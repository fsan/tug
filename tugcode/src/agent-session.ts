/**
 * agent-session — the verbs a Session card drives on whichever coding agent
 * writes it.
 *
 * A card used to have exactly one backend: `SessionManager`, which spawns
 * `claude` and translates its stream-json. The bridge now also runs other
 * agents (see `@tugproto/agent`), so `main.ts` and the inbound registry talk to
 * this interface instead of the concrete class. `SessionManager` satisfies it
 * structurally; `OpencodeSession` implements it for the ACP backends.
 *
 * The interface is the *inbound* surface only — the verbs tugcast forwards from
 * a card. Everything a backend does on its own (spawning, draining its
 * transport, shaping its own wire) stays private to it, so this file needs to
 * know nothing about ACP or stream-json.
 *
 * @module agent-session
 */

import type {
  PermissionModeMessage,
  QuestionAnswer,
  ReplayLineageEntry,
  ReplayRelocationOrigin,
  ReplayWindow,
  RewindPreview,
  SessionRewind,
  SessionStageSpec,
  SideQuestion,
  ToolApproval,
  UserMessage,
} from "./types.ts";

/**
 * One session's coding agent, as the bridge drives it.
 *
 * Every method is named for the inbound verb that reaches it, so a reader can
 * go from `tugproto/inbound.ts` to the implementation by name. A backend that
 * cannot honour a verb answers with a frame — `interrupt_noop`, an `error`, or
 * a capability-gated no-op — rather than throwing; the deck gates its controls
 * off `session_capabilities.features`, but the gate is a courtesy, not a
 * contract, and an un-gated verb must still be answerable.
 */
export interface AgentSession {
  /**
   * Resume-mode cold boot: emit the synthetic `session_init` so tugcast can
   * promote the spawn, then leave the transport to start in the background
   * ({@link spawnAgentAndWatch}).
   */
  prepareSession(): void;

  /**
   * Start the backend in the background and return the readiness gate the
   * first user message awaits. Named for the claude backend because that is
   * where it began; every backend starts a child here.
   */
  spawnAgentAndWatch(): Promise<void>;

  /** Fresh-session cold boot: start the backend and emit the synthetic init. */
  initialize(): Promise<void>;

  /** Submit a user turn. Rejects when the backend could not accept it. */
  handleUserMessage(msg: UserMessage): Promise<void>;

  handleToolApproval(msg: ToolApproval): void;
  handleQuestionAnswer(msg: QuestionAnswer): void;
  handleInterrupt(retract: boolean): void;
  handlePermissionMode(msg: PermissionModeMessage): void;
  handleModelChange(model: string): void;
  /**
   * Reasoning effort and working-root changes. Parameter shapes match the
   * claude backend's, which is what the inbound registry passes.
   */
  handleEffortChange(effort: string): Promise<void>;
  handleAddDirectory(directory: string): Promise<void>;
  handleStopTask(taskId: string): void;
  handleStopAllWork(taskIds: string[]): Promise<void>;

  /** Replay the saved conversation onto the wire, bracketed. */
  runReplay(
    window?: ReplayWindow,
    lineage?: ReplayLineageEntry[],
    relocation?: ReplayRelocationOrigin,
    askId?: string,
  ): Promise<void>;
  cancelReplay(): void;
  requestInflight(): void;

  handleRewindPreview(msg: RewindPreview): Promise<void>;
  handleSessionRewind(msg: SessionRewind): Promise<void>;
  handleSessionCommand(
    command: "fork" | "continue" | "new",
    stage?: SessionStageSpec,
  ): Promise<void>;
  handleSideQuestion(msg: SideQuestion): void;

  /** End the backend and release its handles, bounded by `graceMs`. */
  shutdown(opts?: { graceMs?: number }): Promise<void>;
}
