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
 * Since Windows has no `lsof`, we reverse-map project directories,
 * sort by most recently modified JSONL, and assign to PIDs.
 */
async function getWindowsCwds(pids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;

  const projectsDir = resolveClaudeProjectsDir();

  // Collect all project dirs with their latest JSONL mtime
  const candidates: { workingDir: string; latestMtime: number }[] = [];

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

      // Reverse-map the escaped directory name to a working directory
      // Windows: "C--Users-yegor" → "C:\Users\yegor"
      let workingDir: string;
      const winMatch = dir.match(/^([A-Za-z])--(.*)$/);
      if (winMatch) {
        workingDir = `${winMatch[1]}:\\${winMatch[2].replace(/-/g, "\\")}`;
      } else {
        workingDir = dir.replace(/-/g, "/");
      }

      // Find the most recently modified JSONL in this dir
      let entries: string[];
      try {
        entries = (await readdir(dirPath)).filter((e) => e.endsWith(".jsonl"));
      } catch {
        continue;
      }

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

      if (latestMtime > 0) {
        candidates.push({ workingDir, latestMtime });
      }
    }
  } catch {
    // projects dir doesn't exist
  }

  // Sort by most recent first and assign to PIDs
  candidates.sort((a, b) => b.latestMtime - a.latestMtime);

  const unmatched = [...pids];
  for (const candidate of candidates) {
    if (unmatched.length === 0) break;
    const pid = unmatched.shift()!;
    result.set(pid, candidate.workingDir);
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
