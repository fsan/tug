/**
 * Pure-logic coverage for the setup wizard's provider form: the draft it opens
 * on, the `set_provider` payload a draft becomes, when Save may be pressed, and
 * the words the login row uses for a configured provider.
 *
 * The payload is the half worth pinning: it is the shape tugcore's
 * `ProviderTable` deserializes, so a field renamed here is a config file with a
 * key the schema refuses, and the form's answer to "why didn't it save" would
 * be a sentence about Application Support rather than about the form.
 */

import { describe, expect, test } from "bun:test";

import {
  PROVIDER_METHODS,
  configuredProviderLabel,
  initialProviderDraft,
  methodHint,
  providerChoicePayload,
  providerDraftReady,
} from "@/components/tugways/configure-tug-provider";

describe("the provider form's draft", () => {
  test("opens on the configured provider, or the subscription", () => {
    expect(initialProviderDraft(null).method).toBe("subscription");
    expect(initialProviderDraft("bedrock").method).toBe("bedrock");
  });

  test("opens with every credential field empty", () => {
    const draft = initialProviderDraft("api");
    for (const value of [
      draft.apiKey,
      draft.apiBaseUrl,
      draft.region,
      draft.profile,
      draft.model,
      draft.endpoint,
    ]) {
      expect(value).toBe("");
    }
  });

  test("offers exactly the four methods the config schema knows", () => {
    expect(PROVIDER_METHODS.map((m) => m.value)).toEqual([
      "subscription",
      "api",
      "bedrock",
      "ollama",
    ]);
  });
});

describe("the set_provider payload", () => {
  const draft = initialProviderDraft(null);

  test("the subscription carries nothing but its name", () => {
    expect(providerChoicePayload({ ...draft, method: "subscription" })).toEqual({
      provider: { method: "subscription" },
    });
  });

  test("an API key choice carries the key, and the endpoint only when given", () => {
    expect(
      providerChoicePayload({ ...draft, method: "api", apiKey: "sk-ant-test" }),
    ).toEqual({
      provider: { method: "api", api: { api_key: "sk-ant-test" } },
    });
    expect(
      providerChoicePayload({
        ...draft,
        method: "api",
        apiKey: "sk-ant-test",
        apiBaseUrl: "https://gateway.example/v1",
      }),
    ).toEqual({
      provider: {
        method: "api",
        api: {
          api_key: "sk-ant-test",
          base_url: "https://gateway.example/v1",
        },
      },
    });
  });

  test("a Bedrock choice carries the region and profile it was given", () => {
    expect(
      providerChoicePayload({
        ...draft,
        method: "bedrock",
        region: "us-east-1",
        profile: "work",
      }),
    ).toEqual({
      provider: { method: "bedrock", bedrock: { region: "us-east-1", profile: "work" } },
    });
  });

  test("an Ollama choice carries its model, and its endpoint only when given", () => {
    expect(
      providerChoicePayload({ ...draft, method: "ollama", model: "qwen3-coder" }),
    ).toEqual({
      provider: { method: "ollama", ollama: { model: "qwen3-coder" } },
    });
    expect(
      providerChoicePayload({
        ...draft,
        method: "ollama",
        model: "qwen3-coder",
        endpoint: "http://box:11434",
      }),
    ).toEqual({
      provider: {
        method: "ollama",
        ollama: { model: "qwen3-coder", base_url: "http://box:11434" },
      },
    });
  });

  test("an untouched field is absent rather than empty", () => {
    // An empty string would be a key the schema reads and refuses ("api_key is
    // empty"); an absent one is what lets tugcore supply its own default.
    const payload = providerChoicePayload({
      ...draft,
      method: "ollama",
      model: "   ",
      endpoint: "  ",
    });
    expect(payload).toEqual({ provider: { method: "ollama", ollama: {} } });
  });

  test("values are trimmed, so a trailing space is not part of a model name", () => {
    expect(
      providerChoicePayload({
        ...draft,
        method: "ollama",
        model: "  qwen3-coder  ",
      }),
    ).toEqual({ provider: { method: "ollama", ollama: { model: "qwen3-coder" } } });
  });
});

describe("when Save may be pressed", () => {
  const draft = initialProviderDraft(null);

  test("a subscription or Bedrock choice needs nothing typed", () => {
    expect(providerDraftReady({ ...draft, method: "subscription" })).toBe(true);
    expect(providerDraftReady({ ...draft, method: "bedrock" })).toBe(true);
  });

  test("an API choice needs a credential and an Ollama choice a model", () => {
    expect(providerDraftReady({ ...draft, method: "api" })).toBe(false);
    expect(providerDraftReady({ ...draft, method: "api", apiKey: "sk-ant" })).toBe(
      true,
    );
    expect(providerDraftReady({ ...draft, method: "ollama" })).toBe(false);
    expect(
      providerDraftReady({ ...draft, method: "ollama", model: "qwen3-coder" }),
    ).toBe(true);
  });

  test("whitespace is not an answer", () => {
    expect(providerDraftReady({ ...draft, method: "api", apiKey: "   " })).toBe(
      false,
    );
  });
});

describe("the login row's words", () => {
  test("names the provider, and stays silent for the subscription", () => {
    expect(configuredProviderLabel("api")).toBe("Using an Anthropic API key");
    expect(configuredProviderLabel("bedrock")).toBe("Using Amazon Bedrock");
    expect(configuredProviderLabel("ollama")).toBe("Using Ollama");
    expect(configuredProviderLabel("subscription")).toBeNull();
    expect(configuredProviderLabel(null)).toBeNull();
  });

  test("every method says what it is", () => {
    const hints = PROVIDER_METHODS.map((method) =>
      methodHint({ ...initialProviderDraft(null), method: method.value }),
    );
    for (const hint of hints) expect(hint.length).toBeGreaterThan(0);
    expect(new Set(hints).size).toBe(hints.length);
  });
});
