# Development & roadmap

This is a **learning project**. The code deliberately favors clarity and directness over production hardening: there is no retry/backoff, error surfacing to the user is still minimal, and several rough edges remain. It's meant to be read, run, and extended by engineers, not deployed as-is.

## Prerequisites (all platforms)

The primary and tested platform is **Windows** (see the [README](../README.md) for the quick setup). Notes:

- **Windows** — if the C++ Build Tools are missing, the build fails with `error: linker `link.exe` not found`; installing the *Desktop development with C++* workload resolves it.
- **macOS (untested)** — install the Xcode Command Line Tools (`xcode-select --install`).
- **Linux (untested)** — install `webkit2gtk` (4.1), `librsvg2`, and a C toolchain such as `build-essential` plus `libssl-dev` (package names vary by distribution).

## Development notes

- **The session token lives in memory only.** After SSO login the captured token is held in the Rust backend's state and is **never written to disk**. Practical consequence: any change to the Rust backend triggers `cargo tauri dev` to recompile and restart the app, which wipes the in-memory token — **you have to log in again**. Editing only the frontend (JS/HTML/CSS) hot-reloads and keeps the session alive, so front-end iteration is fast.
- **Two separate log streams.** Rust `println!` / `eprintln!` output goes to the **terminal** running `cargo tauri dev`; JavaScript `console.log` goes to the in-app **DevTools console (F12)**. WebSocket connection state, errors, and the raw event loop are logged from Rust (terminal), while parsed messages are emitted to the frontend. When something goes wrong, check *both* places.
- **serde field renaming is bidirectional.** `Channel.channel_type` is annotated with `#[serde(rename = "type")]`. That rename applies in both directions, so on the **JavaScript side the field is `type`**, not `channel_type` (e.g. `channel.type === "D"`). Keep this in mind whenever you touch a struct with renamed fields.
- **TLS uses the `native-tls` backend.** The WebSocket relies on OS-provided TLS (Schannel on Windows), which matches reqwest's default and avoids any extra configuration. *Historical note:* an earlier attempt with rustls failed on Windows because rustls requires an explicit crypto provider to be installed — `native-tls` sidesteps that entirely.

## Known gotchas

- **"Runs but behaves like an old version" usually means a failed compile.** `cargo tauri dev` keeps running the **last successfully-built binary** when a rebuild fails, so your latest changes silently don't take effect. Always scroll up in the terminal and look for red compile errors before assuming a logic bug.
- **After any backend edit you are logged out** (see Development notes) — if the app suddenly acts unauthenticated right after a recompile, that's expected; just log in again.
- **Don't look for `channel_type` in the frontend** — the field is `type` on the JS side due to the serde rename.

## Status — what works today

- SSO login via cookie capture.
- Fetching the current user, teams, and channels.
- Chat / Community grouping of channels.
- Cross-team channel aggregation, with de-duplication and in-memory caching.
- Real-time receiving of new messages over WebSocket.
- Sending messages.
- Loading paginated message history (last 100 posts, returned oldest→newest).

## Roadmap / TODO

- **Proper WhatsApp-style UI** (chat sidebar, message pane, composer). Only a minimal test frontend exists today — the UI is the main remaining work.
- **Resolve display names for direct-message channels.** Mattermost `D` channels come back with an empty `display_name`, so the other participant's name has to be derived.
- **Infinite-scroll history pagination** — fetch older posts using a `before=<post_id>` cursor.
- **Keep the WebSocket handle in state and add automatic reconnection.**
- **Persist the token securely on disk** (e.g. encrypted, in the app data directory) so you don't have to log in after every restart.
- **Unit tests** — extract pure logic such as channel de-duplication and grouping into testable functions.
- **Migrate remaining `String`-typed command errors** to the unified `AppError` type.
