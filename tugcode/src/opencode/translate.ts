/**
 * translate — the pure half of the opencode backend.
 *
 * ACP's vocabulary is not Tug's: it carries tool calls as status-bearing
 * `tool_call` / `tool_call_update` notifications rather than a tool_use /
 * tool_result pair, permissions as an option list rather than an allow/deny
 * decision, and questions as a JSON Schema rather than Tug's
 * {@link QuestionDef} list. Every mapping between the two lives here as a
 * pure function, so the transport (`session.ts`) stays a router and the rules
 * are testable without a subprocess or a wire.
 *
 * @module opencode/translate
 */

import type { QuestionDef } from "../types.ts";

/** Narrow an unknown to a plain object (not null, not array). */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read a string field, or `null` when absent / mistyped. */
export function readString(obj: Record<string, unknown> | null, key: string): string | null {
  if (obj === null) return null;
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

/** Read a finite number field, or `null` when absent / mistyped. */
export function readNumber(obj: Record<string, unknown> | null, key: string): number | null {
  if (obj === null) return null;
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Read an array field, or an empty array when absent / mistyped. */
export function readArray(obj: Record<string, unknown> | null, key: string): unknown[] {
  if (obj === null) return [];
  const value = obj[key];
  return Array.isArray(value) ? value : [];
}

/**
 * The text of an ACP content block or content-block array.
 *
 * ACP reuses Anthropic's block shape for message content (`{type:"text",
 * text}` and `{type:"image", …}`) and wraps tool output in a
 * `{type:"content", content:{…}}` envelope. Text is concatenated in order;
 * anything without text contributes nothing.
 */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => contentText(part)).join("");
  }
  const obj = asRecord(content);
  if (obj === null) return "";
  const text = readString(obj, "text");
  if (text !== null) return text;
  if (obj.content !== undefined) return contentText(obj.content);
  return "";
}

/**
 * Render a tool call's content for Tug's `tool_result.output`.
 *
 * The result block is display text, so the mapping is display-oriented: ACP
 * `content` parts contribute their text, a `diff` part becomes a unified-diff
 * preamble naming the file (the deck renders the diff from the tool input
 * where it can, and a raw patch here reads as noise), and an update with only
 * `rawOutput` falls back to its JSON.
 */
export function renderToolOutput(content: unknown, rawOutput: unknown): string {
  const parts = Array.isArray(content) ? content : [];
  const rendered: string[] = [];
  for (const part of parts) {
    const obj = asRecord(part);
    if (obj === null) continue;
    const kind = readString(obj, "type");
    if (kind === "content") {
      const text = contentText(obj.content);
      if (text !== "") rendered.push(text);
    } else if (kind === "diff") {
      const path = readString(obj, "path");
      if (path !== null) rendered.push(`diff: ${path}`);
    } else {
      const text = contentText(obj);
      if (text !== "") rendered.push(text);
    }
  }
  if (rendered.length > 0) return rendered.join("\n");
  if (typeof rawOutput === "string") return rawOutput;
  if (rawOutput !== undefined && rawOutput !== null) {
    try {
      return JSON.stringify(rawOutput);
    } catch {
      return String(rawOutput);
    }
  }
  return "";
}

/**
 * The prompt text a tool call carries, used for the input preview Tug shows
 * while a call is in flight: ACP's `title` is the agent's own one-line
 * description of the call, which is what the block wants.
 */
export function toolCallLabel(update: Record<string, unknown>): string {
  const title = readString(update, "title");
  if (title !== null && title !== "") return title;
  const kind = readString(update, "kind");
  if (kind !== null && kind !== "") return kind;
  return "tool";
}

/**
 * The tool name Tug files a call under.
 *
 * ACP names a call by its `kind` (`read`, `edit`, `execute`, `search`,
 * `fetch`, `think`, `other`), not by a tool name. Tug's transcript renders
 * per-tool chrome from the name, so the kind is title-cased into one
 * (`read` → `Read`), and `title` — which for opencode starts with the tool's
 * own name, e.g. `Read src/main.rs` — supplies the first word when the kind
 * is absent or `other`.
 */
export function toolNameOf(update: Record<string, unknown>): string {
  const kind = readString(update, "kind");
  if (kind !== null && kind !== "" && kind !== "other") {
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
  const title = readString(update, "title");
  if (title !== null) {
    const first = title.trim().split(/\s+/, 1)[0];
    if (first !== undefined && first !== "") {
      return first.charAt(0).toUpperCase() + first.slice(1);
    }
  }
  return "Tool";
}

/** The option ids a `session/request_permission` offers, grouped by intent. */
export interface PermissionChoices {
  /** Allow once — the common "yes" and Tug's plain allow. */
  allowId: string | null;
  /** Allow for the rest of the session, when the agent offers it. */
  allowAlwaysId: string | null;
  /** Reject — Tug's deny. */
  denyId: string | null;
}

/**
 * Choose the option ids a Tug allow/deny answer maps onto.
 *
 * ACP options carry a `kind` (`allow_once`, `allow_always`, `reject_once`,
 * `reject_always`) and a display `optionId`. Kind wins; an agent that omits
 * kinds falls back to matching the option's name/optionId, and an agent that
 * offers neither is answered with its first option for allow and its refusal
 * option for deny. `null` means the agent offered nothing usable, which the
 * caller treats as a cancelled prompt rather than guessing.
 */
export function permissionChoices(options: unknown): PermissionChoices {
  const entries: Array<{ optionId: string; kind: string; name: string }> = [];
  for (const raw of Array.isArray(options) ? options : []) {
    const obj = asRecord(raw);
    if (obj === null) continue;
    const optionId = readString(obj, "optionId");
    if (optionId === null) continue;
    entries.push({
      optionId,
      kind: readString(obj, "kind") ?? "",
      name: (readString(obj, "name") ?? "").toLowerCase(),
    });
  }

  const pick = (kinds: string[], words: RegExp): string | null => {
    const byKind = entries.find((e) => kinds.includes(e.kind));
    if (byKind !== undefined) return byKind.optionId;
    const byWord = entries.find((e) => words.test(`${e.name} ${e.optionId.toLowerCase()}`));
    return byWord?.optionId ?? null;
  };

  const allowId =
    pick(["allow_once", "allow"], /allow|approve|accept|yes|once/) ??
    entries.find((e) => e.kind === "allow_always")?.optionId ??
    null;
  const denyId = pick(
    ["reject_once", "reject"],
    /reject|deny|decline|no|cancel/,
  );
  return {
    allowId,
    allowAlwaysId: pick(["allow_always"], /always/) ?? null,
    denyId,
  };
}

/**
 * Map an `elicitation/create` request's JSON Schema onto Tug's question
 * list.
 *
 * ACP asks a form (`{type:"object", properties:{key:{type,title,description,
 * enum|oneOf}}}`); Tug asks a list of questions with a choice or free-text
 * answer. Each property becomes one question keyed by its property name (the
 * answer comes back keyed the same way), titled by `title` (else the key).
 * An enum or `oneOf` becomes a single-choice question; an array becomes a
 * multi-choice; everything else is free text. A schema with no properties —
 * or one this function cannot read — yields an empty list, which the caller
 * answers by declining the request rather than showing an empty dialog.
 */
export function elicitationQuestions(params: unknown): QuestionDef[] {
  const requestedSchema = asRecord(asRecord(params)?.requestedSchema);
  const properties = asRecord(requestedSchema?.properties);
  if (properties === null) return [];
  const questions: QuestionDef[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const property = asRecord(raw);
    if (property === null) continue;
    const text = readString(property, "title") ?? key;
    const enumValues = readArray(property, "enum").filter(
      (v): v is string => typeof v === "string",
    );
    const oneOf = readArray(property, "oneOf");
    const options: Array<{ label: string }> = [];
    if (enumValues.length > 0) {
      for (const value of enumValues) options.push({ label: value });
    } else {
      for (const entry of oneOf) {
        const option = asRecord(entry);
        if (option === null) continue;
        const label = readString(option, "title") ?? readString(option, "const");
        if (label !== null) options.push({ label });
      }
    }
    if (options.length > 0) {
      const question: QuestionDef = {
        id: key,
        text,
        type: readString(property, "type") === "array" ? "multi_choice" : "single_choice",
        options,
      };
      questions.push(question);
    } else {
      questions.push({ id: key, text, type: "text" });
    }
  }
  return questions;
}

/**
 * Turn Tug's answer map back into the `content` object an elicitation
 * `accept` carries.
 *
 * Tug keys answers by question **text** (the label the dialog showed); ACP
 * keys the content object by **property name**. This function walks the
 * questions in schema order and, for each, looks the answer up by text and
 * then by id. Multi-choice answers arrive as a comma-joined label list from
 * the dialog, and are split back into an array for an array-typed property.
 * Questions the user left blank are omitted, which `accept` treats as
 * "unspecified".
 */
export function elicitationContent(
  questions: QuestionDef[],
  answers: Record<string, string>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const question of questions) {
    const raw = answers[question.text] ?? answers[question.id];
    if (raw === undefined) continue;
    if (question.type === "multi_choice") {
      const selected = raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "");
      content[question.id] = selected;
    } else {
      content[question.id] = raw;
    }
  }
  return content;
}

/**
 * The stop reason a `session/prompt` result carries, normalized onto Tug's
 * turn classification. ACP's vocabulary is small (`end_turn`, `max_tokens`,
 * `max_turn_requests`, `refusal`, `cancelled`); an unknown value is read as a
 * completed turn, since the prompt did return.
 */
export function stopReasonOf(result: unknown): string {
  return readString(asRecord(result), "stopReason") ?? "end_turn";
}
