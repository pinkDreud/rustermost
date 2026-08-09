# Architecture

`rustermost` is a [Tauri v2](https://tauri.app/) desktop application. The **frontend** (plain HTML + vanilla JavaScript in `src/`) renders the UI and calls into the **Rust backend** (`src-tauri/src/lib.rs`) through Tauri's `invoke` bridge. The backend owns all network I/O — REST calls to the Mattermost server and a persistent WebSocket — and holds the authenticated session in shared, mutex-guarded state. The frontend never sees the Mattermost credentials directly beyond the moment they are captured; all authenticated work happens in Rust.

## Authentication flow

Authentication is delegated entirely to the Mattermost server's own SSO, so `rustermost` never handles usernames or passwords:

1. The user enters their server URL and submits the form. The frontend calls `open_sso_window(url)`, which opens a dedicated Tauri `WebviewWindow` (label `"sso-login"`, 500×700) pointed at the Mattermost server. The user completes the login inside that webview, exactly as they would in a browser.
2. Meanwhile the frontend polls: every 2 seconds it calls `capture_session(baseUrl)`. On the backend, `capture_session` looks up the `"sso-login"` webview, reads its cookies for the given URL via `cookies_for_url`, and searches for the `MMAUTHTOKEN` cookie. Until the user has finished logging in, no such cookie exists and the command rejects; the frontend swallows that rejection and retries on the next tick.
3. Once the cookie appears, `capture_session` extracts its value and stores a `Session { base_url, token }` in the shared backend state, then returns the token to JavaScript (which stops the polling loop).

From that point on, the captured `MMAUTHTOKEN` is used as a **Bearer token** on every REST request (`Authorization: Bearer <MMAUTHTOKEN>`) and as the credential in the WebSocket `authentication_challenge`. Because the token lives in backend state, individual commands don't take it as an argument — they read it from the session.

## Backend state

All shared state lives in a single struct, registered once at startup with Tauri's `.manage(...)` and injected into commands as `tauri::State<'_, AppState>`:

```rust
struct AppState {
    session:  Mutex<Option<Session>>,   // set by capture_session
    channels: Mutex<Vec<Channel>>,      // in-memory cache
}

struct Session { base_url: String, token: String }
```

- `session` is `None` until SSO capture succeeds. The helper `AppState::current_session()` locks the mutex and clones the `Session` out, or returns `AppError::NotLoggedIn` if the user hasn't authenticated yet. Every authenticated command starts by calling it, so "not logged in" is handled uniformly.
- `channels` is an in-memory cache of the user's channels across all teams. It is populated by `fetch_all_channels` and read back instantly (no network) by `get_cached_channels`.

## Error handling

Commands that touch the network return `Result<_, AppError>`. `AppError` is a small enum:

```rust
enum AppError { Network(String), Tauri(String), NotLoggedIn }
```

It implements `Display` (human-readable messages), `From<reqwest::Error>` and `From<tauri::Error>` (so the `?` operator converts underlying failures automatically), and a custom `Serialize` that serializes the error to its `Display` string. Because Tauri serializes a command's `Err` value across the bridge, any `AppError` surfaces in JavaScript as a **rejected promise** carrying that string — catchable with ordinary `try/catch` (or `.catch`). This is exactly how the frontend's SSO polling loop distinguishes "token not ready yet" from success.

Note that the two SSO-facing commands (`open_sso_window`, `capture_session`) instead return `Result<_, String>`, since they run before a session exists and report low-level errors (URL parse, missing webview, cookie not found) directly as strings.

## Commands reference

All commands are invoked from JavaScript via `invoke("<name>", { ...args })`. Tauri maps Rust `snake_case` argument names to **camelCase** on the JS side.

| Command | JS arguments | Description |
| --- | --- | --- |
| `get_app_status` | — | Health check; returns a fixed "Backend Rust is on!" string. |
| `open_sso_window` | `url` | Opens the `"sso-login"` webview window pointed at the Mattermost server. |
| `capture_session` | `baseUrl` | Reads the SSO webview's cookies, finds `MMAUTHTOKEN`, stores the `Session` in state, and returns the token. |
| `fetch_me` | — | `GET /api/v4/users/me`; returns the current user as raw JSON. |
| `fetch_teams` | — | `GET /api/v4/users/me/teams`; returns the user's teams. |
| `fetch_channels` | `teamId` | Returns the user's channels for one team. |
| `fetch_grouped_channels` | `teamId` | Same fetch, but `partition`ed into `chat` (types `D`/`G`) and `community` (types `O`/`P`). |
| `fetch_all_channels` | — | Aggregates channels across every team, de-duplicates by `id`, fills the cache, and returns the list. |
| `get_cached_channels` | — | Returns the cached channel list instantly, with no network call. |
| `connect_websocket` | — | Spawns the background task that maintains the real-time WebSocket connection. |
| `send_message` | `channelId`, `message` | `POST /api/v4/posts`; publishes a message to a channel. |
| `get_posts` | `channelId` | `GET /api/v4/channels/{id}/posts?per_page=100`; returns posts ordered oldest → newest. |

`get_posts` reverses Mattermost's ordering (the API returns newest-first) so the UI receives messages in chronological order.

## Real-time pipeline

`connect_websocket` spawns a detached `tokio` task and returns immediately, so the UI is never blocked by the long-lived connection. Inside the task:

1. It derives the WebSocket URL by rewriting the base URL's scheme (`https://` → `wss://`) and appending `/api/v4/websocket`, then connects with `tokio_tungstenite`.
2. It sends an `authentication_challenge` action carrying the session token, then enters a read loop over incoming frames.
3. It filters to frames where `event == "posted"`. Mattermost nests the post as a **JSON-encoded string** inside `data.post`, so the handler performs a **double parse**: first the envelope, then the `post` string. It builds a clean `IncomingMessage { channel_id, sender, message }` (sender taken from `data.sender_name`) and emits it to the frontend via `app.emit("mm-post", msg)`.

The frontend subscribes with `window.__TAURI__.event.listen("mm-post", cb)`. This closes an elegant loop: a message you publish through `send_message` is echoed back to you by the server over this same WebSocket, so sent and received messages flow through one unified path into the UI.

## REST endpoints used

All endpoints are called against the session's `base_url` and authenticated with `Authorization: Bearer <MMAUTHTOKEN>`:

- `GET /api/v4/users/me` — current user
- `GET /api/v4/users/me/teams` — the user's teams
- `GET /api/v4/users/me/teams/{team_id}/channels` — channels for a team
- `GET /api/v4/channels/{channel_id}/posts?per_page=100` — channel history
- `POST /api/v4/posts` — publish a message
- `wss://<host>/api/v4/websocket` — real-time event stream (authenticated via `authentication_challenge`)

## A note on the `Channel` type

The `Channel` struct's Rust field is `channel_type`, but it is annotated `#[serde(rename = "type")]` to match Mattermost's JSON key `"type"`. Serde's rename is bidirectional and applies to serialization as well as deserialization, so when a `Channel` crosses the bridge into JavaScript the field is named **`type`**, not `channel_type`. Frontend code reading a channel's kind (`D`, `G`, `O`, `P`) must use `channel.type`.
