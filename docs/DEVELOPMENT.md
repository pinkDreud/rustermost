# Development & roadmap

This is a **learning project**: the Rust backend is hand-written by the author while learning the language; the JavaScript frontend is written by Claude (see the README's "How this was built"). The code deliberately favors clarity and directness over production hardening: error surfacing to the user is still minimal, retry logic is basic (the WebSocket reconnects on a fixed 5 s delay; REST calls don't retry), and several rough edges remain. It's meant to be read, run, and extended by engineers, not deployed as-is.

## Prerequisites (all platforms)

Full step-by-step installation instructions for **Windows, macOS, and Linux (Ubuntu)** live in the [README](../README.md#installation). Extra notes:

- **Windows** — if the C++ Build Tools are missing, the build fails with ``error: linker `link.exe` not found``; installing the *Desktop development with C++* workload resolves it.
- **macOS (tested)** — development on an Apple Silicon Mac works; see the macOS notes under "Known gotchas".
- **Linux (untested)** — the README lists the Ubuntu/Debian package set; names vary on other distributions (Tauri's [Linux guide](https://tauri.app/start/prerequisites/#linux) has per-distro equivalents).

## Development notes

- **The session token is persisted to disk.** After SSO login, `capture_session` writes the `Session` (server URL + token) to `session.json` in the app data dir — written atomically and, on Unix, chmodded `0600` (owner-only). On startup the frontend calls `restore_session` and probes the server with `fetch_me`; a valid saved session skips the login screen entirely, a missing or expired one falls back to SSO (which rewrites the file). Practical consequences: backend recompiles no longer cost you a re-login, and **the token is on disk in plaintext** — a deliberate trade-off for a personal machine (same model as `gh`'s hosts file); the OS-keychain upgrade path stays open since the storage is isolated in `capture_session`/`restore_session`.
- **Two separate log streams.** Rust `println!` / `eprintln!` output goes to the **terminal** running `cargo tauri dev`; JavaScript `console.log` goes to the in-app **DevTools console (F12)**. When something goes wrong, check *both* places. Rust-side logging is currently minimal: a single `eprintln!` when the WebSocket connection ends in an error (`ws.rs`). The `mattermost_api` crate logs internally via the `log` crate, but no logger is initialized, so those entries are dropped — wiring up `env_logger` (or `tauri-plugin-log`) would surface them.
- **serde field renaming is bidirectional.** `Channel.channel_type` is annotated with `#[serde(rename = "type")]`. That rename applies in both directions, so on the **JavaScript side the field is `type`**, not `channel_type` (e.g. `channel.type === "D"`). Keep this in mind whenever you touch a struct with renamed fields.
- **TLS uses the `native-tls` backend** (OS-provided: Schannel on Windows, Secure Transport on macOS, OpenSSL on Linux), now supplied through the `mattermost_api` crate's stack — `reqwest` for REST and `async-tungstenite` for the WebSocket — plus our own direct `reqwest` for media downloads. No rustls TLS backend is enabled (rustls appears in `Cargo.lock` only as an unactivated optional dependency of reqwest). *Historical note:* an earlier attempt with rustls failed on Windows because rustls requires an explicit crypto provider to be installed — `native-tls` sidesteps that entirely.
- **The frontend degrades gracefully around missing backend commands.** New features are built frontend-first: the JS probes a command once, and if it isn't registered yet it logs a `console.warn` naming the command and falls back (badges go session-local, attachments render as plain tags, slash commands send as text). This lets the two halves land independently.
- **`dragDropEnabled: false`** is set on the window in `tauri.conf.json` — deliberately. Tauri's native drag-drop interception would otherwise swallow the HTML5 drop events the frontend uses to attach dropped files.
- **A `#[tauri::command]` can be invoked again at any time.** Any command with a side effect like "start a background task" must decide what a second call means. `connect_websocket` answers by aborting the previous task (handle kept in `AppState.ws_task`) — the fix for a duplicate-message bug where every frontend reload leaked a second WebSocket.

## Known gotchas

- **"Runs but behaves like an old version" usually means a failed compile.** `cargo tauri dev` keeps running the **last successfully-built binary** when a rebuild fails, so your latest changes silently don't take effect. Always scroll up in the terminal and look for red compile errors before assuming a logic bug.
- **After any backend edit you are logged out** (see Development notes) — if the app suddenly acts unauthenticated right after a recompile, that's expected; just log in again.
- **Don't look for `channel_type` in the frontend** — the field is `type` on the JS side due to the serde rename.
- **`cargo check` passing does not mean a command is callable** — a `#[tauri::command]` that isn't listed in `generate_handler!` compiles fine (with a dead-code warning) but is invisible to the frontend. The frontend's probe warnings in the DevTools console name the missing command.
- **macOS notifications don't work under `cargo tauri dev`.** Unsigned, unbundled binaries aren't legitimate notification senders for Notification Center — toasts are silently dropped or show placeholder text. Test notifications with the bundled app (`cargo tauri build` → the `.app` under `target/release/bundle/macos/`), which prompts for permission properly. (On Mac, DevTools opens via right-click → *Inspect Element*, not F12.)
- **Keep decoration out of the critical path.** A message handler once died on a `ReferenceError` inside notification title-building, silently eating every incoming message while the window was unfocused. The notify block is now wrapped in `try/catch`; anything cosmetic in `onIncoming` should be.

## Status — what works today

- SSO login via cookie capture.
- Full WhatsApp-style UI: sidebar with sections, search by channel *and* person name, message pane, composer, new-conversation modal, avatars.
- Cross-team channel aggregation, with de-duplication and in-memory caching; DM names resolved via batch user lookup.
- Real-time send + receive over WebSocket via the `mattermost_api` crate, with **auto-reconnection** (5 s retry loop + keep-alive pings) and duplicate-delivery protection (post-id dedupe, and the WS task is aborted/replaced when `connect_websocket` is re-invoked).
- **Unread tracking synced with the server**: badges seeded from `total_msg_count − member.msg_count` at startup, pinned Unread section, reads reported back via `view_channel`.
- Infinite-scroll history (`before` cursor pagination).
- **Attachments both ways**: upload via button / drag & drop / paste, download with thumbnails, lightbox, and file chips.
- **Markdown** (links via system browser, emphasis, code, quotes, lists) rendered injection-safe.
- **Emoji**: shortcodes, composer autocomplete, custom server emoji.
- **Reactions**: add/remove with a searchable picker, live-synced both directions, history seeded from post metadata.
- **Slash commands** with ephemeral replies.
- Desktop notifications (bundled app; suppressed for the sending window's own echo, but fired for your messages from other devices).

## Roadmap / TODO

- **Tests — the next step.** The project has none; it was a Rust-learning exercise and features came first. Plan: extract pure logic (channel grouping/dedup, unread computation, markdown/emoji parsing) into unit-testable functions on both sides.
- **Smarter WebSocket backoff.** Auto-reconnection works (fixed 5 s retry); the refinement is exponential backoff with jitter so a long outage doesn't hammer the server at a steady beat.
- **Forward `channel_viewed` (and optionally `emoji_added`, `ephemeral_message`) over the WS bridge** — the frontend listeners (`mm-viewed`, `mm-emoji-added`) already exist, dormant.
- **Harden token storage** — the token now persists as an owner-only plaintext file (`session.json`); moving it to the OS keychain (the `keyring` crate abstracts all three platforms) remains an optional upgrade.
- **Migrate remaining `String`-typed command errors** to the unified `AppError` type.
- **Streaming uploads** for very large files (attachments currently cross the invoke bridge as base64).
