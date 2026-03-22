import { CLAUDE_PROJECTS_DIR } from "./constants";
import { join, sep } from "path";
import { isWindows } from "./platform";

/**
 * Get the Claude projects directory. Always uses native paths.
 */
export function getProjectsDir(): string {
  return CLAUDE_PROJECTS_DIR;
}

export function workingDirToEscapedPath(workingDir: string): string {
  if (isWindows) {
    // On Windows: "C:\Users\yegor" → "C--Users-yegor"
    // Replace both : and path separators with -
    return workingDir.replace(/[:\\/]/g, "-");
  }
  return workingDir.replace(/\//g, "-");
}

export function escapedPathToProjectDir(escaped: string, baseDir?: string): string {
  return join(baseDir ?? CLAUDE_PROJECTS_DIR, escaped);
}

export function workingDirToProjectDir(workingDir: string, baseDir?: string): string {
  return escapedPathToProjectDir(workingDirToEscapedPath(workingDir), baseDir);
}

export function repoNameFromPath(workingDir: string): string {
  const parts = workingDir.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || workingDir;
}
