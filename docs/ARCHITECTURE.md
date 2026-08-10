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
    session:  Mutex<Option<Session>>,                       // set by capture_session
    channels: Mutex<Vec<Channel>>,                          // in-memory cache
    ws_task:  Mutex<Option<tokio::task::JoinHandle<()>>>,   // the running WebSocket task
}

struct Session { base_url: String, token: String }
```

- `session` is `None` until SSO capture succeeds. The helper `AppState::current_session()` locks the mutex and clones the `Session` out, or returns `AppError::NotLoggedIn` if the user hasn't authenticated yet. Every authenticated command starts by calling it, so "not logged in" is handled uniformly.
- `channels` is an in-memory cache of the user's channels across all teams. It is populated by `fetch_all_channels` / `fetch_all_channels_with_members` and read back instantly (no network) by `get_cached_channels`.
- `ws_task` holds the `JoinHandle` of the background WebSocket task. `connect_websocket` **aborts any previous task before spawning a new one**, making reconnection idempotent — without this, a frontend reload would leave a ghost connection behind and every message would be delivered (and rendered) twice.

The guiding rule for what belongs in state: **cache things that stay true; return things that change.** Per-user read-state (`msg_count`, `mention_count`) changes on every read from any device, so it is fetched fresh and returned, never cached.

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
| `fetch_channel_members` | `teamId` | Returns **my** ChannelMember records (read-state: `msg_count`, `mention_count`, `last_viewed_at`) for every channel in a team. |
| `fetch_all_channels_with_members` | — | Channels across all teams, de-duplicated, each paired with my member record (`member` may be null). Powers the unread badges at startup. |
| `view_channel` | `channelId` | `POST /channels/members/me/view`; marks a channel read on the server (clears badges on other devices too). |
| `connect_websocket` | — | Spawns (replacing any previous instance) the background task that maintains the real-time WebSocket connection. |
| `send_message` | `channelId`, `message`, `fileIds?` | `POST /api/v4/posts`; publishes a message, optionally with uploaded file attachments. |
| `get_posts` | `channelId`, `before?` | `GET /api/v4/channels/{id}/posts?per_page=100[&before=<id>]`; one page of history, oldest → newest. The `before` cursor drives infinite scroll. |
| `get_users_by_ids` | `ids` | `POST /api/v4/users/ids`; batch-resolves user ids to user objects (names for DMs and message authors). |
| `search_users` | `term` | `POST /api/v4/users/search`; people search for the new-conversation modal. |
| `get_avatar` | `userId` | Fetches a user's profile image and returns it as a base64 `data:` URL. |
| `create_chat` | `userIds` | Creates a direct (2 ids) or group (3+) message channel. |
| `create_named_channel` | `teamId`, `name`, `displayName`, `channelType` | Creates a public (`O`) or private (`P`) channel in a team. |
| `get_file_info` | `fileId` | `GET /files/{id}/info`; name, size, and `mime_type` of an attachment. |
| `get_file_thumbnail` | `fileId` | Attachment thumbnail as a `data:` URL (JPEG). |
| `get_file` | `fileId`, `mime` | Full attachment as a `data:` URL; the mime comes from `get_file_info`. |
| `upload_file` | `channelId`, `filename`, `dataB64` | `POST /api/v4/files` (raw body + query params); returns the new file's id, to be passed to `send_message`. |
| `get_custom_emojis` | `page` | One page (200) of the server's custom emoji (`{id, name}`); the frontend pages until exhausted. |
| `get_emoji_image` | `emojiId` | Custom emoji image as a `data:` URL; mime read from the `Content-Type` response header (PNG or GIF). |
| `add_reaction` | `postId`, `emojiName`, `userId` | `POST /api/v4/reactions`; body is a serialized `Reaction`. |
| `remove_reaction` | `postId`, `emojiName`, `userId` | `DELETE /users/{uid}/posts/{pid}/reactions/{name}`. |
| `execute_command` | `channelId`, `teamId`, `command` | `POST /api/v4/commands/execute`; runs a slash command and returns the server's response (ephemeral `text` is rendered locally). |

`get_posts` reverses Mattermost's ordering (the API returns newest-first) so the UI receives messages in chronological order. Binary assets (avatars, attachments, emoji) all follow one pattern: **fetched in Rust, base64-encoded, returned as `data:` URLs** — the webview never talks to the Mattermost server directly.

## Real-time pipeline

`connect_websocket` spawns a detached `tokio` task and returns immediately, so the UI is never blocked by the long-lived connection. Inside the task:

1. It derives the WebSocket URL by rewriting the base URL's scheme (`https://` → `wss://`) and appending `/api/v4/websocket`, then connects with `tokio_tungstenite`.
2. It sends an `authentication_challenge` action carrying the session token, then enters a read loop over incoming frames.
3. It filters incoming frames by event type. Mattermost nests payloads as **JSON-encoded strings** inside the envelope (`data.post`, `data.reaction`), so handlers perform a **double parse**: first the envelope, then the inner string.
   - `posted` → emitted as `mm-post` with `IncomingMessage { id, file_ids, channel_id, sender, message }`. The post `id` powers the frontend's duplicate-delivery guard; `file_ids` lets attachments render live.
   - `reaction_added` / `reaction_removed` → emitted as `mm-reaction-added` / `mm-reaction-removed` with a `Reaction { user_id, post_id, emoji_name }`, keeping reaction pills in sync across clients.

The frontend subscribes with `window.__TAURI__.event.listen(...)`. This closes an elegant loop: a message you publish through `send_message` is echoed back to you by the server over this same WebSocket, so sent and received messages flow through one unified path into the UI. The frontend also listens for `mm-viewed` and `mm-emoji-added` — currently dormant hooks that light up if the WS loop is ever extended to forward `channel_viewed` / `emoji_added` events.

## REST endpoints used

All endpoints are called against the session's `base_url` and authenticated with `Authorization: Bearer <MMAUTHTOKEN>`:

- `GET /api/v4/users/me` — current user
- `GET /api/v4/users/me/teams` — the user's teams
- `GET /api/v4/users/me/teams/{team_id}/channels` — channels for a team
- `GET /api/v4/users/me/teams/{team_id}/channels/members` — my read-state per channel
- `POST /api/v4/channels/members/me/view` — mark a channel viewed
- `GET /api/v4/channels/{channel_id}/posts?per_page=100[&before=<post_id>]` — channel history (paged)
- `POST /api/v4/posts` — publish a message (optionally with `file_ids`)
- `POST /api/v4/users/ids` / `POST /api/v4/users/search` — user resolution & search
- `GET /api/v4/users/{user_id}/image` — avatar
- `POST /api/v4/channels/direct|group` / `POST /api/v4/channels` — create conversations
- `POST /api/v4/files?channel_id&filename` — upload an attachment (raw body)
- `GET /api/v4/files/{id}` / `/info` / `/thumbnail` — attachment content & metadata
- `GET /api/v4/emoji` / `GET /api/v4/emoji/{id}/image` — custom emoji list & images
- `POST /api/v4/reactions` / `DELETE /api/v4/users/{uid}/posts/{pid}/reactions/{name}` — reactions
- `POST /api/v4/commands/execute` — slash commands
- `wss://<host>/api/v4/websocket` — real-time event stream (authenticated via `authentication_challenge`)

## A note on the `Channel` type

The `Channel` struct's Rust field is `channel_type`, but it is annotated `#[serde(rename = "type")]` to match Mattermost's JSON key `"type"`. Serde's rename is bidirectional and applies to serialization as well as deserialization, so when a `Channel` crosses the bridge into JavaScript the field is named **`type`**, not `channel_type`. Frontend code reading a channel's kind (`D`, `G`, `O`, `P`) must use `channel.type`.
