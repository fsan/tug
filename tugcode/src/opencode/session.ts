/**
 * OpenCodeSession — the ACP backend of {@link AgentSession}.
 *
 * OpenCode exposes the Agent Client Protocol (`opencode acp`): JSON-RPC 2.0
 * over stdio, with the agent streaming `session/update` notifications and
 * asking the client for permissions and answers. This class owns the child
 * process, the handshake, and the translation of ACP's vocabulary into the
 * frames tugcast already relays — so a card running OpenCode renders with the
 * same reducer, the same transcript, and the same dialogs as one running
 * Claude Code.
 *
 * What it does NOT do is pretend parity. ACP has no rewind, no side question,
 * no mid-session working-root change, and no subagent lanes, so those verbs
 * answer with an honest frame and the capability list the deck gates on comes
 * from `OPENCODE_FEATURES`.
 *
 * The pure mappings live in `translate.ts`; this file is the transport and the
 * turn state.
 *
 * @module opencode/session
 */

import { LineSplitter } from "../line-splitter.ts";
import { IPC_VERSION } from "../types.ts";
import type {
  OutboundMessage,
  PermissionModeMessage,
  QuestionAnswer,
  QuestionDef,
  ReplayLineageEntry,
  ReplayRelocationOrigin,
  ReplayWindow,
  RewindPreview,
  SessionCapabilities,
  SessionRewind,
  SessionStageSpec,
  SideQuestion,
  SystemMetadata,
  ToolApproval,
  UserMessage,
} from "../types.ts";
import {
  OPENCODE_FEATURES,
  type AgentKind,
} from "@tugproto/agent";
import { emitErrorFrame, writeLine } from "../ipc.ts";
import { AcpClient, AcpClosedError, AcpRequestError } from "./acp.ts";
import {
  asRecord,
  contentText,
  elicitationContent,
  elicitationQuestions,
  permissionChoices,
  readArray,
  readString,
  renderToolOutput,
  stopReasonOf,
  toolNameOf,
} from "./translate.ts";

/** The child `opencode acp` runs in; same channel shape as a claude child. */
export type OpencodeSubprocess = Bun.Subprocess<"pipe", "pipe", "pipe">;

/**
 * Start `opencode acp`. Tests pass a fake so nothing here launches a real
 * agent; the default resolves `opencode` on `PATH` through `Bun.spawn`.
 */
export type OpencodeSpawner = (
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
) => OpencodeSubprocess;

export interface OpencodeSessionOptions {
  /** The project directory the agent runs in. */
  projectDir: string;
  /** This tugcode process's session id — what `session_init` reports. */
  sessionId: string;
  /** Fresh session, or one continuing an earlier ACP session. */
  sessionMode: "new" | "resume";
  /** The ACP session to load in resume mode. */
  resumeSessionId?: string;
  /** The coding agent — always `"opencode"` here; carried for capabilities. */
  agent?: AgentKind;
  /** Omit → the real spawner. */
  spawner?: OpencodeSpawner;
}

/** A text or thinking block of the turn being streamed. */
interface TurnBlock {
  kind: "text" | "thinking";
  index: number;
  text: string;
}

/**
 * One assistant turn's framing state.
 *
 * ACP has no message ids: the agent streams chunks, and the only stable handle
 * on a tool call is its `toolCallId`. The framer therefore mints one `msg_id`
 * per turn and numbers blocks in arrival order, which is exactly the
 * `(msg_id, block_index)` key the deck's reducer appends on. A tool call is a
 * block of its own — closing the text block it interrupted, so text that
 * follows a call mints a fresh block instead of appending onto the pre-call
 * paragraph.
 */
class TurnFramer {
  readonly msgId: string;
  private nextBlockIndex = 0;
  private current: TurnBlock | null = null;
  readonly blocks: TurnBlock[] = [];
  /** The tool blocks this turn minted, for result correlation. */
  readonly toolBlocks = new Map<string, { name: string; index: number }>();
  /** Set by `handleInterrupt`; read when the prompt resolves. */
  cancelled = false;

  constructor(
    msgId: string,
    private readonly emit: (frame: OutboundMessage) => void,
    private readonly nextSeq: () => number,
  ) {
    this.msgId = msgId;
  }

  /** Append a streaming chunk, minting a block when the kind changes. */
  append(kind: "text" | "thinking", text: string): void {
    if (text.length === 0) return;
    if (this.current === null || this.current.kind !== kind) {
      const block: TurnBlock = { kind, index: this.nextBlockIndex++, text: "" };
      this.blocks.push(block);
      this.current = block;
      this.emit({
        type: "content_block_start",
        msg_id: this.msgId,
        block_index: block.index,
        kind,
        ipc_version: IPC_VERSION,
      });
    }
    const block = this.current;
    block.text += text;
    const seq = this.nextSeq();
    if (kind === "text") {
      this.emit({
        type: "assistant_text",
        msg_id: this.msgId,
        block_index: block.index,
        seq,
        rev: 0,
        text,
        is_partial: true,
        status: "streaming",
        ipc_version: IPC_VERSION,
      });
    } else {
      this.emit({
        type: "thinking_text",
        msg_id: this.msgId,
        block_index: block.index,
        seq,
        text,
        is_partial: true,
        status: "streaming",
        ipc_version: IPC_VERSION,
      });
    }
  }

  /** Open a tool block and emit its call. */
  startTool(toolCallId: string, update: Record<string, unknown>): void {
    if (this.toolBlocks.has(toolCallId)) return;
    const index = this.nextBlockIndex++;
    const name = toolNameOf(update);
    this.toolBlocks.set(toolCallId, { name, index });
    this.current = null;
    this.emit({
      type: "content_block_start",
      msg_id: this.msgId,
      block_index: index,
      kind: "tool_use",
      tool_use_id: toolCallId,
      tool_name: name,
      ipc_version: IPC_VERSION,
    });
    const input = asRecord(update.rawInput) ?? {};
    this.emit({
      type: "tool_use",
      msg_id: this.msgId,
      seq: this.nextSeq(),
      tool_name: name,
      tool_use_id: toolCallId,
      input,
      ipc_version: IPC_VERSION,
    });
  }

  /** Emit the result for a tool call this turn opened. */
  finishTool(toolCallId: string, update: Record<string, unknown>, isError: boolean): void {
    this.emit({
      type: "tool_result",
      tool_use_id: toolCallId,
      output: renderToolOutput(update.content, update.rawOutput),
      is_error: isError,
      ipc_version: IPC_VERSION,
    });
  }

  /**
   * Close the turn: re-emit each block whole (`is_partial: false` replaces the
   * streamed text in the reducer), then the terminal frame. A cancelled turn
   * ends `turn_cancelled` with the partial text it had reached.
   */
  finish(result: string, isApiError = false): void {
    const fullText = this.blocks
      .filter((b) => b.kind === "text")
      .map((b) => b.text)
      .join("");
    if (this.cancelled) {
      this.emit({
        type: "turn_cancelled",
        msg_id: this.msgId,
        seq: this.nextSeq(),
        partial_result: fullText,
        ipc_version: IPC_VERSION,
      });
      return;
    }
    for (const block of this.blocks) {
      if (block.text.length === 0) continue;
      if (block.kind === "text") {
        this.emit({
          type: "assistant_text",
          msg_id: this.msgId,
          block_index: block.index,
          seq: this.nextSeq(),
          rev: 0,
          text: block.text,
          is_partial: false,
          status: "complete",
          ipc_version: IPC_VERSION,
        });
      } else {
        this.emit({
          type: "thinking_text",
          msg_id: this.msgId,
          block_index: block.index,
          seq: this.nextSeq(),
          text: block.text,
          is_partial: false,
          status: "complete",
          ipc_version: IPC_VERSION,
        });
      }
    }
    this.emit({
      type: "turn_complete",
      msg_id: this.msgId,
      seq: this.nextSeq(),
      result,
      ...(isApiError ? { is_api_error: true } : {}),
      ipc_version: IPC_VERSION,
    });
  }
}

/**
 * The conversation OpenCode replays on `session/load`, translated and held
 * until a card asks for it with `request_replay`.
 *
 * The load handshake is the only moment the agent narrates its history, and it
 * does so before the `session/load` response returns; buffering keeps those
 * frames off the live wire (where a turn with no `turn_complete` would leave a
 * spinner) and lets `runReplay` emit them inside the bracket the deck expects.
 * The buffer dies with the process; an un-asked session simply never shows it.
 */
class HistoryBuffer {
  readonly frames: OutboundMessage[] = [];
  /** Committed turns, for `replay_complete.count`. */
  turns = 0;
  private framer: TurnFramer | null = null;
  private userText = "";

  constructor(private readonly nextSeq: () => number) {}

  /** One replayed user message chunk. */
  userChunk(text: string): void {
    if (text.length === 0) return;
    this.flushAssistant();
    this.userText += text;
  }

  /** One replayed assistant or thought chunk. */
  assistantChunk(kind: "text" | "thinking", text: string): void {
    this.flushUser();
    this.framerOrOpen().append(kind, text);
  }

  /** One replayed tool call, optionally already complete. */
  toolCall(toolCallId: string, update: Record<string, unknown>): void {
    this.flushUser();
    const framer = this.framerOrOpen();
    framer.startTool(toolCallId, update);
    const status = readString(update, "status");
    if (status === "completed" || status === "failed") {
      framer.finishTool(toolCallId, update, status === "failed");
    }
  }

  /** One replayed tool-call update. */
  toolUpdate(toolCallId: string, update: Record<string, unknown>): void {
    this.flushUser();
    if (this.framer === null) return;
    if (!this.framer.toolBlocks.has(toolCallId)) {
      this.framer.startTool(toolCallId, update);
    }
    const status = readString(update, "status");
    if (status === "completed" || status === "failed") {
      this.framer.finishTool(toolCallId, update, status === "failed");
    }
  }

  /** Close the history: whatever turn is open, and the text it was building. */
  finish(): void {
    this.flushUser();
    if (this.framer !== null) {
      this.framer.finish("success");
      this.turns += 1;
      this.framer = null;
    }
  }

  private framerOrOpen(): TurnFramer {
    if (this.framer === null) {
      this.framer = new TurnFramer(
        this.mintMsgId(),
        (frame) => this.frames.push(frame),
        this.nextSeq,
      );
    }
    return this.framer;
  }

  private flushUser(): void {
    if (this.userText.length === 0) return;
    this.frames.push({
      type: "add_user_message",
      content: [{ type: "text", text: this.userText }],
      ipc_version: IPC_VERSION,
    });
    this.userText = "";
    if (this.framer !== null) {
      this.framer.finish("success");
      this.turns += 1;
      this.framer = null;
    }
  }

  private flushAssistant(): void {
    if (this.framer !== null) {
      this.framer.finish("success");
      this.turns += 1;
      this.framer = null;
    }
  }

  private mintMsgId(): string {
    return `oc-hist-${this.turns}-${this.frames.length}`;
  }
}

/**
 * A session backed by `opencode acp`.
 */
export class OpencodeSession {
  private readonly projectDir: string;
  private readonly sessionId: string;
  private readonly sessionMode: "new" | "resume";
  private readonly resumeSessionId: string | undefined;
  readonly agent: AgentKind;
  private readonly spawner: OpencodeSpawner;

  private child: OpencodeSubprocess | null = null;
  private client: AcpClient | null = null;
  private acpSessionId: string | null = null;
  private readyPromise: Promise<void> | null = null;
  private ready = false;

  /** Monotonic sequence for outbound frames, as the claude backend numbers them. */
  private seq = 0;
  /** Turns minted this process; part of every `msg_id`. */
  private turnCounter = 0;
  /** A per-process suffix so msg ids minted by a respawn never collide. */
  private readonly msgBase = Date.now().toString(36);

  private live: TurnFramer | null = null;
  private pendingPrompts: Promise<void> = Promise.resolve();

  private history: HistoryBuffer | null = null;
  private replayRunning = false;

  private models: { value: string; displayName: string }[] = [];
  private commands: { name: string; description?: string; argumentHint?: string }[] = [];
  private agentVersion: string | null = null;

  private readonly pendingPermissions = new Map<
    string,
    {
      resolve: (optionId: string | null) => void;
      allowId: string | null;
      denyId: string | null;
    }
  >();
  private readonly pendingElicitations = new Map<
    string,
    { questions: QuestionDef[]; resolve: (result: unknown) => void }
  >();
  private permissionCounter = 0;

  constructor(opts: OpencodeSessionOptions) {
    this.projectDir = opts.projectDir;
    this.sessionId = opts.sessionId;
    this.sessionMode = opts.sessionMode;
    this.resumeSessionId = opts.resumeSessionId;
    this.agent = opts.agent ?? "opencode";
    this.spawner =
      opts.spawner ??
      ((args, env, cwd) =>
        Bun.spawn(args, {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          cwd,
          env,
          // Its own process group, so shutdown sweeps the agent and whatever
          // it started; same move the claude spawn makes.
          detached: true,
        }));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Resume-mode cold boot: the synthetic init, then the transport in back. */
  prepareSession(): void {
    writeLine({ type: "session_init", session_id: this.sessionId, ipc_version: IPC_VERSION });
  }

  /** Start the agent and complete its ACP handshake; the readiness gate. */
  spawnAgentAndWatch(): Promise<void> {
    if (this.readyPromise === null) {
      this.readyPromise = this.start();
    }
    return this.readyPromise;
  }

  /** Fresh-session cold boot: init frame first, then the handshake. */
  async initialize(): Promise<void> {
    this.prepareSession();
    await this.spawnAgentAndWatch();
  }

  /**
   * Spawn, `initialize`, then `session/new` (or `session/load` for a resume).
   *
   * The load handshake is what replays history; every `session/update` it
   * sends lands in {@link HistoryBuffer} rather than the live wire.
   */
  private async start(): Promise<void> {
    try {
      const child = this.spawner(["opencode", "acp"], process.env, this.projectDir);
      this.child = child;
      this.client = new AcpClient((line) => this.writeToAgent(line));
      this.client.onNotification((method, params) => this.onNotification(method, params));
      this.client.onRequest((method, params) => this.onRequest(method, params));
      this.startStdoutDrain(child);
      this.startStderrDrain(child);

      const init = await this.client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      this.agentVersion =
        readString(asRecord(asRecord(init)?.agentInfo), "version") ?? null;

      if (this.sessionMode === "resume" && this.resumeSessionId !== undefined) {
        this.history = new HistoryBuffer(() => this.nextSeq());
        const loaded = await this.client.request("session/load", {
          sessionId: this.resumeSessionId,
          cwd: this.projectDir,
          mcpServers: [],
        });
        this.adoptSession(loaded);
        this.history.finish();
      } else {
        const created = await this.client.request("session/new", {
          cwd: this.projectDir,
          mcpServers: [],
        });
        this.adoptSession(created);
      }

      this.ready = true;
      writeLine(this.capabilitiesFrame());
      writeLine(this.systemMetadataFrame());
    } catch (err) {
      this.readyPromise = null;
      const message =
        err instanceof AcpRequestError || err instanceof AcpClosedError
          ? err.message
          : String(err);
      emitErrorFrame("opencode_backend", `OpenCode session failed to start: ${message}`, false);
      throw err;
    }
  }

  /** Read the ACP session id, models and modes out of a new/load response. */
  private adoptSession(result: unknown): void {
    const obj = asRecord(result);
    this.acpSessionId = readString(obj, "sessionId") ?? this.resumeSessionId ?? null;
    const models = asRecord(obj?.models);
    const available = readArray(models, "availableModels");
    const parsed: { value: string; displayName: string }[] = [];
    for (const raw of available) {
      const model = asRecord(raw);
      const value = readString(model, "modelId");
      if (value === null) continue;
      parsed.push({ value, displayName: readString(model, "name") ?? value });
    }
    if (parsed.length > 0) this.models = parsed;
  }

  /** End the agent child and release its handles. */
  async shutdown(opts?: { graceMs?: number }): Promise<void> {
    await this.terminateChild(opts?.graceMs ?? 5000);
  }

  private async terminateChild(graceMs: number): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.client?.fail("session ending");
    this.client = null;
    if (child === null) return;
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    const grace = Math.max(250, graceMs);
    const exited = await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), grace)),
    ]);
    if (!exited) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      const terminated = await Promise.race([
        child.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      if (!terminated) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
        await child.exited.catch(() => undefined);
      }
    }
    // The sweep: whatever the agent left in its group goes with it.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // ESRCH — nothing left, the ordinary answer.
    }
  }

  private writeToAgent(line: string): void {
    const stdin = this.child?.stdin;
    if (!stdin) return;
    try {
      stdin.write(line + "\n");
      void stdin.flush();
    } catch (err) {
      console.error("[tugcode] opencode: write failed:", err);
    }
  }

  private startStdoutDrain(child: OpencodeSubprocess): void {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    void (async () => {
      const splitter = new LineSplitter({ stream: "opencode_stdout" });
      try {
        while (true) {
          let result: Awaited<ReturnType<typeof reader.read>>;
          try {
            result = await reader.read();
          } catch {
            break;
          }
          if (result.done) {
            const rest = splitter.end()?.trim() ?? "";
            if (rest.length > 0) this.client?.handleLine(rest);
            break;
          }
          for (const raw of splitter.push(result.value)) {
            const line = raw.trim();
            if (line.length > 0) this.client?.handleLine(line);
          }
        }
      } finally {
        this.client?.fail("opencode stdout closed");
        this.onAgentExit();
      }
    })();
  }

  private startStderrDrain(child: OpencodeSubprocess): void {
    const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
    void (async () => {
      const splitter = new LineSplitter({ stream: "opencode_stderr" });
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            const rest = splitter.end();
            if (rest !== null) process.stderr.write(rest);
            return;
          }
          for (const line of splitter.push(result.value)) {
            // Verbatim, so tugcast's tugcode_stderr capture sees exactly what
            // the agent wrote.
            process.stderr.write(line + "\n");
          }
        }
      } catch (err) {
        process.stderr.write(`[tugcode] opencode stderr reader error: ${err}\n`);
      }
    })();
  }

  /**
   * The agent is gone. A turn that was streaming can never complete — its
   * `session/prompt` request has already rejected through `AcpClient.fail` —
   * so the exit costs nothing more than a notice.
   */
  private onAgentExit(): void {
    if (this.live !== null) {
      emitErrorFrame(
        "opencode_backend",
        "OpenCode exited while a turn was in flight.",
        true,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Agent → client traffic
  // -------------------------------------------------------------------------

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const update = asRecord(asRecord(params)?.update);
    if (update === null) return;
    const kind = readString(update, "sessionUpdate");
    switch (kind) {
      case "user_message_chunk": {
        const text = contentText(update.content);
        if (this.history !== null && !this.ready) {
          this.history.userChunk(text);
        }
        return;
      }
      case "agent_message_chunk":
        this.delta("text", contentText(update.content));
        return;
      case "agent_thought_chunk":
        this.delta("thinking", contentText(update.content));
        return;
      case "tool_call": {
        const toolCallId = readString(update, "toolCallId");
        if (toolCallId === null) return;
        const target = this.live;
        if (target === null) return;
        target.startTool(toolCallId, update);
        const status = readString(update, "status");
        if (status === "completed" || status === "failed") {
          target.finishTool(toolCallId, update, status === "failed");
        }
        return;
      }
      case "tool_call_update": {
        const toolCallId = readString(update, "toolCallId");
        if (toolCallId === null) return;
        const target = this.live;
        if (target === null) return;
        if (!target.toolBlocks.has(toolCallId)) target.startTool(toolCallId, update);
        const status = readString(update, "status");
        if (status === "completed" || status === "failed") {
          target.finishTool(toolCallId, update, status === "failed");
        }
        return;
      }
      case "available_commands_update": {
        this.commands = parseCommands(update.availableCommands);
        if (this.ready) writeLine(this.capabilitiesFrame());
        return;
      }
      case "current_mode_update": {
        const modeId = readString(update, "currentModeId");
        if (modeId !== null && this.ready) {
          writeLine({ ...this.systemMetadataFrame(), permissionMode: modeId });
        }
        return;
      }
      case "session_info_update":
      case "plan":
      case "usage_update":
        // No Tug surface for a plan or a usage tick yet; the session's own
        // telemetry arrives on `turn_complete`'s cost path where there is one.
        return;
      default:
        return;
    }
  }

  /** Where a delta goes: the history buffer while it is being built, else live. */
  private delta(kind: "text" | "thinking", text: string): void {
    if (this.history !== null && !this.ready) {
      this.history.assistantChunk(kind, text);
      return;
    }
    this.live?.append(kind, text);
  }

  /**
   * An agent → client request. Permission and elicitation prompts hold the
   * request open until the deck answers; anything else is declined, since we
   * advertise no filesystem or terminal capabilities.
   */
  private async onRequest(method: string, params: unknown): Promise<unknown> {
    const obj = asRecord(params);
    switch (method) {
      case "session/request_permission":
        return this.requestPermission(obj);
      case "elicitation/create":
        return this.requestElicitation(obj);
      default:
        throw new Error(`unsupported request: ${method}`);
    }
  }

  private async requestPermission(
    params: Record<string, unknown> | null,
  ): Promise<unknown> {
    const toolCall = asRecord(params?.toolCall) ?? {};
    const choices = permissionChoices(params?.options);
    if (choices.allowId === null && choices.denyId === null) {
      return { outcome: { outcome: "cancelled" } };
    }
    const requestId = `perm-${++this.permissionCounter}`;
    const decision = new Promise<string | null>((resolve) => {
      this.pendingPermissions.set(requestId, {
        resolve,
        allowId: choices.allowId,
        denyId: choices.denyId,
      });
    });
    writeLine({
      type: "tool_approval_request",
      request_id: requestId,
      tool_name: toolNameOf(toolCall),
      input: asRecord(toolCall.rawInput) ?? {},
      ipc_version: IPC_VERSION,
    });
    const optionId = await decision;
    return optionId === null
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId } };
  }

  private async requestElicitation(
    params: Record<string, unknown> | null,
  ): Promise<unknown> {
    const questions = elicitationQuestions(params);
    if (questions.length === 0) return { action: "decline" };
    const requestId = `question-${++this.permissionCounter}`;
    const answer = new Promise<unknown>((resolve) => {
      this.pendingElicitations.set(requestId, { questions, resolve });
    });
    writeLine({
      type: "question",
      request_id: requestId,
      questions,
      ipc_version: IPC_VERSION,
    });
    return answer;
  }

  // -------------------------------------------------------------------------
  // Client → agent verbs
  // -------------------------------------------------------------------------

  async handleUserMessage(msg: UserMessage): Promise<void> {
    await this.spawnAgentAndWatch();
    const prompt = toAcpPrompt(msg.content);
    // ACP runs one prompt at a time per session; a submission that lands
    // mid-turn is queued and opened as the next turn, which is what the claude
    // backend does by letting claude buffer the input.
    this.pendingPrompts = this.pendingPrompts.then(
      () => this.runPrompt(prompt),
      () => this.runPrompt(prompt),
    );
    await this.pendingPrompts;
  }

  private async runPrompt(prompt: unknown[]): Promise<void> {
    const client = this.client;
    const acpSessionId = this.acpSessionId;
    if (client === null || acpSessionId === null) {
      throw new Error("OpenCode session is not initialized");
    }
    const turn = new TurnFramer(
      `oc-${this.msgBase}-${++this.turnCounter}`,
      (frame) => writeLine(frame),
      () => this.nextSeq(),
    );
    this.live = turn;
    let result: unknown;
    try {
      result = await client.request("session/prompt", { sessionId: acpSessionId, prompt });
    } catch (err) {
      if (this.live === turn) this.live = null;
      if (err instanceof AcpClosedError) {
        emitErrorFrame("opencode_backend", `OpenCode went away mid-turn: ${err.message}`, true);
      } else {
        emitErrorFrame("opencode_backend", `OpenCode prompt failed: ${String(err)}`, true);
      }
      return;
    }
    if (this.live === turn) this.live = null;
    const stop = stopReasonOf(result);
    turn.finish(
      stop === "end_turn" ? "success" : stop,
      stop === "refusal",
    );
  }

  handleToolApproval(msg: ToolApproval): void {
    const pending = this.pendingPermissions.get(msg.request_id);
    if (pending === undefined) {
      console.error(`[tugcode] opencode: approval for unknown request ${msg.request_id}`);
      return;
    }
    this.pendingPermissions.delete(msg.request_id);
    // Tug answers allow/deny; ACP wants one of the option ids the agent
    // offered. A decision the agent gave no option for cancels the request
    // rather than inventing an id it will reject.
    pending.resolve(msg.decision === "allow" ? pending.allowId : pending.denyId);
  }

  handleQuestionAnswer(msg: QuestionAnswer): void {
    const pending = this.pendingElicitations.get(msg.request_id);
    if (pending === undefined) {
      console.error(`[tugcode] opencode: answer for unknown question ${msg.request_id}`);
      return;
    }
    this.pendingElicitations.delete(msg.request_id);
    if (msg.answers !== undefined) {
      pending.resolve({
        action: "accept",
        content: elicitationContent(pending.questions, msg.answers),
      });
    } else {
      pending.resolve({ action: "decline" });
    }
  }

  handleInterrupt(retract: boolean): void {
    if (this.client === null || this.acpSessionId === null) {
      writeLine({
        type: "interrupt_noop",
        tug_session_id: this.sessionId,
        reason: "no_process",
        ipc_version: IPC_VERSION,
      });
      return;
    }
    if (this.live === null) {
      writeLine({
        type: "interrupt_noop",
        tug_session_id: this.sessionId,
        reason: "no_turn",
        ipc_version: IPC_VERSION,
      });
      return;
    }
    if (retract) {
      // ACP cancels a turn; it cannot unwrite the prompt from the agent's
      // history the way claude's JSONL truncation does. Plain cancel, logged
      // so the difference is visible rather than silent.
      console.error("[tugcode] opencode: retract unsupported; cancelling the turn instead");
    }
    this.live.cancelled = true;
    this.client.notify("session/cancel", { sessionId: this.acpSessionId });
  }

  handlePermissionMode(msg: PermissionModeMessage): void {
    void this.setMode(msg.mode);
  }

  private async setMode(modeId: string): Promise<void> {
    const client = this.client;
    const acpSessionId = this.acpSessionId;
    if (client === null || acpSessionId === null) return;
    try {
      await client.request("session/set_mode", { sessionId: acpSessionId, modeId });
      writeLine({ ...this.systemMetadataFrame(), permissionMode: modeId });
    } catch (err) {
      emitErrorFrame("opencode_backend", `OpenCode refused mode ${modeId}: ${String(err)}`, true);
    }
  }

  handleModelChange(model: string): void {
    void this.setModel(model);
  }

  private async setModel(model: string): Promise<void> {
    const client = this.client;
    const acpSessionId = this.acpSessionId;
    if (client === null || acpSessionId === null) return;
    try {
      await client.request("session/set_config_option", {
        sessionId: acpSessionId,
        configId: "model",
        value: model,
      });
      writeLine({ ...this.systemMetadataFrame(), model });
    } catch (err) {
      emitErrorFrame("opencode_backend", `OpenCode refused model ${model}: ${String(err)}`, true);
    }
  }

  async handleEffortChange(effort: string): Promise<void> {
    // ACP has no reasoning-effort verb. The model picker's `supportsEffort`
    // is absent for every model this backend reports, so the deck's effort
    // chip is hidden; an un-gated request is logged and dropped.
    console.error(`[tugcode] opencode: effort change (${effort}) unsupported`);
  }

  async handleAddDirectory(directory: string): Promise<void> {
    // A session's roots are fixed by its `session/new` cwd in ACP.
    console.error(`[tugcode] opencode: add-directory (${directory}) unsupported`);
  }

  handleStopTask(taskId: string): void {
    console.error(`[tugcode] opencode: stop-task (${taskId}) unsupported`);
  }

  async handleStopAllWork(_taskIds: string[]): Promise<void> {
    if (this.live !== null) {
      this.live.cancelled = true;
      this.client?.notify("session/cancel", { sessionId: this.acpSessionId });
    }
    writeLine({
      type: "stop_all_work_done",
      tug_session_id: this.sessionId,
      ipc_version: IPC_VERSION,
    });
  }

  handleSideQuestion(msg: SideQuestion): void {
    writeLine({
      type: "side_question_answer",
      tug_session_id: this.sessionId,
      request_id: msg.request_id,
      answer: null,
      synthetic: true,
      ipc_version: IPC_VERSION,
    });
  }

  async handleRewindPreview(msg: RewindPreview): Promise<void> {
    writeLine({
      type: "rewind_preview_result",
      promptUuid: msg.promptUuid,
      canRewind: false,
      error: "OpenCode sessions do not support rewind.",
      ipc_version: IPC_VERSION,
    });
  }

  async handleSessionRewind(msg: SessionRewind): Promise<void> {
    writeLine({
      type: "rewind_result",
      promptUuid: msg.promptUuid,
      scope: msg.scope,
      canRewind: false,
      error: "OpenCode sessions do not support rewind.",
      ipc_version: IPC_VERSION,
    });
  }

  async handleSessionCommand(
    command: "fork" | "continue" | "new",
    _stage?: SessionStageSpec,
  ): Promise<void> {
    if (command !== "new") {
      emitErrorFrame(
        "opencode_backend",
        `OpenCode sessions do not support ${command}.`,
        true,
      );
      return;
    }
    await this.restartSession();
  }

  /** Start a fresh ACP session in place of this one (`/new`). */
  private async restartSession(): Promise<void> {
    if (this.live !== null) {
      this.live.cancelled = true;
      this.client?.notify("session/cancel", { sessionId: this.acpSessionId });
      this.live = null;
    }
    await this.terminateChild(1500);
    this.acpSessionId = null;
    this.history = null;
    this.readyPromise = null;
    this.prepareSession();
    await this.spawnAgentAndWatch();
  }

  // -------------------------------------------------------------------------
  // Replay and inflight
  // -------------------------------------------------------------------------

  /**
   * Replay the conversation OpenCode replayed at load. ACP pages nothing —
   * `session/load` hands over the whole transcript — so the recency window is
   * ignored rather than half-honoured.
   */
  async runReplay(
    _window?: ReplayWindow,
    _lineage?: ReplayLineageEntry[],
    _relocation?: ReplayRelocationOrigin,
    askId?: string,
  ): Promise<void> {
    if (this.replayRunning) {
      if (askId !== undefined) {
        writeLine({ type: "request_replay_dropped", ask_id: askId, ipc_version: IPC_VERSION });
      }
      return;
    }
    this.replayRunning = true;
    const opened: OutboundMessage = {
      type: "replay_started",
      ...(askId !== undefined ? { ask_id: askId } : {}),
      ipc_version: IPC_VERSION,
    };
    try {
      // The load handshake is what produced the history; wait for it.
      await this.spawnAgentAndWatch();
      writeLine(opened);
      const frames = this.history?.frames ?? [];
      for (const frame of frames) writeLine(frame);
      writeLine({
        type: "replay_complete",
        count: this.history?.turns ?? 0,
        ipc_version: IPC_VERSION,
      });
    } catch (err) {
      writeLine(opened);
      writeLine({
        type: "replay_complete",
        count: 0,
        error: { kind: "replay_exception", message: String(err) },
        ipc_version: IPC_VERSION,
      });
    } finally {
      this.replayRunning = false;
    }
  }

  /**
   * Replay emissions are a synchronous loop over a buffer; there is no tail to
   * interrupt. The flag keeps a cancel that races the loop honest about what
   * it did (nothing).
   */
  cancelReplay(): void {
    if (this.replayRunning) {
      console.error("[tugcode] opencode: cancel_replay during a buffered replay is a no-op");
    }
  }

  /**
   * The mid-turn snapshot: open an `inflight_only` bracket and re-emit the turn
   * in flight as it now stands. A card that reloaded learns what the agent had
   * streamed without waiting for the turn to close.
   */
  requestInflight(): void {
    writeLine({ type: "replay_started", inflight_only: true, ipc_version: IPC_VERSION });
    const turn = this.live;
    if (turn !== null) {
      for (const block of turn.blocks) {
        if (block.text.length === 0) continue;
        writeLine({
          type: "content_block_start",
          msg_id: turn.msgId,
          block_index: block.index,
          kind: block.kind,
          ipc_version: IPC_VERSION,
        });
        if (block.kind === "text") {
          writeLine({
            type: "assistant_text",
            msg_id: turn.msgId,
            block_index: block.index,
            seq: this.nextSeq(),
            rev: 0,
            text: block.text,
            is_partial: false,
            status: "streaming",
            ipc_version: IPC_VERSION,
          });
        } else {
          writeLine({
            type: "thinking_text",
            msg_id: turn.msgId,
            block_index: block.index,
            seq: this.nextSeq(),
            text: block.text,
            is_partial: false,
            status: "streaming",
            ipc_version: IPC_VERSION,
          });
        }
      }
    }
    writeLine({ type: "replay_complete", count: 0, ipc_version: IPC_VERSION });
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------

  private capabilitiesFrame(): SessionCapabilities {
    return {
      type: "session_capabilities",
      models: this.models,
      commands: this.commands,
      agents: [],
      available_output_styles: [],
      output_style: "",
      account: null,
      effort: null,
      version: this.agentVersion,
      agent: this.agent,
      features: [...OPENCODE_FEATURES],
      ipc_version: IPC_VERSION,
    };
  }

  private systemMetadataFrame(): SystemMetadata {
    return {
      type: "system_metadata",
      cwd: this.projectDir,
      ipc_version: IPC_VERSION,
    };
  }

  private nextSeq(): number {
    return ++this.seq;
  }
}

/** Map Tug's Anthropic-shaped content blocks onto ACP prompt parts. */
function toAcpPrompt(content: UserMessage["content"]): unknown[] {
  const parts: unknown[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      parts.push({
        type: "image",
        mimeType: block.source.media_type,
        data: block.source.data,
      });
    }
  }
  return parts;
}

/** Map ACP's `availableCommands` onto Tug's command catalog. */
function parseCommands(value: unknown): {
  name: string;
  description?: string;
  argumentHint?: string;
}[] {
  const out: { name: string; description?: string; argumentHint?: string }[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const obj = asRecord(raw);
    const name = readString(obj, "name");
    if (name === null) continue;
    const command: { name: string; description?: string; argumentHint?: string } = { name };
    const description = readString(obj, "description");
    if (description !== null) command.description = description;
    const argumentHint = readString(asRecord(obj?.input), "hint");
    if (argumentHint !== null) command.argumentHint = argumentHint;
    out.push(command);
  }
  return out;
}
