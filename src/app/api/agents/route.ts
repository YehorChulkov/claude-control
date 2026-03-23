import { NextRequest, NextResponse } from "next/server";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { isWindows, isMac } from "@/lib/platform";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

interface AgentInfo {
  name: string;
  description: string;
  model: string | null;
  memory: string | null;
  memorySize: number | null;
  scope: "user" | "project";
  filePath: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

async function getDirSize(dirPath: string): Promise<number> {
  let totalSize = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name);
      if (entry.isFile()) {
        const s = await stat(entryPath);
        totalSize += s.size;
      } else if (entry.isDirectory()) {
        totalSize += await getDirSize(entryPath);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  return totalSize;
}

async function readAgentsFromDir(
  dirPath: string,
  scope: "user" | "project",
): Promise<AgentInfo[]> {
  const agents: AgentInfo[] = [];

  let files: string[];
  try {
    files = (await readdir(dirPath)).filter((f) => f.endsWith(".md"));
  } catch {
    return agents;
  }

  for (const file of files) {
    const filePath = join(dirPath, file);
    try {
      const content = await readFile(filePath, "utf-8");
      const frontmatter = parseFrontmatter(content);

      const name = frontmatter.name || file.replace(/\.md$/, "");
      const description = frontmatter.description || "";
      const model = frontmatter.model || null;
      const memory = frontmatter.memory || null;

      let memorySize: number | null = null;
      if (memory) {
        const memoryDir = join(homedir(), ".claude", "agent-memory", name);
        const size = await getDirSize(memoryDir);
        memorySize = size > 0 ? size : null;
      }

      agents.push({
        name,
        description,
        model,
        memory,
        memorySize,
        scope,
        filePath,
      });
    } catch {
      // Skip files that can't be read
    }
  }

  return agents;
}

export async function GET() {
  const userAgentsDir = join(homedir(), ".claude", "agents");
  const projectAgentsDir = join(process.cwd(), ".claude", "agents");

  const [userAgents, projectAgents] = await Promise.all([
    readAgentsFromDir(userAgentsDir, "user"),
    readAgentsFromDir(projectAgentsDir, "project"),
  ]);

  // Merge, project-level agents override user-level if same name
  const agentMap = new Map<string, AgentInfo>();
  for (const agent of userAgents) {
    agentMap.set(agent.name, agent);
  }
  for (const agent of projectAgents) {
    agentMap.set(agent.name, agent);
  }

  return NextResponse.json({ agents: Array.from(agentMap.values()) });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, agentName } = body;

    if (action !== "launch") {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    if (!agentName || typeof agentName !== "string") {
      return NextResponse.json({ error: "agentName is required" }, { status: 400 });
    }

    if (isWindows) {
      await execFileAsync("wt.exe", [
        "-w", "0", "new-tab", "wsl", "--",
        "claude", "--agent", agentName, "--dangerously-skip-permissions",
      ], { timeout: 5000 });
    } else if (isMac) {
      const escapedName = agentName.replace(/'/g, "'\\''");
      await execFileAsync("osascript", ["-e",
        `tell application "Terminal"
  activate
  do script "claude --agent '${escapedName}' --dangerously-skip-permissions"
end tell`,
      ], { timeout: 5000 });
    } else {
      return NextResponse.json(
        { error: "Launch not supported on this platform" },
        { status: 400 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
