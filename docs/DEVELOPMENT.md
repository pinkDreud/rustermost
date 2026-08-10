# Development & roadmap

This is a **learning project**. The code deliberately favors clarity and directness over production hardening: there is no retry/backoff, error surfacing to the user is still minimal, and several rough edges remain. It's meant to be read, run, and extended by engineers, not deployed as-is.

## Prerequisites (all platforms)

The primary and tested platform is **Windows** (see the [README](../README.md) for the quick setup). Notes:

- **Windows** — if the C++ Build Tools are missing, the build fails with `error: linker `link.exe` not found`; installing the *Desktop development with C++* workload resolves it.
- **macOS (tested)** — install the Xcode Command Line Tools (`xcode-select --install`). Development on an Apple Silicon Mac works; see the macOS notes under "Known gotchas".
- **Linux (untested)** — install `webkit2gtk` (4.1), `librsvg2`, and a C toolchain such as `build-essential` plus `libssl-dev` (package names vary by distribution).

## Development notes

- **The session token lives in memory only.** After SSO login the captured token is held in the Rust backend's state and is **never written to disk**. Practical consequence: any change to the Rust backend triggers `cargo tauri dev` to recompile and restart the app, which wipes the in-memory token — **you have to log in again**. Editing only the frontend (JS/HTML/CSS) hot-reloads and keeps the session alive, so front-end iteration is fast.
- **Two separate log streams.** Rust `println!` / `eprintln!` output goes to the **terminal** running `cargo tauri dev`; JavaScript `console.log` goes to the in-app **DevTools console (F12)**. WebSocket connection state, errors, and the raw event loop are logged from Rust (terminal), while parsed messages are emitted to the frontend. When something goes wrong, check *both* places.
- **serde field renaming is bidirectional.** `Channel.channel_type` is annotated with `#[serde(rename = "type")]`. That rename applies in both directions, so on the **JavaScript side the field is `type`**, not `channel_type` (e.g. `channel.type === "D"`). Keep this in mind whenever you touch a struct with renamed fields.
- **TLS uses the `native-tls` backend.** The WebSocket relies on OS-provided TLS (Schannel on Windows), which matches reqwest's default and avoids any extra configuration. *Historical note:* an earlier attempt with rustls failed on Windows because rustls requires an explicit crypto provider to be installed — `native-tls` sidesteps that entirely.
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
- Real-time send + receive over WebSocket, with duplicate-delivery protection (post-id dedupe, and the WS task is aborted/replaced on reconnect).
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
- **WebSocket auto-reconnection.** The abort/replace machinery (`ws_task`) is the foundation; what's missing is a retry loop when the connection drops. Until then, a dead socket means no live updates until restart.
- **Forward `channel_viewed` (and optionally `emoji_added`, `ephemeral_message`) over the WS bridge** — the frontend listeners (`mm-viewed`, `mm-emoji-added`) already exist, dormant.
- **Persist the token securely** (OS keychain) so a restart doesn't require a new SSO login.
- **Migrate remaining `String`-typed command errors** to the unified `AppError` type.
- **Streaming uploads** for very large files (attachments currently cross the invoke bridge as base64).
