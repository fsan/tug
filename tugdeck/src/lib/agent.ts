/**
 * agent.ts — the deck's half of the coding-agent choice.
 *
 * A Session card runs one coding agent, named on its `spawn_session` payload
 * and echoed back on `session_capabilities.agent`. Two persisted values
 * decide what a card spawns with, and this module is the single resolver for
 * both — mirroring `permission-mode.ts`:
 *
 *  - the **per-card** agent, under {@link AGENT_DOMAIN}, written when the user
 *    switches a card's backend;
 *  - the **deck-wide default**, under {@link AGENT_DEFAULT_DOMAIN}, written from
 *    Settings and adopted by a card that has no per-card value of its own.
 *
 * The resolution is pure — {@link parsePersistedAgent} and
 * {@link resolveSeedAgent} read a tagged value and answer, and the spawn path
 * calls them through the tugbank cache exactly as it reads the permission mode.
 * The one writer, {@link writePersistedAgent}, has the same optimistic-cache +
 * PUT shape as `writePersistedPermissionMode`, because a card's agent is the
 * same kind of per-card setting.
 *
 * The module also owns the **feature gate** ({@link unsupportedFeatureNote})
 * that decides whether a locally-handled slash command is offered by the
 * session's agent, and the display copy for the picker and the Settings row.
 *
 * @module lib/agent
 */

import {
  type AgentFeature,
  agentLabel,
  DEFAULT_AGENT_KIND,
  isAgentKind,
  type AgentKind,
} from "@tugproto/agent";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import type { TaggedValue } from "@/lib/tugbank-client";

/**
 * tugbank domain for the per-card coding agent. A card reads its own value at
 * spawn time; a switch writes here and starts a fresh session, since an agent
 * is fixed for the life of the bridge process that serves it.
 */
export const AGENT_DOMAIN = "dev.agent";

/**
 * tugbank domain/key for the deck-wide default agent — what a card with
 * nothing persisted of its own spawns with.
 */
export const AGENT_DEFAULT_DOMAIN = "dev.tugapp.agent";
export const AGENT_DEFAULT_KEY = "default";

/**
 * Parse a persisted agent out of its tugbank tagged value, narrowed to a known
 * {@link AgentKind} (or `null`). The persisted string is untrusted: a value
 * from a future or corrupt build yields `null` (no restore) rather than being
 * sent as a backend the bridge would refuse.
 */
export function parsePersistedAgent(
  entry: TaggedValue | undefined,
): AgentKind | null {
  if (entry?.kind === "string" && isAgentKind(entry.value)) {
    return entry.value;
  }
  return null;
}

/**
 * The agent a freshly-spawned card should run: its own per-card value when
 * present, otherwise the deck-wide default, otherwise
 * {@link DEFAULT_AGENT_KIND} (Claude Code — the backend every session ran
 * before the choice existed).
 */
export function resolveSeedAgent(
  persisted: AgentKind | null,
  globalDefault: AgentKind | null,
): AgentKind {
  return persisted ?? globalDefault ?? DEFAULT_AGENT_KIND;
}

/**
 * One line per agent, for the picker and the Settings row — what choosing it
 * means for this card. The second line is the whole reason the picker exists
 * before the choice is made: an agent's missing surfaces are permanent for the
 * life of the session, so it says so here rather than in a refusal afterwards.
 */
export const AGENT_DESCRIPTIONS: Record<AgentKind, string> = {
  "claude-code":
    "Anthropic's Claude Code over stream-json — every Tug surface: rewind, side questions, subagent lanes, skills and hooks.",
  opencode:
    "OpenCode over ACP — provider-agnostic (Ollama, Bedrock, Anthropic). No rewind, side questions, subagent lanes, or skill hooks.",
};

/**
 * Recognize an `/agent` argument. The wire and tugbank spell the kind
 * kebab-case; `claude` is accepted because every user calls it that, and the
 * bare kind names match the picker's labels case-insensitively.
 */
export function parseAgentArgument(text: string): AgentKind | null {
  const word = text.trim().toLowerCase();
  if (word === "claude") return "claude-code";
  return isAgentKind(word) ? word : null;
}

/**
 * The caution shown when a locally-handled slash command's surface is not
 * implemented by the session's agent, or `null` when it is. Gating reads the
 * **frame's** feature list, not the kind's shipped set: a backend may declare
 * fewer surfaces than its kind defaults to, and the frame is authoritative.
 *
 * The sentence names both the command and the agent, because the refusal is
 * the only place the user learns that which agent runs decides what Tug can
 * offer.
 */
export function unsupportedFeatureNote(
  agent: AgentKind,
  features: readonly AgentFeature[],
  command: string,
): string | null {
  const feature = commandNeedsFeature(command);
  if (feature === undefined || features.includes(feature)) return null;
  return `/${command} is not available with ${agentLabel(agent)}`;
}

/**
 * The feature a locally-handled slash command needs, if any. Kept as its own
 * table so the gate and the command surfaces cannot drift, and so a command
 * with no entry needs nothing an agent can lack — it is Tug's own surface (a
 * project diff, a rename, a local export) and runs the same on every backend.
 */
export function commandNeedsFeature(
  command: string,
): AgentFeature | undefined {
  return COMMAND_FEATURES[command];
}

const COMMAND_FEATURES: Readonly<Record<string, AgentFeature>> = {
  rewind: "rewind",
  btw: "side_question",
  "add-dir": "add_directory",
  agents: "subagents",
  skills: "inventories",
  hooks: "inventories",
  context: "context_breakdown",
};

/**
 * Persist a card's coding agent: the optimistic local-cache write (so the spawn
 * reader sees the new value immediately and every `useTugbankValue` reader
 * re-renders) plus an HTTP PUT to the defaults endpoint. Mirrors
 * {@link writePersistedPermissionMode}; a PUT failure logs and the cache holds
 * for the page session.
 */
export function writePersistedAgent(cardId: string, agent: AgentKind): void {
  const client = getTugbankClient();
  if (client !== null) {
    client.setLocalValue(AGENT_DOMAIN, cardId, {
      kind: "string",
      value: agent,
    });
  }
  const url = `/api/defaults/${AGENT_DOMAIN}/${encodeURIComponent(cardId)}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: agent }),
  }).catch((err) => {
    console.warn(`[agent] PUT failed for card ${cardId}:`, err);
  });
}
