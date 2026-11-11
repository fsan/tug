/**
 * ConfigureTug's provider form, rendered: the login step's other answer.
 *
 * The shape is the projects-folder row's — a full-width control on the row's
 * `body` slot, with its own Save so the form, not the row's CTA slot, decides
 * when there is a choice worth saving. One line of method buttons and one line
 * of fields, so every method costs the same height and picking one does not
 * move the rows under it.
 *
 * It owns its draft (nothing outside needs it while the form is open) and hands
 * its parent one payload at Save time; the parent sends the frame and owns the
 * outcome — the row's words, the error, and closing the form.
 *
 * Laws: [L11] controls emit actions (the wizard's direct-action idiom: the form
 * owns its draft and calls its parent's callback), [L19] `.tsx`/`.css` pair,
 * [L20] owns its `--tugx-` knobs.
 *
 * @module components/tugways/configure-tug-provider-form
 */

import "./configure-tug-provider.css";

import { type ChangeEvent, type ReactElement, useState } from "react";
import type { AuthProvider } from "@/lib/auth-store";
import {
  PROVIDER_METHODS,
  type ProviderDraft,
  initialProviderDraft,
  methodHint,
  providerChoicePayload,
  providerDraftReady,
} from "./configure-tug-provider";
import { TugInput } from "./tug-input";
import { TugPushButton } from "./tug-push-button";

export function ConfigureTugProviderForm({
  provider,
  saving,
  returnHome,
  onCancel,
  onSave,
}: {
  /** The provider already configured, or `null` when the file resolves to none. */
  provider: AuthProvider | null;
  /** A write is in flight; the fields are read-only until its result lands. */
  saving: boolean;
  /** This row's Save is Return's home and wears the double ring. */
  returnHome: boolean;
  onCancel: () => void;
  onSave: (choice: ReturnType<typeof providerChoicePayload>) => void;
}): ReactElement {
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    initialProviderDraft(provider),
  );
  const edit =
    (field: keyof ProviderDraft) => (event: ChangeEvent<HTMLInputElement>) =>
      setDraft((current) => ({ ...current, [field]: event.target.value }));
  const ready = providerDraftReady(draft);

  return (
    <div className="configure-tug-provider" data-testid="configure-tug-provider">
      <div
        className="configure-tug-provider-methods"
        role="group"
        aria-label="Model provider"
      >
        {PROVIDER_METHODS.map((method) => (
          <TugPushButton
            key={method.value}
            size="sm"
            emphasis={draft.method === method.value ? "filled" : "outlined"}
            aria-pressed={draft.method === method.value}
            disabled={saving}
            onClick={() =>
              setDraft((current) => ({ ...current, method: method.value }))
            }
          >
            {method.label}
          </TugPushButton>
        ))}
      </div>
      <span className="configure-tug-provider-hint">{methodHint(draft)}</span>
      <div className="configure-tug-provider-fields">
        {draft.method === "api" && (
          <>
            <TugInput
              size="sm"
              type="password"
              aria-label="Anthropic API key"
              placeholder="API key"
              autoComplete="off"
              spellCheck={false}
              value={draft.apiKey}
              disabled={saving}
              onChange={edit("apiKey")}
            />
            <TugInput
              size="sm"
              type="text"
              aria-label="API endpoint (optional)"
              placeholder="Endpoint (optional)"
              autoComplete="off"
              spellCheck={false}
              value={draft.apiBaseUrl}
              disabled={saving}
              onChange={edit("apiBaseUrl")}
            />
          </>
        )}
        {draft.method === "bedrock" && (
          <>
            <TugInput
              size="sm"
              type="text"
              aria-label="AWS region"
              placeholder="Region, e.g. us-east-1"
              autoComplete="off"
              spellCheck={false}
              value={draft.region}
              disabled={saving}
              onChange={edit("region")}
            />
            <TugInput
              size="sm"
              type="text"
              aria-label="AWS profile (optional)"
              placeholder="Profile (optional)"
              autoComplete="off"
              spellCheck={false}
              value={draft.profile}
              disabled={saving}
              onChange={edit("profile")}
            />
          </>
        )}
        {draft.method === "ollama" && (
          <>
            <TugInput
              size="sm"
              type="text"
              aria-label="Model"
              placeholder="Model, e.g. qwen3-coder"
              autoComplete="off"
              spellCheck={false}
              value={draft.model}
              disabled={saving}
              onChange={edit("model")}
            />
            <TugInput
              size="sm"
              type="text"
              aria-label="Endpoint (optional)"
              placeholder="http://localhost:11434"
              autoComplete="off"
              spellCheck={false}
              value={draft.endpoint}
              disabled={saving}
              onChange={edit("endpoint")}
            />
          </>
        )}
        <TugPushButton
          size="sm"
          emphasis="filled"
          role="action"
          disabled={saving || !ready}
          persistentDefaultRing={returnHome}
          neverDefaultButton={!returnHome}
          onClick={() => onSave(providerChoicePayload(draft))}
        >
          {saving ? "Saving…" : "Save"}
        </TugPushButton>
        <TugPushButton
          size="sm"
          emphasis="ghost"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </TugPushButton>
      </div>
    </div>
  );
}
