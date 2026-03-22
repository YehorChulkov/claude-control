import { execFile } from "child_process";
import { promisify } from "util";
import type { TerminalApp, TerminalInfo, TmuxPaneInfo, TmuxClientInfo, ProcessTreeEntry } from "./types";
import { PROCESS_TIMEOUT_MS } from "../constants";
import { isWindows, wslExecArgs } from "../platform";

const execFileAsync = promisify(execFile);

// Known terminal mappings: process name (lowercased) -> app info
const KNOWN_TERMINALS: Record<string, { app: TerminalApp; appName: string; processName: string }> = {
  iterm2: { app: "iterm", appName: "iTerm2", processName: "iTerm2" },
  terminal: { app: "terminal-app", appName: "Terminal", processName: "Terminal" },
  ghostty: { app: "ghostty", appName: "Ghostty", processName: "ghostty" },
  kitty: { app: "kitty", appName: "kitty", processName: "kitty" },
  "wezterm-gui": { app: "wezterm", appName: "WezTerm", processName: "wezterm-gui" },
  wezterm: { app: "wezterm", appName: "WezTerm", processName: "WezTerm" },
  alacritty: { app: "alacritty", appName: "Alacritty", processName: "alacritty" },
  windowsterminal: { app: "windows-terminal", appName: "Windows Terminal", processName: "WindowsTerminal.exe" },
};

const WINDOWS_TERMINAL_INFO: Pick<TerminalInfo, "app" | "appName" | "processName"> = {
  app: "windows-terminal",
  appName: "Windows Terminal",
  processName: "WindowsTerminal.exe",
};

const UNKNOWN_TERMINAL: Pick<TerminalInfo, "app" | "appName" | "processName"> = {
  app: "unknown",
  appName: "Unknown",
  processName: "unknown",
};

// Cache keyed by PID -- only caches successful (non-unknown) detections
const terminalCache = new Map<number, TerminalInfo>();

export function clearTerminalCache(pid: number): void {
  terminalCache.delete(pid);
}

export function evictStaleTerminalCache(alivePids: Set<number>): void {
  Array.from(terminalCache.keys()).forEach((pid) => {
    if (!alivePids.has(pid)) terminalCache.delete(pid);
  });
}

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

/**
 * Build a process tree from a single `ps -eo pid,ppid,%cpu,comm` call.
 * On Windows, uses PowerShell to get native process info.
 * Returns a Map keyed by PID.
 */
// Track which PIDs came from WSL (needed for tmux interaction)
const wslPids = new Set<number>();

export function isWslProcess(pid: number): boolean {
  return wslPids.has(pid);
}

export async function buildProcessTree(): Promise<Map<number, ProcessTreeEntry>> {
  const tree = new Map<number, ProcessTreeEntry>();

  if (isWindows) {
    // Scan BOTH native Windows processes AND WSL processes in parallel
    const [nativeResult, wslResult] = await Promise.allSettled([
      // Native Windows processes via PowerShell
      execFileAsync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|0|$($_.Name)" }`,
        ],
        { timeout: PROCESS_TIMEOUT_MS * 2 },
      ),
      // WSL processes via wsl ps
      execFileAsync("wsl", ["--", "ps", "-eo", "pid,ppid,%cpu,comm"], {
        timeout: PROCESS_TIMEOUT_MS * 2,
      }),
    ]);

    // Parse native Windows processes
    if (nativeResult.status === "fulfilled") {
      for (const line of nativeResult.value.stdout.split(/\r?\n/)) {
        const parts = line.trim().split("|");
        if (parts.length >= 4) {
          const pid = parseInt(parts[0], 10);
          if (!isNaN(pid)) {
            tree.set(pid, {
              ppid: parseInt(parts[1], 10) || 0,
              cpuPercent: parseFloat(parts[2]) || 0,
              comm: parts[3].trim(),
            });
          }
        }
      }
    }

    // Parse WSL processes — use negative PID offset to avoid collisions with Windows PIDs
    // WSL PIDs are prefixed with 10_000_000 to distinguish them
    if (wslResult.status === "fulfilled") {
      for (const line of wslResult.value.stdout.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.,]+)\s+(.+)$/);
        if (match) {
          const wslPid = parseInt(match[1], 10) + 10_000_000;
          wslPids.add(wslPid);
          tree.set(wslPid, {
            ppid: parseInt(match[2], 10) + 10_000_000,
            cpuPercent: parseFloat(match[3].replace(",", ".")) || 0,
            comm: match[4].trim(),
          });
        }
      }
    }

    return tree;
  }

  // macOS/Linux: use ps
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid,ppid,%cpu,comm"], {
      timeout: PROCESS_TIMEOUT_MS,
    });
    for (const line of stdout.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.,]+)\s+(.+)$/);
      if (match) {
        tree.set(parseInt(match[1], 10), {
          ppid: parseInt(match[2], 10),
          cpuPercent: parseFloat(match[3].replace(",", ".")) || 0,
          comm: match[4].trim(),
        });
      }
    }
  } catch {
    // empty tree
  }
  return tree;
}

/**
 * Extract PIDs from the process tree where comm matches "claude".
 * On Windows, matches "claude.exe"; on macOS/Linux, matches "claude".
 */
export function findClaudePidsFromTree(processTree: Map<number, ProcessTreeEntry>): number[] {
  const pids: number[] = [];
  Array.from(processTree.entries()).forEach(([pid, entry]) => {
    const comm = entry.comm.toLowerCase();
    if (comm === "claude" || comm === "claude.exe") {
      pids.push(pid);
    }
  });
  return pids;
}

/**
 * Get TTYs for multiple PIDs in a single `ps` call.
 * Returns a Map of PID -> normalized TTY path.
 */
export async function getTtysForPids(pids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pids.length === 0 || isWindows) return result;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pid=,tty=", "-p", pids.join(",")], {
      timeout: PROCESS_TIMEOUT_MS,
    });
    for (const line of stdout.trim().split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (match) {
        const tty = match[2].trim();
        if (tty && tty !== "?" && tty !== "??") {
          result.set(parseInt(match[1], 10), normalizeTty(tty));
        }
      }
    }
  } catch {
    /* ignore */
  }
  return result;
}

/**
 * Get the TTY for a single PID. Throws if no TTY found.
 * On Windows, always throws (no TTY concept for native processes).
 */
export async function getTtyForPid(pid: number): Promise<string> {
  if (isWindows) {
    throw new Error(`No TTY on Windows for PID ${pid}`);
  }
  const { stdout } = await execFileAsync("ps", ["-o", "tty=", "-p", String(pid)], {
    timeout: PROCESS_TIMEOUT_MS,
  });
  const tty = stdout.trim();
  if (!tty || tty === "?" || tty === "??") {
    throw new Error(`No TTY found for PID ${pid}`);
  }
  return normalizeTty(tty);
}

function normalizeTty(tty: string): string {
  return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
}

/**
 * Detect all tmux panes. Returns a Map keyed by normalized TTY path.
 */
export async function detectAllTmuxPanes(): Promise<Map<string, TmuxPaneInfo>> {
  try {
    const { stdout } = await execPlatform(
      "tmux",
      ["list-panes", "-a", "-F", "#{pane_tty}\t#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}"],
      { timeout: 5000 },
    );
    const panes = new Map<string, TmuxPaneInfo>();
    for (const line of stdout.split("\n")) {
      const parts = line.trim().split("\t");
      if (parts.length < 5) continue;
      const [rawTty, paneId, sessionName, winIdx, paneIdx] = parts;
      const tty = normalizeTty(rawTty);
      const windowIndex = parseInt(winIdx, 10);
      const paneIndex = parseInt(paneIdx, 10);
      panes.set(tty, {
        tty,
        paneId,
        sessionName,
        windowIndex,
        paneIndex,
        target: `${sessionName}:${windowIndex}.${paneIndex}`,
      });
    }
    return panes;
  } catch {
    return new Map();
  }
}

/**
 * Detect all tmux clients.
 */
export async function detectTmuxClients(): Promise<TmuxClientInfo[]> {
  try {
    const { stdout } = await execPlatform(
      "tmux",
      ["list-clients", "-F", "#{client_tty}\t#{client_pid}\t#{client_session}"],
      { timeout: 5000 },
    );
    const clients: TmuxClientInfo[] = [];
    for (const line of stdout.split("\n")) {
      const parts = line.trim().split("\t");
      if (parts.length < 3) continue;
      const pid = parseInt(parts[1], 10);
      if (!isNaN(pid)) {
        clients.push({ tty: normalizeTty(parts[0]), pid, sessionName: parts[2] });
      }
    }
    return clients;
  } catch {
    return [];
  }
}

/**
 * Walk the process tree upward from startPid, checking each ancestor's comm
 * against known terminals. Returns matched terminal info or unknown.
 *
 * On Windows, the process tree is from WSL so we won't find Windows Terminal.
 * In that case, we default to Windows Terminal.
 */
export function findTerminalInTree(
  startPid: number,
  processTree: Map<number, ProcessTreeEntry>,
): Pick<TerminalInfo, "app" | "appName" | "processName"> {
  let currentPid = startPid;
  const visited = new Set<number>();

  while (currentPid > 1 && !visited.has(currentPid)) {
    visited.add(currentPid);
    const entry = processTree.get(currentPid);
    if (!entry) break;

    const matched = matchTerminal(entry.comm);
    if (matched) return matched;

    currentPid = entry.ppid;
  }

  // On Windows, the terminal (Windows Terminal) runs outside WSL,
  // so it won't appear in the WSL process tree. Default to Windows Terminal.
  if (isWindows) {
    return WINDOWS_TERMINAL_INFO;
  }

  return UNKNOWN_TERMINAL;
}

/**
 * Match a process comm string against known terminals.
 * Handles full paths like /Applications/iTerm.app/Contents/MacOS/iTerm2.
 */
export function matchTerminal(comm: string): Pick<TerminalInfo, "app" | "appName" | "processName"> | null {
  const basename = comm.includes("/") ? comm.split("/").pop() || comm : comm;
  const lower = basename.toLowerCase();

  // Direct match
  const direct = KNOWN_TERMINALS[lower];
  if (direct) return direct;

  // Fuzzy match for versioned/server processes (e.g. "iTermServer-3.5.14" -> iterm)
  for (const [key, value] of Object.entries(KNOWN_TERMINALS)) {
    if (lower.startsWith(key) || lower.includes(key)) return value;
  }

  // Match by app bundle path (e.g. "/Applications/iTerm.app/..." -> iterm)
  const lowerComm = comm.toLowerCase();
  if (lowerComm.includes("iterm")) return KNOWN_TERMINALS["iterm2"];
  if (lowerComm.includes("ghostty")) return KNOWN_TERMINALS["ghostty"];
  if (lowerComm.includes("kitty")) return KNOWN_TERMINALS["kitty"];
  if (lowerComm.includes("wezterm")) return KNOWN_TERMINALS["wezterm-gui"] ?? KNOWN_TERMINALS["wezterm"];
  if (lowerComm.includes("alacritty")) return KNOWN_TERMINALS["alacritty"];

  return null;
}

/**
 * Detect the terminal for a given claude PID.
 * Uses cache for non-unknown results.
 */
export async function detectTerminal(
  pid: number,
  processTree: Map<number, ProcessTreeEntry>,
  tmuxPanes: Map<string, TmuxPaneInfo>,
  tmuxClients?: TmuxClientInfo[],
): Promise<TerminalInfo> {
  const cached = terminalCache.get(pid);
  if (cached) return cached;

  try {
    const tty = await getTtyForPid(pid);
    const paneInfo = tmuxPanes.get(tty);
    const inTmux = paneInfo !== undefined;

    let termApp: Pick<TerminalInfo, "app" | "appName" | "processName">;
    let tmuxInfo: TerminalInfo["tmux"] | undefined;

    if (inTmux && paneInfo) {
      // In tmux: trace from the tmux client PID to find the GUI terminal
      const clients = tmuxClients ?? (await detectTmuxClients());
      const sessionClient = clients.find((c) => c.sessionName === paneInfo.sessionName);

      tmuxInfo = {
        paneId: paneInfo.paneId,
        sessionName: paneInfo.sessionName,
        windowIndex: paneInfo.windowIndex,
        paneIndex: paneInfo.paneIndex,
        target: paneInfo.target,
        clientTty: sessionClient?.tty ?? "",
      };

      termApp =
        sessionClient && sessionClient.pid > 0 ? findTerminalInTree(sessionClient.pid, processTree) : isWindows ? WINDOWS_TERMINAL_INFO : UNKNOWN_TERMINAL;
    } else {
      // Not in tmux: walk up from the claude process itself
      termApp = findTerminalInTree(pid, processTree);
    }

    const result: TerminalInfo = {
      ...termApp,
      inTmux,
      tty,
      ...(tmuxInfo ? { tmux: tmuxInfo } : {}),
    };

    if (result.app !== "unknown") {
      terminalCache.set(pid, result);
    }
    return result;
  } catch {
    // On Windows, default to Windows Terminal even on failure
    if (isWindows) {
      return { ...WINDOWS_TERMINAL_INFO, inTmux: false, tty: "" };
    }
    return { ...UNKNOWN_TERMINAL, inTmux: false, tty: "" };
  }
}

/**
 * Return the display name for a TerminalApp value.
 */
export function getTerminalAppName(app: TerminalApp): string {
  for (const entry of Object.values(KNOWN_TERMINALS)) {
    if (entry.app === app) return entry.appName;
  }
  if (app === "windows-terminal") return "Windows Terminal";
  return app;
}
