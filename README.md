<p align="center">
  <img src="docs/images/RusterMost_logo.png" alt="rustermost logo" width="220">
</p>

# rustermost

A lightweight, WhatsApp-style alternative desktop client for Mattermost.

> **Unofficial, third-party project** — not affiliated with or endorsed by Mattermost, Inc. Built as a learning project.

## How this was built

This project has a deliberate division of labor: the **Rust backend** (`src-tauri/`) is hand-written by me as a learning exercise — while exploring Rust, under some guidance by various LLMs. The **frontend** (`src/`, vanilla JavaScript) is the mirror image: it's programmed by [Claude](https://claude.com/claude-code). Keep that in mind when reading the code — the backend optimizes for learning clarity, the frontend for getting a UI built around it.

## Overview

rustermost is a desktop client for [Mattermost](https://mattermost.com/), aimed at organizations that run Mattermost behind **SSO** with **Personal Access Tokens disabled**. Since you can't get an API token the normal way, rustermost opens an SSO login window, captures the session cookie (`MMAUTHTOKEN`) from it, and reuses its value as a Bearer token for REST and WebSocket calls. Built with [Tauri v2](https://tauri.app/) (Rust backend + vanilla JS frontend).

## Features

- **SSO login** via cookie capture — no Personal Access Token required; the server URL is remembered between launches.
- **Conversation sidebar** grouped into Direct messages, Groups, and Community (public/private channels), each collapsible, ordered by recent activity, with per-conversation unread badges.
- **Search** conversations by channel name *and* by people's real names (first/last), not just usernames.
- **Avatars** shown next to every message; in the sidebar, direct chats show the person's photo and groups/channels an initial.
- **Real-time messaging** — messages are received live over WebSocket (with auto-reconnect) and sent over REST, with desktop notifications for incoming messages.
- **Message history** with infinite scroll — older messages load as you scroll back up.
- **Start new conversations** from inside the app: a direct message or group message by picking people, or a named public/private channel in a team.
- **Team labels** on Community channels, so same-named channels across teams are easy to tell apart.
- **Unread tracking synced with the server** — badges are seeded from Mattermost's read-state at startup, a pinned **Unread** section sits on top of the sidebar, and opening a conversation reports the read back so your other devices clear their badges too.
- **File & image attachments, both directions** — send via the 📎 button, drag & drop, or pasting a screenshot; received images render as thumbnails with a click-to-zoom lightbox, other files as named chips.
- **Markdown rendering** — links (opened in the system browser), bold/italic/strikethrough, inline code and fenced code blocks, quotes, and lists — built as DOM nodes, never injected HTML.
- **Emoji** — `:shortcodes:`, an autocomplete popup in the composer (type `:ta…`), and the server's custom emoji rendered inline.
- **Reactions** — react to any message from a searchable emoji picker; counts update live across clients and devices.
- **Slash commands** — `/away`, `/shrug`, custom integrations — executed for real, with ephemeral replies rendered in-chat as "only visible to you" bubbles.
- **Display settings** — a ⚙ panel for font size (small/medium/large), theme (dark/light/system, following the OS live), and message density (comfortable/compact); applied instantly and remembered between launches.

## Installation

rustermost is built with [Tauri v2](https://tauri.app/): the toolchain is **Rust only** — the frontend is vanilla JS served straight from `src/`, so **no Node.js/npm is required**. Follow your platform's steps, then [run it](#run-it).

### 1. Install Rust (all platforms)

Install Rust via [rustup](https://rustup.rs) — on macOS/Linux:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

On Windows, download and run `rustup-init.exe` from the same page (keep the default `stable-msvc` toolchain).

### 2. Platform dependencies

**Linux (Ubuntu / Debian)** — the system libraries Tauri needs (WebKitGTK webview, GTK, TLS, tray/icon support):

```sh
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

> Ubuntu 22.04+ / Debian 12+. On other distributions the package names differ — see [Tauri&#39;s Linux prerequisites](https://tauri.app/start/prerequisites/#linux). Note: Linux is currently untested — these are Tauri's standard requirements; reports welcome.

**macOS** — the Xcode Command Line Tools (compiler + system SDKs):

```sh
xcode-select --install
```

**Windows** — Microsoft C++ Build Tools with the *Desktop development with C++* workload:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

WebView2 is also required, but already ships with Windows 10/11.

### 3. Install the Tauri CLI (all platforms)

```sh
cargo install tauri-cli --locked
```

### Run it

From the project root (the folder with `src/` and `src-tauri/`):

```sh
cargo tauri dev
```

The first build compiles several hundred crates and takes a few minutes; later builds are incremental.

**Log in:** enter your Mattermost server URL (e.g. `https://your-mattermost.example.org`), click **Connect**, and complete the SSO login in the window that opens. The session cookie is captured automatically.

> Development notes, gotchas, and troubleshooting are in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Try it / share it with testers

To let colleagues try rustermost **without installing Rust or any toolchain**, build a packaged app and hand them the result. Builds are **per-platform** (a Windows build must be made on Windows, a macOS build on a Mac, …). On the build machine (which does need the prerequisites above), from the project root:

```sh
cargo tauri build
```

This produces, under `src-tauri/target/release/`:

- **Windows** — `rustermost.exe` (in `release/` directly): a standalone executable; copy the single file and double-click, no install needed (Windows 10/11 already ship WebView2). Plus installers under `release/bundle/`: an NSIS setup (`bundle/nsis/rustermost_<version>_x64-setup.exe`) and/or an MSI (`bundle/msi/…`) for a normal install with Start-menu entry and uninstaller.
- **macOS** — `bundle/macos/rustermost.app` and a drag-to-Applications disk image under `bundle/dmg/`.
- **Linux** — `bundle/deb/` (Debian/Ubuntu package) and `bundle/appimage/` (portable AppImage).

Testers just need the URL of a Mattermost server they can reach and their SSO credentials; on first launch they enter the URL, click **Connect**, and log in through SSO exactly as in dev.

> The builds are **unsigned**: Windows SmartScreen shows a "Windows protected your PC" warning (click **More info → Run anyway**), and macOS Gatekeeper may require right-click → **Open** the first time. That's expected for an in-house tool; code-signing removes the warnings but isn't set up here.

## Tests

There are **no tests yet**. This repository began as a Rust-learning project, and the priority so far has been building features while learning the language — a deliberate trade-off, not an oversight. **Tests are the next step**: the plan is to extract the pure logic (channel grouping and de-duplication, unread computation, markdown parsing, emoji resolution) into functions testable on both the Rust and JavaScript sides.

## Documentation

- **[Architecture](docs/ARCHITECTURE.md)** — auth flow, backend state, commands reference, real-time pipeline.
- **[Development &amp; roadmap](docs/DEVELOPMENT.md)** — dev notes, gotchas, current status, and what's next.

## License

Released under the **MIT License** — see [`LICENSE`](LICENSE). You are free to use, modify, and distribute this software, including commercially, provided the copyright notice is retained.
