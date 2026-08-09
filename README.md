<p align="center">
  <img src="docs/images/RusterMost_logo.png" alt="rustermost logo" width="220">
</p>

# rustermost

A lightweight, WhatsApp-style alternative desktop client for Mattermost.

> **Unofficial, third-party project** — not affiliated with or endorsed by Mattermost, Inc. Built as a learning project.

## Overview

rustermost is a desktop client for [Mattermost](https://mattermost.com/), aimed at organizations that run Mattermost behind **SSO** with **Personal Access Tokens disabled**. Since you can't get an API token the normal way, rustermost opens an SSO login window, captures the session cookie (`MMAUTHTOKEN`) from it, and reuses it for REST and WebSocket calls. Built with [Tauri v2](https://tauri.app/) (Rust backend + vanilla JS frontend).

It is a working proof-of-concept: the backend is fully functional; a polished UI is still in progress.

## Features

- SSO login via cookie capture (no Personal Access Token required)
- Fetch user, teams, and channels; group them into **Chat** (DMs/groups) vs **Community** (public/private)
- Real-time messaging over WebSocket (receive + send)
- Paginated message history

## Quick start

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

## Documentation

- **[Architecture](docs/ARCHITECTURE.md)** — auth flow, backend state, commands reference, real-time pipeline.
- **[Development & roadmap](docs/DEVELOPMENT.md)** — dev notes, gotchas, current status, and what's next.

## License

Released under the **MIT License** — see [`LICENSE`](LICENSE). You are free to use, modify, and distribute this software, including commercially, provided the copyright notice is retained.

Copyright © 2026 Matteo Magherini
