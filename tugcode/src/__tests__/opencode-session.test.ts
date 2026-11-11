/**
 * opencode-session.test.ts — the ACP transport, driven by a fake agent.
 *
 * `OpencodeSession` takes its spawner as an argument so a test can hand it a
 * child whose stdout it controls line by line. The fake below is a small ACP
 * agent: it answers the handshake, streams `session/update` notifications,
 * asks the client for permissions and answers, and replies to client requests
 * in order — the same traffic a real `opencode acp` would produce, with no
 * process and no network.
 *
 * What is pinned here is the contract the deck depends on: the capability
 * frame names the agent and its features, a turn brackets `content_block_start`
 * … `turn_complete` exactly as the claude backend does, cancellation ends
 * `turn_cancelled` with the partial text, and a `session/load` handshake's
 * history emerges only inside `runReplay`'s bracket.
 */

import { describe, expect, test } from "bun:test";

import { drainPendingWrites } from "../ipc.ts";
import {
  OpencodeSession,
  type OpencodeSubprocess,
  type OpencodeSpawner,
} from "../opencode/session.ts";
import type { OutboundMessage } from "../types.ts";

const PROJECT_DIR = "/tmp/opencode-session-test";
const TUG_SESSION_ID = "tug-oc-1";

// ---------------------------------------------------------------------------
// Fake ACP agent
// ---------------------------------------------------------------------------

interface AcpWireMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

type AcpHandler = (msg: AcpWireMessage, acp: FakeAcp) => void;

interface FakeAcp {
  /** The spawner {@link OpencodeSession} should be constructed with. */
  spawner: OpencodeSpawner;
  /** Every message the session wrote to the agent's stdin. */
  received: AcpWireMessage[];
  /** Agent → client notifications the session saw (a `received` subset). */
  notifications: AcpWireMessage[];
  /** Send one raw JSON object on stdout. */
  send(message: AcpWireMessage): void;
  notify(method: string, params: unknown): void;
  respond(request: AcpWireMessage, result: unknown): void;
  /** Send a client-bound request and return its id. */
  request(method: string, params: unknown): number;
  /** Resolve once a message (past or future) matches; rejects on timeout. */
  waitFor(predicate: (msg: AcpWireMessage) => boolean, label?: string): Promise<AcpWireMessage>;
  /** End the agent's stdout, as a real process exit would. */
  close(): void;
}

function fakeAcp(handler: AcpHandler = () => {}): FakeAcp {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  const encoder = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const stderrClosed = new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });

  const received: AcpWireMessage[] = [];
  const notifications: AcpWireMessage[] = [];
  const waiters: Array<{
    predicate: (msg: AcpWireMessage) => boolean;
    resolve: (msg: AcpWireMessage) => void;
  }> = [];
  let nextRequestId = 1;
  let exitResolve: ((code: number) => void) | null = null;

  const acp: FakeAcp = {
    spawner: undefined as unknown as OpencodeSpawner,
    received,
    notifications,
    send(message) {
      if (closed || controller === null) return;
      controller.enqueue(encoder.encode(JSON.stringify(message) + "\n"));
    },
    notify(method, params) {
      acp.send({ jsonrpc: "2.0", method, params });
    },
    respond(request, result) {
      if (request.id === undefined) return;
      acp.send({ jsonrpc: "2.0", id: request.id, result });
    },
    request(method, params) {
      const id = nextRequestId++;
      acp.send({ jsonrpc: "2.0", id, method, params });
      return id;
    },
    waitFor(predicate, label) {
      const seen = received.find(predicate);
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise<AcpWireMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for ${label ?? "a message"}`));
        }, 2000);
        waiters.push({
          predicate,
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
        });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      controller?.close();
    },
  };

  const child = {
    stdin: {
      write(data: string | Uint8Array) {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        for (const raw of text.split("\n")) {
          const line = raw.trim();
          if (line.length === 0) continue;
          let msg: AcpWireMessage;
          try {
            msg = JSON.parse(line) as AcpWireMessage;
          } catch {
            continue;
          }
          received.push(msg);
          const hasCorrelation =
            typeof msg.id === "number" || typeof msg.id === "string";
          if (typeof msg.method === "string" && !hasCorrelation) {
            notifications.push(msg);
          }
          // Responses from the client to our own requests carry an id and no
          // method; the handler sees them so a test can continue a turn.
          handler(msg, acp);
          for (const waiter of [...waiters]) {
            if (!waiter.predicate(msg)) continue;
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(msg);
          }
        }
        return text.length;
      },
      end() {
        exitResolve?.(0);
      },
      flush() {},
    },
    stdout,
    stderr: stderrClosed,
    exited: new Promise<number>((resolve) => {
      exitResolve = resolve;
    }),
    // A pid no process owns, so a stray group signal finds nothing (ESRCH)
    // rather than reaching a real process group.
    pid: 999_999,
    kill() {
      exitResolve?.(0);
    },
  };

  acp.spawner = (() => child as unknown as OpencodeSubprocess) as OpencodeSpawner;
  return acp;
}

// ---------------------------------------------------------------------------
// Frame capture
// ---------------------------------------------------------------------------

/**
 * Capture every `writeLine` frame for the duration of `fn`, which receives the
 * live array so it can wait on a frame mid-test.
 */
async function capture(
  fn: (frames: OutboundMessage[]) => Promise<void>,
): Promise<OutboundMessage[]> {
  const captured: OutboundMessage[] = [];
  const originalWrite = Bun.write;
  const decoder = new TextDecoder();
  (Bun as unknown as { write: unknown }).write = (dest: unknown, data: unknown) => {
    if (dest === Bun.stdout) {
      const text =
        typeof data === "string"
          ? data
          : data instanceof Uint8Array
            ? decoder.decode(data)
            : "";
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          captured.push(JSON.parse(trimmed) as OutboundMessage);
        } catch {
          // Non-JSON writes are not frames.
        }
      }
    }
    return Promise.resolve(
      data instanceof Uint8Array ? data.length : String(data).length,
    );
  };
  try {
    await fn(captured);
    await drainPendingWrites();
  } finally {
    (Bun as unknown as { write: unknown }).write = originalWrite;
  }
  return captured;
}

/** Poll the capture until a frame matches. */
async function waitForFrame<T extends OutboundMessage>(
  frames: OutboundMessage[],
  predicate: (frame: OutboundMessage) => frame is T,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const found = frames.find(predicate);
    if (found !== undefined) return found;
    await Bun.sleep(2);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function newSession(acp: FakeAcp, overrides: Partial<{
  sessionMode: "new" | "resume";
  resumeSessionId: string;
}> = {}): OpencodeSession {
  return new OpencodeSession({
    projectDir: PROJECT_DIR,
    sessionId: TUG_SESSION_ID,
    sessionMode: overrides.sessionMode ?? "new",
    ...(overrides.resumeSessionId !== undefined
      ? { resumeSessionId: overrides.resumeSessionId }
      : {}),
    spawner: acp.spawner,
  });
}

const handshake = (msg: AcpWireMessage, acp: FakeAcp): boolean => {
  if (msg.method === "initialize") {
    acp.respond(msg, {
      protocolVersion: 1,
      agentInfo: { name: "opencode", version: "1.2.3" },
    });
    return true;
  }
  if (msg.method === "session/new") {
    acp.respond(msg, {
      sessionId: "acp-1",
      models: { availableModels: [{ modelId: "opencode/big-pickle", name: "Big Pickle" }] },
    });
    return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpencodeSession handshake", () => {
  test("announces the agent, its features and its model catalog", async () => {
    const acp = fakeAcp(handshake);
    const session = newSession(acp);
    const frames = await capture(async () => {
      await session.initialize();
      acp.close();
      await session.shutdown();
    });

    const init = frames[0];
    expect(init?.type).toBe("session_init");

    const capabilities = frames.find((f) => f.type === "session_capabilities");
    expect(capabilities).toMatchObject({
      type: "session_capabilities",
      agent: "opencode",
      features: ["replay", "cost"],
      version: "1.2.3",
      models: [{ value: "opencode/big-pickle", displayName: "Big Pickle" }],
    });

    const metadata = frames.find((f) => f.type === "system_metadata");
    expect(metadata).toMatchObject({ cwd: PROJECT_DIR });
  });
});

describe("OpencodeSession turns", () => {
  test("streams thinking and text, then closes the turn", async () => {
    const acp = fakeAcp((msg, acp) => {
      if (handshake(msg, acp)) return;
      if (msg.method !== "session/prompt") return;
      const chunk = (sessionUpdate: string, text: string): void => {
        acp.notify("session/update", {
          sessionId: "acp-1",
          update: { sessionUpdate, content: { type: "text", text } },
        });
      };
      chunk("agent_thought_chunk", "pondering");
      chunk("agent_message_chunk", "Hel");
      chunk("agent_message_chunk", "lo");
      acp.respond(msg, { stopReason: "end_turn" });
    });
    const session = newSession(acp);

    const frames = await capture(async () => {
      await session.initialize();
      await session.handleUserMessage({
        type: "user_message",
        content: [{ type: "text", text: "hi" }],
      });
      acp.close();
      await session.shutdown();
    });

    const prompt = acp.received.find((m) => m.method === "session/prompt");
    expect(prompt?.params).toEqual({
      sessionId: "acp-1",
      prompt: [{ type: "text", text: "hi" }],
    });

    const starts = frames.filter((f) => f.type === "content_block_start");
    expect(starts.map((f) => f.kind)).toEqual(["thinking", "text"]);
    expect(starts.map((f) => f.block_index)).toEqual([0, 1]);

    const partialText = frames.filter(
      (f): f is Extract<OutboundMessage, { type: "assistant_text" }> =>
        f.type === "assistant_text" && f.is_partial,
    );
    expect(partialText.map((f) => f.text)).toEqual(["Hel", "lo"]);

    // The close re-emits each block whole, in block order, then the terminal.
    const closeIndex = frames.findIndex((f) => f.type === "turn_complete");
    const whole = frames
      .slice(0, closeIndex)
      .filter(
        (f): f is Extract<OutboundMessage, { type: "assistant_text" }> =>
          f.type === "assistant_text" && !f.is_partial,
      );
    expect(whole.map((f) => f.text)).toEqual(["Hello"]);

    const complete = frames[closeIndex];
    expect(complete).toMatchObject({ type: "turn_complete", result: "success" });
    // One msg_id for the whole turn, as the reducer's key expects.
    const msgIds = new Set(
      frames
        .filter((f) => f.type === "assistant_text" || f.type === "thinking_text")
        .map((f) => f.msg_id),
    );
    expect(msgIds.size).toBe(1);
  });

  test("a tool call becomes tool_use, and its permission round-trips", async () => {
    let promptRequest: AcpWireMessage | null = null;
    let permissionId: number | null = null;
    const acp = fakeAcp((msg, acp) => {
      if (handshake(msg, acp)) return;
      if (msg.method === "session/prompt") {
        promptRequest = msg;
        acp.notify("session/update", {
          sessionId: "acp-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            kind: "execute",
            title: "Bash ls",
            rawInput: { command: "ls" },
            status: "pending",
          },
        });
        permissionId = acp.request("session/request_permission", {
          sessionId: "acp-1",
          toolCall: {
            toolCallId: "t1",
            kind: "execute",
            title: "Bash ls",
            rawInput: { command: "ls" },
          },
          options: [
            { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
            { optionId: "reject-once", kind: "reject_once", name: "Reject" },
          ],
        });
        return;
      }
      if (msg.id === permissionId && msg.result !== undefined && promptRequest !== null) {
        acp.notify("session/update", {
          sessionId: "acp-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            status: "completed",
            content: [
              { type: "content", content: { type: "text", text: "file.txt" } },
            ],
          },
        });
        acp.respond(promptRequest, { stopReason: "end_turn" });
      }
    });
    const session = newSession(acp);

    const frames = await capture(async (frames) => {
      await session.initialize();
      const turn = session.handleUserMessage({
        type: "user_message",
        content: [{ type: "text", text: "list the files" }],
      });

      const approval = await waitForFrame(
        frames,
        (f): f is Extract<OutboundMessage, { type: "tool_approval_request" }> =>
          f.type === "tool_approval_request",
        "the permission prompt",
      );
      expect(approval).toMatchObject({
        tool_name: "Execute",
        input: { command: "ls" },
      });
      session.handleToolApproval({
        type: "tool_approval",
        request_id: approval.request_id,
        decision: "allow",
      });

      await turn;
      acp.close();
      await session.shutdown();
    });

    const use = frames.find((f) => f.type === "tool_use");
    expect(use).toMatchObject({
      type: "tool_use",
      tool_name: "Execute",
      tool_use_id: "t1",
      input: { command: "ls" },
    });
    const result = frames.find((f) => f.type === "tool_result");
    expect(result).toMatchObject({
      type: "tool_result",
      tool_use_id: "t1",
      output: "file.txt",
      is_error: false,
    });

    const response = acp.received.find(
      (m) => m.id === permissionId && m.result !== undefined,
    );
    expect(response?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });

  test("an interrupted turn ends turn_cancelled with the text so far", async () => {
    let promptRequest: AcpWireMessage | null = null;
    const acp = fakeAcp((msg, acp) => {
      if (handshake(msg, acp)) return;
      if (msg.method === "session/prompt") {
        promptRequest = msg;
        acp.notify("session/update", {
          sessionId: "acp-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "half an ans" },
          },
        });
        return;
      }
      if (msg.method === "session/cancel" && promptRequest !== null) {
        acp.respond(promptRequest, { stopReason: "cancelled" });
      }
    });
    const session = newSession(acp);

    const frames = await capture(async (frames) => {
      await session.initialize();
      const turn = session.handleUserMessage({
        type: "user_message",
        content: [{ type: "text", text: "go" }],
      });
      await waitForFrame(
        frames,
        (f): f is Extract<OutboundMessage, { type: "assistant_text" }> =>
          f.type === "assistant_text" && f.is_partial,
        "the first streamed chunk",
      );
      session.handleInterrupt(false);
      await turn;
      acp.close();
      await session.shutdown();
    });

    const cancel = acp.notifications.find((m) => m.method === "session/cancel");
    expect(cancel?.params).toEqual({ sessionId: "acp-1" });

    const cancelled = frames.find((f) => f.type === "turn_cancelled");
    expect(cancelled).toMatchObject({
      type: "turn_cancelled",
      partial_result: "half an ans",
    });
    expect(frames.some((f) => f.type === "turn_complete")).toBe(false);
  });

  test("an elicitation becomes a question, and its answer an accept", async () => {
    let promptRequest: AcpWireMessage | null = null;
    let elicitationId: number | null = null;
    const acp = fakeAcp((msg, acp) => {
      if (handshake(msg, acp)) return;
      if (msg.method === "session/prompt") {
        promptRequest = msg;
        elicitationId = acp.request("elicitation/create", {
          sessionId: "acp-1",
          message: "Pick a flavor",
          requestedSchema: {
            type: "object",
            properties: {
              flavor: {
                type: "string",
                title: "Which flavor?",
                enum: ["vanilla", "chocolate"],
              },
            },
          },
        });
        return;
      }
      if (msg.id === elicitationId && msg.result !== undefined && promptRequest !== null) {
        acp.respond(promptRequest, { stopReason: "end_turn" });
      }
    });
    const session = newSession(acp);

    const frames = await capture(async (frames) => {
      await session.initialize();
      const turn = session.handleUserMessage({
        type: "user_message",
        content: [{ type: "text", text: "order ice cream" }],
      });
      const question = await waitForFrame(
        frames,
        (f): f is Extract<OutboundMessage, { type: "question" }> =>
          f.type === "question",
        "the elicitation dialog",
      );
      expect(question.questions).toEqual([
        {
          id: "flavor",
          text: "Which flavor?",
          type: "single_choice",
          options: [{ label: "vanilla" }, { label: "chocolate" }],
        },
      ]);
      session.handleQuestionAnswer({
        type: "question_answer",
        request_id: question.request_id,
        answers: { "Which flavor?": "chocolate" },
      });
      await turn;
      acp.close();
      await session.shutdown();
    });

    const response = acp.received.find(
      (m) => m.id === elicitationId && m.result !== undefined,
    );
    expect(response?.result).toEqual({
      action: "accept",
      content: { flavor: "chocolate" },
    });
  });
});

describe("OpencodeSession resume", () => {
  test("session/load history stays buffered until runReplay brackets it", async () => {
    const acp = fakeAcp((msg, acp) => {
      if (msg.method === "initialize") {
        acp.respond(msg, {
          protocolVersion: 1,
          agentInfo: { name: "opencode", version: "1.2.3" },
        });
        return;
      }
      if (msg.method !== "session/load") return;
      const replay = (sessionUpdate: string, content: unknown): void => {
        acp.notify("session/update", { sessionId: "acp-old", update: { sessionUpdate, content } });
      };
      replay(
        "user_message_chunk",
        { type: "text", text: "the old question" },
      );
      replay(
        "agent_message_chunk",
        { type: "text", text: "the old answer" },
      );
      acp.respond(msg, { sessionId: "acp-old" });
    });
    const session = newSession(acp, {
      sessionMode: "resume",
      resumeSessionId: "acp-old",
    });

    const duringLoad = await capture(async () => {
      await session.initialize();
    });
    // The load handshake narrates history; none of it may reach the live wire.
    expect(duringLoad.some((f) => f.type === "assistant_text")).toBe(false);
    expect(duringLoad.some((f) => f.type === "add_user_message")).toBe(false);

    const load = acp.received.find((m) => m.method === "session/load");
    expect(load?.params).toEqual({
      sessionId: "acp-old",
      cwd: PROJECT_DIR,
      mcpServers: [],
    });

    const frames = await capture(async () => {
      await session.runReplay();
      acp.close();
      await session.shutdown();
    });

    const opened = frames.findIndex((f) => f.type === "replay_started");
    const closed = frames.findIndex((f) => f.type === "replay_complete");
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(closed).toBeGreaterThan(opened);

    const inside = frames.slice(opened + 1, closed);
    expect(inside[0]).toMatchObject({
      type: "add_user_message",
      content: [{ type: "text", text: "the old question" }],
    });
    const whole = inside.filter(
      (f): f is Extract<OutboundMessage, { type: "assistant_text" }> =>
        f.type === "assistant_text" && !f.is_partial,
    );
    expect(whole.map((f) => f.text)).toEqual(["the old answer"]);
    expect(inside.some((f) => f.type === "turn_complete")).toBe(true);

    expect(frames[closed]).toMatchObject({ type: "replay_complete", count: 1 });
  });
});
