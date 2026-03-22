import { join } from "path";
import { readdir, stat, readFile, unlink } from "fs/promises";
import { SessionStatus } from "./types";
import { resolveClaudeControlDir } from "./platform";

const EVENTS_DIR = join(resolveClaudeControlDir(), "events");
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

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
};

export function classifyStatusFromHook(eventName: string): SessionStatus | null {
  return EVENT_TO_STATUS[eventName] ?? null;
}

interface HookMaps {
  byPid: Map<number, HookStatus>;
  bySessionId: Map<string, HookStatus>;
}

async function readHookEvents(): Promise<HookMaps> {
  const byPid = new Map<number, HookStatus>();
  const bySessionId = new Map<string, HookStatus>();

  let entries: string[];
  try {
    entries = await readdir(EVENTS_DIR);
  } catch {
    return { byPid, bySessionId };
  }

  const now = Date.now();

  await Promise.all(
    entries
      .filter((e) => e.endsWith(".json"))
      .map(async (filename) => {
        const filePath = join(EVENTS_DIR, filename);

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

          const hookStatus: HookStatus = {
            status,
            event: data.event,
            ts: data.ts ?? 0,
            cwd: data.cwd || null,
            sessionId: data.session_id || null,
            transcriptPath: data.transcript_path || null,
          };

          const pid = parseInt(filename.replace(/\.json$/, ""), 10);
          if (!isNaN(pid)) {
            byPid.set(pid, hookStatus);
          }

          if (data.session_id) {
            // If multiple event files share the same session_id, keep the newest
            const existing = bySessionId.get(data.session_id);
            if (!existing || hookStatus.ts > existing.ts) {
              bySessionId.set(data.session_id, hookStatus);
            }
          }
        } catch {
          // Invalid JSON -- skip
        }
      }),
  );

  return { byPid, bySessionId };
}

export async function readAllHookStatuses(): Promise<Map<number, HookStatus>> {
  const { byPid } = await readHookEvents();
  return byPid;
}

export async function readAllHookStatusesBySessionId(): Promise<Map<string, HookStatus>> {
  const { bySessionId } = await readHookEvents();
  return bySessionId;
}

export async function readAllHookMaps(): Promise<HookMaps> {
  return readHookEvents();
}
