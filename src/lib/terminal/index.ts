export type {
  TerminalApp,
  TerminalOpenIn,
  TerminalInfo,
  TmuxPaneInfo,
  TmuxClientInfo,
  ProcessTreeEntry,
} from "./types";

export {
  buildProcessTree,
  findClaudePidsFromTree,
  getTtyForPid,
  getTtysForPids,
  detectAllTmuxPanes,
  detectAllTmuxPanesByPid,
  detectTmuxClients,
  detectTerminal,
  findTerminalInTree,
  matchTerminal,
  clearTerminalCache,
  evictStaleTerminalCache,
  getTerminalAppName,
} from "./detect";

export {
  focusSession,
  sendText,
  sendKeystroke,
  createSession,
  listTmuxSessions,
  getTmuxPaneDetails,
  killTmuxSession,
} from "./adapters";
export type { CreateSessionOpts } from "./adapters";
