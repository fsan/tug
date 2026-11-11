/**
 * agent.test.ts — the pure half of the coding-agent choice.
 *
 * No store, no DOM, no wire: the persisted-value parser, the seed resolver, the
 * `/agent` argument grammar, and the feature gate that decides which
 * locally-handled commands a session's agent can honour. The sheet, the spawn
 * payload, and the Settings row are covered by their own suites.
 */

import { describe, expect, test } from "bun:test";

import {
  AGENT_DESCRIPTIONS,
  parseAgentArgument,
  parsePersistedAgent,
  resolveSeedAgent,
  unsupportedFeatureNote,
} from "@/lib/agent";
import type { TaggedValue } from "@/lib/tugbank-client";
import {
  AGENT_FEATURES,
  AGENT_KINDS,
  CLAUDE_CODE_FEATURES,
  OPENCODE_FEATURES,
  agentFeatures,
  agentSupports,
} from "@tugproto/agent";

const stringValue = (value: string): TaggedValue => ({ kind: "string", value });

describe("parsePersistedAgent", () => {
  test("reads a known agent kind", () => {
    expect(parsePersistedAgent(stringValue("claude-code"))).toBe("claude-code");
    expect(parsePersistedAgent(stringValue("opencode"))).toBe("opencode");
  });

  test("an absent entry, another kind, or a future value yields null", () => {
    expect(parsePersistedAgent(undefined)).toBeNull();
    expect(parsePersistedAgent({ kind: "json", value: "opencode" })).toBeNull();
    expect(parsePersistedAgent(stringValue("aider"))).toBeNull();
  });
});

describe("resolveSeedAgent", () => {
  test("the per-card value wins over the deck default", () => {
    expect(resolveSeedAgent("opencode", "claude-code")).toBe("opencode");
  });

  test("the deck default seeds a card with nothing persisted", () => {
    expect(resolveSeedAgent(null, "opencode")).toBe("opencode");
  });

  test("with neither, Claude Code is the answer an absent value always meant", () => {
    expect(resolveSeedAgent(null, null)).toBe("claude-code");
  });
});

describe("parseAgentArgument", () => {
  test("accepts both wire names and the spoken shorthand", () => {
    expect(parseAgentArgument("opencode")).toBe("opencode");
    expect(parseAgentArgument("claude-code")).toBe("claude-code");
    expect(parseAgentArgument("claude")).toBe("claude-code");
  });

  test("is case- and whitespace-insensitive", () => {
    expect(parseAgentArgument("  OpenCode ")).toBe("opencode");
  });

  test("an unknown word yields null so the caller can answer it", () => {
    expect(parseAgentArgument("cursor")).toBeNull();
    expect(parseAgentArgument("")).toBeNull();
  });
});

describe("unsupportedFeatureNote", () => {
  test("a Claude Code session is offered every gated command", () => {
    for (const command of ["rewind", "btw", "add-dir", "agents", "skills", "hooks", "context"]) {
      expect(
        unsupportedFeatureNote("claude-code", CLAUDE_CODE_FEATURES, command),
      ).toBeNull();
    }
  });

  test("an OpenCode session is refused the surfaces its backend lacks, by name", () => {
    expect(unsupportedFeatureNote("opencode", OPENCODE_FEATURES, "rewind")).toBe(
      "/rewind is not available with OpenCode",
    );
    expect(unsupportedFeatureNote("opencode", OPENCODE_FEATURES, "skills")).toBe(
      "/skills is not available with OpenCode",
    );
    expect(unsupportedFeatureNote("opencode", OPENCODE_FEATURES, "btw")).toBe(
      "/btw is not available with OpenCode",
    );
  });

  test("a command with no agent-dependent surface is never refused", () => {
    for (const command of ["diff", "resume", "rename", "export", "agent"]) {
      expect(unsupportedFeatureNote("opencode", [], command)).toBeNull();
    }
  });

  test("the frame's list is authoritative over the kind's shipped set", () => {
    // A future backend that runs on OpenCode's kind but declares rewind works.
    expect(
      unsupportedFeatureNote("opencode", [...OPENCODE_FEATURES, "rewind"], "rewind"),
    ).toBeNull();
  });
});

describe("agent capability tables", () => {
  test("every agent has a description and a label", () => {
    for (const kind of AGENT_KINDS) {
      expect(AGENT_DESCRIPTIONS[kind].length).toBeGreaterThan(0);
      expect(agentFeatures(kind).length).toBeGreaterThan(0);
    }
  });

  test("Claude Code ships every declared surface", () => {
    for (const feature of AGENT_FEATURES) {
      expect(agentSupports("claude-code", feature)).toBe(true);
    }
  });

  test("OpenCode's first slice is replay and cost, and nothing it cannot honour", () => {
    expect(agentSupports("opencode", "replay")).toBe(true);
    expect(agentSupports("opencode", "cost")).toBe(true);
    for (const feature of ["rewind", "side_question", "add_directory", "subagents", "inventories", "context_breakdown"] as const) {
      expect(agentSupports("opencode", feature)).toBe(false);
    }
  });
});
