# Claude Control

Electron + Next.js dashboard that discovers and monitors running Claude Code sessions in real time. Fork of claude-control (`github.com/YehorChulkov/claude-control`). Run it with `npm run electron:dev` (Next on :3200 + Electron).

## Cross-platform architecture — the part that bites

Session discovery has to work on macOS and on Windows-with-WSL, and the two platforms disagree about almost everything. `src/lib/platform.ts` is the abstraction layer: it detects the host and wraps commands with `wsl` where needed. Anything platform-conditional belongs there, not scattered through callers.

**WSL PIDs are offset by 10,000,000.** A WSL process and a native Windows process can hold the same PID number, so WSL PIDs are stored offset (`src/lib/terminal/detect.ts`, `src/lib/process-utils.ts`) and the offset is subtracted again before any command is sent *into* WSL. If you touch PID plumbing, keep the two spaces straight — a PID that crosses the boundary un-normalized silently addresses the wrong process.

**Working-directory resolution differs by platform.** macOS/Linux read cwd from `lsof` (batched — one call for many PIDs, `process-utils.ts`). Windows has no `lsof` equivalent, so `getWindowsWorkingDirectories()` reverse-maps instead: scan recently-modified JSONL session files under the Claude projects dir and read the cwd out of their content. The Windows path is inference, not truth — it can lag or miss.

**Process tree:** `buildProcessTree()` in `src/lib/terminal/detect.ts` — PowerShell on Windows, `ps` on macOS.

## Hook events

Status detection is driven by Claude Code hooks, installed by `src/lib/hooks-installer.ts` into `~/.claude-control/hooks/` — `.sh` on macOS, `.ps1` on Windows (same payload, two languages; change both or the platforms drift).

Each event is written to `~/.claude-control/events/<pid>.json`, so the **filename carries the PID** and the **body carries `session_id`** (plus `event`, `cwd`, `transcript_path`, `ts`). That double keying is deliberate: it's what maps a live process to its JSONL transcript authoritatively, instead of guessing by mtime.
