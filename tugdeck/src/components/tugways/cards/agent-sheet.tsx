/**
 * agent-sheet.tsx — the `/agent` coding-agent picker.
 *
 * A Session card runs one coding agent at a time, fixed for the life of the
 * bridge process that serves it. This sheet is the door onto that choice: two
 * segments (Claude Code, OpenCode), the chosen one's description under them, and
 * — when the choice differs from what is running — the one consequence that
 * matters, that OK starts a fresh session in this card.
 *
 * **Why a transaction.** Every other per-session setting is a knob on a live
 * session. This one replaces the process: the new agent has its own
 * conversation store and cannot resume the old agent's session. Presenting the
 * alternatives is free; committing is not, so the choice is held until OK and
 * Cancel/Escape send nothing.
 *
 * **It is not part of the AI configuration sheet** even though that sheet is
 * "how should the AI run?". That sheet's commit is a batch of flags on the same
 * running session (model, effort, mode); this commit discards the session. One
 * OK that both re-flags a session and replaces it would be two transactions
 * wearing one button, and the flags would land on a process already being torn
 * down.
 *
 * Compositional — composes `TugSheet` (via the card's shared `showSheet`),
 * `TugChoiceGroup`, `TugPushButton`; composed children keep their own tokens
 * ([L20]).
 *
 * Laws: [L02] the running agent is read from the metadata store, not mirrored;
 *       [L06] appearance lives in CSS — the pending pick is dialog-local data;
 *       [L07] the current agent is read at open time, never from a render
 *       closure; [L11] the choice group emits through the chain.
 * Decisions: [D15] pane sheets are overlays, [D23] local slash-command dispatch.
 *
 * @module components/tugways/cards/agent-sheet
 */

import "./agent-sheet.css";

import React, { useCallback, useId, useState } from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { TugChoiceGroup } from "@/components/tugways/tug-choice-group";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import { useResponder } from "@/components/tugways/use-responder";
import {
  AGENT_KINDS,
  AGENT_LABELS,
  isAgentKind,
  type AgentKind,
} from "@tugproto/agent";
import { AGENT_DESCRIPTIONS } from "@/lib/agent";
import { MODAL_REST_LINE } from "./modal-rest-line";

/** Focus orders within the sheet's own group: the picker, then the doors. */
const PICKER_FOCUS_ORDER = 0;
const CANCEL_FOCUS_ORDER = 1;
const OK_FOCUS_ORDER = 2;

const AGENT_ITEMS = AGENT_KINDS.map((kind) => ({
  value: kind,
  label: AGENT_LABELS[kind],
}));

export interface UseAgentSheetArgs {
  /** The card's shared sheet host (`useTugSheet().showSheet`). */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
  /**
   * The agent the card is running now, read at open time ([L07]). A card with
   * no session reports the metadata store's default, which is what the next
   * spawn will use.
   */
  currentAgent: () => AgentKind;
  /**
   * Apply the choice: persist it on the card and, when it differs from what is
   * running, start a fresh session. Answers whether it was applied; `false`
   * keeps the sheet open with its pending pick.
   */
  onSwitch: (agent: AgentKind) => boolean;
}

export interface AgentSheetController {
  /** Bare `/agent` — present the picker. */
  openAgentSheet: () => void;
}

export function useAgentSheet({
  showSheet,
  currentAgent,
  onSwitch,
}: UseAgentSheetArgs): AgentSheetController {
  const openAgentSheet = useCallback(() => {
    const current = currentAgent();
    void showSheet({
      title: "Coding Agent",
      icon: "Bot",
      // One column of named alternatives plus their description — the decision
      // width, like the AI sheet.
      displayWidth: "sm",
      presentation: "rise",
      bottomAnchorSelector: MODAL_REST_LINE,
      content: (close) => (
        <AgentSheetBody
          current={current}
          onCommit={(next) => {
            if (!onSwitch(next)) return;
            close();
          }}
          onCancel={() => close()}
        />
      ),
    });
  }, [showSheet, currentAgent, onSwitch]);

  return { openAgentSheet };
}

interface AgentSheetBodyProps {
  /** The agent running when the sheet opened — the commit baseline. */
  current: AgentKind;
  /** Apply the pending pick; the host closes the sheet when it applied. */
  onCommit: (agent: AgentKind) => void;
  onCancel: () => void;
}

function AgentSheetBody({
  current,
  onCommit,
  onCancel,
}: AgentSheetBodyProps): React.ReactElement {
  const [pending, setPending] = useState<AgentKind>(current);

  const senderId = useId();
  const { ResponderScope, responderRef } = useResponder({
    id: "agent-sheet",
    actions: {
      [TUG_ACTIONS.SELECT_VALUE]: (event: ActionEvent) => {
        if (event.sender !== senderId) return;
        if (!isAgentKind(event.value)) return;
        setPending(event.value);
      },
    },
  });

  const focusGroup = useId();
  useSeedKeyView(`${focusGroup}:${PICKER_FOCUS_ORDER}`);

  const changed = pending !== current;

  return (
    <ResponderScope>
      <div
        className="agent-sheet"
        data-slot="agent-sheet"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <div className="agent-sheet-lead">
          This card runs one coding agent at a time.
        </div>

        <TugLabel size="md" emphasis="proposal" className="agent-sheet-caption">
          Agent
        </TugLabel>
        <TugChoiceGroup
          items={AGENT_ITEMS}
          value={pending}
          senderId={senderId}
          size="sm"
          sidePadding="xs"
          columns="proportional"
          commit="live"
          focusGroup={focusGroup}
          focusOrder={PICKER_FOCUS_ORDER}
          aria-label="Coding agent"
          data-testid="agent-sheet-choice"
        />
        <div className="agent-sheet-note" data-testid="agent-sheet-note">
          {AGENT_DESCRIPTIONS[pending]}
        </div>

        {changed && (
          // Shown only when the pick differs: a consequence line that rides
          // every state is read as boilerplate and stops being read at all.
          <div className="agent-sheet-consequence" data-testid="agent-sheet-consequence">
            OK starts a new session in this card. The current conversation stays
            resumable with `/resume`.
          </div>
        )}

        <div className="tug-sheet-actions">
          <TugPushButton
            size="sm"
            emphasis="outlined"
            role="action"
            onClick={onCancel}
            data-testid="agent-sheet-cancel"
            focusGroup={focusGroup}
            focusOrder={CANCEL_FOCUS_ORDER}
          >
            Cancel
          </TugPushButton>
          <TugPushButton
            size="sm"
            emphasis="primary"
            role="action"
            onClick={() => onCommit(pending)}
            data-testid="agent-sheet-ok"
            focusGroup={focusGroup}
            focusOrder={OK_FOCUS_ORDER}
            persistentDefaultRing
          >
            OK
          </TugPushButton>
        </div>
      </div>
    </ResponderScope>
  );
}
