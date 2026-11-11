/**
 * acp — a small JSON-RPC 2.0 client for the Agent Client Protocol.
 *
 * OpenCode speaks ACP over stdin/stdout when started as `opencode acp`: one
 * JSON object per line, requests carrying `id`, notifications without. This
 * module owns the correlation, the error mapping, and the two inbound request
 * kinds an agent sends the client (`session/request_permission` and
 * `elicitation/create`). It knows nothing about Tug's frame vocabulary — that
 * translation lives in `translate.ts` and `session.ts`.
 *
 * The client does not spawn or read the process: {@link AcpClient.write} is
 * the caller's line writer and {@link AcpClient.handleLine} is fed every line
 * the caller splits. That keeps the whole client testable without a
 * subprocess, and keeps the process lifecycle with the session that owns it.
 *
 * @module opencode/acp
 */

export type AcpId = number | string;

export interface AcpError {
  code: number;
  message: string;
  data?: unknown;
}

/** A request the client sends the agent. */
export interface AcpRequestMessage {
  jsonrpc: "2.0";
  id: AcpId;
  method: string;
  params?: unknown;
}

/** A notification either side sends. */
export interface AcpNotificationMessage {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** A response either side sends. */
export interface AcpResponseMessage {
  jsonrpc: "2.0";
  id: AcpId;
  result?: unknown;
  error?: AcpError;
}

export type AcpNotificationHandler = (method: string, params: unknown) => void;

/**
 * Handle an agent→client request. The returned value becomes the response's
 * `result`; throwing becomes a JSON-RPC error response. A handler that never
 * resolves holds the agent's request open, which is exactly what a permission
 * prompt is.
 */
export type AcpRequestHandler = (method: string, params: unknown) => Promise<unknown>;

/** The error a request rejects with when the process goes away. */
export class AcpClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpClosedError";
  }
}

/** The error a request rejects with when the agent answers with an error. */
export class AcpRequestError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(method: string, error: AcpError) {
    super(`${method}: ${error.message}`);
    this.name = "AcpRequestError";
    this.code = error.code;
    this.data = error.data;
  }
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/**
 * Correlates JSON-RPC traffic with pending promises.
 *
 * Every outbound line goes through `write`; every inbound line goes through
 * {@link handleLine}. Once {@link fail} runs — the process exited, or a fatal
 * protocol error — new requests reject immediately rather than hanging on a
 * peer that will never answer.
 */
export class AcpClient {
  private readonly writeLine: (line: string) => void;
  private readonly pending = new Map<AcpId, Pending>();
  private nextId = 1;
  private closedReason: string | null = null;
  private notificationHandler: AcpNotificationHandler | null = null;
  private requestHandler: AcpRequestHandler | null = null;

  constructor(writeLine: (line: string) => void) {
    this.writeLine = writeLine;
  }

  /** Route incoming agent notifications. */
  onNotification(handler: AcpNotificationHandler): void {
    this.notificationHandler = handler;
  }

  /** Route agent→client requests. Unset means every request is refused. */
  onRequest(handler: AcpRequestHandler): void {
    this.requestHandler = handler;
  }

  /** Whether the client is still able to send. */
  get isOpen(): boolean {
    return this.closedReason === null;
  }

  /** Send a request and resolve with its `result`. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closedReason !== null) {
      return Promise.reject(new AcpClosedError(this.closedReason));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      const message: AcpRequestMessage = { jsonrpc: "2.0", id, method };
      if (params !== undefined) message.params = params;
      this.writeLine(JSON.stringify(message));
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.closedReason !== null) return;
    const message: AcpNotificationMessage = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.writeLine(JSON.stringify(message));
  }

  /**
   * Feed one inbound line. Malformed lines are ignored (and logged by the
   * caller's stderr capture) — one bad line must not take the session down.
   */
  handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.error(`[tugcode] opencode: dropping non-JSON line: ${trimmed.slice(0, 200)}`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const msg = parsed as Record<string, unknown>;
    const hasMethod = typeof msg.method === "string";
    const hasId = typeof msg.id === "number" || typeof msg.id === "string";

    if (hasMethod && hasId) {
      void this.dispatchRequest(msg.id as AcpId, msg.method as string, msg.params);
      return;
    }
    if (hasMethod) {
      this.notificationHandler?.(msg.method as string, msg.params);
      return;
    }
    if (hasId) {
      this.resolveResponse(msg);
    }
  }

  /**
   * The peer is gone. Reject every pending request; later requests reject
   * immediately. Idempotent.
   */
  fail(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      entry.reject(new AcpClosedError(`${entry.method}: ${reason}`));
    }
  }

  private resolveResponse(msg: Record<string, unknown>): void {
    const id = msg.id as AcpId;
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    const error = msg.error;
    if (typeof error === "object" && error !== null) {
      const e = error as Record<string, unknown>;
      entry.reject(
        new AcpRequestError(entry.method, {
          code: typeof e.code === "number" ? e.code : -32603,
          message: typeof e.message === "string" ? e.message : "unknown error",
          data: e.data,
        }),
      );
      return;
    }
    entry.resolve(msg.result);
  }

  private async dispatchRequest(id: AcpId, method: string, params: unknown): Promise<void> {
    if (this.requestHandler === null) {
      this.writeResponse(id, undefined, {
        code: -32601,
        message: `unsupported request: ${method}`,
      });
      return;
    }
    try {
      const result = await this.requestHandler(method, params);
      this.writeResponse(id, result, undefined);
    } catch (err) {
      this.writeResponse(id, undefined, {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private writeResponse(id: AcpId, result: unknown, error: AcpError | undefined): void {
    if (this.closedReason !== null) return;
    const message: AcpResponseMessage =
      error === undefined
        ? { jsonrpc: "2.0", id, result: result ?? null }
        : { jsonrpc: "2.0", id, error };
    this.writeLine(JSON.stringify(message));
  }
}
