import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir, chmod, access } from "fs/promises";
import { constants } from "fs";
import { isWindows } from "./platform";

const HOME = homedir();
const CLAUDE_SETTINGS_PATH = join(HOME, ".claude", "settings.json");
const HOOKS_DIR = join(HOME, ".claude-control", "hooks");
const EVENTS_DIR = join(HOME, ".claude-control", "events");

// On Windows, use a PowerShell script; on macOS/Linux, use bash
const HOOK_SCRIPT_NAME = isWindows ? "status-hook.ps1" : "status-hook.sh";
const HOOK_SCRIPT_PATH = join(HOOKS_DIR, HOOK_SCRIPT_NAME);

// The command registered in settings.json
const HOOK_COMMAND = isWindows
  ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${HOOK_SCRIPT_PATH}"`
  : HOOK_SCRIPT_PATH;

function buildBashHookScript(): string {
  return `#!/bin/bash
# claude-control status hook -- writes session events for real-time status detection
set -e

EVENTS_DIR="${EVENTS_DIR}"
mkdir -p "$EVENTS_DIR"

INPUT=$(cat)

HOOK_EVENT=$(echo "$INPUT" | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\\([^"]*\\)"$/\\1/')
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\\([^"]*\\)"$/\\1/')
CWD=$(echo "$INPUT" | grep -o '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\\([^"]*\\)"$/\\1/')
TRANSCRIPT=$(echo "$INPUT" | grep -o '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\\([^"]*\\)"$/\\1/')

if [ -z "$SESSION_ID" ] || [ -z "$HOOK_EVENT" ]; then
  exit 0
fi

TS=$(date +%s)

echo "{\\"event\\":\\"$HOOK_EVENT\\",\\"session_id\\":\\"$SESSION_ID\\",\\"cwd\\":\\"$CWD\\",\\"transcript_path\\":\\"$TRANSCRIPT\\",\\"ts\\":$TS}" > "$EVENTS_DIR/$PPID.json"
`;
}

function buildPowerShellHookScript(): string {
  // PowerShell script that reads JSON from stdin and writes event file
  // Use native PowerShell path separators
  const eventsDir = EVENTS_DIR.replace(/\\/g, "\\\\");
  return `# claude-control status hook -- writes session events for real-time status detection
$ErrorActionPreference = "Stop"

$eventsDir = "${eventsDir}"
if (-not (Test-Path $eventsDir)) { New-Item -ItemType Directory -Path $eventsDir -Force | Out-Null }

$input_text = [Console]::In.ReadToEnd()

try {
    $data = $input_text | ConvertFrom-Json
} catch {
    exit 0
}

$hookEvent = $data.hook_event_name
$sessionId = $data.session_id
$cwd = $data.cwd
$transcript = $data.transcript_path

if (-not $sessionId -or -not $hookEvent) { exit 0 }

$ts = [int][double]::Parse((Get-Date -UFormat %s))
$ppid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId

$json = @"
{"event":"$hookEvent","session_id":"$sessionId","cwd":"$($cwd -replace '\\\\','\\\\\\\\')","transcript_path":"$($transcript -replace '\\\\','\\\\\\\\')","ts":$ts}
"@

$json | Out-File -FilePath "$eventsDir\\$ppid.json" -Encoding utf8 -NoNewline
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
    // Create directories
    await mkdir(HOOKS_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });

    // Write hook script (platform-specific)
    const hookScript = isWindows ? buildPowerShellHookScript() : buildBashHookScript();
    await writeFile(HOOK_SCRIPT_PATH, hookScript, "utf-8");

    if (!isWindows) {
      await chmod(HOOK_SCRIPT_PATH, 0o755);
    }

    // Read existing settings
    let settings: Record<string, unknown> = {};
    try {
      const raw = await readFile(CLAUDE_SETTINGS_PATH, "utf-8");
      settings = JSON.parse(raw);
    } catch {
      // No settings file or invalid JSON -- start fresh
    }

    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    let changed = false;

    for (const event of HOOK_EVENTS) {
      const existing = hooks[event] ?? [];
      const alreadyRegistered = (existing as Array<{ hooks?: Array<{ command?: string }> }>).some((entry) =>
        entry.hooks?.some((h) => h.command === HOOK_COMMAND),
      );

      if (!alreadyRegistered) {
        const matcher = event === "PostToolUseFailure" ? "Bash" : "";
        const newEntry = {
          matcher,
          hooks: [
            {
              type: "command",
              command: HOOK_COMMAND,
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
      try {
        await access(CLAUDE_SETTINGS_PATH, constants.W_OK);
      } catch {
        console.warn("claude-control: settings.json is not writable, hooks not installed");
        installed = false;
        return false;
      }

      settings.hooks = hooks;
      await writeFile(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
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
