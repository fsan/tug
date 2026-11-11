//! Detection of the user's Claude Code login state via `claude auth status`,
//! plus a `login()` helper that drives `claude auth login`, and the version
//! pair the setup wizard's install row reports: the locally installed version
//! (`claude --version`) and the newest release on the stable channel.
//!
//! `claude` owns authentication (the credentials live in the macOS Keychain,
//! not a file we could read), so we ask the CLI rather than inspecting storage
//! directly. The probe runs under the **configured** provider's environment —
//! the one [`tugcore::provider`] resolves from the user's config file — so a
//! session on Bedrock or a local Ollama endpoint reports the login state it
//! will actually spawn with, not a subscription state it will never use, and
//! the setup wizard's sign-in step is satisfied by the configured provider
//! rather than demanded of a user who has no subscription login to give.
//! `auth login` and `auth logout` stay on the subscription: they drive the
//! OAuth flow, which is the one auth method those verbs own.

use tokio::process::Command;

use tugcore::provider::{EnvOp, ProviderMethod, ProviderPlan};
use tugcore::version::parse_leading_version as parse_version;

/// Resolved Claude Code login state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthState {
    /// The `claude` CLI is not on PATH.
    ClaudeMissing,
    /// CLI present but no valid login.
    LoggedOut,
    /// Logged in; carries account details for the sign-in UI.
    LoggedIn(AccountInfo),
    /// The probe did not answer, so the login state is genuinely unknown.
    ///
    /// Distinct from [`AuthState::LoggedOut`] on purpose, and the distinction
    /// is the whole point of this arm. Every non-`NotFound` failure used to
    /// resolve to `LoggedOut`, which is reasonable for a definite answer —
    /// better to offer sign-in than to crash-loop a session — and wrong for
    /// silence: it is exactly what turns a machine whose `claude` is slow or
    /// wedged into a user being told they are signed out and handed a modal
    /// that cannot succeed. "We could not tell" is a different sentence from
    /// "you are signed out", and only the surface reading it can decide what
    /// to do about it.
    Unknown,
}

/// Account details surfaced by `claude auth status --json`, shown in the
/// sign-in sheet (e.g. "Signed in as user@example.com — Max").
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AccountInfo {
    pub email: Option<String>,
    pub subscription_type: Option<String>,
    pub auth_method: Option<String>,
}

/// Resolve the `claude` executable: the user's PATH first, then the native
/// installer's `~/.local/bin/claude` as a fallback. This lets Tug find a
/// `claude` installed by `claude.ai/install.sh` even when the user hasn't added
/// `~/.local/bin` to their shell PATH — we don't edit their shell environment.
/// Resolved fresh on every call so a just-installed `claude` is found without
/// relaunch. Returns the bare name when nothing is found, so the spawn fails
/// with `NotFound` and [`probe`] maps it to [`AuthState::ClaudeMissing`].
pub fn claude_executable() -> std::ffi::OsString {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("claude");
            if candidate.is_file() {
                return candidate.into_os_string();
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let candidate = std::path::Path::new(&home).join(".local/bin/claude");
        if candidate.is_file() {
            return candidate.into_os_string();
        }
    }
    std::ffi::OsString::from("claude")
}

/// A `claude` command under the user's configured provider.
///
/// Shared with [`super::claude_usage`], the shared agent pool and the scribe,
/// so every auxiliary `claude` process authenticates exactly as a Session
/// card's does. A provider config that cannot be read falls back to the
/// subscription here, with a warning: these callers have no card to put the
/// error on, and a probe that refuses to answer would be worse than one that
/// reports the login it can see. A session spawn reports the config error
/// itself, where the user can read it.
pub(crate) fn claude_command(args: &[&str]) -> Command {
    let plan = match ProviderPlan::load() {
        Ok(plan) => plan,
        Err(err) => {
            tracing::warn!(
                error = %err,
                "provider config could not be read; using the subscription"
            );
            ProviderPlan::legacy_subscription()
        }
    };
    build_claude_command(args, &plan)
}

/// A `claude` command for subscription-only verbs (`auth login`,
/// `auth logout`, `/usage`), which always speak to the OAuth login
/// regardless of the configured provider.
pub(crate) fn subscription_command(args: &[&str]) -> Command {
    build_claude_command(args, &ProviderPlan::legacy_subscription())
}

/// Build the command, applying the plan's env and, when the provider has no
/// model aliases, rewriting a `--model` the caller passed in place.
///
/// The rewrite is what lets a local Ollama model survive the shared agent's
/// `--model haiku`: the endpoint has no such alias, and a silent fallback to
/// "the default" would ask for a Claude model it does not serve. A command
/// that passes no `--model` — `--version`, `auth status` — is left alone,
/// because the plan's environment already names the model for every
/// invocation that actually runs one, and appending a flag a subcommand does
/// not accept would turn a harmless probe into a failure.
fn build_claude_command(args: &[&str], plan: &ProviderPlan) -> Command {
    let mut cmd = Command::new(claude_executable());
    match plan.forced_model() {
        Some(forced) => {
            let mut args = args.iter();
            while let Some(arg) = args.next() {
                if *arg == "--model" {
                    // Replace the flag's value rather than the whole flag: the
                    // caller passed it deliberately, and its position relative
                    // to the other options is the caller's.
                    args.next();
                    cmd.arg("--model").arg(forced);
                } else {
                    cmd.arg(arg);
                }
            }
        }
        None => {
            cmd.args(args);
        }
    }
    for op in plan.env_ops() {
        match op {
            EnvOp::Remove(var) => {
                cmd.env_remove(var);
            }
            EnvOp::Set(key, value) => {
                cmd.env(key, value);
            }
        }
    }
    cmd
}

/// How long the auth probe may run before its answer stops being worth
/// waiting for.
///
/// `claude auth status --json` reports stored credentials without a model
/// query, so a healthy run answers in well under a second; five seconds is
/// roughly ten times that. It is short enough that the setup wizard and the
/// session-open gate both stay responsive, and it bounds a `claude` binary
/// that is itself hung — which is the case this exists for, because an
/// unbounded probe is a wait with no exit on the path to opening a card.
const AUTH_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Probe the current login state by running `claude auth status --json`.
///
/// Fast and local — the CLI reports stored auth without a model query. A
/// missing `claude` binary resolves to [`AuthState::ClaudeMissing`]; any other
/// *definite* failure resolves to [`AuthState::LoggedOut`] so the UI offers
/// sign-in rather than silently crash-looping a session. A probe that does not
/// answer inside [`AUTH_PROBE_TIMEOUT`] resolves to [`AuthState::Unknown`]
/// instead — see that arm for why silence is not a signed-out answer.
///
/// A provider config that cannot be resolved is also [`AuthState::Unknown`]:
/// there is no login state to report until the file is fixed, and the session
/// spawn will put the file's own sentence on the card.
///
/// A configured provider outranks a `loggedIn: false` answer — see
/// [`resolve_login_state`].
pub async fn probe() -> AuthState {
    let plan = match ProviderPlan::load() {
        Ok(plan) => plan,
        Err(err) => {
            tracing::warn!(
                error = %err,
                "provider config could not be read; login state is unknown"
            );
            return AuthState::Unknown;
        }
    };
    let answered = probe_command(
        build_claude_command(&["auth", "status", "--json"], &plan),
        AUTH_PROBE_TIMEOUT,
    )
    .await;
    resolve_login_state(answered, &plan)
}

/// Reconcile the CLI's answer with the provider the config selected.
///
/// Under the subscription the answer is the answer. Under any other provider
/// it is not: the credentials the plan already resolved from `config.toml` are
/// what the session will run on, and the CLI's own report of "logged in" is
/// derived from that same environment rather than the other way round. The
/// setup wizard gates its sign-in row on `loggedIn`, so a `false` here would
/// claim the app with a login the user does not need and cannot satisfy with a
/// subscription — pinning the provider's authority here is what makes login
/// genuinely optional once a config file names a method.
///
/// What still passes through is everything the config cannot speak to: a
/// missing `claude` is about the binary, and silence is about the probe. A
/// malformed model, key, or endpoint is not reported here at all — the session
/// spawn puts the config's own sentence on the card.
fn resolve_login_state(answered: AuthState, plan: &ProviderPlan) -> AuthState {
    match answered {
        AuthState::LoggedOut if plan.method() != ProviderMethod::Subscription => {
            AuthState::LoggedIn(AccountInfo::default())
        }
        other => other,
    }
}

/// The bounded probe itself, over a command the caller supplies.
///
/// Split out from [`probe`] so a test can point it at a command that never
/// answers and watch it come back anyway — which is the claim, and which no
/// test could make against a function that resolves its own executable.
async fn probe_command(mut cmd: Command, timeout: std::time::Duration) -> AuthState {
    let started = std::time::Instant::now();
    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(output)) => parse_status(&String::from_utf8_lossy(&output.stdout)),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => AuthState::ClaudeMissing,
        Ok(Err(_)) => AuthState::LoggedOut,
        Err(_) => {
            // Logged with the elapsed time so a slow `claude` is a fact in the
            // log rather than something inferred from a UI that went quiet.
            tracing::warn!(
                elapsed_ms = started.elapsed().as_millis() as u64,
                timeout_ms = timeout.as_millis() as u64,
                "claude auth probe timed out; login state is unknown"
            );
            AuthState::Unknown
        }
    }
}

/// Parse `claude auth status --json` stdout into an [`AuthState`]. Output that
/// is unparseable or reports `loggedIn: false` is treated as logged-out.
fn parse_status(stdout: &str) -> AuthState {
    #[derive(serde::Deserialize)]
    struct Raw {
        #[serde(rename = "loggedIn")]
        logged_in: bool,
        email: Option<String>,
        #[serde(rename = "subscriptionType")]
        subscription_type: Option<String>,
        #[serde(rename = "authMethod")]
        auth_method: Option<String>,
    }
    match serde_json::from_str::<Raw>(stdout.trim()) {
        Ok(raw) if raw.logged_in => AuthState::LoggedIn(AccountInfo {
            email: raw.email,
            subscription_type: raw.subscription_type,
            auth_method: raw.auth_method,
        }),
        _ => AuthState::LoggedOut,
    }
}

/// Drive `claude auth login` and await completion, then return the freshly
/// probed state.
///
/// The CLI opens the browser and blocks on its own localhost OAuth callback,
/// so the child process exiting *is* the completion signal — no polling. We
/// re-probe afterward regardless of exit code because the probe is the
/// authoritative source of truth (the user may have completed or abandoned the
/// browser flow).
pub async fn login() -> AuthState {
    let _ = subscription_command(&["auth", "login"]).status().await;
    probe().await
}

/// Drive `claude auth logout` and return `(ok, error_message)`. Unlike
/// [`login`], the command's own success matters: a failed logout must surface
/// as an error rather than a silent no-op, so the caller (`claude_logout`) can
/// tell the user it didn't work instead of pretending they're logged out. The
/// caller re-probes afterward to broadcast the authoritative auth state.
pub async fn logout() -> (bool, Option<String>) {
    match subscription_command(&["auth", "logout"]).output().await {
        Ok(out) if out.status.success() => (true, None),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = stderr.trim().lines().last().unwrap_or("logout failed");
            (false, Some(detail.to_string()))
        }
        Err(e) => (false, Some(e.to_string())),
    }
}

/// The release channel `claude install` (and therefore the official installer)
/// resolves by default. Tug reports the same channel the update it offers would
/// land, so "up to date" means up to date with what pressing Update would do.
const STABLE_CHANNEL_URL: &str = "https://downloads.claude.ai/claude-code-releases/stable";

/// How long to wait on the release-channel lookup. The version row is
/// informational — a slow or unreachable network resolves to "latest unknown"
/// and the row still reports the installed version rather than hanging.
const LATEST_VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// The version of Claude Code installed locally, from `claude --version`
/// (`"2.1.222 (Claude Code)"`). `None` when the CLI is missing or its output
/// does not lead with a version.
pub async fn installed_version() -> Option<String> {
    let output = claude_command(&["--version"]).output().await.ok()?;
    parse_version(&String::from_utf8_lossy(&output.stdout))
}

/// The newest Claude Code release on the stable channel, or `None` when the
/// lookup fails (offline, unsupported region, unexpected content).
pub async fn latest_version() -> Option<String> {
    let response = reqwest::Client::new()
        .get(STABLE_CHANNEL_URL)
        .timeout(LATEST_VERSION_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    parse_version(&response.text().await.ok()?)
}

/// Run the official Claude Code installer (`curl -fsSL https://claude.ai/
/// install.sh | bash`) and return `(ok, error_message)`. The native installer
/// drops `claude` in `~/.local/bin` without editing the shell PATH; Tug finds
/// it via [`claude_executable`]'s fallback, so no shell-environment change is
/// needed. Tug manages the install itself rather than asking the user to run
/// commands.
pub async fn install() -> (bool, Option<String>) {
    // `set -o pipefail` is load-bearing: without it the pipeline's exit status
    // is `bash`'s, not `curl`'s, so a failed download (no network, DNS failure,
    // HTTP error) is masked — `curl` emits nothing, `bash` reads empty stdin and
    // exits 0, and the install reports success while nothing was installed. With
    // pipefail, a `curl` failure fails the whole pipeline so it surfaces as an
    // install error.
    match Command::new("bash")
        .arg("-c")
        .arg("set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash")
        .output()
        .await
    {
        Ok(out) if out.status.success() => (true, None),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = stderr.trim().lines().last().unwrap_or("install failed");
            (false, Some(detail.to_string()))
        }
        Err(e) => (false, Some(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_logged_in_max_subscription() {
        // The real shape of `claude auth status --json` for a Max subscription.
        let json = r#"{
            "loggedIn": true,
            "authMethod": "claude.ai",
            "apiProvider": "firstParty",
            "email": "user@example.com",
            "orgId": "abc",
            "orgName": "Org",
            "subscriptionType": "max"
        }"#;
        assert_eq!(
            parse_status(json),
            AuthState::LoggedIn(AccountInfo {
                email: Some("user@example.com".to_string()),
                subscription_type: Some("max".to_string()),
                auth_method: Some("claude.ai".to_string()),
            })
        );
    }

    #[test]
    fn logged_out_when_flag_false() {
        assert_eq!(parse_status(r#"{"loggedIn": false}"#), AuthState::LoggedOut);
    }

    #[test]
    fn logged_out_when_unparseable() {
        assert_eq!(parse_status("not json at all"), AuthState::LoggedOut);
    }

    #[tokio::test]
    async fn a_probe_that_never_answers_is_unknown_not_logged_out() {
        // The whole claim of the bound: a command that would run for half a
        // minute comes back with `Unknown`. An unbounded `output().await`
        // would sit here for thirty seconds, and the arm it used to resolve to
        // would have told the user they were signed out.
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let state = probe_command(cmd, std::time::Duration::from_millis(200)).await;
        assert_eq!(state, AuthState::Unknown);
    }

    #[tokio::test]
    async fn a_definite_answer_is_unchanged_by_the_bound() {
        // The bound must not change what a command that *does* answer means.
        // Valid output still reads `LoggedIn`, and malformed output still reads
        // `LoggedOut` — only silence became a third thing.
        let mut ok = Command::new("printf");
        ok.arg(r#"{"loggedIn": true, "email": "user@example.com"}"#);
        assert_eq!(
            probe_command(ok, std::time::Duration::from_secs(20)).await,
            AuthState::LoggedIn(AccountInfo {
                email: Some("user@example.com".to_string()),
                subscription_type: None,
                auth_method: None,
            })
        );

        let mut garbage = Command::new("printf");
        garbage.arg("not json at all");
        assert_eq!(
            probe_command(garbage, std::time::Duration::from_secs(20)).await,
            AuthState::LoggedOut
        );
    }

    fn plan_for(text: &str) -> ProviderPlan {
        ProviderPlan::parse(text, std::path::Path::new("config.toml"), &|_: &str| None)
            .expect("parses")
    }

    #[test]
    fn a_configured_provider_outranks_a_logged_out_answer() {
        // The wizard claims the app on `loggedIn: false`, and a subscription
        // cannot satisfy a card running on Bedrock or a local endpoint. The
        // config already resolved the credentials, so the gate believes it.
        let ollama = plan_for(
            "[provider]\nmethod = \"ollama\"\n[provider.ollama]\nmodel = \"qwen3-coder\"\n",
        );
        assert_eq!(
            resolve_login_state(AuthState::LoggedOut, &ollama),
            AuthState::LoggedIn(AccountInfo::default())
        );

        let api = plan_for("[provider]\nmethod = \"api\"\n[provider.api]\napi_key = \"k\"\n");
        assert_eq!(
            resolve_login_state(AuthState::LoggedOut, &api),
            AuthState::LoggedIn(AccountInfo::default())
        );
    }

    #[test]
    fn the_subscription_and_the_binarys_own_answers_are_untouched() {
        // No config file: the old behaviour, exactly.
        assert_eq!(
            resolve_login_state(AuthState::LoggedOut, &ProviderPlan::legacy_subscription()),
            AuthState::LoggedOut
        );
        // An explicit subscription is the same answer, not a provider.
        let explicit = plan_for("[provider]\nmethod = \"subscription\"\n");
        assert_eq!(
            resolve_login_state(AuthState::LoggedOut, &explicit),
            AuthState::LoggedOut
        );

        // A missing binary and a probe that never answered are facts the
        // config cannot speak to, so they survive the reconciliation.
        let ollama = plan_for(
            "[provider]\nmethod = \"ollama\"\n[provider.ollama]\nmodel = \"qwen3-coder\"\n",
        );
        assert_eq!(
            resolve_login_state(AuthState::ClaudeMissing, &ollama),
            AuthState::ClaudeMissing
        );
        assert_eq!(
            resolve_login_state(AuthState::Unknown, &ollama),
            AuthState::Unknown
        );
    }

    #[test]
    fn a_forced_model_rewrites_a_passed_model_and_leaves_a_flagless_command_alone() {
        // A local endpoint has no `haiku` alias, so the shared agent's model
        // selector must be rewritten — and a command that runs no model must
        // not collect a flag on the way past, which is what appending the
        // model unconditionally used to do to `--version` and `auth status`.
        let plan = ProviderPlan::parse(
            "[provider]\nmethod = \"ollama\"\n[provider.ollama]\nmodel = \"qwen3-coder\"\n",
            std::path::Path::new("config.toml"),
            &|_: &str| None,
        )
        .expect("parses");
        let args_of = |cmd: Command| -> Vec<String> {
            cmd.as_std()
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect()
        };

        assert_eq!(
            args_of(build_claude_command(
                &["-p", "hi", "--model", "haiku"],
                &plan
            )),
            ["-p", "hi", "--model", "qwen3-coder"]
        );
        assert_eq!(
            args_of(build_claude_command(&["--version"], &plan)),
            ["--version"]
        );
        assert_eq!(
            args_of(build_claude_command(&["auth", "status", "--json"], &plan)),
            ["auth", "status", "--json"]
        );
    }

    #[tokio::test]
    async fn a_missing_binary_is_still_claude_missing() {
        let cmd = Command::new("/nonexistent/tug-test-no-such-claude");
        assert_eq!(
            probe_command(cmd, std::time::Duration::from_secs(20)).await,
            AuthState::ClaudeMissing
        );
    }
}
