"use client";

import { useState } from "react";
import useSWR from "swr";

interface AgentInfo {
  name: string;
  description: string;
  model: string | null;
  memory: string | null;
  memorySize: number | null;
  scope: "user" | "project";
  filePath: string;
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });

const modelColors: Record<string, { text: string; bg: string; border: string }> = {
  opus: { text: "text-orange-400", bg: "bg-orange-500/10", border: "border-orange-500/20" },
  sonnet: { text: "text-violet-400", bg: "bg-violet-500/10", border: "border-violet-500/20" },
  haiku: { text: "text-sky-400", bg: "bg-sky-500/10", border: "border-sky-500/20" },
};

function getModelStyle(model: string | null) {
  if (!model) return null;
  const key = model.toLowerCase();
  for (const [name, style] of Object.entries(modelColors)) {
    if (key.includes(name)) return { name, style };
  }
  return { name: model, style: { text: "text-zinc-400", bg: "bg-zinc-500/10", border: "border-zinc-500/20" } };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AgentsPanel() {
  const { data } = useSWR<{ agents: AgentInfo[] }>(
    "/api/agents",
    fetcher,
    {
      refreshInterval: 10000,
      revalidateOnFocus: false,
      keepPreviousData: true,
    },
  );

  const [collapsed, setCollapsed] = useState(false);
  const [launching, setLaunching] = useState<string | null>(null);

  const agents = data?.agents ?? [];

  async function handleLaunch(agentName: string) {
    setLaunching(agentName);
    try {
      await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "launch", agentName }),
      });
    } catch {
      // best effort
    } finally {
      setTimeout(() => setLaunching(null), 1500);
    }
  }

  if (agents.length === 0) {
    return null;
  }

  return (
    <section className="mt-8">
      {/* Section header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 mb-4 group cursor-pointer"
      >
        <svg
          className={`w-4 h-4 text-zinc-600 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider group-hover:text-zinc-300 transition-colors">
          Defined Agents
        </h2>
        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-zinc-800 text-zinc-500 border border-zinc-700/50">
          {agents.length}
        </span>
      </button>

      {!collapsed && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {agents.map((agent) => {
            const modelStyle = getModelStyle(agent.model);

            return (
              <div
                key={`${agent.scope}-${agent.name}`}
                className={`relative rounded-xl border bg-[#0a0a0f]/80 backdrop-blur-xs p-4 transition-all border-zinc-800/40 hover:border-zinc-700/60 ${
                  launching === agent.name ? "opacity-50 pointer-events-none" : ""
                }`}
              >
                <div className="relative">
                  {/* Header row */}
                  <div className="flex items-start justify-between mb-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold text-sm text-zinc-100 truncate">
                          {agent.name}
                        </h3>
                        {modelStyle && (
                          <span
                            className={`shrink-0 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider rounded-sm ${modelStyle.style.bg} border ${modelStyle.style.border} ${modelStyle.style.text}`}
                          >
                            {modelStyle.name}
                          </span>
                        )}
                        <span
                          className={`shrink-0 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider rounded-sm ${
                            agent.scope === "project"
                              ? "bg-amber-500/10 border border-amber-500/20 text-amber-400"
                              : "bg-zinc-500/10 border border-zinc-500/20 text-zinc-500"
                          }`}
                        >
                          {agent.scope}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Description */}
                  {agent.description && (
                    <p className="text-[12px] text-zinc-500 mb-3 line-clamp-2 leading-relaxed">
                      {agent.description}
                    </p>
                  )}

                  {/* Memory badge */}
                  {agent.memory && (
                    <div className="mb-3">
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-(family-name:--font-geist-mono) text-teal-400 bg-teal-500/8 border border-teal-500/15">
                        <svg
                          className="w-3 h-3"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125v-3.75"
                          />
                        </svg>
                        <span>memory: {agent.memory}</span>
                        {agent.memorySize !== null && (
                          <span className="text-zinc-600">({formatSize(agent.memorySize)})</span>
                        )}
                      </span>
                    </div>
                  )}

                  {/* Divider */}
                  <div className="h-px bg-white/4 mb-3" />

                  {/* Launch button */}
                  <div className="flex items-center">
                    <button
                      onClick={() => handleLaunch(agent.name)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-100 bg-white/4 hover:bg-white/8 border border-white/7 hover:border-white/15 transition-colors"
                    >
                      <svg
                        className="w-3.5 h-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z"
                        />
                      </svg>
                      {launching === agent.name ? "Launching..." : "Launch"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
