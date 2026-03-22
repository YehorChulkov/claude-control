import { execFile } from "child_process";
import { promisify } from "util";
import type { TerminalInfo, TerminalApp } from "./types";
import { detectTmuxClients, buildProcessTree, findTerminalInTree } from "./detect";
import { PROCESS_TIMEOUT_MS, APPLESCRIPT_FOCUS_DELAY_S } from "../constants";
import { isWindows, isMac, wslExecArgs, getWslDistro } from "../platform";

const execFileAsync = promisify(execFile);
const OSASCRIPT_TIMEOUT_MS = 10000;

/**
 * Helper to run a command, automatically prefixing with `wsl --` on Windows.
 */
function execPlatform(
  command: string,
  args: string[],
  options: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { command: cmd, args: cmdArgs } = wslExecArgs(command, args);
  return execFileAsync(cmd, cmdArgs, { ...options, encoding: "utf-8" });
}

function escapeForAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function mapKeystrokeToSystemEvents(keystroke: string): string {
  switch (keystroke) {
    case "return":
      return `keystroke return`;
    case "escape":
      return `key code 53`;
    case "up":
      return `key code 126`;
    case "down":
      return `key code 125`;
    case "tab":
      return `key code 48`;
    case "space":
      return `keystroke " "`;
    default:
      return `keystroke "${keystroke.replace(/"/g, '\\"')}"`;
  }
}

// ----------------------------------------------------------------
// AppleScript template builders -- shared across focusSession, sendText,
// and sendKeystroke to avoid duplicating TTY-matching loops.
// ----------------------------------------------------------------

function iTermFocusScript(ttyPath: string): string {
  const safeTty = escapeForAppleScript(ttyPath);
  return `tell application "iTerm"
  activate
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if tty of aSession is "${safeTty}" then
          select aWindow
          select aTab
          select aSession
          return
        end if
      end repeat
    end repeat
  end repeat
end tell`;
}

function terminalAppFocusScript(ttyPath: string): string {
  const safeTty = escapeForAppleScript(ttyPath);
  return `tell application "Terminal"
  activate
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      if tty of aTab is "${safeTty}" then
        set selected tab of aWindow to aTab
        set index of aWindow to 1
        return
      end if
    end repeat
  end repeat
end tell`;
}

function systemEventsScript(processName: string, action: string): string {
  return `tell application "System Events"
  tell process "${processName}"
    ${action}
  end tell
end tell`;
}

function withFocusDelay(focusScript: string, actionScript: string): string {
  return `${focusScript}\ndelay ${APPLESCRIPT_FOCUS_DELAY_S}\n${actionScript}`;
}

function genericActivateScript(appName: string): string {
  return `tell application "${appName}" to activate`;
}

// ----------------------------------------------------------------
// focusSession
// ----------------------------------------------------------------

export async function focusSession(info: TerminalInfo): Promise<void> {
  // If in tmux, select the correct pane first
  if (info.inTmux && info.tmux) {
    const windowTarget = `${info.tmux.sessionName}:${info.tmux.windowIndex}`;
    await execPlatform("tmux", ["select-window", "-t", windowTarget], { timeout: PROCESS_TIMEOUT_MS });
    await execPlatform("tmux", ["select-pane", "-t", info.tmux.paneId], { timeout: PROCESS_TIMEOUT_MS });
  }

  // On Windows: open a new Windows Terminal tab attached to the tmux session
  if (isWindows) {
    if (info.inTmux && info.tmux) {
      // Open WT tab with wsl tmux attach to the session
      const distro = await getWslDistro();
      const distroArg = distro ? ["-d", distro] : [];
      try {
        await execFileAsync(
          "wt.exe",
          ["-w", "0", "new-tab", "wsl", ...distroArg, "--", "tmux", "attach", "-t", info.tmux.sessionName],
          { timeout: 5000 },
        );
      } catch {
        // Fallback: just focus WT window
        try {
          await execFileAsync("powershell", ["-NoProfile", "-Command",
            `$wt = Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Select-Object -First 1; if ($wt) { (New-Object -ComObject WScript.Shell).AppActivate($wt.Id) }`
          ], { timeout: 5000 });
        } catch { /* best effort */ }
      }
    } else {
      // Non-tmux session: just focus Windows Terminal
      try {
        await execFileAsync("powershell", ["-NoProfile", "-Command",
          `$wt = Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Select-Object -First 1; if ($wt) { (New-Object -ComObject WScript.Shell).AppActivate($wt.Id) }`
        ], { timeout: 5000 });
      } catch { /* best effort */ }
    }
    return;
  }

  // Use tmux client TTY (terminal tab's TTY) when in tmux, otherwise the process's TTY
  const ttyPath = info.inTmux && info.tmux?.clientTty ? info.tmux.clientTty : info.tty;

  switch (info.app) {
    case "iterm":
      await execFileAsync("osascript", ["-e", iTermFocusScript(ttyPath)], { timeout: OSASCRIPT_TIMEOUT_MS });
      break;

    case "terminal-app":
      await execFileAsync("osascript", ["-e", terminalAppFocusScript(ttyPath)], { timeout: OSASCRIPT_TIMEOUT_MS });
      break;

    case "ghostty":
    case "kitty":
    case "wezterm":
    case "alacritty":
      await execFileAsync("open", ["-a", info.appName], { timeout: OSASCRIPT_TIMEOUT_MS });
      break;

    case "windows-terminal":
      // On Windows, we can't programmatically focus Windows Terminal from Node.
      // tmux pane selection above is sufficient.
      break;

    default:
      throw new Error("Cannot focus unknown terminal");
  }
}

// ----------------------------------------------------------------
// sendText
// ----------------------------------------------------------------

export async function sendText(info: TerminalInfo, text: string): Promise<void> {
  // tmux: send directly to the pane -- works in background without focus
  if (info.inTmux && info.tmux) {
    await execPlatform("tmux", ["send-keys", "-t", info.tmux.paneId, text, "Enter"], {
      timeout: PROCESS_TIMEOUT_MS,
    });
    return;
  }

  // On Windows without tmux, we cannot send text
  if (isWindows) {
    throw new Error("Cannot send text to non-tmux session on Windows");
  }

  const asEscaped = escapeForAppleScript(text);

  switch (info.app) {
    case "iterm": {
      const safeTty = escapeForAppleScript(info.tty);
      const script = `tell application "iTerm"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if tty of aSession is "${safeTty}" then
          tell aSession
            write text "${asEscaped}"
          end tell
          return
        end if
      end repeat
    end repeat
  end repeat
end tell`;
      await execFileAsync("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
      break;
    }

    case "terminal-app": {
      // Combined focus + text in a single osascript to avoid Electron focus-steal race
      const action = systemEventsScript("Terminal", `keystroke "${asEscaped}"\n    keystroke return`);
      const script = withFocusDelay(terminalAppFocusScript(info.tty), action);
      await execFileAsync("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
      break;
    }

    case "ghostty":
    case "kitty":
    case "wezterm":
    case "alacritty": {
      // Combined activate + text in a single osascript to avoid Electron focus-steal race
      const action = systemEventsScript(info.appName, `keystroke "${asEscaped}"\n    keystroke return`);
      const script = withFocusDelay(genericActivateScript(info.appName), action);
      await execFileAsync("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
      break;
    }

    default:
      throw new Error("Cannot send text to unknown terminal");
  }
}

// ----------------------------------------------------------------
// sendKeystroke
// ----------------------------------------------------------------

export async function sendKeystroke(info: TerminalInfo, keystroke: string): Promise<void> {
  // tmux: send directly to the pane
  if (info.inTmux && info.tmux) {
    const tmuxKeyMap: Record<string, string> = {
      return: "Enter",
      escape: "Escape",
      up: "Up",
      down: "Down",
      tab: "Tab",
      space: "Space",
    };
    await execPlatform("tmux", ["send-keys", "-t", info.tmux.paneId, tmuxKeyMap[keystroke] ?? keystroke], {
      timeout: PROCESS_TIMEOUT_MS,
    });
    return;
  }

  // On Windows without tmux, we cannot send keystrokes
  if (isWindows) {
    throw new Error("Cannot send keystroke to non-tmux session on Windows");
  }

  // iTerm2: use write text for simple keys (no focus needed)
  if (info.app === "iterm") {
    const itermWriteMap: Record<string, string> = {
      return: `write text ""`,
      escape: `write text (ASCII character 27) newline NO`,
      y: `write text "y"`,
      n: `write text "n"`,
    };

    const writeCmd = itermWriteMap[keystroke];
    if (writeCmd) {
      const safeTty = escapeForAppleScript(info.tty);
      const script = `tell application "iTerm"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if tty of aSession is "${safeTty}" then
          tell aSession
            ${writeCmd}
          end tell
          return
        end if
      end repeat
    end repeat
  end repeat
end tell`;
      await execFileAsync("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
      return;
    }
    // Arrow keys fall through to the System Events path below
  }

  // All remaining apps: combined focus + keystroke in a single osascript
  // to avoid Electron focus-steal race between two separate calls
  if (info.app === "unknown" || info.app === "windows-terminal") {
    throw new Error("Cannot send keystroke to unknown terminal");
  }

  const asKeystroke = mapKeystrokeToSystemEvents(keystroke);

  if (info.app === "iterm") {
    // iTerm arrow keys: native tab-matching focus, then System Events
    const action = systemEventsScript("iTerm2", asKeystroke);
    const script = withFocusDelay(iTermFocusScript(info.tty), action);
    await execFileAsync("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
  } else if (info.app === "terminal-app") {
    const action = systemEventsScript("Terminal", asKeystroke);
    const script = withFocusDelay(terminalAppFocusScript(info.tty), action);
    await execFileAsync("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
  } else {
    // Ghostty, Kitty, WezTerm, Alacritty: activate + keystroke in one script
    const action = systemEventsScript(info.appName, asKeystroke);
    const script = withFocusDelay(genericActivateScript(info.appName), action);
    await execFileAsync("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
  }
}

// ----------------------------------------------------------------
// createSession
// ----------------------------------------------------------------

export interface CreateSessionOpts {
  terminalApp: TerminalApp;
  openIn: "tab" | "window";
  useTmux: boolean;
  tmuxSession?: string; // session name to create or add a window to
  cwd: string;
  prompt?: string; // initial prompt for claude (raw, unescaped)
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

function shellEscapeDouble(s: string): string {
  return s.replace(/["$`\\]/g, "\\$&");
}

export async function createSession(opts: CreateSessionOpts): Promise<void> {
  const { terminalApp, openIn, useTmux, tmuxSession, cwd, prompt } = opts;

  // Build the shell command with proper escaping -- all user input
  // goes through shellEscape so callers can't introduce injection
  let command = "claude";
  if (prompt) {
    command += ` '${shellEscape(prompt)}'`;
  }
  const cmd = `cd '${shellEscape(cwd)}' && ${command}`;

  // Named tmux session: try adding a window to existing session
  if (useTmux && tmuxSession) {
    try {
      await execPlatform("tmux", ["new-window", "-t", tmuxSession, cmd], { timeout: OSASCRIPT_TIMEOUT_MS });
      // Focus the terminal tab that has the tmux client for this session
      if (isMac) {
        try {
          const [clients, tree] = await Promise.all([detectTmuxClients(), buildProcessTree()]);
          const client = clients.find((c) => c.sessionName === tmuxSession);
          if (client) {
            const termApp = findTerminalInTree(client.pid, tree);
            // Don't set inTmux -- we just want to focus the terminal tab by
            // the client TTY. tmux already switched to the new window.
            await focusSession({
              ...termApp,
              inTmux: false,
              tty: client.tty,
            });
          }
        } catch (err) {
          console.error("focus after new-window failed:", err);
        }
      }
      return;
    } catch {
      // Session doesn't exist -- fall through to open a terminal with new-session
    }
  }

  // Build the effective command
  let effectiveCommand: string;
  if (useTmux) {
    // Named session that needs creating, or unnamed fallback
    const sessionName = tmuxSession || `claude-${Date.now().toString(36).slice(-4)}`;
    effectiveCommand = `tmux new-session -s '${shellEscape(sessionName)}' "${shellEscapeDouble(cmd)}"`;
  } else {
    effectiveCommand = cmd;
  }

  // Windows: use wt.exe to open a new tab in Windows Terminal with WSL
  if (isWindows) {
    const distro = await getWslDistro();
    const distroArg = distro ? ["-d", distro] : [];
    // wt.exe -w 0 new-tab wsl -d <distro> -- bash -c "<command>"
    await execFileAsync(
      "wt.exe",
      ["-w", "0", "new-tab", "wsl", ...distroArg, "--", "bash", "-c", effectiveCommand],
      { timeout: OSASCRIPT_TIMEOUT_MS },
    );
    return;
  }

  // macOS terminal launch
  switch (terminalApp) {
    case "iterm": {
      const asCmd = escapeForAppleScript(effectiveCommand);
      const script =
        openIn === "tab"
          ? `tell application "iTerm"
  activate
  tell current window
    set newTab to (create tab with default profile)
    tell current session of newTab
      write text "${asCmd}"
    end tell
  end tell
end tell`
          : `tell application "iTerm"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow
    write text "${asCmd}"
  end tell
end tell`;
      await execFileAsync("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
      break;
    }

    case "terminal-app": {
      const asCmd = escapeForAppleScript(effectiveCommand);
      const script = `tell application "Terminal"
  activate
  do script "${asCmd}"
end tell`;
      await execFileAsync("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
      break;
    }

    case "ghostty":
      await execFileAsync("ghostty", ["-e", "sh", "-c", effectiveCommand], { timeout: OSASCRIPT_TIMEOUT_MS });
      break;
    case "kitty":
      await execFileAsync("kitty", ["sh", "-c", effectiveCommand], { timeout: OSASCRIPT_TIMEOUT_MS });
      break;
    case "wezterm":
      await execFileAsync("wezterm", ["start", "--", "sh", "-c", effectiveCommand], { timeout: OSASCRIPT_TIMEOUT_MS });
      break;
    case "alacritty":
      await execFileAsync("alacritty", ["-e", "sh", "-c", effectiveCommand], { timeout: OSASCRIPT_TIMEOUT_MS });
      break;

    default:
      throw new Error(`Cannot create session for unknown terminal: ${terminalApp}`);
  }
}

// ----------------------------------------------------------------
// listTmuxSessions
// ----------------------------------------------------------------

export async function listTmuxSessions(): Promise<{ name: string; windows: number; attached: boolean }[]> {
  try {
    const { stdout } = await execPlatform(
      "tmux",
      ["list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_attached}"],
      { timeout: PROCESS_TIMEOUT_MS },
    );
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        return {
          name: parts[0],
          windows: parseInt(parts[1] ?? "0", 10),
          attached: parts[2] === "1",
        };
      });
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------
// getTmuxPaneDetails
// ----------------------------------------------------------------

export async function getTmuxPaneDetails(
  sessionName: string,
): Promise<{ paneId: string; command: string; pid: number }[]> {
  try {
    const { stdout } = await execPlatform(
      "tmux",
      ["list-panes", "-t", sessionName, "-F", "#{pane_id}\t#{pane_current_command}\t#{pane_pid}"],
      { timeout: PROCESS_TIMEOUT_MS },
    );
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        return {
          paneId: parts[0] ?? "",
          command: parts[1] ?? "",
          pid: parseInt(parts[2] ?? "0", 10),
        };
      });
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------
// killTmuxSession
// ----------------------------------------------------------------

export async function killTmuxSession(sessionName: string): Promise<void> {
  await execPlatform("tmux", ["kill-session", "-t", sessionName], {
    timeout: PROCESS_TIMEOUT_MS,
  });
}
