import { execFile } from "child_process";
import { promisify } from "util";
import { homedir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

/**
 * Platform detection and helpers for Windows support.
 *
 * On macOS: all commands run natively, files in ~/.claude/.
 * On Windows: Claude Code runs natively as claude.exe, files in %USERPROFILE%\.claude\.
 *   Optionally, sessions may also run inside WSL.
 */

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";

// ────────────────────────────────────────────────────────────────────────────
// WSL helpers (optional — for future WSL session discovery)
// ────────────────────────────────────────────────────────────────────────────

let _wslDistro: string | null = null;
let _wslDistroDetected = false;

export async function getWslDistro(): Promise<string | null> {
  if (_wslDistroDetected) return _wslDistro;
  _wslDistroDetected = true;

  if (!isWindows) {
    _wslDistro = null;
    return null;
  }

  try {
    const { stdout } = await execFileAsync("wsl", ["-l", "--quiet"], { timeout: 5000 });
    const cleaned = stdout.replace(/\0/g, "").trim();
    const lines = cleaned.split(/\r?\n/).filter(Boolean);
    _wslDistro = lines[0]?.trim() || null;
    return _wslDistro;
  } catch {
    _wslDistro = null;
    return null;
  }
}

export function wslExecArgs(command: string, args: string[]): { command: string; args: string[] } {
  if (!isWindows) {
    return { command, args };
  }
  return { command: "wsl", args: ["--", command, ...args] };
}

export async function execWsl(
  command: string,
  args: string[],
  options: { timeout?: number; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { command: cmd, args: cmdArgs } = wslExecArgs(command, args);
  return execFileAsync(cmd, cmdArgs, { ...options, encoding: "utf-8" });
}

export async function wslToWindowsPath(wslPath: string): Promise<string> {
  const distro = await getWslDistro();
  if (!distro) throw new Error("No WSL distro detected");
  const winSubPath = wslPath.replace(/\//g, "\\");
  return `\\\\wsl.localhost\\${distro}${winSubPath}`;
}

export function windowsToWslPath(winPath: string): string {
  const match = winPath.match(/^\\\\wsl\.localhost\\[^\\]+\\(.*)$/i);
  if (!match) return winPath;
  return "/" + match[1].replace(/\\/g, "/");
}

// ────────────────────────────────────────────────────────────────────────────
// Path resolution — uses NATIVE paths on all platforms
// ────────────────────────────────────────────────────────────────────────────

/**
 * Claude projects directory. On all platforms, this is the native homedir.
 * On Windows: C:\Users\<user>\.claude\projects
 * On macOS:   /Users/<user>/.claude/projects
 */
export function resolveClaudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/**
 * Claude Control directory for hooks/events.
 * On all platforms, this is in the native homedir since Claude Code
 * runs natively on the same OS.
 */
export function resolveClaudeControlDir(): string {
  return join(homedir(), ".claude-control");
}

/**
 * Resolve WSL Claude projects directory as a Windows UNC path.
 * Returns null if WSL is not available.
 */
let _wslProjectsDir: string | null | undefined = undefined;
export async function resolveWslClaudeProjectsDir(): Promise<string | null> {
  if (!isWindows) return null;
  if (_wslProjectsDir !== undefined) return _wslProjectsDir;

  try {
    const { stdout } = await execWsl("bash", ["-c", 'echo "$HOME"'], { timeout: 5000 });
    const wslHome = stdout.trim();
    _wslProjectsDir = await wslToWindowsPath(wslHome + "/.claude/projects");
    return _wslProjectsDir;
  } catch {
    _wslProjectsDir = null;
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Native Windows process discovery
// ────────────────────────────────────────────────────────────────────────────

export interface WindowsProcessInfo {
  pid: number;
  parentPid: number;
  name: string;
  cpuPercent: number;
}

/**
 * Find all claude.exe processes on Windows using tasklist + wmic.
 * Returns process info including PID and parent PID.
 */
export async function findWindowsClaudeProcesses(): Promise<WindowsProcessInfo[]> {
  if (!isWindows) return [];

  try {
    // Use wmic to get PID, ParentProcessId, and Name for claude.exe
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }`,
      ],
      { timeout: 10000 },
    );

    const results: WindowsProcessInfo[] = [];
    for (const line of stdout.trim().split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.trim().split("|");
      if (parts.length >= 3) {
        results.push({
          pid: parseInt(parts[0], 10),
          parentPid: parseInt(parts[1], 10),
          name: parts[2],
          cpuPercent: 0, // CPU% not easily available from WMI snapshot
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Get working directories for Windows processes.
 * Uses the Claude project directory structure to reverse-map:
 * reads each JSONL file's content to find the CWD field.
 *
 * On Windows, there's no `lsof` equivalent for getting process CWD,
 * so we scan recently-modified JSONL files and extract CWD from them.
 */
export async function getWindowsWorkingDirectories(
  pids: number[],
): Promise<Map<number, string>> {
  if (!isWindows || pids.length === 0) return new Map();

  const { readdir, stat, open } = await import("fs/promises");
  const projectsDir = resolveClaudeProjectsDir();
  const result = new Map<number, string>();
  const pidSet = new Set(pids);

  try {
    const projectDirs = await readdir(projectsDir);

    for (const dir of projectDirs) {
      const dirPath = join(projectsDir, dir);
      try {
        const dirStat = await stat(dirPath);
        if (!dirStat.isDirectory()) continue;
      } catch {
        continue;
      }

      // Read JSONL files in this project directory
      let entries: string[];
      try {
        entries = (await readdir(dirPath)).filter((e) => e.endsWith(".jsonl"));
      } catch {
        continue;
      }

      for (const jsonlFile of entries) {
        const filePath = join(dirPath, jsonlFile);
        try {
          const fileStat = await stat(filePath);
          // Only check recently modified files (within last 5 minutes)
          if (Date.now() - fileStat.mtimeMs > 5 * 60 * 1000) continue;

          // Read last chunk of the file to find PID references
          const fileHandle = await open(filePath, "r");
          try {
            const chunkSize = Math.min(fileStat.size, 8192);
            const buffer = Buffer.alloc(chunkSize);
            await fileHandle.read(buffer, 0, chunkSize, fileStat.size - chunkSize);
            const content = buffer.toString("utf-8");

            // Look for "cwd" field in the last lines
            const lines = content.split("\n").filter(Boolean);
            for (const line of lines.reverse()) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.cwd && pidSet.has(0)) {
                  // Can't directly match PID to file, but if the file is active,
                  // use the CWD from it
                }
                // Check if sessionId matches and extract CWD
                if (parsed.cwd) {
                  // Reverse-map the directory name to a working directory
                  const cwd = parsed.cwd;
                  // Assign to any unmatched PID (best effort without hooks)
                  for (const pid of pids) {
                    if (!result.has(pid)) {
                      result.set(pid, cwd);
                      break;
                    }
                  }
                  break;
                }
              } catch {
                // Not valid JSON, skip
              }
            }
          } finally {
            await fileHandle.close();
          }
        } catch {
          continue;
        }
      }
    }
  } catch {
    // projects dir doesn't exist yet
  }

  return result;
}

/**
 * Reverse-map an escaped project directory name back to a working directory path.
 * On Windows: "C--Users-yegor" → "C:/Users/yegor"
 * On macOS/Linux: "-Users-yehor" → "/Users/yehor"
 */
export function escapedPathToWorkingDir(escaped: string): string {
  if (isWindows) {
    // Windows paths: "C--Users-yegor-project" → "C:/Users/yegor/project"
    // First char is drive letter, "--" is ":/", remaining "-" are "/"
    // But we need to be careful: "C--Users-yegor" means C:/Users/yegor
    const match = escaped.match(/^([A-Za-z])--(.*)$/);
    if (match) {
      const drive = match[1];
      const rest = match[2].replace(/-/g, "/");
      return `${drive}:/${rest}`;
    }
  }
  // Unix paths: "-Users-yehor" → "/Users/yehor"
  return escaped.replace(/-/g, "/");
}

export async function checkWslAvailability(): Promise<string | null> {
  if (!isWindows) return null;
  const distro = await getWslDistro();
  if (!distro) {
    return "WSL is not available. Some features (tmux integration) require WSL.";
  }
  return null;
}
