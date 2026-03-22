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
  remote?: string;
}

async function discoverRemoteTmuxSessions(): Promise<TmuxSessionInfo[]> {
  const { loadConfig } = await import("@/lib/config");
  const config = await loadConfig();
  if (!config.remotes || config.remotes.length === 0) return [];

  const results: TmuxSessionInfo[] = [];

  for (const remote of config.remotes) {
    try {
      // List sessions
      const { stdout: sessionsOut } = await execFileAsync(
        "ssh",
        ["-o", "ConnectTimeout=5", "-o", "BatchMode=yes", `${remote.user}@${remote.host}`,
         "tmux list-sessions -F '#{session_name}\t#{session_windows}\t#{session_attached}' 2>/dev/null"],
        { timeout: 10000 },
      );

      for (const line of sessionsOut.trim().split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const name = parts[0];
        const windows = parseInt(parts[1] ?? "0", 10);
        const attached = parts[2] === "1";

        // Get pane details
        let panes: TmuxPaneDetail[] = [];
        try {
          const { stdout: panesOut } = await execFileAsync(
            "ssh",
            ["-o", "ConnectTimeout=5", "-o", "BatchMode=yes", `${remote.user}@${remote.host}`,
             `tmux list-panes -t '${name}' -F '#{pane_id}\t#{pane_current_command}\t#{pane_pid}' 2>/dev/null`],
            { timeout: 10000 },
          );
          panes = panesOut.trim().split("\n").filter(Boolean).map((p) => {
            const [paneId, command, pid] = p.split("\t");
            return { paneId: paneId || "", command: command || "", pid: parseInt(pid || "0", 10) };
          });
        } catch { /* ignore */ }

        const hasClaudeRunning = panes.some(
          (p) => p.command.toLowerCase() === "claude" || p.command.toLowerCase() === "claude.exe",
        );

        results.push({ name, windows, attached, panes, hasClaudeRunning, remote: remote.name });
      }
    } catch {
      // Remote unreachable — skip
    }
  }

  return results;
}

export async function GET() {
  // Discover local and remote tmux sessions in parallel
  const [localSessions, remoteSessions] = await Promise.all([
    listTmuxSessions(),
    discoverRemoteTmuxSessions(),
  ]);

  // Enrich local sessions with pane details
  const enriched: TmuxSessionInfo[] = await Promise.all(
    localSessions.map(async (session) => {
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

  // Merge local + remote
  enriched.push(...remoteSessions);

  return NextResponse.json({ sessions: enriched });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, sessionName, remote } = body;

    if (!sessionName || typeof sessionName !== "string") {
      return NextResponse.json({ error: "sessionName is required" }, { status: 400 });
    }

    // Handle remote tmux sessions
    if (remote) {
      const { loadConfig } = await import("@/lib/config");
      const config = await loadConfig();
      const remoteConfig = config.remotes?.find((r: { name: string }) => r.name === remote);
      if (!remoteConfig) {
        return NextResponse.json({ error: `Unknown remote: ${remote}` }, { status: 400 });
      }

      if (action === "kill") {
        await execFileAsync("ssh", [
          "-o", "ConnectTimeout=5", "-o", "BatchMode=yes",
          `${remoteConfig.user}@${remoteConfig.host}`,
          `tmux kill-session -t '${sessionName}'`,
        ], { timeout: 10000 });
        return NextResponse.json({ ok: true });
      }

      if (action === "attach") {
        // Open a terminal with SSH to the remote + tmux attach
        if (isWindows) {
          await execFileAsync("wt.exe", [
            "-w", "0", "new-tab", "ssh",
            `${remoteConfig.user}@${remoteConfig.host}`,
            "-t", "tmux", "attach", "-t", sessionName,
          ], { timeout: 5000 });
        } else {
          await execFileAsync("osascript", ["-e",
            `tell application "Terminal"\n  activate\n  do script "ssh ${remoteConfig.user}@${remoteConfig.host} -t tmux attach -t '${sessionName.replace(/'/g, "'\\\\''")}';"\nend tell`
          ], { timeout: 5000 });
        }
        return NextResponse.json({ ok: true });
      }

      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    // Local tmux sessions
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
