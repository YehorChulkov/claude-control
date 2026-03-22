import { homedir } from "os";
import { join } from "path";
import { readdir, stat, readFile, unlink } from "fs/promises";
import { SessionStatus } from "./types";
import { isWindows, resolveClaudeControlDir } from "./platform";

const NATIVE_EVENTS_DIR = join(homedir(), ".claude-control", "events");
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// Cached resolved events dir for Windows
let _resolvedEventsDir: string | null = null;
let _resolvedEventsDirPromise: Promise<string> | null = null;

async function getEventsDir(): Promise<string> {
  if (!isWindows) return NATIVE_EVENTS_DIR;

  if (_resolvedEventsDir) return _resolvedEventsDir;

  if (!_resolvedEventsDirPromise) {
    _resolvedEventsDirPromise = resolveClaudeControlDir().then((dir) => {
      const resolved = join(dir, "events");
      _resolvedEventsDir = resolved;
      return resolved;
    });
  }

  return _resolvedEventsDirPromise;
}

export interface HookStatus {
  status: SessionStatus | null;
  event: string;
  ts: number;
  cwd: string | null;
  sessionId: string | null;
  transcriptPath: string | null;
}

const EVENT_TO_STATUS: Record<string, SessionStatus> = {
  UserPromptSubmit: "working",
  SubagentStart: "working",
  PostToolUseFailure: "working",
  Stop: "idle",
  SessionStart: "idle",
  SessionEnd: "finished",
  // PermissionRequest is intentionally excluded -- it fires for auto-approved
  // tools too, causing false "waiting" states. The JSONL heuristic handles
  // waiting detection via hasPendingToolUse + APPROVAL_SETTLE_MS instead.
};

export function classifyStatusFromHook(eventName: string): SessionStatus | null {
  return EVENT_TO_STATUS[eventName] ?? null;
}

export async function readAllHookStatuses(): Promise<Map<number, HookStatus>> {
  const result = new Map<number, HookStatus>();
  const eventsDir = await getEventsDir();

  let entries: string[];
  try {
    entries = await readdir(eventsDir);
  } catch {
    return result;
  }

  const now = Date.now();

  await Promise.all(
    entries
      .filter((e) => e.endsWith(".json"))
      .map(async (filename) => {
        const filePath = join(eventsDir, filename);

        // Clean up stale files
        try {
          const s = await stat(filePath);
          if (now - s.mtimeMs > STALE_THRESHOLD_MS) {
            await unlink(filePath).catch(() => {});
            return;
          }
        } catch {
          return;
        }

        let content: string;
        try {
          content = (await readFile(filePath, "utf-8")).trim();
        } catch {
          return;
        }
        if (!content) return;

        try {
          const data = JSON.parse(content) as {
            event?: string;
            session_id?: string;
            cwd?: string;
            transcript_path?: string;
            ts?: number;
          };

          if (!data.event) return;

          const status = classifyStatusFromHook(data.event);

          const pid = parseInt(filename.replace(/\.json$/, ""), 10);
          if (isNaN(pid)) return;

          result.set(pid, {
            status,
            event: data.event,
            ts: data.ts ?? 0,
            cwd: data.cwd || null,
            sessionId: data.session_id || null,
            transcriptPath: data.transcript_path || null,
          });
        } catch {
          // Invalid JSON -- skip
        }
      }),
  );

  return result;
}
