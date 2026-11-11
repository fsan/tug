# Tug: An IDE for AI coding

Tug is a full-featured Integrated Development Environment (IDE) built from scratch to improve the experience of AI-assisted software development. It is a macOS app and uses Claude Code for the AI. All prompts, AI responses, shell commands, file edits, git history, and in-flight work are integrated together, with excellent typography, rich text input, and content display along with tools to visualize, track, and manage the work. Tug is open source, distributed under the MIT license.

I’ve made everything just like I want it. My hope is that the things I chose to please myself might also please you too.

## Download

> Tug is beta software: expect rough edges and frequent changes.

**[Download Tug for macOS](https://github.com/kocienda/tug/releases/latest/download/Tug.dmg)**: the latest release, as a disk image.

[![Latest release](https://img.shields.io/github/v/release/kocienda/tug?label=version)](https://github.com/kocienda/tug/releases/latest)
[![Release date](https://img.shields.io/github/release-date/kocienda/tug?label=released)](https://github.com/kocienda/tug/releases/latest)

### System requirements

- A Mac with Apple silicon
- macOS 15 Sequoia or later, including macOS 26 Tahoe and macOS 27 Golden Gate

### What else you’ll need

- A paid Claude plan that includes Claude Code, such as Pro or Max (the free plan doesn’t) — or another way to reach a model, such as an Anthropic API key, Amazon Bedrock, or a local endpoint ([below](#choosing-the-model-provider)). Tug runs Claude Code by default, and the first-launch setup of Tug installs the `claude` program (if needed) and logs you in. A session can instead run [OpenCode](#choosing-the-coding-agent), which you install yourself.
- The `git` program for changes and commits. If `git` isn’t on your Mac, setup offers to install Apple’s Command Line Tools (about 3 GB). You can skip the install at first and add `git` later, when you’re ready for your first commit.

### Choosing the model provider

By default Tug uses the Claude Code subscription login the setup wizard establishes. If you’d rather run sessions through an Anthropic API key, Amazon Bedrock, or an endpoint that speaks the Anthropic Messages API — Ollama on your Mac, a gateway, LiteLLM — you can pick it at the wizard’s login step (**Use Another Provider…**), or write a `config.toml` in Tug’s application-data folder. The wizard offers that door whether or not you are signed in: on a machine already logged in to Claude, the login row still carries **Use Another Provider…** beside the account, and picking a method there writes the file for you.

```
~/Library/Application Support/Tug/config.toml
```

One `[provider]` table selects the method; one table under it carries what that method needs. The file is machine-wide (a debug and a release build share it) and is never inside a project, so your credentials stay out of anything committed or shared. Changes apply to the next session you open.

**An Anthropic API key**, optionally against a compatible gateway:

```toml
[provider]
method = "api"

[provider.api]
api_key = "sk-ant-…"            # or api_key_env = "MY_ANTHROPIC_KEY"
# auth_token = "…"             # the ANTHROPIC_AUTH_TOKEN spelling, instead of api_key
# base_url = "https://gateway.example/v1"
# model = "claude-sonnet-5-5"
# small_model = "claude-haiku-5-5"
```

**Amazon Bedrock**, through a named AWS profile or explicit credentials:

```toml
[provider]
method = "bedrock"

[provider.bedrock]
region = "us-east-1"
profile = "work"                # or access_key_id / secret_access_key / session_token
# model = "us.anthropic.claude-sonnet-5-5"
```

**Ollama** (0.14 or later), locally or on another machine. A local endpoint has no `sonnet` or `opus` alias, so `model` is required and every session uses it:

```toml
[provider]
method = "ollama"

[provider.ollama]
model = "qwen3-coder"           # any tool-capable model you have pulled
# base_url = "http://localhost:11434"
# context_tokens = 65536
```

`method = "subscription"` is the default and can be stated explicitly, and it is the way back from either door. The wizard writes this file for you and rewrites the whole `[provider]` table each time, so the two doors describe the same choice; the form asks for less than the file can say — a gateway’s model, a session token, an `*_env` name — so a hand edit remains the fuller spelling. Every method also takes an `extra_env` table of additional variables to set on each spawn. A key may be given literally or named by an `*_env` field — a malformed file, a typo’d key, or a named variable that isn’t set is reported on the Session card where the session would have started, rather than silently falling back, or on the wizard’s row if the wizard is what wrote it.

### Choosing the coding agent

A Session card runs Claude Code unless you tell it otherwise. The Settings card’s **Coding Agent** row picks the deck-wide default, and `/agent` in a session picks it for that card — as does clicking the chip above the prompt that names the running agent — either way the choice starts a fresh session in the card, and the conversation you were in stays resumable with `/resume`. Choosing **OpenCode** runs [`opencode acp`](https://opencode.ai/docs/), which Tug expects on your `PATH`; Tug configures its provider from the same `[provider]` table described above, so an Ollama, gateway, or Bedrock setup carries over. The Claude Code subscription does not: OpenCode keeps its own credentials, so run `opencode auth login` for an account-based setup. OpenCode sessions have the core surfaces — prompts, streamed answers and reasoning, tools and their permissions, questions, interrupt and resume — but not rewind, side questions, subagent lanes, working-root changes or the skills and hooks inventories, and Tug says so rather than offering a control that cannot work.

Looking for an earlier version? [See all releases](https://github.com/kocienda/tug/releases). Want to know what changed? [Release notes](https://github.com/kocienda/tug/releases).

## For developers

Building Tug from source needs more than running it does. Beyond the requirements above, a build machine needs:

- Xcode 26.3 or later, for the Swift app and the macOS 26 SDK it compiles against
- A Rust toolchain from [rustup](https://rustup.rs) (the checkout pins the version), plus `cargo-nextest` for the tests
- [Bun](https://bun.sh) 1.3, for the frontend, the Claude Code bridge, and the TypeScript tests
- [`just`](https://github.com/casey/just), which runs every build, test, and lint recipe
- `tmux`, `wasm-pack`, and `shellcheck` for the day-to-day development loop

An Apple Developer ID certificate is optional for building and running Tug. It is needed for the app-test suite and for builds you share with other Macs. [DEVELOPING.md](DEVELOPING.md) walks through installing the tools and going from a fresh checkout to a running build.

## Learn more

- [More about Tug](https://kocienda.com/tug)
- [Read the journal](https://kocienda.com/tug/journal)
