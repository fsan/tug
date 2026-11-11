/**
 * `SessionRouteIndicatorBadge` — the Z4B coding-agent indicator badge for
 * the Session card's prompt-entry toolbar.
 *
 * Names the destination the prompt targets. Rendered as a two-line
 * `TugPushButton` (`layout="label-top"`): the agent's name over the version of
 * the bridge process answering for it, matching the other Z4B chrome chips. The
 * caption is the session's **agent** (`session_capabilities.agent`), so a card
 * running OpenCode says so rather than wearing Claude Code's name — the one
 * chrome that tells a user which backend their prompt reaches without opening a
 * sheet.
 *
 * The value is the running bridge's version (with `· N events` appended on
 * drift, flagged with a `TriangleAlert` icon and a `data-drift` hook when the
 * dispatch detected drift, [D04] / [Q03]). A **left click** opens the coding
 * agent picker — the chip names which backend the prompt reaches, so clicking
 * the name is how a user changes it; a **right click** opens the report
 * popover listing running / validated versions and any drift events. Falls
 * back to the tugbank-persisted last-known version before the live handshake
 * reports one, or `?` when none has ever been seen.
 *
 * The agent's changelog / docs link is not on this chip: it is the AI
 * configuration sheet's footer link ({@link agentDocsUrl}), which the sheet
 * renders for whichever agent the session runs.
 *
 * The last-known version is persisted **per agent** under one domain
 * ({@link AGENT_VERSION_DOMAIN}): Claude Code's stream-json version and
 * OpenCode's ACP agent version are different numbers from different products,
 * and one slot would have each new session greet a switch with the other
 * backend's version. Drift detection is Claude Code's alone — it compares the
 * running stream-json version against the one Tug validates — so an OpenCode
 * session shows the plain running version and no validated row.
 *
 * Laws:
 *  - [L02] external state enters through `useSyncExternalStore` — the
 *    `CodeSessionStore` transcript and `SessionMetadataStore` version are
 *    subscribed, never mirrored into React state.
 *  - [L06] no React state for appearance — the report popover's
 *    open/closed state is owned by `TugPopover` and driven imperatively
 *    (`handle.open()` on right-click); the drift treatment is pure
 *    render from the derived summary.
 *  - [L11] the chip emits no chain action — its left click opens the agent
 *    picker through the card's own sheet door and its right click opens the
 *    report popover via the imperative handle; `TugPopover` owns the
 *    disclosure.
 *  - [L19] file pair (`.tsx` + `.css`); the report node carries
 *    `data-slot="session-route-indicator-badge-report"`.
 *  - [L20] owns only the `--tugx-route-indicator-*` report-geometry
 *    slots; composes `TugPushButton` (the chip) and `SessionCautionBadge`
 *    (the report rows), each of which keeps its own tokens.
 *
 * @module components/tugways/chrome/session-route-indicator-badge
 */

import "./session-route-indicator-badge.css";

import React, { useCallback, useEffect, useMemo } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { TriangleAlert } from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import {
  TugPopover,
  TugPopoverAnchor,
  TugPopoverContent,
  type TugPopoverHandle,
} from "@/components/tugways/tug-popover";
import {
  agentLabel,
  DEFAULT_AGENT_KIND,
  type AgentKind,
} from "@tugproto/agent";
import {
  VALIDATED_CC_VERSION,
  logDriftEvent,
  summarizeDrift,
  type DriftEvent,
} from "@/components/tugways/cards/session-assistant-renderer-dispatch";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type { SessionMetadataStore } from "@/lib/session-metadata-store";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import type { TaggedValue } from "@/lib/tugbank-client";

import { SessionCautionBadge } from "./session-caution-badge";

// ── External links ─────────────────────────────────────────────────────────

/**
 * Anthropic's Claude Code changelog, opened by the AI configuration sheet's
 * footer link — the home of the version/drift report's companion "where does
 * this number come from" door. (The Code-route chip itself opens the agent
 * picker on a left click and the report on a right click.)
 */
export const CLAUDE_CODE_CHANGELOG_URL =
  "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md";

/** Where a click on an OpenCode badge goes — the project's documentation. */
export const OPENCODE_DOCS_URL = "https://opencode.ai/docs/";

/** The docs link beside the version in the AI sheet's footer. */
export function agentDocsUrl(agent: AgentKind): string {
  return agent === "opencode" ? OPENCODE_DOCS_URL : CLAUDE_CODE_CHANGELOG_URL;
}

/** The word the footer link calls that destination. */
export function agentDocsLabel(agent: AgentKind): string {
  return agent === "opencode" ? "docs" : "changelog";
}

// ── Last-known version persistence ─────────────────────────────────────────

/**
 * tugbank slot for the most recent bridge version seen for an agent. The badge
 * falls back to it before the live session reports one, so a version number
 * shows immediately; the mixer sheet's footer version line reads the same slot.
 * One domain, one key per agent — see {@link versionKeyFor}.
 */
export const AGENT_VERSION_DOMAIN = "dev.tugapp.dev";

/**
 * The Claude Code key. Its name predates the choice of agent and is kept as-is:
 * it is already written on every machine, and renaming it would blank the
 * badge of every session until a new version arrived.
 */
export const CC_VERSION_KEY = "ccVersion";

/** The OpenCode key — its own slot, so the two products never overwrite each other. */
export const OPENCODE_VERSION_KEY = "opencodeVersion";

/** The tugbank key an agent's last-known version lives under. */
export function versionKeyFor(agent: AgentKind): string {
  return agent === "opencode" ? OPENCODE_VERSION_KEY : CC_VERSION_KEY;
}

/** Read the persisted last-known version from its tugbank tagged value. */
export function parseLastKnownVersion(
  entry: TaggedValue | undefined,
): string | null {
  return entry?.kind === "string" && typeof entry.value === "string"
    ? entry.value
    : null;
}

/**
 * Persist `version` as the last-known version for `agent` (fire-and-forget).
 * A failure logs and vanishes: the slot is a nicety that saves the badge one
 * "?" on the next fresh card, never a source of truth.
 */
function persistLastKnownVersion(agent: AgentKind, version: string): void {
  const url = `/api/defaults/${AGENT_VERSION_DOMAIN}/${versionKeyFor(agent)}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: version }),
  }).catch((err) => {
    console.warn("[SessionRouteIndicatorBadge] persist version failed:", err);
  });
}

export interface SessionRouteIndicatorBadgeProps {
  /**
   * Session store — its committed transcript is walked for tool-call
   * drift (unknown tool names, unknown structured-result shapes). Read
   * only on the `Code` branch.
   */
  codeSessionStore: CodeSessionStore;
  /**
   * Session-metadata store — supplies `system_metadata.version`, both
   * for display and for the version-drift check. Omitted in gallery /
   * fixture mounts, where the badge has no version to show. Read only
   * on the `Code` branch.
   */
  sessionMetadataStore?: SessionMetadataStore;
  /**
   * Left click — open the coding agent picker. Required rather than optional:
   * a chip named for the running backend that did nothing on a click would
   * read as broken, so every mount must say where its click goes.
   */
  onOpenAgentSheet: () => void;
  /** Forwarded class name for cascade-scoped customization. */
  className?: string;
  /** Author the chip into a focus group ([P02]) — forwarded to the composed
   *  {@link TugPushButton}. The session card passes its cycle group so the chip
   *  becomes a keyboard-focus-cycling stop; omitted elsewhere. */
  focusGroup?: string;
  /** Order within {@link focusGroup}. */
  focusOrder?: number;
}

/** Stable list key for a drift event row. */
function driftEventKey(event: DriftEvent): string {
  return `${event.caution.reason}:${event.toolUseId ?? "version"}`;
}

/** `1 event` / `N events`. */
function eventCountLabel(count: number): string {
  return `${count} ${count === 1 ? "event" : "events"}`;
}

/**
 * The route-aware indicator badge. See the module docstring for the
 * route→content table, mount-identity contract, and per-branch
 * behavior.
 */
export function SessionRouteIndicatorBadge({
  codeSessionStore,
  sessionMetadataStore,
  onOpenAgentSheet,
  className,
  focusGroup,
  focusOrder,
}: SessionRouteIndicatorBadgeProps): React.ReactElement {
  // Narrowed to `transcript` — the only snapshot field the drift walk
  // reads. The committed transcript array's reference changes once per
  // turn commit, so the badge does not re-render on every streaming
  // delta the way a whole-snapshot subscription would.
  const transcript = useSyncExternalStore(
    codeSessionStore.subscribe,
    useCallback(
      () => codeSessionStore.getSnapshot().transcript,
      [codeSessionStore],
    ),
  );
  const subscribeMetadata = useCallback(
    (listener: () => void) =>
      sessionMetadataStore !== undefined
        ? sessionMetadataStore.subscribe(listener)
        : () => {},
    [sessionMetadataStore],
  );
  const version = useSyncExternalStore(
    subscribeMetadata,
    useCallback(
      () => sessionMetadataStore?.getSnapshot().version ?? null,
      [sessionMetadataStore],
    ),
  );
  // The agent the session reports — the caption, and which version slot the
  // fallback reads. Absent (an older bridge) means Claude Code.
  const agent = useSyncExternalStore(
    subscribeMetadata,
    useCallback(
      () => sessionMetadataStore?.getSnapshot().agent ?? DEFAULT_AGENT_KIND,
      [sessionMetadataStore],
    ),
  );

  // Last version seen in a prior session of the same agent — the fallback the
  // badge shows before the live handshake reports one. [L02].
  const lastKnownVersion = useTugbankValue<string | null>(
    AGENT_VERSION_DOMAIN,
    versionKeyFor(agent),
    parseLastKnownVersion,
    null,
  );

  // Drift is Claude Code's alone: it compares the running stream-json version
  // (and the tool names it emits) against what Tug validates. An OpenCode
  // session's tool names come from ACP kinds, so running the same walk would
  // report every tool call as unknown.
  const summary = useMemo(() => {
    if (agent !== "claude-code") {
      return summarizeDrift({ toolCalls: [], version: null });
    }
    const toolCalls = transcript.flatMap((turn) =>
      turn.messages.filter(
        (m): m is import("@/lib/code-session-store").ToolUseMessage =>
          m.kind === "tool_use",
      ),
    );
    return summarizeDrift({ toolCalls, version });
  }, [agent, transcript, version]);

  // Triage logging. `logDriftEvent` dedupes by occurrence, so this
  // effect re-running on unrelated renders never spams the console.
  useEffect(() => {
    for (const event of summary.events) logDriftEvent(event);
  }, [summary]);

  // Persist each live version as it arrives so the next session has a
  // fallback. Skipped when it already matches what's stored.
  useEffect(() => {
    if (version !== null && version !== lastKnownVersion) {
      persistLastKnownVersion(agent, version);
    }
  }, [agent, version, lastKnownVersion]);

  // The version shown on the badge face: the live version when the
  // session has reported one, else the last-known version.
  const displayVersion = version ?? lastKnownVersion;

  const hasDrift = summary.count > 0;
  const cls =
    className === undefined
      ? "session-route-indicator-badge"
      : `session-route-indicator-badge ${className}`;

  // Content line: the running bridge's version, with the drift event count
  // appended when drift is present (the running / validated split and the full
  // event list live in the click-expand report). `?` until any version has been
  // seen.
  let codeContent: string;
  if (displayVersion === null) {
    codeContent = "?";
  } else if (!hasDrift) {
    codeContent = displayVersion;
  } else {
    codeContent = `${version ?? displayVersion} · ${eventCountLabel(summary.count)}`;
  }

  const caption = agentLabel(agent);
  const content = codeContent;

  // Imperative handle for the report popover — opened on right-click of
  // the chip ([D13]). Left click belongs to the agent picker, so the
  // disclosure is driven imperatively rather than by a `TugPopoverTrigger`'s
  // click-toggle.
  const popoverRef = React.useRef<TugPopoverHandle>(null);

  // Left click opens the coding agent picker.
  const handleClick = (): void => onOpenAgentSheet();

  // Right click opens the version / drift report popover.
  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    popoverRef.current?.open();
  };

  // Tooltip carries the version plus the affordance hint; it surfaces the
  // drift count so the signal survives even without opening the report.
  const title = hasDrift
    ? `${caption} ${version ?? displayVersion ?? "?"} · ${eventCountLabel(summary.count)} drift — click to choose the coding agent, right-click for report`
    : `${caption} ${displayVersion ?? "?"} — click to choose the coding agent, right-click for report`;

  return (
    <TugPopover ref={popoverRef}>
      <TugPopoverAnchor>
        <TugPushButton
          layout="label-top"
          label={caption}
          emphasis="tinted"
          role="action"
          size="sm"
          icon={hasDrift ? <TriangleAlert aria-hidden="true" /> : undefined}
          className={cls}
          data-route="code"
          data-drift={hasDrift ? "" : undefined}
          data-slot="session-route-indicator-badge"
          focusGroup={focusGroup}
          focusOrder={focusOrder}
          aria-label={`${caption} — choose the coding agent`}
          title={title}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
        >
          {content}
        </TugPushButton>
      </TugPopoverAnchor>
      {(
        <TugPopoverContent side="top" align="end" sideOffset={8} arrow spaceDismisses>
          <div
            className="session-route-indicator-badge-report"
            data-slot="session-route-indicator-badge-report"
          >
            <div className="session-route-indicator-badge-report-title">
              {agent === "opencode" ? "OpenCode ACP" : "Claude Code stream-json"}
            </div>
            <div className="session-route-indicator-badge-versions">
              <div className="session-route-indicator-badge-version-row">
                <span className="session-route-indicator-badge-version-label">
                  running
                </span>
                <span className="session-route-indicator-badge-version-value">
                  {version ?? "—"}
                </span>
              </div>
              {/* Tug validates one stream-json version; there is no such
                  pin for an ACP agent, and inventing one would report drift
                  that means nothing. */}
              {agent === "claude-code" && (
                <div className="session-route-indicator-badge-version-row">
                  <span className="session-route-indicator-badge-version-label">
                    validated
                  </span>
                  <span className="session-route-indicator-badge-version-value">
                    {VALIDATED_CC_VERSION}
                  </span>
                </div>
              )}
            </div>
            {hasDrift && (
              <ul className="session-route-indicator-badge-report-list">
                {summary.events.map((event) => (
                  <li
                    key={driftEventKey(event)}
                    className="session-route-indicator-badge-report-row"
                  >
                    <SessionCautionBadge caution={event.caution} />
                    <span className="session-route-indicator-badge-report-detail">
                      {event.caution.detail ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </TugPopoverContent>
      )}
    </TugPopover>
  );
}
