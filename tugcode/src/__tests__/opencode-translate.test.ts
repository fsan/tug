/**
 * opencode-translate.test.ts — the pure ACP ↔ Tug vocabulary mapping.
 *
 * No subprocess, no wire: every rule the opencode backend relies on to make an
 * ACP agent read like a Claude Code session is pinned here. The transport that
 * applies these rules (handshake, turns, replay) is covered by
 * `opencode-session.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import {
  asRecord,
  contentText,
  elicitationContent,
  elicitationQuestions,
  permissionChoices,
  readArray,
  readNumber,
  readString,
  renderToolOutput,
  stopReasonOf,
  toolCallLabel,
  toolNameOf,
} from "../opencode/translate.ts";

describe("shape readers", () => {
  test("asRecord accepts plain objects and refuses null and arrays", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(null)).toBeNull();
    expect(asRecord([1, 2])).toBeNull();
    expect(asRecord("text")).toBeNull();
  });

  test("a mistyped field reads as absent", () => {
    const obj = { name: "ok", count: 3, bad: "3", list: "nope" } as Record<string, unknown>;
    expect(readString(obj, "name")).toBe("ok");
    expect(readString(obj, "bad")).toBe("3");
    expect(readString(obj, "count")).toBeNull();
    expect(readNumber(obj, "count")).toBe(3);
    expect(readNumber(obj, "bad")).toBeNull();
    expect(readNumber({ count: Number.NaN }, "count")).toBeNull();
    expect(readArray(obj, "list")).toEqual([]);
    expect(readArray(null, "list")).toEqual([]);
  });
});

describe("contentText", () => {
  test("a string is its own text", () => {
    expect(contentText("hello")).toBe("hello");
  });

  test("text blocks concatenate in order", () => {
    expect(
      contentText([
        { type: "text", text: "one " },
        { type: "text", text: "two" },
      ]),
    ).toBe("one two");
  });

  test("a content envelope unwraps to the block inside it", () => {
    expect(
      contentText({ type: "content", content: { type: "text", text: "inside" } }),
    ).toBe("inside");
  });

  test("an image block contributes nothing", () => {
    expect(
      contentText([
        { type: "image", mimeType: "image/png", data: "…" },
        { type: "text", text: "caption" },
      ]),
    ).toBe("caption");
  });
});

describe("renderToolOutput", () => {
  test("content parts contribute their text, joined by newlines", () => {
    expect(
      renderToolOutput(
        [
          { type: "content", content: { type: "text", text: "line one" } },
          { type: "content", content: { type: "text", text: "line two" } },
        ],
        undefined,
      ),
    ).toBe("line one\nline two");
  });

  test("a diff part is named, not dumped", () => {
    expect(
      renderToolOutput([{ type: "diff", path: "src/main.rs", oldText: "a", newText: "b" }], undefined),
    ).toBe("diff: src/main.rs");
  });

  test("with no renderable content the raw output stands in", () => {
    expect(renderToolOutput([], "raw string")).toBe("raw string");
    expect(renderToolOutput(undefined, { exitCode: 0 })).toBe('{"exitCode":0}');
    expect(renderToolOutput(undefined, undefined)).toBe("");
  });
});

describe("toolNameOf / toolCallLabel", () => {
  test("a kind is title-cased into the tool name", () => {
    expect(toolNameOf({ kind: "read" })).toBe("Read");
    expect(toolNameOf({ kind: "execute" })).toBe("Execute");
  });

  test("`other` and an absent kind fall back to the title's first word", () => {
    expect(toolNameOf({ kind: "other", title: "Bash ls -la" })).toBe("Bash");
    expect(toolNameOf({ title: "  search the tree" })).toBe("Search");
  });

  test("with nothing to name it by the call is a Tool", () => {
    expect(toolNameOf({})).toBe("Tool");
    expect(toolNameOf({ kind: "other", title: "   " })).toBe("Tool");
  });

  test("the label is the agent's own title, else its kind", () => {
    expect(toolCallLabel({ title: "Read src/main.rs", kind: "read" })).toBe(
      "Read src/main.rs",
    );
    expect(toolCallLabel({ kind: "fetch" })).toBe("fetch");
    expect(toolCallLabel({})).toBe("tool");
  });
});

describe("permissionChoices", () => {
  test("kinds decide the mapping", () => {
    expect(
      permissionChoices([
        { optionId: "yes", kind: "allow_once", name: "Allow once" },
        { optionId: "always", kind: "allow_always", name: "Always" },
        { optionId: "no", kind: "reject_once", name: "Reject" },
      ]),
    ).toEqual({ allowId: "yes", allowAlwaysId: "always", denyId: "no" });
  });

  test("an agent that omits kinds is matched by its option words", () => {
    expect(
      permissionChoices([
        { optionId: "a", name: "Approve" },
        { optionId: "d", name: "Decline" },
      ]),
    ).toEqual({ allowId: "a", allowAlwaysId: null, denyId: "d" });
  });

  test("only an allow-always option still answers allow", () => {
    expect(
      permissionChoices([{ optionId: "always", kind: "allow_always" }]),
    ).toEqual({ allowId: "always", allowAlwaysId: "always", denyId: null });
  });

  test("nothing usable yields three nulls rather than a guess", () => {
    expect(permissionChoices(undefined)).toEqual({
      allowId: null,
      allowAlwaysId: null,
      denyId: null,
    });
    expect(permissionChoices([{ name: "?" }])).toEqual({
      allowId: null,
      allowAlwaysId: null,
      denyId: null,
    });
  });
});

describe("elicitationQuestions", () => {
  const params = {
    message: "Choose",
    requestedSchema: {
      type: "object",
      properties: {
        flavor: {
          type: "string",
          title: "Which flavor?",
          enum: ["vanilla", "chocolate"],
        },
        toppings: {
          type: "array",
          title: "Toppings",
          enum: ["nuts", "sprinkles"],
        },
        size: {
          type: "string",
          oneOf: [
            { const: "s", title: "Small" },
            { const: "l", title: "Large" },
          ],
        },
        note: { type: "string", description: "Anything else?" },
      },
    },
  };

  test("each property becomes one question, typed by its schema", () => {
    expect(elicitationQuestions(params)).toEqual([
      {
        id: "flavor",
        text: "Which flavor?",
        type: "single_choice",
        options: [{ label: "vanilla" }, { label: "chocolate" }],
      },
      {
        id: "toppings",
        text: "Toppings",
        type: "multi_choice",
        options: [{ label: "nuts" }, { label: "sprinkles" }],
      },
      {
        id: "size",
        text: "size",
        type: "single_choice",
        options: [{ label: "Small" }, { label: "Large" }],
      },
      {
        id: "note",
        text: "note",
        type: "text",
      },
    ]);
  });

  test("a schema with nothing to ask yields no questions", () => {
    expect(elicitationQuestions(undefined)).toEqual([]);
    expect(elicitationQuestions({ requestedSchema: {} })).toEqual([]);
  });
});

describe("elicitationContent", () => {
  const questions = elicitationQuestions({
    requestedSchema: {
      type: "object",
      properties: {
        flavor: { type: "string", title: "Which flavor?", enum: ["vanilla", "chocolate"] },
        toppings: { type: "array", title: "Toppings", enum: ["nuts", "sprinkles"] },
        note: { type: "string", title: "Note" },
      },
    },
  });

  test("answers keyed by the question text land on the property name", () => {
    expect(
      elicitationContent(questions, { "Which flavor?": "chocolate", Note: "no cone" }),
    ).toEqual({ flavor: "chocolate", note: "no cone" });
  });

  test("an answer keyed by id works too, and a multi-choice splits back apart", () => {
    expect(
      elicitationContent(questions, { toppings: "nuts, sprinkles" }),
    ).toEqual({ toppings: ["nuts", "sprinkles"] });
  });

  test("a blank answer is omitted, not sent empty", () => {
    expect(elicitationContent(questions, {})).toEqual({});
  });
});

describe("stopReasonOf", () => {
  test("reads the prompt result's stopReason", () => {
    expect(stopReasonOf({ stopReason: "cancelled" })).toBe("cancelled");
    expect(stopReasonOf({ stopReason: "refusal" })).toBe("refusal");
  });

  test("a result that says nothing is a completed turn", () => {
    expect(stopReasonOf(undefined)).toBe("end_turn");
    expect(stopReasonOf({})).toBe("end_turn");
  });
});
