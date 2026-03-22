import { execFile } from "child_process";
import { promisify } from "util";
import type { ClaudeSession, ConversationPreview } from "./types";
import type { RemoteConfig } from "./config";
import { loadConfig } from "./config";
import {
  extractSessionId,
  extractStartedAt,
  extractBranch,
  extractPreview,
  extractTaskSummary,
  lastMessageHasError,
  isAskingForInput,
  hasPendingToolUse,
} from "./session-reader";
import { classifyStatus } from "./status-classifier";
import { repoNameFromPath } from "./paths";

const execFileAsync = promisify(execFile);

/** PID offset for remote Mac sessions to avoid collision with local (0-10M) and WSL (10M-20M) */
const REMOTE_PID_OFFSET = 20_000_000;

/** Cache SSH command results briefly to avoid hammering */
interface SshCache {
  data: string;
  timestamp: number;
}

const sshCache = new Map<string, SshCache>();
const SSH_CACHE_TTL_MS = 3000;

// ────────────────────────────────────────────────────────────────────────────
// SSH helper
// ────────────────────────────────────────────────────────────────────────────

async function sshExec(
  remote: RemoteConfig,
  command: string,
  cacheKey?: string,
): Promise<string> {
  // Check cache
  if (cacheKey) {
    const cached = sshCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SSH_CACHE_TTL_MS) {
      return cached.data;
    }
  }

  try {
    const { stdout } = await execFileAsync(
      "ssh",
      [
        "-o", "ConnectTimeout=5",
        "-o", "BatchMode=yes",
        `${remote.user}@${remote.host}`,
        command,
      ],
      { timeout: 15000 },
    );

    if (cacheKey) {
      sshCache.set(cacheKey, { data: stdout, timestamp: Date.now() });
    }

    return stdout;
  } catch {
    return "";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Remote process discovery
// ────────────────────────────────────────────────────────────────────────────

interface RemoteProcess {
  pid: number;
  ppid: number;
  cpuPercent: number;
  comm: string;
}

async function discoverRemoteProcesses(remote: RemoteConfig): Promise<RemoteProcess[]> {
  const cacheKey = `${remote.host}:ps`;
  const output = await sshExec(remote, "ps -eo pid,ppid,%cpu,comm", cacheKey);
  if (!output) return [];

  const processes: RemoteProcess[] = [];
  const lines = output.trim().split("\n");

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse: PID PPID %CPU COMM
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
    if (!match) continue;

    const comm = match[4].trim().toLowerCase();
    // Look for claude processes (same logic as local detection)
    if (comm.includes("claude") && !comm.includes("claude-control")) {
      processes.push({
        pid: parseInt(match[1], 10),
        ppid: parseInt(match[2], 10),
        cpuPercent: parseFloat(match[3]),
        comm: match[4].trim(),
      });
    }
  }

  return processes;
}

async function getRemoteWorkingDirectories(
  remote: RemoteConfig,
  pids: number[],
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;

  const cacheKey = `${remote.host}:lsof:${pids.join(",")}`;
  const output = await sshExec(
    remote,
    `lsof -p ${pids.join(",")} -Fpn -d cwd 2>/dev/null`,
    cacheKey,
  );
  if (!output) return result;

  let currentPid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      currentPid = parseInt(line.slice(1), 10);
    } else if (line.startsWith("n") && currentPid !== null) {
      result.set(currentPid, line.slice(1));
      currentPid = null;
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Remote JSONL reading
// ────────────────────────────────────────────────────────────────────────────

interface JsonlLine {
  type: string;
  subtype?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  message?: {
    role?: string;
    stop_reason?: string;
    content?: string | Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
  };
}

function workingDirToEscapedPath(workingDir: string): string {
  return workingDir.replace(/\//g, "-");
}

async function findRemoteLatestJsonl(
  remote: RemoteConfig,
  workingDir: string,
): Promise<{ path: string; content: string } | null> {
  const escaped = workingDirToEscapedPath(workingDir);
  const projectDir = `~/.claude/projects/${escaped}`;

  // List JSONL files sorted by modification time (newest first), pick the first one,
  // then tail the last 50KB of it
  const findCmd = `ls -t "${projectDir}"/*.jsonl 2>/dev/null | head -1`;
  const latestFile = (await sshExec(remote, findCmd)).trim();
  if (!latestFile) return null;

  // Read last 50KB of the file
  const tailCmd = `tail -c 51200 "${latestFile}" 2>/dev/null`;
  const cacheKey = `${remote.host}:jsonl:${latestFile}`;
  const content = await sshExec(remote, tailCmd, cacheKey);
  if (!content) return null;

  return { path: latestFile, content };
}

function parseJsonlContent(content: string): JsonlLine[] {
  const lines = content.trim().split("\n").filter(Boolean);
  // If we read from an offset (tail -c), the first line is likely partial — skip it
  const startIdx = lines.length > 1 ? 1 : 0;
  const parsed: JsonlLine[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    try {
      parsed.push(JSON.parse(lines[i]));
    } catch {
      // skip malformed lines
    }
  }
  return parsed;
}

function parseJsonlHead(content: string, maxLines = 30): JsonlLine[] {
  const lines = content.trim().split("\n").filter(Boolean);
  const headLines = lines.slice(0, maxLines);
  const parsed: JsonlLine[] = [];
  for (const line of headLines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  return parsed;
}

// ────────────────────────────────────────────────────────────────────────────
// Build remote sessions
// ────────────────────────────────────────────────────────────────────────────

async function buildRemoteSession(
  remote: RemoteConfig,
  pid: number,
  cpuPercent: number,
  workingDir: string,
): Promise<ClaudeSession | null> {
  const jsonlResult = await findRemoteLatestJsonl(remote, workingDir);

  let sessionId = `remote-${remote.name}-pid-${pid}`;
  let startedAt: string | null = null;
  let branch: string | null = null;
  let preview: ConversationPreview = {
    lastUserMessage: null,
    lastAssistantText: null,
    assistantIsNewer: false,
    lastTools: [],
    messageCount: 0,
    recentMessages: [],
  };
  let hasError = false;
  let askingForInput = false;
  let pendingToolUse = false;
  let lastActivity = new Date().toISOString();
  let taskSummary: ClaudeSession["taskSummary"] = null;
  let jsonlPath: string | null = null;

  if (jsonlResult) {
    jsonlPath = jsonlResult.path;
    const tailLines = parseJsonlContent(jsonlResult.content);
    const headLines = parseJsonlHead(jsonlResult.content);

    const jsonlSessionId = extractSessionId(tailLines);
    sessionId = jsonlSessionId ?? sessionId;
    startedAt = extractStartedAt(tailLines);
    branch = extractBranch(tailLines);
    preview = extractPreview(tailLines);
    hasError = lastMessageHasError(tailLines);
    askingForInput = isAskingForInput(tailLines);
    pendingToolUse = hasPendingToolUse(tailLines);
    taskSummary = extractTaskSummary(headLines);
  }

  const offsetPid = pid + REMOTE_PID_OFFSET;

  const status = classifyStatus({
    pid: offsetPid,
    jsonlMtime: new Date(), // We can't get exact mtime via SSH easily, assume recent
    cpuPercent,
    hasError,
    isAskingForInput: askingForInput,
    hasPendingToolUse: pendingToolUse,
  });

  return {
    id: sessionId,
    pid: offsetPid,
    workingDirectory: workingDir,
    repoName: repoNameFromPath(workingDir),
    parentRepo: null,
    isWorktree: false,
    branch,
    status,
    lastActivity,
    startedAt,
    git: null, // Skip git info for remote sessions (would require too many SSH calls)
    preview,
    hasPendingToolUse: pendingToolUse,
    taskSummary,
    jsonlPath,
    prUrl: null,
    remote: remote.name,
  };
}

async function discoverRemoteSessionsForHost(remote: RemoteConfig): Promise<ClaudeSession[]> {
  try {
    const processes = await discoverRemoteProcesses(remote);
    if (processes.length === 0) return [];

    const pids = processes.map((p) => p.pid);
    const cwds = await getRemoteWorkingDirectories(remote, pids);

    const results = await Promise.all(
      processes
        .filter((p) => cwds.has(p.pid))
        .map((p) => buildRemoteSession(remote, p.pid, p.cpuPercent, cwds.get(p.pid)!)),
    );

    return results.filter((s): s is ClaudeSession => s !== null);
  } catch {
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export async function discoverAllRemoteSessions(): Promise<ClaudeSession[]> {
  const config = await loadConfig();
  if (!config.remotes || config.remotes.length === 0) return [];

  const results = await Promise.all(
    config.remotes.map((remote) => discoverRemoteSessionsForHost(remote)),
  );

  return results.flat();
}

/** Check if a PID belongs to a remote session */
export function isRemotePid(pid: number): boolean {
  return pid >= REMOTE_PID_OFFSET;
}

/** Get the remote config for a given remote name */
export async function getRemoteConfig(remoteName: string): Promise<RemoteConfig | null> {
  const config = await loadConfig();
  return config.remotes?.find((r) => r.name === remoteName) ?? null;
}
