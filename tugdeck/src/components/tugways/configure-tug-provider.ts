/**
 * ConfigureTug's provider form — the other answer to the login step, as data:
 * the draft it edits, the `set_provider` payload that draft becomes, and the
 * words the wizard's row uses for it.
 *
 * The wizard's second step used to have one move: log in to Claude. That is
 * still the default, and it is the right answer for most people. But a Session
 * card runs whatever the `claude` CLI is pointed at, and a user who reaches a
 * model through an Anthropic API key, Amazon Bedrock, or an Ollama endpoint
 * should not have to author TOML in Application Support to say so. The form
 * writes the same `config.toml` a hand edit would (`[provider]` and the one
 * method table under it), through `set_provider`, which validates the choice
 * exactly as a spawn does.
 *
 * What the form deliberately does not do is guess. An empty model is an empty
 * model: Save stays disabled rather than writing a file the next spawn would
 * refuse. What it does not *ask* — a gateway's model, a session token, an
 * `*_env` name — is still the file's to say, and the wizard's own output keeps
 * that door open because it is a plain `config.toml`.
 *
 * Pure — no React, no DOM. The form that renders this logic is
 * `configure-tug-provider-form.tsx`; this file is what a test can pin.
 *
 * @module components/tugways/configure-tug-provider
 */

import type { AuthProvider } from "@/lib/auth-store";

/**
 * The methods the form offers, in the order it offers them. The same four the
 * config schema knows, and the same names the `[provider] method` value takes.
 */
export const PROVIDER_METHODS: ReadonlyArray<{
  value: AuthProvider;
  label: string;
}> = [
  { value: "subscription", label: "Claude" },
  { value: "api", label: "API Key" },
  { value: "bedrock", label: "Bedrock" },
  { value: "ollama", label: "Ollama" },
];

/** The form's whole draft, one field per input it can show. */
export interface ProviderDraft {
  method: AuthProvider;
  /** `[provider.api] api_key`. */
  apiKey: string;
  /** `[provider.api] base_url` — a gateway, when there is one. */
  apiBaseUrl: string;
  /** `[provider.bedrock] region`. */
  region: string;
  /** `[provider.bedrock] profile` — the named AWS profile, when there is one. */
  profile: string;
  /** `[provider.ollama] model` — required: a local endpoint has no aliases. */
  model: string;
  /** `[provider.ollama] base_url`. */
  endpoint: string;
}

/**
 * The draft a form opens on: the provider already configured, so a visit that
 * changed nothing re-saves nothing surprising, and the subscription otherwise.
 * Every text field starts empty — the credentials are not on this side of the
 * wire, and a form that pre-filled them would be showing a secret back.
 */
export function initialProviderDraft(
  provider: AuthProvider | null,
): ProviderDraft {
  return {
    method: provider ?? "subscription",
    apiKey: "",
    apiBaseUrl: "",
    region: "",
    profile: "",
    model: "",
    endpoint: "",
  };
}

/** A trimmed value, or nothing — an empty field must not become an empty key. */
function present(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The `set_provider` payload for a draft: the `[provider]` table, with only the
 * selected method's table and only the fields that were filled in.
 *
 * An absent optional key is what lets tugcore supply its own default — the
 * local Ollama endpoint, the AWS SDK's credential chain — rather than this
 * form encoding a default that the schema would then have to agree with.
 */
export function providerChoicePayload(draft: ProviderDraft): {
  provider: Record<string, unknown>;
} {
  const method = draft.method;
  switch (method) {
    case "subscription":
      return { provider: { method } };
    case "api":
      return {
        provider: {
          method,
          api: presentFields({
            api_key: present(draft.apiKey),
            base_url: present(draft.apiBaseUrl),
          }),
        },
      };
    case "bedrock":
      return {
        provider: {
          method,
          bedrock: presentFields({
            region: present(draft.region),
            profile: present(draft.profile),
          }),
        },
      };
    case "ollama":
      return {
        provider: {
          method,
          ollama: presentFields({
            model: present(draft.model),
            base_url: present(draft.endpoint),
          }),
        },
      };
  }
}

/** Drop the keys a draft left empty, keeping the ones it filled in. */
function presentFields(
  fields: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/**
 * Whether the draft says enough for the write to have a chance.
 *
 * The strictness is the schema's, not the form's taste: an API method with no
 * credential and an Ollama method with no model are both refused by
 * `resolve`, so a Save that sent them would only come back as an error. The
 * other two are ready as drafted — Bedrock's region and profile may both be
 * left to the AWS SDK's own chain, and the subscription needs nothing.
 */
export function providerDraftReady(draft: ProviderDraft): boolean {
  switch (draft.method) {
    case "subscription":
      return true;
    case "api":
      return present(draft.apiKey) !== undefined;
    case "bedrock":
      return true;
    case "ollama":
      return present(draft.model) !== undefined;
  }
}

/**
 * What the login row is called over a configured provider — or `null` when the
 * answer is the subscription, whose row has its own words (a login, an email,
 * a Log Out).
 */
export function configuredProviderLabel(
  provider: AuthProvider | null,
): string | null {
  switch (provider) {
    case "api":
      return "Using an Anthropic API key";
    case "bedrock":
      return "Using Amazon Bedrock";
    case "ollama":
      return "Using Ollama";
    case "subscription":
    case null:
      return null;
  }
}

/** The method's one-line description, said under the method buttons. */
export function methodHint(draft: ProviderDraft): string {
  switch (draft.method) {
    case "subscription":
      return "Sessions run on your Claude subscription. Save, then log in with your browser.";
    case "api":
      return "An Anthropic API key, billed per token. A gateway goes in the endpoint field.";
    case "bedrock":
      return "Amazon Bedrock. Leave the region and profile empty to use the AWS toolchain's own.";
    case "ollama":
      return "An endpoint that speaks the Anthropic Messages API — Ollama, or a gateway such as LiteLLM.";
  }
}

