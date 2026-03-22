import { CLAUDE_PROJECTS_DIR } from "./constants";
import { join } from "path";
import { isWindows, resolveClaudeProjectsDir } from "./platform";

// Cached resolved projects dir for Windows (async initialization)
let _resolvedProjectsDir: string | null = null;
let _resolvedProjectsDirPromise: Promise<string> | null = null;

/**
 * Get the platform-appropriate Claude projects directory.
 * On macOS: returns CLAUDE_PROJECTS_DIR synchronously.
 * On Windows: resolves the WSL filesystem path (cached after first call).
 */
export async function getProjectsDir(): Promise<string> {
  if (!isWindows) return CLAUDE_PROJECTS_DIR;

  if (_resolvedProjectsDir) return _resolvedProjectsDir;

  if (!_resolvedProjectsDirPromise) {
    _resolvedProjectsDirPromise = resolveClaudeProjectsDir().then((dir) => {
      _resolvedProjectsDir = dir;
      return dir;
    });
  }

  return _resolvedProjectsDirPromise;
}

export function workingDirToEscapedPath(workingDir: string): string {
  return workingDir.replace(/\//g, "-");
}

export function escapedPathToProjectDir(escaped: string, baseDir?: string): string {
  return join(baseDir ?? CLAUDE_PROJECTS_DIR, escaped);
}

export function workingDirToProjectDir(workingDir: string, baseDir?: string): string {
  return escapedPathToProjectDir(workingDirToEscapedPath(workingDir), baseDir);
}

export function repoNameFromPath(workingDir: string): string {
  const parts = workingDir.split("/").filter(Boolean);
  return parts[parts.length - 1] || workingDir;
}
