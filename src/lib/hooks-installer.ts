import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir, chmod, access } from "fs/promises";
import { constants } from "fs";
import { isWindows, execWsl, resolveWslHomedir } from "./platform";

// Native paths (macOS/Linux)
const NATIVE_HOME = homedir();
const NATIVE_CLAUDE_SETTINGS_PATH = join(NATIVE_HOME, ".claude", "settings.json");
const NATIVE_HOOKS_DIR = join(NATIVE_HOME, ".claude-control", "hooks");
const NATIVE_EVENTS_DIR = join(NATIVE_HOME, ".claude-control", "events");
const NATIVE_HOOK_SCRIPT_PATH = join(NATIVE_HOOKS_DIR, "status-hook.sh");

// WSL paths (used in the hook script itself, which runs inside WSL)
// These are resolved dynamically on Windows
let _wslEventsDir: string | null = null;
let _wslHooksDir: string | null = null;
let _wslHookScriptPath: string | null = null;
let _wslSettingsPath: string | null = null;
// Windows UNC paths for file I/O from the Electron side
let _winHooksDir: string | null = null;
let _winEventsDir: string | null = null;
let _winHookScriptPath: string | null = null;
let _winSettingsPath: string | null = null;
let _pathsResolved = false;

async function resolvePaths(): Promise<void> {
  if (_pathsResolved) return;

  if (!isWindows) {
    _pathsResolved = true;
    return;
  }

  // Get WSL home directory
  const winHome = await resolveWslHomedir();

  // Windows UNC paths (for Node.js file I/O)
  _winHooksDir = join(winHome, ".claude-control", "hooks");
  _winEventsDir = join(winHome, ".claude-control", "events");
  _winHookScriptPath = join(_winHooksDir, "status-hook.sh");
  _winSettingsPath = join(winHome, ".claude", "settings.json");

  // WSL-native paths (for the hook script content and settings.json hook references)
  try {
    const { stdout } = await execWsl("bash", ["-c", 'echo "$HOME"'], { timeout: 5000 });
    const wslHome = stdout.trim();
    _wslHooksDir = `${wslHome}/.claude-control/hooks`;
    _wslEventsDir = `${wslHome}/.claude-control/events`;
    _wslHookScriptPath = `${_wslHooksDir}/status-hook.sh`;
    _wslSettingsPath = `${wslHome}/.claude/settings.json`;
  } catch {
    // Fallback
    _wslHooksDir = "/home/user/.claude-control/hooks";
    _wslEventsDir = "/home/user/.claude-control/events";
    _wslHookScriptPath = `${_wslHooksDir}/status-hook.sh`;
    _wslSettingsPath = "/home/user/.claude/settings.json";
  }

  _pathsResolved = true;
}

function getClaudeSettingsPath(): string {
  return isWindows && _winSettingsPath ? _winSettingsPath : NATIVE_CLAUDE_SETTINGS_PATH;
}

function getHooksDir(): string {
  return isWindows && _winHooksDir ? _winHooksDir : NATIVE_HOOKS_DIR;
}

function getEventsDir(): string {
  return isWindows && _winEventsDir ? _winEventsDir : NATIVE_EVENTS_DIR;
}

function getHookScriptPath(): string {
  return isWindows && _winHookScriptPath ? _winHookScriptPath : NATIVE_HOOK_SCRIPT_PATH;
}

/**
 * The hook script path as it should appear in settings.json (WSL-native path on Windows).
 */
function getHookScriptPathForSettings(): string {
  return isWindows && _wslHookScriptPath ? _wslHookScriptPath : NATIVE_HOOK_SCRIPT_PATH;
}

function buildHookScript(): string {
  // The events dir must be a WSL-native path since the script runs inside WSL
  const eventsDir = isWindows && _wslEventsDir ? _wslEventsDir : NATIVE_EVENTS_DIR;

  return `#!/bin/bash
# claude-control status hook -- writes session events for real-time status detection
set -e

EVENTS_DIR="${eventsDir}"
mkdir -p "$EVENTS_DIR"

# Read JSON from stdin
INPUT=$(cat)

# Extract fields using grep/sed (no jq dependency)
HOOK_EVENT=$(echo "$INPUT" | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\\([^"]*\\)"$/\\1/')
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\\([^"]*\\)"$/\\1/')
CWD=$(echo "$INPUT" | grep -o '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\\([^"]*\\)"$/\\1/')
TRANSCRIPT=$(echo "$INPUT" | grep -o '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\\([^"]*\\)"$/\\1/')

if [ -z "$SESSION_ID" ] || [ -z "$HOOK_EVENT" ]; then
  exit 0
fi

TS=$(date +%s)

# $PPID = Claude process that invoked this hook (keys the event file by PID)
echo "{\\"event\\":\\"$HOOK_EVENT\\",\\"session_id\\":\\"$SESSION_ID\\",\\"cwd\\":\\"$CWD\\",\\"transcript_path\\":\\"$TRANSCRIPT\\",\\"ts\\":$TS}" > "$EVENTS_DIR/$PPID.json"
`;
}

const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "Stop",
  "UserPromptSubmit",
  "PermissionRequest",
  "SubagentStart",
  "PostToolUseFailure",
] as const;

let installed: boolean | null = null;

export async function ensureHooksInstalled(): Promise<boolean> {
  if (installed !== null) return installed;

  try {
    await resolvePaths();

    const claudeSettingsPath = getClaudeSettingsPath();
    const hooksDir = getHooksDir();
    const eventsDir = getEventsDir();
    const hookScriptPath = getHookScriptPath();
    const hookScriptPathForSettings = getHookScriptPathForSettings();

    // Create directories
    await mkdir(hooksDir, { recursive: true });
    await mkdir(eventsDir, { recursive: true });

    // Write hook script
    const hookScript = buildHookScript();
    await writeFile(hookScriptPath, hookScript, "utf-8");

    // On Windows, chmod via WSL since UNC paths don't support Unix permissions
    if (isWindows && _wslHookScriptPath) {
      try {
        await execWsl("chmod", ["755", _wslHookScriptPath], { timeout: 5000 });
      } catch {
        // Best effort
      }
    } else {
      await chmod(hookScriptPath, 0o755);
    }

    // Read existing settings
    let settings: Record<string, unknown> = {};
    try {
      const raw = await readFile(claudeSettingsPath, "utf-8");
      settings = JSON.parse(raw);
    } catch {
      // No settings file or invalid JSON -- start fresh
    }

    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    let changed = false;

    for (const event of HOOK_EVENTS) {
      const existing = hooks[event] ?? [];
      // Check if our hook is already registered (check both native and WSL paths)
      const alreadyRegistered = (existing as Array<{ hooks?: Array<{ command?: string }> }>).some((entry) =>
        entry.hooks?.some((h) => h.command === hookScriptPathForSettings),
      );

      if (!alreadyRegistered) {
        const matcher = event === "PostToolUseFailure" ? "Bash" : "";
        const newEntry = {
          matcher,
          hooks: [
            {
              type: "command",
              command: hookScriptPathForSettings,
              timeout: 5,
              async: true,
            },
          ],
        };
        hooks[event] = [...(existing as unknown[]), newEntry];
        changed = true;
      }
    }

    if (changed) {
      // Verify settings.json is writable before attempting write
      try {
        await access(claudeSettingsPath, constants.W_OK);
      } catch {
        console.warn("claude-control: settings.json is not writable, hooks not installed");
        installed = false;
        return false;
      }

      settings.hooks = hooks;
      await writeFile(claudeSettingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    }

    installed = true;
    return true;
  } catch (error) {
    console.warn("claude-control: failed to install hooks:", error);
    installed = false;
    return false;
  }
}

export function areHooksInstalled(): boolean {
  return installed === true;
}
