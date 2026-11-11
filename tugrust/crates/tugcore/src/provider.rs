//! The user's choice of model provider, read from one file.
//!
//! Tug's Session cards run the `claude` CLI, and that CLI chooses where its
//! model turns go from its environment: a subscription login in
//! `~/.claude.json`, an Anthropic API key, Amazon Bedrock, or any endpoint
//! that speaks the Anthropic Messages API (Ollama, a gateway, LiteLLM).
//! Tug used to scrub the API credentials out of every spawn so that a stray
//! shell variable could not silently move a session onto per-token billing.
//! That made the subscription the only provider a Session card could use,
//! because a Finder-launched app inherits no shell variables and there was no
//! other door.
//!
//! This module is that door. `config.toml` in the Tug application-data root
//! selects one method and carries what that method needs; the resolved plan
//! is a set of environment variables to remove and a set to set, which every
//! `claude` spawn applies. The file is deliberately **not** the per-project
//! `.tugtool/config.toml`: credentials are the machine's, not the project's,
//! and a project file is committed and shared.
//!
//! There are two ways to write it, and they share one schema. A user can edit
//! the file by hand, and the setup wizard's login step can write it through
//! [`ProviderTable::save`] — the `set_provider` control — for the person who
//! would rather pick Amazon Bedrock from a form than author TOML. Both paths
//! resolve through [`ProviderPlan::parse`], so a choice the wizard accepts is a
//! file every spawn can use.
//!
//! ```toml
//! [provider]
//! method = "ollama"          # subscription (default) | api | bedrock | ollama
//!
//! [provider.ollama]
//! base_url = "http://localhost:11434"
//! model    = "qwen3-coder"
//! ```
//!
//! An absent file means the subscription, byte for byte the behaviour Tug had
//! before this module existed. A present file that names a method is
//! authoritative: the plan strips every credential and base-URL variable the
//! other methods would have inherited, so a stale `ANTHROPIC_API_KEY` in the
//! environment cannot turn a Bedrock session into an API-billed one.

use std::collections::BTreeMap;
use std::env;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Environment variable naming an alternate config file. Test harnesses set
/// it (beside `TUG_DATA_DIR`) so a run never reads the developer's own
/// provider choice; a user can point it at a file outside the data root.
pub const ENV_CONFIG_FILE: &str = "TUG_CONFIG_FILE";

/// Environment variable carrying the resolved method to a spawned `tugcode`.
///
/// `tugcode` re-derives the environment for every `claude` spawn — including
/// the respawns a model or effort change causes inside the same process — and
/// must know whether the auth variables it received are the configured
/// provider's or a developer's stray shell export. `subscription` keeps the
/// old scrub; every other value leaves the provider's variables alone.
pub const ENV_PROVIDER: &str = "TUG_LLM_PROVIDER";

/// Environment variable carrying a model the provider requires every spawn to
/// use. Only `ollama` sets it, because a local endpoint has no `sonnet` or
/// `opus` alias to resolve; `tugcode` then omits `--model` so the card's
/// Anthropic-shaped selector cannot name a model the server does not have.
pub const ENV_PROVIDER_MODEL: &str = "TUG_LLM_PROVIDER_MODEL";

/// The subscription's auth variables, the only ones Tug scrubbed before this
/// module existed. Kept as its own list so an absent config file reproduces
/// the old behaviour exactly, rather than inheriting a broader policy from a
/// feature the user never opted into.
const LEGACY_AUTH_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
];

/// Every variable that can select or configure a model provider. A config
/// file that names a method removes all of these before applying that
/// method's own values, so no other provider — and no stale shell export —
/// can leak through.
///
/// `AWS_*` credentials are deliberately absent: they select nothing on their
/// own (only [`CLAUDE_CODE_USE_BEDROCK`] does), and removing them from a
/// session's environment would break the user's own `aws` commands run from a
/// Bash block. Bedrock's plan sets the ones it needs and lets the AWS SDK's
/// credential chain find the rest.
const PROVIDER_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    "CLAUDE_CODE_SKIP_MANTLE_AUTH",
];

/// A resolved provider choice: the variables to remove from a spawn, the
/// variables to set, and a model the spawn must not override.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderPlan {
    method: ProviderMethod,
    remove: Vec<&'static str>,
    env: BTreeMap<String, String>,
    forced_model: Option<String>,
}

impl ProviderPlan {
    /// The plan for a machine with no config file: the subscription, scrubbing
    /// only the three auth keys Tug has always scrubbed.
    pub fn legacy_subscription() -> Self {
        Self {
            method: ProviderMethod::Subscription,
            remove: LEGACY_AUTH_ENV.to_vec(),
            env: BTreeMap::new(),
            forced_model: None,
        }
    }

    /// Read and resolve the user's config file.
    ///
    /// A missing file is the subscription and is not an error. Every other
    /// failure — an unreadable file, malformed TOML, an unknown key, a missing
    /// required value, an `*_env` variable that is not set — is returned, so a
    /// session can say what is wrong instead of falling back to a provider the
    /// user did not choose.
    pub fn load() -> Result<Self, ProviderConfigError> {
        let path = config_path();
        match fs::read_to_string(&path) {
            Ok(text) => Self::parse(&text, &path, &|name| env::var(name).ok()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Self::legacy_subscription()),
            Err(err) => Err(ProviderConfigError::new(format!(
                "could not read {}: {err}",
                path.display()
            ))),
        }
    }

    /// Which method the config file selects right now.
    ///
    /// For callers that need the name rather than a spawn's environment — the
    /// auth result the setup wizard's login row reads. A file that does not
    /// resolve is an error here rather than a quiet "subscription": the row
    /// that shows this is the one place a user can see that the file is wrong.
    pub fn current() -> Result<ProviderMethod, ProviderConfigError> {
        Self::load().map(|plan| plan.method())
    }

    /// Resolve a config document without touching the filesystem or the
    /// process environment.
    ///
    /// `lookup` resolves an `*_env` field. It is a parameter rather than a
    /// direct `env::var` call so the rules can be tested without mutating a
    /// process-wide environment — the kind of test that makes every other test
    /// in the binary serial.
    pub fn parse(
        text: &str,
        path: &Path,
        lookup: &dyn Fn(&str) -> Option<String>,
    ) -> Result<Self, ProviderConfigError> {
        let file: ConfigFile = toml::from_str(text)
            .map_err(|err| ProviderConfigError::new(format!("{}: {err}", path.display())))?;
        let Some(provider) = file.provider else {
            // A file with no `[provider]` table selects nothing; treating it as
            // the subscription keeps a template with only comments harmless.
            return Ok(Self::legacy_subscription());
        };
        provider.resolve(lookup)
    }

    /// The method this plan selects.
    pub fn method(&self) -> ProviderMethod {
        self.method
    }

    /// The wire name of the method, as [`ENV_PROVIDER`] carries it.
    pub fn method_str(&self) -> &'static str {
        self.method.as_str()
    }

    /// The variables to remove from a spawn's environment.
    pub fn removals(&self) -> &[&'static str] {
        &self.remove
    }

    /// The variables to set on a spawn's environment.
    pub fn envs(&self) -> &BTreeMap<String, String> {
        &self.env
    }

    /// The model every command that runs a model must use, when the provider
    /// has no aliases.
    pub fn forced_model(&self) -> Option<&str> {
        self.forced_model.as_deref()
    }

    /// The environment edits this plan makes, removals first.
    ///
    /// A caller applies them to whatever command type it holds:
    ///
    /// ```ignore
    /// for op in plan.env_ops() {
    ///     match op {
    ///         EnvOp::Remove(var) => { command.env_remove(var); }
    ///         EnvOp::Set(key, value) => { command.env(key, value); }
    ///     }
    /// }
    /// ```
    ///
    /// One list rather than one method per command type: `std::process::
    /// Command` and `tokio::process::Command` have the same `env`/`env_remove`
    /// pair, but naming either here would make tugcore depend on the standard
    /// library being the only option, or on Tokio's whole surface just to
    /// reach its process module.
    ///
    /// Removals come before sets, so a value this plan sets is never removed
    /// by the cleanup that precedes it.
    pub fn env_ops(&self) -> impl Iterator<Item = EnvOp<'_>> {
        let removals = self.remove.iter().copied().map(EnvOp::Remove);
        let sets = self
            .env
            .iter()
            .map(|(key, value)| EnvOp::Set(key.as_str(), value.as_str()));
        let marker = std::iter::once(EnvOp::Set(ENV_PROVIDER, self.method.as_str()));
        let model = self
            .forced_model
            .as_deref()
            .map(|model| EnvOp::Set(ENV_PROVIDER_MODEL, model));
        removals.chain(sets).chain(marker).chain(model)
    }
}

/// One environment edit from [`ProviderPlan::env_ops`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvOp<'a> {
    /// Remove a variable inherited from the launching environment.
    Remove(&'a str),
    /// Set a variable the provider requires.
    Set(&'a str, &'a str),
}

/// The provider selected by `[provider] method`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderMethod {
    /// The `claude` login (`~/.claude.json`, the macOS Keychain): Tug's
    /// original and still the default.
    #[default]
    Subscription,
    /// An Anthropic API key or auth token, optionally against a compatible
    /// gateway.
    Api,
    /// Amazon Bedrock.
    Bedrock,
    /// An endpoint speaking the Anthropic Messages API — Ollama locally or in
    /// the cloud, LiteLLM, or another translator.
    Ollama,
}

impl ProviderMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderMethod::Subscription => "subscription",
            ProviderMethod::Api => "api",
            ProviderMethod::Bedrock => "bedrock",
            ProviderMethod::Ollama => "ollama",
        }
    }
}

/// A provider config that could not be resolved, with a sentence a card can
/// show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderConfigError {
    message: String,
}

impl ProviderConfigError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for ProviderConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProviderConfigError {}

/// The config file's path: `TUG_CONFIG_FILE`, else `config.toml` in the Tug
/// application-data root.
///
/// The root is machine-wide ([`crate::instance::base_data_dir`]) rather than
/// per-instance so a debug and a release build make the same provider choice,
/// and so the file survives instance teardown.
pub fn config_path() -> PathBuf {
    match env::var_os(ENV_CONFIG_FILE).filter(|v| !v.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => crate::instance::base_data_dir().join("config.toml"),
    }
}

// ---------------------------------------------------------------------------
// File schema
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ConfigFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<ProviderTable>,
}

/// The `[provider]` table: the method in force, plus one table per method.
///
/// Public because the setup wizard's `set_provider` control carries this shape
/// as JSON. One value describes both the file a user hand-edits and the choice
/// the wizard writes, so the two can never drift into different schemas.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderTable {
    #[serde(default)]
    method: ProviderMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api: Option<ApiTable>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bedrock: Option<BedrockTable>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ollama: Option<OllamaTable>,
}

impl ProviderTable {
    fn resolve(
        self,
        lookup: &dyn Fn(&str) -> Option<String>,
    ) -> Result<ProviderPlan, ProviderConfigError> {
        match self.method {
            ProviderMethod::Subscription => Ok(ProviderPlan {
                method: ProviderMethod::Subscription,
                remove: PROVIDER_ENV.to_vec(),
                env: BTreeMap::new(),
                forced_model: None,
            }),
            ProviderMethod::Api => self.api.unwrap_or_default().resolve(lookup),
            ProviderMethod::Bedrock => self.bedrock.unwrap_or_default().resolve(lookup),
            ProviderMethod::Ollama => self.ollama.unwrap_or_default().resolve(lookup),
        }
    }

    /// Validate this choice the way a spawn would, then write it to the config
    /// file.
    ///
    /// The validation is [`Self::resolve`] — the very function every `claude`
    /// spawn runs — so a file that saves is a file a session can run on. A
    /// choice that does not resolve writes nothing: a half-written or
    /// unresolvable file on disk would be worse than the one already there,
    /// because every later spawn would report the wizard's mistake.
    ///
    /// The write replaces the whole file, `[provider]` table and all. That is
    /// the schema's whole content today, and it means a method's table cannot
    /// linger beside the next method's — which is the point: the wizard writes
    /// a choice, not an edit.
    pub fn save(self) -> Result<ProviderPlan, ProviderConfigError> {
        self.save_to(&config_path())
    }

    /// [`Self::save`] at an explicit path, for tests and for any caller that
    /// resolved its own config location.
    pub fn save_to(self, path: &Path) -> Result<ProviderPlan, ProviderConfigError> {
        // Resolved with the real environment: an `*_env` field that names an
        // unset variable is refused here exactly as it would be at spawn.
        let plan = self.clone().resolve(&|name| env::var(name).ok())?;
        let text = serialize(&self).map_err(|err| {
            ProviderConfigError::new(format!("could not write {}: {err}", path.display()))
        })?;
        write_private(path, &text).map_err(|err| {
            ProviderConfigError::new(format!("could not write {}: {err}", path.display()))
        })?;
        Ok(plan)
    }
}

/// Render a choice as the config document a user would hand-write.
fn serialize(provider: &ProviderTable) -> Result<String, toml::ser::Error> {
    let body = toml::to_string(&ConfigFile {
        provider: Some(provider.clone()),
    })?;
    // A comment the wizard's own output would otherwise lack. Hand edits stay
    // the first-class door — this file is the second one, and the file says so.
    Ok(format!(
        "# Tug's model provider choice. Hand edits are welcome; the setup\n\
         # wizard rewrites this whole file when you pick a provider there.\n\
         {body}"
    ))
}

/// Write `text` to `path` atomically and privately (mode 0600).
///
/// A sibling temp file plus a rename, because the file is read by every
/// `claude` spawn and every auth probe: a reader must see the old choice or
/// the new one, never a half-written one. 0600 because this file is where
/// credentials live, and a file created by an ordinary `File::create` would be
/// readable by every account on the machine under a loose umask.
fn write_private(path: &Path, text: &str) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let tmp = path.with_file_name(format!(
        ".{}.tmp.{}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let create = || {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
    };
    let mut file = match create() {
        Ok(file) => file,
        // A temp file from a crashed run that happened to share this pid. It
        // is ours by name; the rename below is what makes a leftover harmless.
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            fs::remove_file(&tmp)?;
            create()?
        }
        Err(err) => return Err(err),
    };
    let written = file
        .write_all(text.as_bytes())
        .and_then(|()| file.sync_all());
    drop(file);
    if let Err(err) = written {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    fs::rename(&tmp, path)
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ApiTable {
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key_env: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_token_env: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    small_model: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    extra_env: BTreeMap<String, String>,
}

impl ApiTable {
    fn resolve(
        self,
        lookup: &dyn Fn(&str) -> Option<String>,
    ) -> Result<ProviderPlan, ProviderConfigError> {
        let api_key = resolve_secret(self.api_key, self.api_key_env, "api_key", lookup)?;
        let auth_token =
            resolve_secret(self.auth_token, self.auth_token_env, "auth_token", lookup)?;
        if api_key.is_some() && auth_token.is_some() {
            return Err(ProviderConfigError::new(
                "[provider.api]: set either api_key or auth_token, not both",
            ));
        }
        if api_key.is_none() && auth_token.is_none() {
            return Err(ProviderConfigError::new(
                "[provider.api]: set one of api_key, api_key_env, auth_token or auth_token_env",
            ));
        }

        let mut env = BTreeMap::new();
        if let Some(key) = api_key {
            env.insert("ANTHROPIC_API_KEY".to_string(), key);
        }
        if let Some(token) = auth_token {
            env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), token);
        }
        if let Some(base_url) = non_empty(self.base_url, "[provider.api] base_url")? {
            env.insert("ANTHROPIC_BASE_URL".to_string(), base_url);
        }
        if let Some(model) = non_empty(self.model, "[provider.api] model")? {
            env.insert("ANTHROPIC_MODEL".to_string(), model);
        }
        if let Some(model) = non_empty(self.small_model, "[provider.api] small_model")? {
            env.insert("ANTHROPIC_SMALL_FAST_MODEL".to_string(), model.clone());
            env.insert("ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(), model);
        }
        env.extend(self.extra_env);

        Ok(ProviderPlan {
            method: ProviderMethod::Api,
            remove: PROVIDER_ENV.to_vec(),
            env,
            forced_model: None,
        })
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BedrockTable {
    #[serde(skip_serializing_if = "Option::is_none")]
    region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    access_key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret_access_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    small_model: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    extra_env: BTreeMap<String, String>,
}

impl BedrockTable {
    fn resolve(
        self,
        _lookup: &dyn Fn(&str) -> Option<String>,
    ) -> Result<ProviderPlan, ProviderConfigError> {
        let access_key_id = non_empty(self.access_key_id, "[provider.bedrock] access_key_id")?;
        let secret_access_key = non_empty(
            self.secret_access_key,
            "[provider.bedrock] secret_access_key",
        )?;
        let session_token = non_empty(self.session_token, "[provider.bedrock] session_token")?;

        if access_key_id.is_some() != secret_access_key.is_some() {
            return Err(ProviderConfigError::new(
                "[provider.bedrock]: access_key_id and secret_access_key go together",
            ));
        }
        if access_key_id.is_some() && self.profile.is_some() {
            return Err(ProviderConfigError::new(
                "[provider.bedrock]: set either profile or access_key_id/secret_access_key, not both",
            ));
        }
        if session_token.is_some() && access_key_id.is_none() {
            return Err(ProviderConfigError::new(
                "[provider.bedrock]: session_token needs access_key_id and secret_access_key",
            ));
        }

        // The AWS SDK reads `AWS_PROFILE` and `AWS_REGION`; an unset region is
        // left to its chain (profile, shared config, `us-east-1`) rather than
        // guessed here. An explicit `region` wins over the environment.
        let mut env = BTreeMap::new();
        env.insert("CLAUDE_CODE_USE_BEDROCK".to_string(), "1".to_string());
        if let Some(region) = non_empty(self.region, "[provider.bedrock] region")? {
            env.insert("AWS_REGION".to_string(), region);
        }
        if let Some(profile) = non_empty(self.profile, "[provider.bedrock] profile")? {
            env.insert("AWS_PROFILE".to_string(), profile);
        }
        if let Some(key) = access_key_id {
            env.insert("AWS_ACCESS_KEY_ID".to_string(), key);
            // Checked above: present exactly when the id is.
            env.insert(
                "AWS_SECRET_ACCESS_KEY".to_string(),
                secret_access_key.expect("checked with access_key_id"),
            );
        }
        if let Some(token) = session_token {
            env.insert("AWS_SESSION_TOKEN".to_string(), token);
        }
        if let Some(model) = non_empty(self.model, "[provider.bedrock] model")? {
            env.insert("ANTHROPIC_MODEL".to_string(), model);
        }
        if let Some(model) = non_empty(self.small_model, "[provider.bedrock] small_model")? {
            env.insert("ANTHROPIC_SMALL_FAST_MODEL".to_string(), model.clone());
            env.insert("ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(), model);
        }
        env.extend(self.extra_env);

        Ok(ProviderPlan {
            method: ProviderMethod::Bedrock,
            remove: PROVIDER_ENV.to_vec(),
            env,
            forced_model: None,
        })
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct OllamaTable {
    #[serde(skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key_env: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    extra_env: BTreeMap<String, String>,
}

impl OllamaTable {
    fn resolve(
        self,
        lookup: &dyn Fn(&str) -> Option<String>,
    ) -> Result<ProviderPlan, ProviderConfigError> {
        let base_url = non_empty(self.base_url, "[provider.ollama] base_url")?
            .unwrap_or_else(|| "http://localhost:11434".to_string());
        let model = non_empty(self.model, "[provider.ollama] model")?.ok_or_else(|| {
            ProviderConfigError::new(
                "[provider.ollama]: model is required — a local endpoint has no \
                 sonnet or opus alias to fall back to",
            )
        })?;
        let api_key = resolve_secret(self.api_key, self.api_key_env, "api_key", lookup)?
            .unwrap_or_else(|| "ollama".to_string());

        let mut env = BTreeMap::new();
        env.insert("ANTHROPIC_BASE_URL".to_string(), base_url);
        env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), api_key);
        // Ollama ignores a key, but an empty value is what the CLI's own
        // guidance sets so a real Anthropic key is never sent to it.
        env.insert("ANTHROPIC_API_KEY".to_string(), String::new());
        // Every alias Claude Code might resolve — the main model plus the
        // small/fast one its background work asks for — names the local model.
        for var in [
            "ANTHROPIC_MODEL",
            "ANTHROPIC_SMALL_FAST_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
        ] {
            env.insert(var.to_string(), model.clone());
        }
        if let Some(tokens) = self.context_tokens {
            env.insert(
                "CLAUDE_CODE_MAX_CONTEXT_TOKENS".to_string(),
                tokens.to_string(),
            );
        }
        // Local turns never leave the machine; the CLI's non-essential calls
        // to Anthropic would fail and slow every turn down.
        env.insert(
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_string(),
            "1".to_string(),
        );
        env.extend(self.extra_env);

        Ok(ProviderPlan {
            method: ProviderMethod::Ollama,
            remove: PROVIDER_ENV.to_vec(),
            env,
            forced_model: Some(model),
        })
    }
}

/// Resolve a `value` / `value_env` pair to the secret it names.
///
/// Either spelling is accepted, never both: two sources for one credential is
/// a mistake about which one is live, and silently preferring one would leave
/// the other looking effective. An `*_env` name that resolves to an unset or
/// empty variable is an error, not an empty credential.
fn resolve_secret(
    value: Option<String>,
    env_name: Option<String>,
    field: &str,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<String>, ProviderConfigError> {
    match (value, env_name) {
        (Some(_), Some(_)) => Err(ProviderConfigError::new(format!(
            "set either {field} or {field}_env, not both"
        ))),
        (Some(value), None) => {
            if value.is_empty() {
                Err(ProviderConfigError::new(format!("{field} is empty")))
            } else {
                Ok(Some(value))
            }
        }
        (None, Some(name)) => lookup(&name)
            .filter(|value| !value.is_empty())
            .map(Some)
            .ok_or_else(|| {
                ProviderConfigError::new(format!("{field}_env names {name}, which is not set"))
            }),
        (None, None) => Ok(None),
    }
}

/// Refuse an empty string for a field that only makes sense with a value.
fn non_empty(value: Option<String>, field: &str) -> Result<Option<String>, ProviderConfigError> {
    match value {
        Some(value) if value.is_empty() => {
            Err(ProviderConfigError::new(format!("{field} is empty")))
        }
        other => Ok(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn parse(text: &str) -> Result<ProviderPlan, ProviderConfigError> {
        ProviderPlan::parse(text, Path::new("config.toml"), &no_env)
    }

    #[test]
    fn no_file_is_the_legacy_subscription() {
        let plan = ProviderPlan::legacy_subscription();
        assert_eq!(plan.method(), ProviderMethod::Subscription);
        assert_eq!(plan.removals(), LEGACY_AUTH_ENV);
        assert!(plan.envs().is_empty());
        assert_eq!(plan.forced_model(), None);
    }

    #[test]
    fn a_file_without_a_provider_table_is_the_legacy_subscription() {
        let plan = parse("# only comments\n").expect("comments parse");
        assert_eq!(plan.method(), ProviderMethod::Subscription);
        assert_eq!(plan.removals(), LEGACY_AUTH_ENV);
    }

    #[test]
    fn an_explicit_subscription_strips_every_provider_selector() {
        let plan = parse("[provider]\nmethod = \"subscription\"\n").expect("parses");
        assert_eq!(plan.method(), ProviderMethod::Subscription);
        assert!(plan.removals().contains(&"ANTHROPIC_BASE_URL"));
        assert!(plan.removals().contains(&"CLAUDE_CODE_USE_BEDROCK"));
        assert!(plan.envs().is_empty());
    }

    #[test]
    fn api_sets_the_key_and_optional_endpoint() {
        let plan = parse(
            r#"
            [provider]
            method = "api"
            [provider.api]
            api_key = "sk-ant-test"
            base_url = "https://gateway.example/v1"
            model = "claude-sonnet-5-5"
            small_model = "claude-haiku-5-5"
            "#,
        )
        .expect("parses");
        assert_eq!(plan.method(), ProviderMethod::Api);
        assert_eq!(plan.envs().get("ANTHROPIC_API_KEY").unwrap(), "sk-ant-test");
        assert_eq!(
            plan.envs().get("ANTHROPIC_BASE_URL").unwrap(),
            "https://gateway.example/v1"
        );
        assert_eq!(
            plan.envs().get("ANTHROPIC_MODEL").unwrap(),
            "claude-sonnet-5-5"
        );
        assert_eq!(
            plan.envs().get("ANTHROPIC_DEFAULT_HAIKU_MODEL").unwrap(),
            "claude-haiku-5-5"
        );
        assert!(plan.removals().contains(&"CLAUDE_CODE_OAUTH_TOKEN"));
        assert_eq!(plan.forced_model(), None);
    }

    #[test]
    fn api_reads_a_key_from_the_environment() {
        let lookup = |name: &str| (name == "MY_ANTHROPIC_KEY").then(|| "sk-from-env".to_string());
        let plan = ProviderPlan::parse(
            "[provider]\nmethod = \"api\"\n[provider.api]\napi_key_env = \"MY_ANTHROPIC_KEY\"\n",
            Path::new("config.toml"),
            &lookup,
        )
        .expect("parses");
        assert_eq!(plan.envs().get("ANTHROPIC_API_KEY").unwrap(), "sk-from-env");
    }

    #[test]
    fn api_refuses_an_unset_key_variable() {
        let err = parse("[provider]\nmethod = \"api\"\n[provider.api]\napi_key_env = \"NOPE\"\n")
            .expect_err("unset env must refuse");
        assert!(err.to_string().contains("NOPE"), "{err}");
    }

    #[test]
    fn api_refuses_two_credentials_and_no_credential() {
        let both = parse(
            "[provider]\nmethod = \"api\"\n[provider.api]\napi_key = \"a\"\nauth_token = \"b\"\n",
        )
        .expect_err("two credentials must refuse");
        assert!(both.to_string().contains("not both"), "{both}");

        let neither =
            parse("[provider]\nmethod = \"api\"\n").expect_err("no credential must refuse");
        assert!(neither.to_string().contains("api_key"), "{neither}");
    }

    #[test]
    fn bedrock_sets_the_switch_and_the_region() {
        let plan = parse(
            r#"
            [provider]
            method = "bedrock"
            [provider.bedrock]
            region = "eu-west-1"
            profile = "work"
            model = "eu.anthropic.claude-sonnet-5-5"
            "#,
        )
        .expect("parses");
        assert_eq!(plan.method(), ProviderMethod::Bedrock);
        assert_eq!(plan.envs().get("CLAUDE_CODE_USE_BEDROCK").unwrap(), "1");
        assert_eq!(plan.envs().get("AWS_REGION").unwrap(), "eu-west-1");
        assert_eq!(plan.envs().get("AWS_PROFILE").unwrap(), "work");
        assert_eq!(
            plan.envs().get("ANTHROPIC_MODEL").unwrap(),
            "eu.anthropic.claude-sonnet-5-5"
        );
        assert!(plan.removals().contains(&"ANTHROPIC_API_KEY"));
        assert_eq!(plan.forced_model(), None);
    }

    #[test]
    fn bedrock_refuses_a_half_static_credential_and_a_profile_beside_one() {
        let half =
            parse("[provider]\nmethod = \"bedrock\"\n[provider.bedrock]\naccess_key_id = \"id\"\n")
                .expect_err("half a key must refuse");
        assert!(half.to_string().contains("go together"), "{half}");

        let mixed = parse(
            "[provider]\nmethod = \"bedrock\"\n[provider.bedrock]\nprofile = \"p\"\naccess_key_id = \"id\"\nsecret_access_key = \"secret\"\n",
        )
        .expect_err("profile beside keys must refuse");
        assert!(mixed.to_string().contains("either profile"), "{mixed}");
    }

    #[test]
    fn ollama_defaults_the_local_endpoint_and_forces_its_model() {
        let plan =
            parse("[provider]\nmethod = \"ollama\"\n[provider.ollama]\nmodel = \"qwen3-coder\"\n")
                .expect("parses");
        assert_eq!(plan.method(), ProviderMethod::Ollama);
        assert_eq!(
            plan.envs().get("ANTHROPIC_BASE_URL").unwrap(),
            "http://localhost:11434"
        );
        assert_eq!(plan.envs().get("ANTHROPIC_AUTH_TOKEN").unwrap(), "ollama");
        assert_eq!(plan.envs().get("ANTHROPIC_API_KEY").unwrap(), "");
        for var in [
            "ANTHROPIC_MODEL",
            "ANTHROPIC_SMALL_FAST_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
        ] {
            assert_eq!(plan.envs().get(var).unwrap(), "qwen3-coder", "{var}");
        }
        assert_eq!(plan.forced_model(), Some("qwen3-coder"));
        assert_eq!(
            plan.envs().get("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"),
            Some(&"1".to_string())
        );
    }

    #[test]
    fn ollama_requires_a_model_and_takes_a_context_budget() {
        let err = parse(
            "[provider]\nmethod = \"ollama\"\n[provider.ollama]\nbase_url = \"http://box:11434\"\n",
        )
        .expect_err("no model must refuse");
        assert!(err.to_string().contains("model is required"), "{err}");

        let plan = parse(
            "[provider]\nmethod = \"ollama\"\n[provider.ollama]\nmodel = \"gpt-oss:20b\"\ncontext_tokens = 65536\n",
        )
        .expect("parses");
        assert_eq!(
            plan.envs().get("CLAUDE_CODE_MAX_CONTEXT_TOKENS").unwrap(),
            "65536"
        );
    }

    #[test]
    fn extra_env_is_applied_last() {
        let plan = parse(
            "[provider]\nmethod = \"api\"\n[provider.api]\napi_key = \"k\"\nextra_env = { ANTHROPIC_MODEL = \"custom\" }\n",
        )
        .expect("parses");
        assert_eq!(plan.envs().get("ANTHROPIC_MODEL").unwrap(), "custom");
    }

    #[test]
    fn unknown_keys_and_methods_refuse_by_name() {
        let unknown_key =
            parse("[provider]\nmethod = \"api\"\n[provider.api]\napi_kye = \"typo\"\n")
                .expect_err("typo must refuse");
        assert!(unknown_key.to_string().contains("api_kye"), "{unknown_key}");

        let unknown_method =
            parse("[provider]\nmethod = \"openai\"\n").expect_err("unknown method must refuse");
        assert!(
            unknown_method.to_string().contains("openai"),
            "{unknown_method}"
        );
    }

    #[test]
    fn applying_a_plan_removes_then_sets() {
        let plan =
            parse("[provider]\nmethod = \"ollama\"\n[provider.ollama]\nmodel = \"qwen3-coder\"\n")
                .expect("parses");
        let mut removals = Vec::new();
        let mut sets = Vec::new();
        for op in plan.env_ops() {
            match op {
                EnvOp::Remove(var) => removals.push(var.to_string()),
                EnvOp::Set(key, value) => sets.push((key.to_string(), value.to_string())),
            }
        }
        assert!(removals.contains(&"ANTHROPIC_BASE_URL".to_string()));
        assert!(sets.contains(&("TUG_LLM_PROVIDER".to_string(), "ollama".to_string())));
        assert!(sets.contains(&(
            "TUG_LLM_PROVIDER_MODEL".to_string(),
            "qwen3-coder".to_string()
        )));
    }

    // ---- the wizard's write ------------------------------------------------

    /// A choice as the `set_provider` control carries it: the same document a
    /// user would write, read into the table the control deserializes.
    fn table(text: &str) -> ProviderTable {
        toml::from_str::<ConfigFile>(text)
            .expect("fixture parses as a config file")
            .provider
            .expect("fixture names a provider")
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).expect("written file reads back")
    }

    #[test]
    fn a_saved_choice_is_a_file_a_spawn_can_run_on() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.toml");
        let plan = table(
            "[provider]\nmethod = \"api\"\n[provider.api]\napi_key = \"sk-ant-test\"\nbase_url = \"https://gateway.example/v1\"\n",
        )
        .save_to(&path)
        .expect("saves");

        assert_eq!(plan.method(), ProviderMethod::Api);
        assert_eq!(plan.envs().get("ANTHROPIC_API_KEY").unwrap(), "sk-ant-test");
        // What was written is what a spawn reads: the file parses to the very
        // plan the write returned, with no `*_env` lookup in the way.
        let text = read(&path);
        let reloaded = ProviderPlan::parse(&text, &path, &no_env).expect("the written file parses");
        assert_eq!(reloaded, plan);
        // One method's table, never a second one's.
        assert!(text.contains("[provider.api]"), "{text}");
        assert!(!text.contains("[provider.ollama]"), "{text}");
        assert!(!text.contains("[provider.bedrock]"), "{text}");
    }

    #[test]
    fn a_refused_choice_writes_nothing() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.toml");
        let err = table("[provider]\nmethod = \"ollama\"\n")
            .save_to(&path)
            .expect_err("no model must refuse");
        assert!(err.to_string().contains("model is required"), "{err}");
        assert!(!path.exists(), "a refused choice must not touch the disk");
    }

    #[test]
    fn saving_one_method_forgets_the_last_ones_credentials() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.toml");
        table("[provider]\nmethod = \"api\"\n[provider.api]\napi_key = \"sk-ant-test\"\n")
            .save_to(&path)
            .expect("saves");

        let plan = table("[provider]\nmethod = \"subscription\"\n")
            .save_to(&path)
            .expect("saves");
        assert_eq!(plan.method(), ProviderMethod::Subscription);
        let text = read(&path);
        assert!(!text.contains("sk-ant-test"), "{text}");
        // An explicit subscription is the way back, and it reads as such.
        assert!(text.contains("method = \"subscription\""), "{text}");
    }

    #[test]
    fn the_saved_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.toml");
        table("[provider]\nmethod = \"api\"\n[provider.api]\napi_key = \"sk-ant-test\"\n")
            .save_to(&path)
            .expect("saves");
        let mode = fs::metadata(&path).expect("metadata").permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "config holds credentials");
    }

    #[test]
    fn a_choice_deserializes_from_the_controls_json() {
        // The wire shape the deck sends, through the same serde path the
        // control uses — so a field renamed on one side fails here.
        let choice: ProviderTable = serde_json::from_value(serde_json::json!({
            "method": "bedrock",
            "bedrock": { "region": "us-east-1", "profile": "work" },
        }))
        .expect("the control's payload parses");
        let dir = tempfile::tempdir().expect("temp dir");
        let plan = choice
            .save_to(&dir.path().join("config.toml"))
            .expect("saves");
        assert_eq!(plan.method(), ProviderMethod::Bedrock);
        assert_eq!(plan.envs().get("AWS_REGION").unwrap(), "us-east-1");
        assert_eq!(plan.envs().get("AWS_PROFILE").unwrap(), "work");
        assert_eq!(plan.envs().get("CLAUDE_CODE_USE_BEDROCK").unwrap(), "1");
    }
}
