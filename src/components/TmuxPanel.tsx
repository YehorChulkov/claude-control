"use client";

import { useState } from "react";
import useSWR from "swr";

interface TmuxPaneDetail {
  paneId: string;
  command: string;
  pid: number;
}

interface TmuxSessionInfo {
  name: string;
  windows: number;
  attached: boolean;
  panes: TmuxPaneDetail[];
  hasClaudeRunning: boolean;
  remote?: string;
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });

export function TmuxPanel() {
  const { data, mutate } = useSWR<{ sessions: TmuxSessionInfo[] }>(
    "/api/tmux/sessions",
    fetcher,
    {
      refreshInterval: 2000,
      revalidateOnFocus: false,
      keepPreviousData: true,
    },
  );

  const [collapsed, setCollapsed] = useState(false);
  const [killConfirm, setKillConfirm] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const sessions = data?.sessions ?? [];

  async function handleAction(action: "attach" | "kill", sessionName: string, remote?: string) {
    if (action === "kill" && killConfirm !== sessionName) {
      setKillConfirm(sessionName);
      setTimeout(() => setKillConfirm((prev) => (prev === sessionName ? null : prev)), 4000);
      return;
    }

    setActionInProgress(sessionName);
    setKillConfirm(null);

    try {
      await fetch("/api/tmux/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, sessionName, ...(remote ? { remote } : {}) }),
      });
      if (action === "kill") {
        mutate();
      }
    } catch {
      // best effort
    } finally {
      setActionInProgress(null);
    }
  }

  if (sessions.length === 0) {
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
          Tmux Sessions
        </h2>
        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-zinc-800 text-zinc-500 border border-zinc-700/50">
          {sessions.length}
        </span>
      </button>

      {!collapsed && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {sessions.map((session) => (
            <div
              key={session.name}
              className={`relative rounded-xl border bg-[#0a0a0f]/80 backdrop-blur-xs p-4 transition-all ${
                session.hasClaudeRunning
                  ? "border-emerald-500/20 hover:border-emerald-500/40"
                  : "border-zinc-800/40 hover:border-zinc-700/60"
              } ${actionInProgress === session.name ? "opacity-50 pointer-events-none" : ""}`}
            >
              {/* Gradient accent for claude sessions */}
              {session.hasClaudeRunning && (
                <div className="absolute inset-x-0 top-0 h-16 rounded-t-xl bg-linear-to-b from-emerald-500/5 to-transparent pointer-events-none" />
              )}

              <div className="relative">
                {/* Header row */}
                <div className="flex items-start justify-between mb-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-sm text-zinc-100 truncate">
                        {session.name}
                      </h3>
                      {session.remote && (
                        <span className="shrink-0 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider rounded-sm bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
                          {session.remote}
                        </span>
                      )}
                      {session.hasClaudeRunning && (
                        <span className="shrink-0 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider rounded-sm bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                          claude
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-zinc-600 font-(family-name:--font-geist-mono) mt-0.5">
                      {session.windows} window{session.windows !== 1 ? "s" : ""}
                    </p>
                  </div>

                  {/* Attached/detached badge */}
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                      session.attached
                        ? "text-emerald-300 bg-emerald-500/10"
                        : "text-zinc-500 bg-zinc-500/10"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        session.attached ? "bg-emerald-400" : "bg-zinc-600"
                      }`}
                    />
                    {session.attached ? "Attached" : "Detached"}
                  </span>
                </div>

                {/* Pane commands */}
                {session.panes.length > 0 && (
                  <div className="mb-3">
                    <div className="h-px bg-white/4 mb-2" />
                    <div className="flex flex-wrap gap-1.5">
                      {session.panes.map((pane) => (
                        <span
                          key={pane.paneId}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-(family-name:--font-geist-mono) ${
                            pane.command.toLowerCase() === "claude" ||
                            pane.command.toLowerCase() === "claude.exe"
                              ? "text-emerald-400 bg-emerald-500/8 border border-emerald-500/15"
                              : "text-zinc-500 bg-zinc-800/50 border border-zinc-700/30"
                          }`}
                        >
                          <span className="truncate max-w-[120px]">{pane.command}</span>
                          <span className="text-zinc-700">({pane.pid})</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleAction("attach", session.name, session.remote)}
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
                        d="M6.115 5.19l.319 1.913A6 6 0 008.11 10.36L9.75 12l-.387.775c-.217.433-.132.956.21 1.298l1.348 1.348c.21.21.329.497.329.795v1.089c0 .426.24.815.622 1.006l.153.076c.433.217.956.132 1.298-.21l.723-.723a8.7 8.7 0 002.288-4.042 1.087 1.087 0 00-.358-1.099l-1.33-1.108c-.251-.21-.582-.299-.905-.245l-1.17.195a1.125 1.125 0 01-.98-.314l-.295-.295a1.125 1.125 0 010-1.591l.13-.132a1.125 1.125 0 011.3-.21l.603.302a.809.809 0 001.086-1.086L14.25 7.5l1.256-.837a4.5 4.5 0 001.528-1.732l.146-.292M6.115 5.19A9 9 0 1017.18 4.64M6.115 5.19A8.965 8.965 0 0112 3c1.929 0 3.72.607 5.18 1.64"
                      />
                    </svg>
                    Attach
                  </button>

                  {killConfirm === session.name ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setKillConfirm(null)}
                        className="px-2.5 py-1.5 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 bg-white/4 hover:bg-white/8 border border-white/7 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleAction("kill", session.name, session.remote)}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-red-400 hover:text-red-300 bg-red-500/8 hover:bg-red-500/18 border border-red-500/15 hover:border-red-500/30 transition-colors"
                      >
                        Confirm Kill
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleAction("kill", session.name, session.remote)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-500 hover:text-red-400 bg-white/3 hover:bg-red-500/8 border border-white/5 hover:border-red-500/20 transition-colors"
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
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                      Kill
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
