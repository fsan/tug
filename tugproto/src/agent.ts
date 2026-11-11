/**
 * tugproto/agent — the coding-agent vocabulary shared by tugdeck and tugcode.
 *
 * Tug's Session card was built around Claude Code: the bridge spawns `claude`
 * and translates its stream-json. A card may now run one of several coding
 * agents instead. The kind travels in two directions:
 *
 *  - **down** on the `spawn_session` CONTROL payload (tugdeck → tugcast →
 *    tugcode), where it selects the bridge backend;
 *  - **up** on the `session_capabilities` frame, so a card can gate the
 *    surfaces its agent does not implement.
 *
 * `claude-code` is the default and is what an absent field means, so an older
 * deck and an older tugcast keep working unchanged. The wire spelling is
 * kebab-case because it is a persisted tugbank value as well as a JSON field.
 *
 * Pure types + pure helpers — no React, no DOM, no Node/Bun API.
 *
 * @module tugproto/agent
 */

/** Every coding agent a session can run. */
export const AGENT_KINDS = ["claude-code", "opencode"] as const;

/** A coding agent's wire name. */
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * The agent a spawn runs when the payload names none.
 *
 * Claude Code is not merely the historical default; it is the one agent whose
 * conversation store, rewind, and subagent lanes Tug knows how to shape. A
 * session that predates this field is a Claude Code session.
 */
export const DEFAULT_AGENT_KIND: AgentKind = "claude-code";

/** Display names, used by the picker and by the route badge. */
export const AGENT_LABELS: Record<AgentKind, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
};

/**
 * Optional surfaces an agent may implement. The deck reads these off
 * `session_capabilities.features` to hide a control its agent cannot honour,
 * rather than offering a button that fails on the wire.
 *
 * The list is deliberately small and behavioural: it names a *Tug surface*, not
 * a protocol method, so a backend maps its own transport onto it.
 */
export const AGENT_FEATURES = [
  /** `/rewind` — restore a conversation to an earlier prompt. */
  "rewind",
  /** `/btw` — a side question that does not join the conversation. */
  "side_question",
  /** `/add-dir` — widen the session's working roots mid-life. */
  "add_directory",
  /** Subagent lanes attached to a parent tool call. */
  "subagents",
  /** The `/skills` and `/hooks` inventories. */
  "inventories",
  /** The context-window breakdown and token accounting. */
  "context_breakdown",
  /** Per-turn cost and usage telemetry. */
  "cost",
  /** Replaying a saved conversation on resume. */
  "replay",
] as const;

export type AgentFeature = (typeof AGENT_FEATURES)[number];

/** What Claude Code supports today. */
export const CLAUDE_CODE_FEATURES: readonly AgentFeature[] = AGENT_FEATURES;

/**
 * What the opencode backend supports in its first slice. The rest are the
 * capability-gated surfaces the feature deliberately leaves off: opencode's
 * ACP transport has no rewind, no subagent transcript lanes, and no Claude
 * plugin inventories.
 */
export const OPENCODE_FEATURES: readonly AgentFeature[] = [
  "replay",
  "cost",
];

/** Whether `value` names a known agent. */
export function isAgentKind(value: unknown): value is AgentKind {
  return (
    typeof value === "string" &&
    (AGENT_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Narrow an untrusted value (a persisted tugbank string, a wire field) to an
 * agent kind, falling back to {@link DEFAULT_AGENT_KIND}. The fallback is the
 * documented meaning of an absent field, not a guess between alternatives.
 */
export function parseAgentKind(value: unknown): AgentKind {
  return isAgentKind(value) ? value : DEFAULT_AGENT_KIND;
}

/** The display name for an agent. */
export function agentLabel(kind: AgentKind): string {
  return AGENT_LABELS[kind];
}

/**
 * The surfaces an agent implements when the wire says nothing narrower. A
 * `session_capabilities` frame from the backend is authoritative over this;
 * it exists so a deck that has not yet seen the handshake (or one talking to
 * a bridge older than the field) still knows what to offer.
 */
export function agentFeatures(kind: AgentKind): readonly AgentFeature[] {
  return kind === "opencode" ? OPENCODE_FEATURES : CLAUDE_CODE_FEATURES;
}

/** Whether `kind` implements `feature`. */
export function agentSupports(
  kind: AgentKind,
  feature: AgentFeature,
): boolean {
  return agentFeatures(kind).includes(feature);
}
