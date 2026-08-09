<p align="center">
  <img src="docs/images/RusterMost_logo.png" alt="rustermost logo" width="220">
</p>

# rustermost

A lightweight, WhatsApp-style alternative desktop client for Mattermost.

> **Unofficial, third-party project** — not affiliated with or endorsed by Mattermost, Inc. Built as a learning project.

## Overview

rustermost is a desktop client for [Mattermost](https://mattermost.com/), aimed at organizations that run Mattermost behind **SSO** with **Personal Access Tokens disabled**. Since you can't get an API token the normal way, rustermost opens an SSO login window, captures the session cookie (`MMAUTHTOKEN`) from it, and reuses it for REST and WebSocket calls. Built with [Tauri v2](https://tauri.app/) (Rust backend + vanilla JS frontend).

## Features

- **SSO login** via cookie capture — no Personal Access Token required; the server URL is remembered between launches.
- **Conversation sidebar** grouped into Direct messages, Groups, and Community (public/private channels), each collapsible, ordered by recent activity, with per-conversation unread badges.
- **Search** conversations by channel name *and* by people's real names (first/last), not just usernames.
- **Avatars** shown next to every message and in the sidebar, for both direct chats and channels.
- **Real-time messaging** over WebSocket (send + receive), with desktop notifications for incoming messages.
- **Message history** with infinite scroll — older messages load as you scroll back up.
- **Start new conversations** from inside the app: a direct message or group message by picking people, or a named public/private channel in a team.
- **Team labels** on Community channels, so same-named channels across teams are easy to tell apart.

## Quick start (developers)

**Prerequisites (Windows):**

- [Rust](https://rustup.rs) (default `stable-msvc` toolchain)
- Microsoft C++ Build Tools with the *Desktop development with C++* workload:
  ```powershell
  winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  ```
- Tauri CLI: `cargo install tauri-cli --locked`
- WebView2 (already present on Windows 10/11)

**Run** — from the project root (the folder with `src/` and `src-tauri/`):

```powershell
cargo tauri dev
```

The first build compiles several hundred crates and takes a few minutes; later builds are incremental.

**Log in:** enter your Mattermost server URL (e.g. `https://your-mattermost.example.org`), click **Connect**, and complete the SSO login in the window that opens. The session cookie is captured automatically.

> macOS/Linux prerequisites and troubleshooting are in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Try it / share it with testers

To let colleagues try rustermost **without installing Rust or any toolchain**, build a packaged app and hand them the result. On the build machine (which does need the prerequisites above), from the project root:

```powershell
cargo tauri build
```

This produces, under `src-tauri/target/release/`:

- **`rustermost.exe`** (in `release/` directly) — a standalone executable. The quickest way to test: copy this single file to the tester's machine and double-click it. No install needed (Windows 10/11 already ship WebView2).
- An **installer**, under `release/bundle/` — an NSIS setup (`bundle/nsis/rustermost_<version>_x64-setup.exe`) and/or an MSI (`bundle/msi/…`). Send this if you'd rather testers install it like a normal app (Start-menu entry, uninstaller, the rustermost icon).

Testers just need the URL of a Mattermost server they can reach and their SSO credentials; on first launch they enter the URL, click **Connect**, and log in through SSO exactly as in dev.

> The build is **unsigned**, so Windows SmartScreen will show a "Windows protected your PC" warning the first time — that's expected for an in-house tool. Testers click **More info → Run anyway**. Signing the binary (a code-signing certificate) removes the warning but isn't set up here.

## Documentation

- **[Architecture](docs/ARCHITECTURE.md)** — auth flow, backend state, commands reference, real-time pipeline.
- **[Development & roadmap](docs/DEVELOPMENT.md)** — dev notes, gotchas, current status, and what's next.

## License

Released under the **MIT License** — see [`LICENSE`](LICENSE). You are free to use, modify, and distribute this software, including commercially, provided the copyright notice is retained.

Copyright © 2026 Matteo Magherini
