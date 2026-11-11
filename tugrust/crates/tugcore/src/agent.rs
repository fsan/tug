//! Which coding agent a session runs, and how Tug's provider choice reaches an
//! opencode spawn.
//!
//! Tug's Session card was built around Claude Code. A spawn may now name
//! another agent, and the name is load-bearing in three places that cannot
//! guess for themselves: the bridge argv (`--agent`), the ledger row a resume
//! reads, and the `session_capabilities` frame the deck gates its surfaces on.
//! [`AgentKind`] is that one vocabulary, and its default is the historical
//! behaviour so a payload that predates the field is a Claude Code session.
//!
//! The second half of this module is the provider translation. Tug configures
//! its own LLM provider ([`crate::provider`]) and can also configure the
//! opencode process it spawns: opencode reads an inline config document from
//! `OPENCODE_CONFIG_CONTENT`, and that is where an Anthropic-compatible
//! gateway, a local Ollama endpoint, or a default model is named. The
//! translation is deliberately conservative — it sets only what Tug actually
//! resolved, and leaves a choice opencode's own catalog should make when Tug
//! has no answer.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::provider::{ProviderMethod, ProviderPlan};

/// The coding agent a session runs.
///
/// Serialized in kebab-case because the spelling is both a wire field and a
/// persisted tugbank value; an older reader that meets a name it does not know
/// should reject it rather than silently running a different agent, which is
/// why this has no `#[serde(other)]` arm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    /// The `claude` CLI over stream-json. Tug's original backend.
    #[default]
    ClaudeCode,
    /// `opencode acp`, speaking the Agent Client Protocol over stdio.
    Opencode,
}

impl AgentKind {
    /// The wire name, as `spawn_session.agent` and the ledger carry it.
    pub fn as_str(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "claude-code",
            AgentKind::Opencode => "opencode",
        }
    }

    /// Parse a wire name. `None` is an unknown name, never a fallback: the
    /// caller decides whether an unknown value is an error or an absence.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude-code" => Some(AgentKind::ClaudeCode),
            "opencode" => Some(AgentKind::Opencode),
            _ => None,
        }
    }
}

/// Everything opencode needs to be told about Tug's provider choice, as the
/// inline config document `OPENCODE_CONFIG_CONTENT` carries.
///
/// Returns `None` when there is nothing to say — the subscription method,
/// whose credentials opencode cannot borrow from Claude Code and must find in
/// its own auth store. A session that runs opencode on the subscription is
/// therefore not misconfigured; it is unauthenticated until the user runs
/// `opencode auth login`, and the ACP error says so.
///
/// The document is merged **over** the user's own opencode config, so it names
/// only the fields Tug resolved. `providers` entries do not replace the rest of
/// a provider's config; opencode treats them as overlays.
pub fn opencode_config_content(plan: &ProviderPlan) -> Option<String> {
    let envs = plan.envs();
    let mut document = Map::new();

    match plan.method() {
        ProviderMethod::Subscription => return None,
        ProviderMethod::Ollama => {
            let base_url = envs.get("ANTHROPIC_BASE_URL")?;
            let model = plan.forced_model()?;
            let mut settings = Map::new();
            settings.insert("baseURL".to_string(), json!(base_url));
            // Ollama ignores a bearer token, but a remote or proxied endpoint
            // may not. The provider config's default key is the literal
            // "ollama", so only a real key is worth naming.
            if let Some(key) = envs
                .get("ANTHROPIC_AUTH_TOKEN")
                .filter(|key| !key.is_empty() && key.as_str() != "ollama")
            {
                settings.insert("apiKey".to_string(), json!(key));
            }
            document.insert(
                "providers".to_string(),
                json!({ "ollama": { "settings": Value::Object(settings) } }),
            );
            // Ollama discoveries are the only model list Tug can be certain
            // opencode will have: the plugin reads `/api/tags` from this very
            // endpoint, so the configured model is one of its ids.
            document.insert("model".to_string(), json!(format!("ollama/{model}")));
        }
        ProviderMethod::Api => {
            let mut provider = Map::new();
            let mut settings = Map::new();
            if let Some(base_url) = envs.get("ANTHROPIC_BASE_URL") {
                settings.insert("baseURL".to_string(), json!(base_url));
            }
            // opencode's anthropic provider reads `ANTHROPIC_API_KEY`; an
            // auth token is the same credential under Tug's other spelling, and
            // the provider config's `apiKey` is the one place both can land.
            if let Some(key) = envs
                .get("ANTHROPIC_API_KEY")
                .filter(|key| !key.is_empty())
                .or_else(|| {
                    envs.get("ANTHROPIC_AUTH_TOKEN")
                        .filter(|key| !key.is_empty())
                })
            {
                settings.insert("apiKey".to_string(), json!(key));
            }
            if !settings.is_empty() {
                provider.insert("settings".to_string(), Value::Object(settings));
                document.insert(
                    "providers".to_string(),
                    json!({ "anthropic": Value::Object(provider) }),
                );
            }
            if let Some(model) = concrete_model(envs.get("ANTHROPIC_MODEL")) {
                document.insert("model".to_string(), json!(format!("anthropic/{model}")));
            }
        }
        ProviderMethod::Bedrock => {
            // The AWS credentials and region travel as environment variables,
            // which opencode's amazon-bedrock provider reads exactly as
            // Claude Code does. Only the default model needs naming.
            if let Some(model) = concrete_model(envs.get("ANTHROPIC_MODEL")) {
                document.insert(
                    "model".to_string(),
                    json!(format!("amazon-bedrock/{model}")),
                );
            }
        }
    }

    (!document.is_empty()).then(|| Value::Object(document).to_string())
}

/// A model name worth handing to opencode, or `None` for an alias.
///
/// Claude Code resolves `sonnet` / `opus` / `haiku` against whatever the
/// provider offers. opencode has no such aliases — its ids are concrete model
/// names — so passing one through would name a model that does not exist and
/// turn a working provider into a failed spawn. An alias is left for opencode's
/// own default; a concrete id is used.
fn concrete_model(model: Option<&String>) -> Option<&String> {
    model.filter(|model| {
        !matches!(
            model.as_str(),
            "sonnet" | "opus" | "haiku" | "default" | "inherit"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn plan(text: &str) -> ProviderPlan {
        ProviderPlan::parse(text, Path::new("config.toml"), &|_| None).expect("resolves")
    }

    #[test]
    fn absent_agent_is_claude_code() {
        assert_eq!(AgentKind::default(), AgentKind::ClaudeCode);
        assert_eq!(
            serde_json::from_str::<AgentKind>("\"claude-code\"").unwrap(),
            AgentKind::ClaudeCode
        );
        assert_eq!(
            serde_json::from_str::<AgentKind>("\"opencode\"").unwrap(),
            AgentKind::Opencode
        );
        assert!(AgentKind::parse("gemini").is_none());
    }

    #[test]
    fn subscription_has_nothing_to_say() {
        assert_eq!(
            opencode_config_content(&ProviderPlan::legacy_subscription()),
            None
        );
    }

    #[test]
    fn ollama_names_its_endpoint_and_model() {
        let plan = plan(
            r#"
            [provider]
            method = "ollama"
            [provider.ollama]
            base_url = "http://127.0.0.1:11434"
            model = "qwen3-coder"
            "#,
        );
        let doc: Value =
            serde_json::from_str(&opencode_config_content(&plan).expect("configured")).unwrap();
        assert_eq!(doc["model"], "ollama/qwen3-coder");
        assert_eq!(
            doc["providers"]["ollama"]["settings"]["baseURL"],
            "http://127.0.0.1:11434"
        );
        assert!(doc["providers"]["ollama"]["settings"]["apiKey"].is_null());
    }

    #[test]
    fn ollama_names_a_real_key() {
        let plan = plan(
            r#"
            [provider]
            method = "ollama"
            [provider.ollama]
            base_url = "https://ollama.example"
            model = "qwen3-coder"
            api_key = "secret"
            "#,
        );
        let doc: Value =
            serde_json::from_str(&opencode_config_content(&plan).expect("configured")).unwrap();
        assert_eq!(doc["providers"]["ollama"]["settings"]["apiKey"], "secret");
    }

    #[test]
    fn api_names_the_gateway_and_a_concrete_model() {
        let plan = plan(
            r#"
            [provider]
            method = "api"
            [provider.api]
            api_key = "sk-test"
            base_url = "https://gateway.example/anthropic"
            model = "claude-sonnet-4-5"
            "#,
        );
        let doc: Value =
            serde_json::from_str(&opencode_config_content(&plan).expect("configured")).unwrap();
        assert_eq!(doc["model"], "anthropic/claude-sonnet-4-5");
        assert_eq!(
            doc["providers"]["anthropic"]["settings"]["baseURL"],
            "https://gateway.example/anthropic"
        );
        assert_eq!(
            doc["providers"]["anthropic"]["settings"]["apiKey"],
            "sk-test"
        );
    }

    #[test]
    fn api_leaves_an_alias_to_opencode() {
        let plan = plan(
            r#"
            [provider]
            method = "api"
            [provider.api]
            api_key = "sk-test"
            model = "sonnet"
            "#,
        );
        let doc: Value =
            serde_json::from_str(&opencode_config_content(&plan).expect("configured")).unwrap();
        assert!(doc.get("model").is_none());
    }

    #[test]
    fn bedrock_names_a_concrete_model_only() {
        let plan = plan(
            r#"
            [provider]
            method = "bedrock"
            [provider.bedrock]
            region = "us-east-1"
            model = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
            "#,
        );
        let doc: Value =
            serde_json::from_str(&opencode_config_content(&plan).expect("configured")).unwrap();
        assert_eq!(
            doc["model"],
            "amazon-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0"
        );
        assert!(doc.get("providers").is_none());
    }
}
