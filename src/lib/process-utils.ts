import { execFile } from "child_process";
import { promisify } from "util";
import { readdir, stat, open } from "fs/promises";
import { join } from "path";
import type { ProcessTreeEntry } from "./terminal/types";
import { PROCESS_TIMEOUT_MS } from "./constants";
import { isWindows, resolveClaudeProjectsDir, wslExecArgs } from "./platform";
import { isWslProcess } from "./terminal/detect";

const execFileAsync = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  workingDirectory: string | null;
  cpuPercent: number;
}

/**
 * Get working directories for multiple PIDs in a single `lsof` call (macOS/Linux).
 */
export async function getBatchWorkingDirectories(pids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;

  if (isWindows) {
    // Split PIDs into native Windows and WSL
    const nativePids = pids.filter((p) => !isWslProcess(p));
    const wslPidList = pids.filter((p) => isWslProcess(p));

    // Get CWDs for native Windows processes by scanning JSONL files
    const nativeResult = await getWindowsCwds(nativePids);

    // Get CWDs for WSL processes via wsl lsof
    if (wslPidList.length > 0) {
      try {
        const realPids = wslPidList.map((p) => p - 10_000_000);
        const { command: cmd, args: cmdArgs } = wslExecArgs(
          "lsof",
          ["-p", realPids.join(","), "-Fpn", "-d", "cwd"],
        );
        const { stdout } = await execFileAsync(cmd, cmdArgs, { timeout: PROCESS_TIMEOUT_MS });
        let currentPid: number | null = null;
        for (const line of stdout.split("\n")) {
          if (line.startsWith("p")) {
            currentPid = parseInt(line.slice(1), 10) + 10_000_000; // Add offset back
          } else if (line.startsWith("n") && currentPid !== null) {
            nativeResult.set(currentPid, line.slice(1));
            currentPid = null;
          }
        }
      } catch {
        /* WSL lsof failed — ignore */
      }
    }

    return nativeResult;
  }

  try {
    const { stdout } = await execFileAsync("lsof", ["-p", pids.join(","), "-Fpn", "-d", "cwd"], {
      timeout: PROCESS_TIMEOUT_MS,
    });
    let currentPid: number | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) {
        currentPid = parseInt(line.slice(1), 10);
      } else if (line.startsWith("n") && currentPid !== null) {
        result.set(currentPid, line.slice(1));
        currentPid = null;
      }
    }
  } catch {
    /* ignore -- PIDs may have exited */
  }
  return result;
}

/**
 * Get working directories for Windows processes by scanning JSONL files.
 * Since Windows has no `lsof`, we reverse-map project directories and
 * check recently modified JSONL files for CWD info.
 */
async function getWindowsCwds(pids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;

  const projectsDir = resolveClaudeProjectsDir();
  const unmatched = new Set(pids);

  try {
    const projectDirs = await readdir(projectsDir);

    for (const dir of projectDirs) {
      if (unmatched.size === 0) break;

      const dirPath = join(projectsDir, dir);
      let dirStat;
      try {
        dirStat = await stat(dirPath);
        if (!dirStat.isDirectory()) continue;
      } catch {
        continue;
      }

      // Reverse-map the escaped directory name to a working directory
      // Windows: "C--Users-yegor" → "C:\Users\yegor" (replace first -- with :\, then - with \)
      let workingDir: string;
      const winMatch = dir.match(/^([A-Za-z])--(.*)$/);
      if (winMatch) {
        workingDir = `${winMatch[1]}:\\${winMatch[2].replace(/-/g, "\\")}`;
      } else {
        workingDir = dir.replace(/-/g, "/"); // Unix-style fallback
      }

      // Check if any JSONL in this dir was recently modified
      let entries: string[];
      try {
        entries = (await readdir(dirPath)).filter((e) => e.endsWith(".jsonl"));
      } catch {
        continue;
      }

      // Find the most recently modified JSONL
      let latestMtime = 0;
      for (const jsonlFile of entries) {
        try {
          const fileStat = await stat(join(dirPath, jsonlFile));
          if (fileStat.mtimeMs > latestMtime) {
            latestMtime = fileStat.mtimeMs;
          }
        } catch {
          continue;
        }
      }

      // If modified within last 2 minutes, likely an active session
      if (Date.now() - latestMtime < 2 * 60 * 1000) {
        for (const pid of unmatched) {
          result.set(pid, workingDir);
          unmatched.delete(pid);
          break; // One PID per active project dir
        }
      }
    }
  } catch {
    // projects dir doesn't exist
  }

  return result;
}

/**
 * Build ProcessInfo for all given PIDs using the process tree + cwd resolution.
 */
export async function getAllProcessInfos(
  pids: number[],
  processTree: Map<number, ProcessTreeEntry>,
): Promise<ProcessInfo[]> {
  if (pids.length === 0) return [];

  const cwds = await getBatchWorkingDirectories(pids);

  const results: ProcessInfo[] = [];
  for (const pid of pids) {
    const entry = processTree.get(pid);
    if (!entry) {
      // On Windows, the process tree might not contain native processes
      // if they were found via PowerShell instead of ps
      if (isWindows) {
        results.push({
          pid,
          workingDirectory: cwds.get(pid) ?? null,
          cpuPercent: 0,
        });
        continue;
      }
      continue;
    }

    results.push({
      pid,
      workingDirectory: cwds.get(pid) ?? null,
      cpuPercent: entry.cpuPercent,
    });
  }
  return results;
}
