import { NextRequest, NextResponse } from "next/server";
import { listTmuxSessions } from "@/lib/terminal";
import { getTmuxPaneDetails, killTmuxSession } from "@/lib/terminal/adapters";
import { isWindows, isMac, getWslDistro } from "@/lib/platform";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

export interface TmuxPaneDetail {
  paneId: string;
  command: string;
  pid: number;
}

export interface TmuxSessionInfo {
  name: string;
  windows: number;
  attached: boolean;
  panes: TmuxPaneDetail[];
  hasClaudeRunning: boolean;
}

export async function GET() {
  const sessions = await listTmuxSessions();

  // Enrich each session with pane details
  const enriched: TmuxSessionInfo[] = await Promise.all(
    sessions.map(async (session) => {
      const panes = await getTmuxPaneDetails(session.name);
      const hasClaudeRunning = panes.some(
        (p) => p.command.toLowerCase() === "claude" || p.command.toLowerCase() === "claude.exe",
      );
      return {
        ...session,
        panes,
        hasClaudeRunning,
      };
    }),
  );

  return NextResponse.json({ sessions: enriched });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, sessionName } = body;

    if (!sessionName || typeof sessionName !== "string") {
      return NextResponse.json({ error: "sessionName is required" }, { status: 400 });
    }

    if (action === "kill") {
      await killTmuxSession(sessionName);
      return NextResponse.json({ ok: true });
    }

    if (action === "attach") {
      if (isWindows) {
        // Open a Windows Terminal tab with wsl tmux attach
        const distro = await getWslDistro();
        const distroArg = distro ? ["-d", distro] : [];
        try {
          await execFileAsync(
            "wt.exe",
            ["-w", "0", "new-tab", "wsl", ...distroArg, "--", "tmux", "attach", "-t", sessionName],
            { timeout: 5000 },
          );
        } catch {
          return NextResponse.json({ error: "Failed to open Windows Terminal" }, { status: 500 });
        }
      } else if (isMac) {
        // On macOS, focus the session via the existing focusSession adapter
        // We need to construct a minimal TerminalInfo for the tmux session
        // Just select the tmux window/pane and let the user's existing client show it
        try {
          const { wslExecArgs } = await import("@/lib/platform");
          const { command: cmd, args: cmdArgs } = wslExecArgs("tmux", [
            "select-window",
            "-t",
            `${sessionName}:0`,
          ]);
          await execFileAsync(cmd, cmdArgs, { timeout: 5000, encoding: "utf-8" });
        } catch {
          // Session might not have window 0, that's ok
        }

        // Try to open a new terminal tab attached to the session
        try {
          await execFileAsync(
            "osascript",
            [
              "-e",
              `tell application "Terminal"
  activate
  do script "tmux attach -t '${sessionName.replace(/'/g, "'\\''")}';"
end tell`,
            ],
            { timeout: 5000 },
          );
        } catch {
          return NextResponse.json({ error: "Failed to open Terminal" }, { status: 500 });
        }
      } else {
        return NextResponse.json({ error: "Attach not supported on this platform" }, { status: 400 });
      }

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
