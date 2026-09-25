# AGENTS.md — shared project memory

Persistent memory for AI agents working on rustermost. **Read this file first.**
Keep it up to date whenever conventions, structure or workflow change.

## What this is

- **rustermost**: a lightweight, WhatsApp-style Mattermost desktop client, built
  on **Tauri v2**. Rust backend in `src-tauri/src/`, **vanilla-JS frontend in
  `src/`** (no build step; Node.js is NOT needed to develop the app — only to
  run the frontend test harness).
- Deeper docs: `docs/ARCHITECTURE.md` (auth flow, backend state, command
  reference, WS pipeline) and `docs/DEVELOPMENT.md` (dev notes, gotchas, roadmap).
- Run dev build: `cargo tauri dev` from the repo root.

## Division of labor (set by the user — respect it)

- The **user writes all Rust** (`src-tauri/`) by hand as a learning exercise.
  The AI agent's role on the Rust side is **teacher only**: explain, review,
  design, sketch snippets in chat — but never write/edit Rust files.
- The **AI agent owns the frontend** (`src/`, vanilla JS): implement, test and
  commit UI work directly.

## Working agreements

- **One commit per issue.** Message style follows history:
  `[BUGFIX] what changed (#N)` — `[FEATURE]`, `[DOCS]`, `[RELEASE]` as fits.
  Never `git push` unless the user explicitly asks.
- Every frontend change **must ship with a passing test** (see Testing) before
  its commit, and the whole suite must stay green.
- GitHub issues: `gh` CLI is NOT installed — use the API:
  `curl -s "https://api.github.com/repos/pinkDreud/rustermost/issues?state=all&per_page=100"`.
- Working method requested by the user: implementation steps are delegated to
  sub-agent instances (Task tool); afterwards **separate verifier sub-agents**
  re-check the work — run the tests, review the diff against the issue text,
  and report pass/fail back.

## Frontend conventions (src/)

- One module, `src/main.js`, organized in `===== SECTION =====` banners;
  `src/styles.css` (theming via CSS variables, `data-theme` / `data-density` /
  `data-grouping` on `<html>`); `src/index.html`.
- Message content is rendered as **DOM nodes only — never innerHTML** (injection
  surface). `innerHTML` is only ever assigned fixed literal placeholders.
- Talk to the backend ONLY via registered Tauri commands / `mm-*` events, and
  **probe + degrade gracefully** when a command might not exist in the backend
  yet (pattern documented at the top of `main.js`).
- Settings persist in localStorage key `rustermost.settings`; enum values are
  validated against `SETTINGS_VALUES`; applied via CSS variables / `data-*`
  attributes. The inline script in `index.html` is the pre-paint copy and
  **must stay in sync** with the `SETTINGS_*` constants in `main.js`. Pane
  sizes (sidebar width + composer floor, set via drag sashes) persist
  separately under `rustermost.panes`; the same inline script re-applies the
  sidebar width pre-paint, so it must also stay in sync with the
  `SIDEBAR_MIN`/`SIDEBAR_MAX` clamp in `main.js`.
- Avatar/image URLs are interpolated into inline styles only after validating
  they are `data:image/…;base64,…` URLs (see `paintAvatar`).
- External links open via the opener plugin, http(s) only (see `openExternal`).

## Testing (frontend)

- Harness: `tests/harness.mjs` — a dependency-free fake DOM + a stubbed
  `window.__TAURI__` bridge. It boots `src/main.js` in Node by having the
  `restore_session`/`fetch_me` stubs resolve, so the app's `init()` runs; tests
  then drive the app through fake events.
- Run the suite: `node tests/run.mjs` (discovers `tests/fe/*.test.mjs`;
  non-zero exit on failure).
- Convention: each fix/feature adds `tests/fe/<issue>-<slug>.test.mjs`.
