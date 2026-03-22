import { execFile } from "child_process";
import { promisify } from "util";
import { homedir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

/**
 * Platform detection and helpers for Windows/WSL support.
 *
 * On macOS: all commands run natively.
 * On Windows: Claude Code runs inside WSL, so shell commands (ps, lsof, tmux)
 * must be prefixed with `wsl`. JSONL/config files in WSL are accessible via
 * `\\wsl.localhost\<distro>\...` paths from Windows.
 */

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";

// Cached WSL distro name (detected lazily)
let _wslDistro: string | null = null;
let _wslDistroDetected = false;

/**
 * Detect the default WSL distro name. Cached after first call.
 * Returns null if WSL is not available or no distro is installed.
 */
export async function getWslDistro(): Promise<string | null> {
  if (_wslDistroDetected) return _wslDistro;
  _wslDistroDetected = true;

  if (!isWindows) {
    _wslDistro = null;
    return null;
  }

  try {
    // `wsl -l -v` outputs UTF-16LE on Windows; `wsl -l --quiet` is simpler
    const { stdout } = await execFileAsync("wsl", ["-l", "--quiet"], {
      timeout: 5000,
      // wsl -l outputs UTF-16LE; Node handles it as a buffer
    });
    // Remove null bytes (UTF-16LE artifact) and pick first non-empty line
    const cleaned = stdout.replace(/\0/g, "").trim();
    const lines = cleaned.split(/\r?\n/).filter(Boolean);
    // The default distro is the first one listed
    _wslDistro = lines[0]?.trim() || null;
    return _wslDistro;
  } catch {
    _wslDistro = null;
    return null;
  }
}

/**
 * Execute a command, optionally through WSL on Windows.
 * On macOS, runs the command directly.
 * On Windows, wraps with `wsl --` prefix.
 *
 * Returns { command, args } suitable for execFileAsync.
 */
export function wslExecArgs(command: string, args: string[]): { command: string; args: string[] } {
  if (!isWindows) {
    return { command, args };
  }
  return { command: "wsl", args: ["--", command, ...args] };
}

/**
 * Execute a command through WSL (on Windows) or directly (on macOS).
 * Convenience wrapper around execFileAsync with wslExecArgs.
 */
export async function execWsl(
  command: string,
  args: string[],
  options: { timeout?: number; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { command: cmd, args: cmdArgs } = wslExecArgs(command, args);
  return execFileAsync(cmd, cmdArgs, { ...options, encoding: "utf-8" });
}

/**
 * Convert a WSL path to a Windows-accessible UNC path.
 * e.g. /home/user/.claude/projects → \\wsl.localhost\Ubuntu\home\user\.claude\projects
 */
export async function wslToWindowsPath(wslPath: string): Promise<string> {
  const distro = await getWslDistro();
  if (!distro) {
    throw new Error("No WSL distro detected");
  }
  // Replace forward slashes with backslashes and prepend UNC prefix
  const winSubPath = wslPath.replace(/\//g, "\\");
  return `\\\\wsl.localhost\\${distro}${winSubPath}`;
}

/**
 * Convert a Windows UNC path (\\wsl.localhost\Distro\...) back to a WSL path.
 */
export function windowsToWslPath(winPath: string): string {
  // Match \\wsl.localhost\<distro>\<rest>
  const match = winPath.match(/^\\\\wsl\.localhost\\[^\\]+\\(.*)$/i);
  if (!match) return winPath;
  return "/" + match[1].replace(/\\/g, "/");
}

/**
 * Resolve the Claude projects directory.
 * On macOS: ~/.claude/projects (native path)
 * On Windows: \\wsl.localhost\<distro>\home\<user>\.claude\projects (UNC path readable by Node.js)
 */
export async function resolveClaudeProjectsDir(): Promise<string> {
  if (!isWindows) {
    return join(homedir(), ".claude", "projects");
  }
  // On Windows, Claude Code runs in WSL, so the projects dir is in the WSL filesystem.
  // We need to find the WSL home directory.
  try {
    const { stdout } = await execWsl("bash", ["-c", 'echo "$HOME"'], { timeout: 5000 });
    const wslHome = stdout.trim();
    return await wslToWindowsPath(join(wslHome, ".claude", "projects").replace(/\\/g, "/"));
  } catch {
    // Fallback: assume Ubuntu default
    return `\\\\wsl.localhost\\Ubuntu\\home\\${process.env.USER || "user"}\\.claude\\projects`;
  }
}

/**
 * Resolve the WSL home directory path as a Windows UNC path.
 * On macOS: returns native homedir.
 */
export async function resolveWslHomedir(): Promise<string> {
  if (!isWindows) {
    return homedir();
  }
  try {
    const { stdout } = await execWsl("bash", ["-c", 'echo "$HOME"'], { timeout: 5000 });
    const wslHome = stdout.trim();
    return await wslToWindowsPath(wslHome);
  } catch {
    return homedir();
  }
}

/**
 * Resolve the ~/.claude-control directory.
 * On Windows, this is in the WSL filesystem since hooks run inside WSL.
 */
export async function resolveClaudeControlDir(): Promise<string> {
  if (!isWindows) {
    return join(homedir(), ".claude-control");
  }
  try {
    const { stdout } = await execWsl("bash", ["-c", 'echo "$HOME"'], { timeout: 5000 });
    const wslHome = stdout.trim();
    return await wslToWindowsPath(wslHome + "/.claude-control");
  } catch {
    return join(homedir(), ".claude-control");
  }
}

/**
 * Check if WSL is available and has at least one distro.
 * Returns an error message if not available, null if OK.
 */
export async function checkWslAvailability(): Promise<string | null> {
  if (!isWindows) return null;

  const distro = await getWslDistro();
  if (!distro) {
    return "WSL is not installed or no Linux distribution is available. Claude Control requires WSL with a Linux distribution to monitor Claude Code sessions.";
  }
  return null;
}
