import { execFile } from "child_process";
import { promisify } from "util";
import { GitSummary } from "./types";
import { GIT_TIMEOUT_MS } from "./constants";
import { isWindows, wslExecArgs } from "./platform";

const execFileAsync = promisify(execFile);

async function gitCommand(args: string[], cwd: string): Promise<string> {
  try {
    // On Windows, git runs inside WSL, so we need to wrap the command.
    // The cwd is a WSL path (from lsof), so it works directly with `wsl -- git`.
    if (isWindows) {
      // Use wsl to run git with -C <cwd> since we can't set cwd on the Windows side
      // to a WSL path directly.
      const { command, args: cmdArgs } = wslExecArgs("git", ["-C", cwd, ...args]);
      const { stdout } = await execFileAsync(command, cmdArgs, {
        timeout: GIT_TIMEOUT_MS,
      });
      return stdout.trim();
    }

    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function getGitBranch(cwd: string): Promise<string | null> {
  const branch = await gitCommand(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return branch || null;
}

export async function getGitSummary(cwd: string): Promise<GitSummary | null> {
  const [branch, porcelain, shortStat] = await Promise.all([
    gitCommand(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    gitCommand(["status", "--porcelain"], cwd),
    gitCommand(["diff", "--shortstat"], cwd),
  ]);

  if (!branch) return null;

  const lines = porcelain.split("\n").filter(Boolean);
  const untrackedFiles = lines.filter((l) => l.startsWith("??")).length;
  const changedFiles = lines.filter((l) => !l.startsWith("??")).length;

  let additions = 0;
  let deletions = 0;
  const statMatch = shortStat.match(/(\d+) insertion/);
  const delMatch = shortStat.match(/(\d+) deletion/);
  if (statMatch) additions = parseInt(statMatch[1], 10);
  if (delMatch) deletions = parseInt(delMatch[1], 10);

  return {
    branch,
    changedFiles,
    additions,
    deletions,
    untrackedFiles,
    shortStat: shortStat || "clean",
  };
}

export async function getGitDiff(cwd: string): Promise<string | null> {
  const diff = await gitCommand(["diff", "--stat"], cwd);
  return diff || null;
}

// Cache: branch -> { url, timestamp }
const prUrlCache = new Map<string, { url: string | null; ts: number }>();
const PR_URL_TTL_MS = 60_000; // 60s for known PR URLs
const PR_URL_NULL_TTL_MS = 30_000; // 30s for "no PR" results

export async function getPrUrl(cwd: string, branch: string): Promise<string | null> {
  const cacheKey = `${cwd}::${branch}`;
  const now = Date.now();
  for (const [key, entry] of prUrlCache) {
    const ttl = entry.url ? PR_URL_TTL_MS : PR_URL_NULL_TTL_MS;
    if (now - entry.ts >= ttl) prUrlCache.delete(key);
  }

  const cached = prUrlCache.get(cacheKey);
  if (cached) return cached.url;

  try {
    let stdout: string;
    if (isWindows) {
      const { command, args } = wslExecArgs("gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"]);
      // Use -C for git context since cwd is a WSL path
      const result = await execFileAsync(command, args, { timeout: 5000 });
      stdout = result.stdout;
    } else {
      const result = await execFileAsync("gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"], {
        cwd,
        timeout: 5000,
      });
      stdout = result.stdout;
    }
    const url = stdout.trim() || null;
    prUrlCache.set(cacheKey, { url, ts: Date.now() });
    return url;
  } catch {
    prUrlCache.set(cacheKey, { url: null, ts: Date.now() });
    return null;
  }
}

export async function getMainWorktreePath(cwd: string): Promise<string | null> {
  const output = await gitCommand(["worktree", "list", "--porcelain"], cwd);
  if (!output) return null;
  // First "worktree" line is always the main worktree
  const match = output.match(/^worktree (.+)$/m);
  return match ? match[1] : null;
}
