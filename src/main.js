// rustermost — frontend logic.
//
// Talks ONLY to registered Tauri commands (see generate_handler! in
// src-tauri/src/lib.rs) plus the "mm-*" events from the WebSocket task.
// Also uses Tauri core JS APIs: window (close interception), tray, menu and
// image for the Linux close-to-tray behavior (see the TRAY section below).
//
// Display settings (font size / theme / density) are frontend-only: saved in
// localStorage and applied as a CSS variable + data-attributes on <html>.
// First paint is covered by the inline script in index.html (see SETTINGS).
//
// FORWARD-COMPATIBLE HOOKS (light up automatically when you add the backend bits):
//   1. Channel.last_post_at (i64) — if present on a channel, the sidebar sorts
//      by it (most recent conversation first). Until then it falls back to
//      live activity learned during the session, then to the server's order.
//   2. "mm-viewed" event — once the WS loop forwards channel_viewed, channels
//      read on my other devices clear their badge here live.
//
// GRACEFUL-DEGRADATION FALLBACKS (these commands are shipped now; the probes
// stay so the frontend still runs against an older backend):
//   - get_users_by_ids — names 1:1 DMs, labels history authors, lets search
//     match people's real names. Without it: anonymous "Direct message".
//   - fetch_all_channels_with_members + view_channel — server-synced unread
//     badges. Without them: fetch_all_channels and session-local badges.
//   - get_file_info / get_file_thumbnail / get_file — attachment rendering.
//     Without them: a plain "📎 attachment" tag.
//   - upload_file — the 📎 button and pasted images. Without it: an error chip,
//     message text preserved.
//   - edit_message — right-click editing of my own messages. Without it: the
//     Edit item never shows / edits stay read-only.

import { EMOJI } from "./emoji-data.js";

const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

// ================= TRAY / CLOSE-TO-TRAY (Linux) =================
// Linux has no backend close handler (the hide-on-close in lib.rs is
// macOS-only; on Windows closing quits, which stays). Without this, closing
// the window kills the app — see issue #10. So on Linux we hide the main
// window instead and offer a tray icon with Show / Quit.
// Degrades gracefully: if the backend was built without the `tray-icon`
// feature or the window permissions (core:window:allow-hide/-show/-set-focus/
// -unminimize/-destroy), we warn once and keep the plain close-quits behavior.
const IS_LINUX = /linux/i.test(navigator.userAgent);

// TrayIcon icons via the always-allowed `plugin:image|new`, which takes raw
// RGBA bytes + dimensions (unlike from_bytes, which needs the image/png
// cargo feature enabled) — so we decode the PNG through a canvas.
async function rgbaFromPng(url) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  return {
    rgba: new Uint8Array(ctx.getImageData(0, 0, bmp.width, bmp.height).data.buffer),
    width: bmp.width,
    height: bmp.height,
  };
}

async function setupTray() {
  const T = window.__TAURI__;
  const win = T.window.getCurrentWindow();
  const showWindow = async () => {
    await win.unminimize(); // no-op unless minimized
    await win.show();
    await win.setFocus();
  };
  const quitApp = async () => {
    // Destroy every window (main + any SSO window left open); Tauri exits
    // once the last one is gone. destroy() skips close-requested listeners.
    for (const w of await T.window.getAllWindows()) await w.destroy();
  };
  const menu = await T.menu.Menu.new({
    items: [
      await T.menu.MenuItem.new({ id: "tray-show", text: "Show rustermost", action: showWindow }),
      await T.menu.MenuItem.new({ id: "tray-quit", text: "Quit", action: quitApp }),
    ],
  });
  const icon = await rgbaFromPng("favicon.png");
  await T.tray.TrayIcon.new({
    id: "main",
    icon: await T.image.Image.new(icon.rgba, icon.width, icon.height),
    tooltip: "rustermost",
    menu, // right-click (or any click on Ubuntu's appindicator ext) shows this
    // NOTE: on Linux (libappindicator) Tauri delivers NO click events, so
    // this action never fires there today — left-clicking our icon is dead
    // by upstream design. Kept for the day Tauri wires Linux tray events.
    action: (ev) => {
      if (ev.type === "Click" && ev.button === "Left" && ev.buttonState === "Down") showWindow();
    },
  });
  await win.onCloseRequested((e) => {
    e.preventDefault(); // intercept first, then hide
    win.hide();
  });
}

if (IS_LINUX) {
  setupTray().catch((e) => console.warn("[tray] unavailable, keeping close-quits behavior:", e));
}

const state = {
  baseUrl: "",
  me: null, // { id, username, ... }
  channels: [], // from fetch_all_channels
  activeId: null,
  // Unread conversation that was just opened: stays listed under Unread until
  // another conversation is opened, so it doesn't vanish from under the click.
  keptUnreadId: null,
  // Unread count captured when a channel is opened, BEFORE markViewed zeroes
  // the badge — anchors the "New messages" divider (#11) for as long as the
  // channel stays open (repaints re-derive the divider from it). Replaced on
  // every openChannel, so switching channels clears it.
  unreadAtOpen: null, // { channelId, count } | null
  unread: {}, // channelId -> count
  dmNames: {}, // channelId -> name learned from a live sender (fallback)
  users: {}, // user_id -> user object { id, username, first_name, last_name, nickname }
  usersByName: {}, // username -> same user object (for resolving group members)
  teams: {}, // team_id -> team display name
  activity: {}, // channelId -> last-activity ms (learned live; complements last_post_at)
  userLookupEnabled: true, // flips off if get_users_by_ids isn't in the backend yet
  canViewChannel: true, // flips off if view_channel isn't in the backend yet
  fileInfos: {}, // file_id -> { name, size, mime_type, ... }
  fileLookupEnabled: true, // flips off if the file commands aren't in the backend yet
  customEmojis: {}, // emoji name -> emoji id (server-defined custom emoji)
  emojiImages: {}, // emoji id -> data URL
  reactions: {}, // post_id -> { emoji_name -> Set(user_id) }
  // Which sidebar sections are unfolded. A section missing from here is
  // folded, so the sidebar opens closed; Unread is the exception — it is
  // pinned on top precisely so new messages are visible without a click.
  expanded: { Unread: true }, // section title -> true when open
  avatars: {}, // user_id -> data URL (in-memory; the disk cache comes later)
  avatarPending: new Set(), // user_ids currently being fetched
  avatarLookupEnabled: true, // flips off if get_avatar isn't in the backend yet
  pageOldest: null, // id of the oldest post currently shown (paging cursor)
  pageMore: false, // might there be older posts to load?
  pageLoading: false, // a page load is in flight
  editMessageEnabled: true, // flips off if edit_message isn't in the backend yet
  editing: null, // { postId, original } while a message edit is in progress
};

const PAGE_SIZE = 30; // matches the backend's per_page

// Issue #16: consecutive messages from the same author collapse into a group
// — follow-up bubbles hide the repeated avatar (the gutter stays, so the text
// keeps its alignment) and sender name, and pack tighter (see .grouped in
// styles.css). There is deliberately NO time window (#16 follow-up: "mai
// ripetere nome e icona se la persona parla due volte di fila") — same author
// + consecutive is all it takes, however long the gap. A group still breaks
// on a different author, the unread divider or an ephemeral row (see
// shouldGroupWith).

// ---------- element refs ----------
const $ = (id) => document.getElementById(id);
// Own-property lookup that ignores Object.prototype — for tables indexed by
// server- or user-supplied names (":constructor:" must not match anything).
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const loginView = $("login-view");
const appView = $("app-view");
const urlForm = $("url-form");
const urlInput = $("url-input");
const loginStatus = $("login-status");
const meAvatar = $("me-avatar");
const meName = $("me-name");
const searchInput = $("search-input");
const searchClearBtn = $("search-clear-btn");
const channelList = $("channel-list");
const emptyState = $("empty-state");
const chatPanel = $("chat-panel");
const chatTitle = $("chat-title");
const chatSub = $("chat-sub");
const muteBtn = $("mute-btn");
const messagesEl = $("messages");
const composer = $("composer");
const composerInput = $("composer-input");

// ================= PERSISTENCE =================
// The webview persists only non-sensitive UI state in localStorage: the server
// URL (here) and the display settings (see SETTINGS below). The session token
// is persisted by the backend (session.json in the app data dir, see
// capture_session/restore_session in api.rs), never by the webview.
const URL_KEY = "rustermost.url";
function saveUrl(url) { try { localStorage.setItem(URL_KEY, url); } catch (_) {} }
function loadUrl() { try { return localStorage.getItem(URL_KEY) || ""; } catch (_) { return ""; } }

// ================= SETTINGS =================
// Display preferences (font size, theme, density). Not sensitive → localStorage,
// same as the server URL. Applied by setting a CSS variable / data-attributes on
// <html>; styles.css does the rest. The first paint is handled by the inline
// script in index.html (this module is deferred, too late to prevent a flash);
// this copy owns everything after that: live changes and OS theme tracking.
const SETTINGS_KEY = "rustermost.settings";
const SETTINGS_DEFAULTS = { fontSize: "medium", theme: "dark", density: "comfortable", giphyKey: "" };
const SETTINGS_VALUES = {
  fontSize: ["small", "medium", "large"],
  theme: ["dark", "light", "system"],
  density: ["comfortable", "compact"],
};
// Must stay in sync with the inline script in index.html; "medium" must also
// match the fallback in styles.css (html { font-size: var(--app-font-size, 14px) }).
const FONT_SIZES = { small: "13px", medium: "14px", large: "16px" };

// Saved settings merged over the defaults; unknown values fall back to default
// (protects against a hand-edited or stale localStorage entry).
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (_) {}
  const s = { ...SETTINGS_DEFAULTS };
  for (const key of Object.keys(SETTINGS_VALUES)) {
    if (SETTINGS_VALUES[key].includes(saved[key])) s[key] = saved[key];
  }
  // Free text, so it gets no enum check — just a type check and a trim.
  if (typeof saved.giphyKey === "string") s.giphyKey = saved.giphyKey.trim();
  return s;
}

const settings = loadSettings();

// ---------- silenced conversations ----------
// Silencing is local to this client for now: no desktop notification, no
// unread badge, dimmed row. Reads and writes go through these four helpers on
// purpose — swapping localStorage for Mattermost's own mute (a channel
// member's notify_props.mark_unread = "mention", which would sync to the
// phone and the official app) then touches nothing else in the file.
const MUTED_KEY = "rustermost.muted";
function loadMuted() {
  try {
    const ids = JSON.parse(localStorage.getItem(MUTED_KEY));
    return new Set(Array.isArray(ids) ? ids : []);
  } catch (_) {
    return new Set();
  }
}
// A Set (not an object) so a channel id can never collide with Object.prototype.
const mutedIds = loadMuted();
function isMuted(channelId) {
  return mutedIds.has(channelId);
}
function setMuted(channelId, muted) {
  if (muted) mutedIds.add(channelId);
  else mutedIds.delete(channelId);
  try { localStorage.setItem(MUTED_KEY, JSON.stringify([...mutedIds])); } catch (_) {}
}

// ================= SPACES =================
// Sidebar "spaces": user-named custom sections that conversations can be
// parked into (Firefox tab-group style). A spaced conversation LEAVES its
// default section (Direct messages / Groups / Community) and renders under
// the space instead — the pinned Unread section is unaffected, so an unread
// spaced conversation shows in both places (by design). Persisted as an
// ordered array: array order == sidebar order (no manual reordering yet).
// Local to this client, like the muted list — reads/writes all funnel through
// these helpers so a future server-side sync touches nothing else in the file.
const SPACES_KEY = "rustermost.spaces";
function loadSpaces() {
  try {
    const list = JSON.parse(localStorage.getItem(SPACES_KEY));
    if (!Array.isArray(list)) return [];
    // Defensive validation: a hand-edited or stale entry degrades to [].
    const clean = [];
    for (const s of list) {
      if (!s || typeof s !== "object") continue;
      if (typeof s.id !== "string" || !s.id) continue;
      if (typeof s.name !== "string" || !s.name.trim()) continue;
      if (!Array.isArray(s.channelIds) || !s.channelIds.every((id) => typeof id === "string")) continue;
      clean.push({ id: s.id, name: s.name, channelIds: s.channelIds });
    }
    return clean;
  } catch (_) {
    return [];
  }
}
const spaces = loadSpaces();
function saveSpaces() {
  try { localStorage.setItem(SPACES_KEY, JSON.stringify(spaces)); } catch (_) {}
}
// The space a conversation currently lives in, or null.
function spaceOf(channelId) {
  return spaces.find((s) => s.channelIds.includes(channelId)) || null;
}
function createSpace(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return null;
  const space = {
    id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: trimmed,
    channelIds: [],
  };
  spaces.push(space);
  saveSpaces();
  return space;
}
// Move a conversation into a space (or back out, with null). A conversation
// lives in at most one space, and an emptied space stays until it's deleted.
function assignToSpace(channelId, spaceIdOrNull) {
  for (const s of spaces) s.channelIds = s.channelIds.filter((id) => id !== channelId);
  if (spaceIdOrNull) {
    const target = spaces.find((s) => s.id === spaceIdOrNull);
    if (target) target.channelIds.push(channelId);
  }
  saveSpaces();
  renderSidebar();
}
function renameSpace(id, name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return false;
  const space = spaces.find((s) => s.id === id);
  if (!space) return false;
  space.name = trimmed;
  saveSpaces();
  renderSidebar();
  return true;
}
// Chats of a deleted space fall back to their default sections automatically:
// membership just stops matching in renderSidebar.
function deleteSpace(id) {
  const i = spaces.findIndex((s) => s.id === id);
  if (i < 0) return;
  spaces.splice(i, 1);
  saveSpaces();
  renderSidebar();
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}

// "system" resolves against the OS preference; the app's own default is dark,
// so no preference (or no matchMedia) means dark.
const lightQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

function applySettings() {
  const root = document.documentElement;
  root.style.setProperty("--app-font-size", FONT_SIZES[settings.fontSize]);
  const theme = settings.theme === "system" ? (lightQuery && lightQuery.matches ? "light" : "dark") : settings.theme;
  root.dataset.theme = theme;
  root.dataset.density = settings.density;
}

// Follow live OS theme changes while set to "system". Older WebKit only has
// the legacy addListener; and some engines (WebKitGTK) don't reliably deliver
// the change event at all, so window-focus also re-applies as a catch-up.
const onSchemeChange = () => { if (settings.theme === "system") applySettings(); };
if (lightQuery && lightQuery.addEventListener) lightQuery.addEventListener("change", onSchemeChange);
else if (lightQuery && lightQuery.addListener) lightQuery.addListener(onSchemeChange);

applySettings();

// ================= PANE RESIZING =================
// The sidebar's right edge and the composer's top edge carry drag handles.
// The sidebar width is a CSS variable on <html> (the inline script in
// index.html re-applies it before the first paint — SIDEBAR_MIN/MAX must stay
// in sync with that copy). The composer size is a FLOOR the textarea's content
// auto-grow sits on (see autoResize); dragging below COMPOSER_SNAP snaps back
// to pure auto-grow, which is also what a double-click restores on either
// handle. Both persist in localStorage under one JSON key.
const PANES_KEY = "rustermost.panes";
const SIDEBAR_MIN = 200, SIDEBAR_MAX = 560, SIDEBAR_DEFAULT = 320;
const COMPOSER_SNAP = 44;        // px; dragging smaller than this = back to auto
const COMPOSER_MAX_FRAC = 0.6;   // of the window height
const COMPOSER_AUTO_CAP = 140;   // content-growth cap while no floor is set

function clampNum(n, lo, hi) { return Math.min(Math.max(n, lo), hi); }

function loadPanes() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PANES_KEY)) || {}; } catch (_) {}
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  return {
    sidebar: clampNum(num(saved.sidebar) ?? SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX),
    composer: Math.max(0, num(saved.composer) ?? 0),
  };
}
const panes = loadPanes();
function savePanes() {
  try { localStorage.setItem(PANES_KEY, JSON.stringify(panes)); } catch (_) {}
}
// How far content may still grow the box: the classic cap, or the user's
// floor when that is taller (autoResize needs it for the inline max-height).
function composerCap() { return Math.max(COMPOSER_AUTO_CAP, panes.composer); }

function applyPanes() {
  document.documentElement.style.setProperty("--sidebar-width", panes.sidebar + "px");
  autoResize(); // folds the composer floor in (declared later — hoisted)
}
applyPanes();

const sidebarResizer = $("sidebar-resizer");
const composerResizer = $("composer-resizer");

// Shared mouse-drag plumbing: move events until mouseup, plus a locked cursor
// and no text selection while the drag lasts. Listeners live on `document` so
// they survive the pointer leaving the 7px sash.
function dragTrack(cursor, move, done) {
  document.body.style.cursor = cursor;
  document.body.style.userSelect = "none";
  const onMove = (e) => move(e);
  const onUp = (e) => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (done) done(e);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

sidebarResizer.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const startX = e.clientX, startW = panes.sidebar;
  dragTrack("col-resize", (ev) => {
    const maxW = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, window.innerWidth * 0.6));
    panes.sidebar = Math.round(clampNum(startW + ev.clientX - startX, SIDEBAR_MIN, maxW));
    document.documentElement.style.setProperty("--sidebar-width", panes.sidebar + "px");
  }, savePanes);
});
sidebarResizer.addEventListener("dblclick", () => {
  panes.sidebar = SIDEBAR_DEFAULT;
  applyPanes();
  savePanes();
});

composerResizer.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const startY = e.clientY;
  // Rendered height when measurable (zero-size layout engines fall back to the
  // current floor, or one line so an untouched composer drags up from ~its size).
  const startH = composerInput.getBoundingClientRect().height || Math.max(panes.composer, COMPOSER_SNAP);
  dragTrack("row-resize", (ev) => {
    const target = clampNum(startH + (startY - ev.clientY), 0, window.innerHeight * COMPOSER_MAX_FRAC);
    panes.composer = target < COMPOSER_SNAP ? 0 : Math.round(target);
    applyPanes();
  }, savePanes);
});
composerResizer.addEventListener("dblclick", () => {
  panes.composer = 0;
  applyPanes();
  savePanes();
});

// ================= LOGIN =================
urlForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim().replace(/\/+$/, "");
  if (!url) return;
  state.baseUrl = url;
  saveUrl(url);
  setLoginStatus("Opening SSO login window…");
  try {
    await invoke("open_sso_window", { url });
  } catch (err) {
    setLoginStatus("Error: " + err, true);
    return;
  }
  setLoginStatus("Waiting for you to finish the SSO login…");

  const timer = setInterval(async () => {
    try {
      await invoke("capture_session", { baseUrl: url });
      clearInterval(timer);
      setLoginStatus("Connected. Loading…");
      await init();
    } catch (_) {
      /* token not present yet — keep polling */
    }
  }, 2000);
});

// On startup, try to resume the saved session (backend reads session.json and
// rebuilds its client). fetch_me is the liveness probe: if the token went
// stale the whole attempt fails and we fall back to the login screen — the
// next SSO login overwrites session.json, so a dead file heals itself.
async function tryRestore() {
  const url = loadUrl();
  if (url) urlInput.value = url;
  try {
    const baseUrl = await invoke("restore_session");
    await invoke("fetch_me");
    state.baseUrl = baseUrl;
    setLoginStatus("Session restored. Loading…");
    await init();
  } catch (_) {
    // no saved session, or a stale one — stay on the login screen
  }
}

tryRestore();

function setLoginStatus(text, isError = false) {
  loginStatus.textContent = text;
  loginStatus.classList.toggle("error", isError);
}

// ================= INIT (after login) =================
async function init() {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");

  // who am I
  try {
    state.me = await invoke("fetch_me");
    if (state.me && state.me.id) rememberUser(state.me); // fetch_me already has the name fields
    renderMe();
  } catch (e) {
    console.error("fetch_me failed", e);
  }

  // start listening BEFORE connecting so we don't miss events
  await listen("mm-post", onIncoming);
  await listen("mm-post-edited", onPostEdited);
  await listen("mm-viewed", onViewedElsewhere);
  // Dormant until the WS loop forwards emoji_added: new custom emoji register live.
  await listen("mm-emoji-added", (ev) => {
    const e = ev.payload;
    if (e && e.name && e.id) state.customEmojis[e.name] = e.id;
  });
  // Dormant until the WS loop forwards reaction_added / reaction_removed.
  await listen("mm-reaction-added", (ev) => {
    const r = ev.payload || {};
    if (r.post_id && r.emoji_name && r.user_id) applyReaction(r.post_id, r.emoji_name, r.user_id, true);
  });
  await listen("mm-reaction-removed", (ev) => {
    const r = ev.payload || {};
    if (r.post_id && r.emoji_name && r.user_id) applyReaction(r.post_id, r.emoji_name, r.user_id, false);
  });
  try {
    await invoke("connect_websocket");
  } catch (e) {
    console.error("connect_websocket failed", e);
  }

  // team names (so we can label which team a channel belongs to)
  try {
    const teams = await invoke("fetch_teams");
    for (const t of teams || []) state.teams[t.id] = t.display_name || t.name;
  } catch (e) {
    console.error("fetch_teams failed", e);
  }

  loadCustomEmojis(); // in parallel with channels; probes and degrades

  // channels + read-state (slow: hits every team twice)
  try {
    state.channels = await loadChannels();
    seedUnread();
    renderSidebar();
    // Try to name the 1:1 DM partners (no-op until get_users_by_ids exists).
    resolveUsers(collectDmPartnerIds()).then(() => renderSidebar());
    // Fire-and-forget: warm the DM disk snapshots in the background (#9).
    prefetchDmCaches();
  } catch (e) {
    console.error("fetch_all_channels failed", e);
    channelList.innerHTML = '<div class="list-empty">Failed to load channels.</div>';
  }
}

// Channels enriched with my read-state, in one call. Falls back to the plain
// channel list if fetch_all_channels_with_members isn't in the backend yet —
// same objects, just without the `member` field.
async function loadChannels() {
  try {
    return await invoke("fetch_all_channels_with_members");
  } catch (e) {
    console.warn("fetch_all_channels_with_members unavailable (badges will be session-only). Is it in generate_handler!?", e);
    return await invoke("fetch_all_channels");
  }
}

// Initial badges: how many of the channel's messages my member record says I
// haven't seen yet. No member data (fallback path, brand-new channel) → no badge.
function seedUnread() {
  for (const ch of state.channels) {
    if (!ch.member) continue;
    const n = ch.total_msg_count - ch.member.msg_count;
    if (n > 0) state.unread[ch.id] = n;
  }
}

// Mark a conversation read: clear the badge immediately (optimistic), then tell
// the server so my other devices clear too and the next launch seeds correctly.
// Throttled per channel; degrades to local-only if view_channel is missing.
const viewedAt = {}; // channelId -> when we last told the server
async function markViewed(channelId) {
  if (!channelId) return;
  state.unread[channelId] = 0;
  if (!state.canViewChannel) return;
  const now = Date.now();
  if (viewedAt[channelId] && now - viewedAt[channelId] < 1500) return;
  viewedAt[channelId] = now;
  try {
    await invoke("view_channel", { channelId });
  } catch (e) {
    state.canViewChannel = false; // command not registered yet
    console.warn("view_channel unavailable (reads won't sync to other devices). Is it in generate_handler!?", e);
  }
}

// One of my other devices read a channel. Dormant until the backend's WS loop
// forwards channel_viewed as "mm-viewed"; payload may be the channel id itself
// or an object carrying channel_id.
function onViewedElsewhere(event) {
  const p = event.payload;
  const id = typeof p === "string" ? p : p && p.channel_id;
  if (!id || !state.unread[id]) return;
  state.unread[id] = 0;
  renderSidebar();
}

function renderMe() {
  const name = state.me?.username || "me";
  meName.textContent = "@" + name;
  decorateAvatar(meAvatar, state.me?.id, name);
}

// ================= DM POST-CACHE PREFETCH =================
// Issue #9: openChannel paints instantly from the on-disk snapshot, but that
// snapshot only exists for channels whose posts were fetched once before (the
// Rust side rewrites it as a side effect of get_posts) — first-time-opened
// DMs still showed "Loading messages…". So once the channel list is in, warm
// the snapshot for the most relevant conversations in the background: a
// fire-and-forget get_posts here is all it takes — no backend change, and no
// repaint, sidebar re-render or notification either (the result is discarded,
// the disk write happens server-side in the backend session).
//
// Gentle by design:
//  - isDM covers 1:1 (D) and group (G) chats alike — both are the person
//    conversations a user clicks expecting them to be instant, and the cap
//    below keeps "G too" cheap. Named channels stay discoverable-on-demand.
//  - PREFETCH_LIMIT is a hard cap on requests per launch: an account with
//    hundreds of DMs warms only the 10 most-recently-active (activityOf, the
//    sidebar's own ordering) — the ones actually likely to be clicked.
//  - PREFETCH_CONCURRENCY workers at a time — a slow drip, never a burst.
//  - Errors are swallowed: offline at boot must stay invisible.
//
// Re-run safe: an id is queued at most once per session (prefetchEnqueued),
// and anything already opened/warmed is skipped at pop time — so a future
// channel-list refresh can re-call prefetchDmCaches to warm brand-new
// conversations without duplicating work for the rest.
const PREFETCH_LIMIT = 10;
const PREFETCH_CONCURRENCY = 2;
const prefetchEnqueued = new Set(); // ids queued for warming this session
const postFetches = new Map(); // channelId -> in-flight plain get_posts promise
const postsWarmed = new Set(); // ids with a successful fetch this session (snapshot exists)

// One in-flight plain get_posts per channel, shared between openChannel and
// the background prefetch: whoever asks second joins the same promise instead
// of duplicating the request. Success marks the channel warmed (the snapshot
// write has happened on the Rust side), so the prefetch can skip it later;
// failures leave postsWarmed untouched, so a later attempt retries normally.
function fetchPostsOnce(channelId) {
  let p = postFetches.get(channelId);
  if (!p) {
    p = invoke("get_posts", { channelId })
      .then((posts) => { postsWarmed.add(channelId); return posts; })
      .finally(() => postFetches.delete(channelId));
    postFetches.set(channelId, p);
  }
  return p;
}

async function prefetchDmCaches() {
  const pool = state.channels
    .filter((ch) => isDM(ch) && !prefetchEnqueued.has(ch.id))
    .sort((a, b) => activityOf(b) - activityOf(a))
    .slice(0, PREFETCH_LIMIT)
    .map((ch) => ch.id);
  for (const id of pool) prefetchEnqueued.add(id);

  // Shared cursor; each worker takes the next id until the pool is drained.
  let next = 0;
  const worker = async () => {
    while (next < pool.length) {
      const id = pool[next++];
      // The user got here first: opening this channel already fetched (or is
      // fetching) it, which wrote the same snapshot — never duplicate that.
      if (postsWarmed.has(id) || postFetches.has(id)) continue;
      try {
        await fetchPostsOnce(id);
      } catch (_) {
        /* warming is invisible: offline or a server hiccup stays silent */
      }
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(PREFETCH_CONCURRENCY, pool.length); i++) workers.push(worker());
  await Promise.all(workers);
}

// ================= USER RESOLUTION =================
// For a 1:1 DM, Mattermost sets channel.name = "<userIdA>__<userIdB>".
// The partner is the id that isn't mine.
function partnerId(ch) {
  if (ch.type !== "D" || !ch.name || !ch.name.includes("__")) return null;
  const [a, b] = ch.name.split("__");
  const mine = state.me?.id;
  if (a === mine) return b;
  if (b === mine) return a;
  return a; // couldn't tell (e.g. me unknown) — pick one deterministically
}

function collectDmPartnerIds() {
  const ids = [];
  for (const ch of state.channels) {
    const pid = partnerId(ch);
    if (pid) ids.push(pid);
  }
  return ids;
}

function rememberUser(u) {
  if (!u || !u.id) return;
  state.users[u.id] = u;
  if (u.username) state.usersByName[u.username] = u;
}

// A user's human-facing name: "First Last", else nickname, else username.
function realName(u) {
  if (!u) return null;
  const fn = (u.first_name || "").trim();
  const ln = (u.last_name || "").trim();
  if (fn || ln) return (fn + " " + ln).trim();
  if ((u.nickname || "").trim()) return u.nickname.trim();
  return u.username || null;
}

// Batch-resolve user_id -> user object. Silently disables itself if the backend
// command isn't there yet, so it never spams the console.
async function resolveUsers(ids) {
  if (!state.userLookupEnabled) return;
  const missing = [...new Set(ids)].filter((id) => id && !state.users[id]);
  if (!missing.length) return;
  try {
    const users = await invoke("get_users_by_ids", { ids: missing });
    for (const u of users || []) rememberUser(u);
  } catch (_) {
    // Command not registered yet → stop trying. Add it in Rust to light this up.
    state.userLookupEnabled = false;
  }
}

// ================= SIDEBAR =================
searchInput.addEventListener("input", renderSidebar);

// Round ✕ overlaid on the field's right edge: clears the text, re-runs the
// exact same filter path as typing, and hands focus back to the input.
searchClearBtn.addEventListener("click", () => {
  searchInput.value = "";
  renderSidebar();
  searchInput.focus();
});

function displayName(ch) {
  if (ch.display_name && ch.display_name.trim()) return ch.display_name;
  if (ch.type === "D") {
    const pid = partnerId(ch);
    if (pid && state.users[pid]) return realName(state.users[pid]);
    if (state.dmNames[ch.id]) return state.dmNames[ch.id];
    return "Direct message";
  }
  return ch.name;
}

// Everything a conversation can be matched against: its shown name, its raw
// server name, and — crucially — the real names of the people in it.
function searchText(ch) {
  const parts = [ch.display_name || "", ch.name || ""];
  if (ch.type === "D") {
    const u = state.users[partnerId(ch)];
    if (u) parts.push(u.username, u.first_name, u.last_name, u.nickname);
    if (state.dmNames[ch.id]) parts.push(state.dmNames[ch.id]);
  } else if (ch.type === "G") {
    // Group display_name is a comma-separated list of usernames.
    for (const un of (ch.display_name || "").split(",").map((s) => s.trim())) {
      const u = state.usersByName[un];
      if (u) parts.push(u.first_name, u.last_name, u.nickname);
    }
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

// A person-to-person conversation (1:1 or group), as opposed to a named channel.
function isDM(ch) {
  return ch.type === "D" || ch.type === "G";
}

function typeLabel(ch) {
  return { D: "Direct message", G: "Group", O: "Public channel", P: "Private channel" }[ch.type] || "Channel";
}

// The team a channel belongs to (only public/private channels have one).
function teamName(ch) {
  return ch.team_id ? state.teams[ch.team_id] || null : null;
}

// Sub-line under a channel: "Team · Public channel", or just the type.
function subLabel(ch) {
  const t = teamName(ch);
  return t ? `${t} · ${typeLabel(ch)}` : typeLabel(ch);
}

// last_post_at (backend, once you add it) OR live-learned activity OR 0.
function activityOf(ch) {
  const server = typeof ch.last_post_at === "number" ? ch.last_post_at : 0;
  const live = state.activity[ch.id] || 0;
  return Math.max(server, live);
}

// Most-recent conversation first (stable when timestamps are equal). Shared
// by renderSidebar and the space sections.
function byRecency(a, b) { return activityOf(b) - activityOf(a); }

// ================= SIDEBAR DRAG & DROP =================
// A conversation can be dragged onto a sidebar section to move it in or out
// of a space: a space section (header included) accepts any conversation —
// the drop assigns it — while a default section's header accepts only
// conversations of its own type, and the drop takes it back OUT of its space.
// The dragged id lives in a module-level variable set at dragstart: browsers
// only expose dataTransfer.getData during the drop itself, but the default
// headers need the dragged conversation's TYPE already during dragover to
// decide whether a drop is even allowed. The dataTransfer write still happens
// for real-world interop, but the module value is the source of truth.
let draggingChannelId = null;

function draggingChannel() {
  if (!draggingChannelId) return null;
  return state.channels.find((c) => c.id === draggingChannelId) || null;
}

// Default-section type gates (Community covers public + private, incl. its
// per-team sub-headers). The pinned Unread section wires nothing at all.
const dropAcceptsDM = (type) => type === "D";
const dropAcceptsGroup = (type) => type === "G";
const dropAcceptsCommunity = (type) => type === "O" || type === "P";

// Wires one element as a drop target for conversation drags. `accepts`
// (null for space sections) gates eligibility by channel type — a refused
// dragover simply isn't preventDefaulted, so the native "no drop" cursor
// shows. stopPropagation everywhere: a space header sits INSIDE its section
// wrapper and both are targets, so the event must not be handled twice.
function makeDropTarget(el, accepts, targetSpaceId) {
  const allowed = () => {
    const ch = draggingChannel(); // unknown/none dragged → refuse everything
    return !!ch && (!accepts || accepts(ch.type));
  };
  el.addEventListener("dragover", (e) => {
    e.stopPropagation();
    if (!allowed()) return;
    e.preventDefault(); // allows the drop
    try { if (e.dataTransfer) e.dataTransfer.dropEffect = "move"; } catch (_) {}
    el.classList.add("drop-target");
  });
  el.addEventListener("dragleave", (e) => {
    e.stopPropagation();
    el.classList.remove("drop-target");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove("drop-target");
    if (!allowed()) return; // id empty/unknown, or the type gate refuses it
    assignToSpace(draggingChannelId, targetSpaceId); // same-space → no-op
  });
}

function renderSidebar() {
  const q = (searchInput.value || "").toLowerCase();
  // The ✕ is shown exactly when there is text to clear. Syncing here —
  // instead of only in the input/click listeners — means every render path
  // (typing, the button itself, live-event refreshes, any future code that
  // sets searchInput.value) keeps the icon in agreement with the field.
  searchClearBtn.classList.toggle("hidden", !q);
  const match = (ch) => searchText(ch).includes(q);

  // Conversations parked in a space leave their default section; the pinned
  // Unread section is NOT affected by this (the duplicate is by design).
  const assigned = new Set(spaces.flatMap((s) => s.channelIds));

  // Silenced conversations never reach the pinned Unread section — that is
  // the whole point of silencing them. They still show in their own section.
  const unread = state.channels.filter(
    (c) => ((state.unread[c.id] || 0) > 0 || c.id === state.keptUnreadId) && !isMuted(c.id) && match(c)
  );
  const direct = state.channels.filter((c) => c.type === "D" && !assigned.has(c.id) && match(c));
  const groups = state.channels.filter((c) => c.type === "G" && !assigned.has(c.id) && match(c));
  const community = state.channels.filter((c) => (c.type === "O" || c.type === "P") && !assigned.has(c.id) && match(c));

  unread.sort(byRecency);
  direct.sort(byRecency);
  groups.sort(byRecency);
  community.sort(byRecency);

  const searching = q.length > 0;
  // One id→channel lookup table per render: the space sections map their
  // stored channelIds through it.
  const byId = new Map(state.channels.map((c) => [c.id, c]));
  channelList.innerHTML = "";
  // Pinned on top, only while something is actually unread; conversations
  // stay in their own section below as well.
  if (unread.length) channelList.appendChild(sectionEl("Unread", "Unread", unread, searching));
  // Spaces sit between pinned Unread and the default sections, in saved order.
  for (const s of spaces) channelList.appendChild(spaceEl(s, match, searching, byId));
  channelList.appendChild(sectionEl("Direct messages", "Direct messages", direct, searching, false, dropAcceptsDM));
  channelList.appendChild(sectionEl("Groups", "Groups", groups, searching, false, dropAcceptsGroup));
  channelList.appendChild(communityEl(community, searching));
}

// Has the user unfolded this section? (hasOwn: section titles are data, so
// "constructor" & friends must not read as open.)
function isOpen(key) {
  return hasOwn(state.expanded, key) && state.expanded[key];
}

// The clickable "TITLE · N ▾" line that folds a section. `key` is where the
// fold state lives in state.expanded — for team sub-groups that is "team:<id>",
// which can never collide with a top-level section title.
function sectionHeaderEl(key, label, count, open) {
  const h = document.createElement("div");
  h.className = "section-title";
  const chev = document.createElement("span");
  chev.className = "chevron";
  chev.textContent = open ? "▾" : "▸"; // ▾ / ▸
  const text = document.createElement("span");
  text.textContent = `${label} · ${count}`;
  h.appendChild(chev);
  h.appendChild(text);
  h.addEventListener("click", () => {
    state.expanded[key] = !isOpen(key);
    renderSidebar();
  });
  return h;
}

// Folded unless the user has opened it; while searching, sections are forced
// open so matches are never hidden. `sub` renders the indented variant used
// for the per-team groups inside Community. `dropAccepts`, when given, makes
// the header a drop target that takes a dragged conversation back OUT of its
// space — gated to the section's channel type (the pinned Unread passes none).
function sectionEl(key, label, items, forceOpen, sub, dropAccepts) {
  const open = forceOpen || isOpen(key);

  const wrap = document.createElement("div");
  wrap.className = sub ? "section sub" : "section";
  const header = sectionHeaderEl(key, label, items.length, open);
  if (dropAccepts) makeDropTarget(header, dropAccepts, null);
  wrap.appendChild(header);

  if (!open) return wrap;

  if (items.length === 0) {
    const e = document.createElement("div");
    e.className = "list-empty";
    e.textContent = "Nothing here.";
    wrap.appendChild(e);
  }
  for (const ch of items) wrap.appendChild(channelItemEl(ch));
  return wrap;
}

// A user-named space section. Visually it's a plain .section with the shared
// header (fold state lives in state.expanded under "space:<id>", which can
// never collide with a section title or a "team:<id>" key), plus a
// right-click manage menu. Unlike the default sections a space NEVER
// disappears for being empty — only deletion removes it — so it always shows
// the standard "Nothing here." row. Membership comes from the space's stored
// channelIds mapped through this render's id→channel table (stale ids, e.g.
// for channels the server no longer lists, drop out silently).
function spaceEl(space, match, forceOpen, byId) {
  const key = "space:" + space.id;
  const open = forceOpen || isOpen(key);
  const items = space.channelIds
    .map((id) => byId.get(id))
    .filter((ch) => ch && match(ch))
    .sort(byRecency);

  const wrap = document.createElement("div");
  wrap.className = "section";
  const header = sectionHeaderEl(key, space.name, items.length, open);
  // The space-title marker: the background right-click menu steps aside for
  // it, and the drop-styling CSS keys off section-title regardless.
  header.classList.add("space-title");
  header.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openSpaceMenu(space, e.clientX, e.clientY);
  });
  // Drop target: the header (all a folded space shows) AND the whole section
  // body (a drop anywhere in it counts); makeDropTarget stops propagation.
  makeDropTarget(header, null, space.id);
  makeDropTarget(wrap, null, space.id);
  wrap.appendChild(header);

  if (!open) return wrap;

  if (items.length === 0) {
    const e = document.createElement("div");
    e.className = "list-empty";
    e.textContent = "Nothing here.";
    wrap.appendChild(e);
  }
  for (const ch of items) wrap.appendChild(channelItemEl(ch));
  return wrap;
}

// Community, split into one sub-group per originating team so channels from
// unrelated teams no longer interleave. The header counts channels (not
// teams); each team folds on its own.
function communityEl(items, forceOpen) {
  const open = forceOpen || isOpen("Community");

  const wrap = document.createElement("div");
  wrap.className = "section";
  const header = sectionHeaderEl("Community", "Community", items.length, open);
  makeDropTarget(header, dropAcceptsCommunity, null);
  wrap.appendChild(header);

  if (!open) return wrap;

  const teams = groupByTeam(items);
  if (teams.length === 0) {
    const e = document.createElement("div");
    e.className = "list-empty";
    e.textContent = "Nothing here.";
    wrap.appendChild(e);
  }
  for (const t of teams) {
    wrap.appendChild(sectionEl(`team:${t.id}`, t.name, t.items, forceOpen, true, dropAcceptsCommunity));
  }
  return wrap;
}

// Channels bucketed by their team, teams A→Z. A channel whose team name never
// arrived (fetch_teams degrades silently) lands in "Other", kept last, so it
// is still reachable.
const OTHER_TEAM = "Other";
function groupByTeam(items) {
  const groups = new Map(); // team_id ("" when unknown) -> { id, name, items }
  for (const ch of items) {
    const name = teamName(ch);
    const id = name ? ch.team_id : "";
    if (!groups.has(id)) groups.set(id, { id, name: name || OTHER_TEAM, items: [] });
    groups.get(id).items.push(ch); // input order (by recency) is preserved
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.id !== !b.id) return a.id ? -1 : 1; // "Other" last
    return a.name.localeCompare(b.name);
  });
}

function channelItemEl(ch) {
  const name = displayName(ch);
  const dm = isDM(ch);
  const muted = isMuted(ch.id);
  const row = document.createElement("div");
  row.className = "channel-item" + (ch.id === state.activeId ? " active" : "") + (muted ? " muted" : "");
  row.addEventListener("click", () => openChannel(ch.id));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openChannelMenu(ch, e.clientX, e.clientY);
  });
  // Draggable into/out of space sections (see makeDropTarget above).
  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    draggingChannelId = ch.id; // source of truth — see makeDropTarget
    const dt = e.dataTransfer; // may be missing in degenerate environments
    if (dt) {
      dt.setData("text/plain", ch.id);
      try { dt.effectAllowed = "move"; } catch (_) {}
    }
    row.classList.add("drag-source");
  });
  row.addEventListener("dragend", () => {
    // dragend fires even when the drop was cancelled.
    draggingChannelId = null;
    row.classList.remove("drag-source");
    // … and a cancel can strand a highlight when no dragleave arrived first.
    for (const t of channelList.querySelectorAll(".drop-target")) t.classList.remove("drop-target");
  });

  const av = document.createElement("div");
  av.className = "item-avatar" + (dm ? " dm" : "");
  if (ch.type === "D") {
    decorateAvatar(av, partnerId(ch), name); // 1:1 → the other person's photo
  } else {
    av.textContent = name.replace(/^@/, "").charAt(0) || "#"; // group/channel → initial
  }
  row.appendChild(av);

  const main = document.createElement("div");
  main.className = "item-main";
  const nm = document.createElement("div");
  nm.className = "item-name";
  nm.textContent = name;
  const sub = document.createElement("div");
  sub.className = "item-sub";
  sub.textContent = subLabel(ch);
  main.appendChild(nm);
  main.appendChild(sub);
  row.appendChild(main);

  const unread = state.unread[ch.id] || 0;
  if (muted) {
    // Silenced: no count, just a marker — the badge would be shouting.
    const bell = document.createElement("div");
    bell.className = "item-muted";
    bell.textContent = "🔕";
    bell.title = "Silenced";
    row.appendChild(bell);
  } else if (unread > 0) {
    const b = document.createElement("div");
    b.className = "badge";
    b.textContent = unread > 99 ? "99+" : String(unread);
    row.appendChild(b);
  }
  return row;
}

// Right-click menu on a sidebar row (silence/unsilence, move-to-space),
// positioned at the cursor and clamped to the window.
const channelMenu = document.createElement("div");
channelMenu.className = "context-menu hidden";
document.body.appendChild(channelMenu);

function openChannelMenu(ch, x, y) {
  const muted = isMuted(ch.id);
  channelMenu.innerHTML = "";
  const row = document.createElement("div");
  row.className = "context-menu-row";
  row.textContent = muted ? "🔔  Unsilence conversation" : "🔕  Silence conversation";
  row.addEventListener("mousedown", (e) => {
    e.preventDefault();
    toggleMuted(ch.id);
    closeChannelMenu();
  });
  channelMenu.appendChild(row);

  const spaceRow = document.createElement("div");
  spaceRow.className = "context-menu-row";
  spaceRow.textContent = "🗂  Move to space…";
  spaceRow.addEventListener("mousedown", (e) => {
    e.preventDefault();
    openSpacePicker(ch);
    closeChannelMenu();
  });
  channelMenu.appendChild(spaceRow);

  showChannelMenu(x, y);
}

// Right-click on the sidebar background: the same shell holds just one row.
function openNewSpaceMenu(x, y) {
  channelMenu.innerHTML = "";
  const row = document.createElement("div");
  row.className = "context-menu-row";
  row.textContent = "🗂  New space…";
  row.addEventListener("mousedown", (e) => {
    e.preventDefault();
    closeChannelMenu();
    openSpaceCreate();
  });
  channelMenu.appendChild(row);
  showChannelMenu(x, y);
}

function showChannelMenu(x, y) {
  channelMenu.classList.remove("hidden");
  const r = channelMenu.getBoundingClientRect(); // measurable now that it is shown
  channelMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
  channelMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
}

function closeChannelMenu() {
  channelMenu.classList.add("hidden");
}

// Background right-click anywhere in the list that isn't a conversation row
// (keeps its own menu) or a space header (keeps its MANAGE modal): empty area
// below the sections, default section headers, "Nothing here." rows.
channelList.addEventListener("contextmenu", (e) => {
  if (e.target.closest(".channel-item")) return;
  if (e.target.closest(".space-title")) return;
  e.preventDefault();
  openNewSpaceMenu(e.clientX, e.clientY);
});

// ---- the space modal ----
// One shell, three modes, built once like channelMenu above. PICK (from a
// conversation's right-click menu) lists the spaces it can move into — with a
// ✓ on its current one — plus the "No space" way out, and can create a space
// on the spot; MANAGE (right-click on a space header) renames or deletes that
// space; CREATE (right-click on the sidebar background) is just the name
// field, with no assignment target. Each mode is its own .modal-body block
// inside the one shared .modal chrome; the hidden class swaps them. DOM nodes
// only — never innerHTML.
const spaceOverlay = document.createElement("div");
spaceOverlay.className = "modal-overlay hidden";
let spaceModalTarget = null; // { ch } in PICK, { space } in MANAGE, { create: true } in CREATE

const spaceModal = document.createElement("div");
spaceModal.className = "modal";
const spaceHeader = document.createElement("div");
spaceHeader.className = "modal-header";
const spaceTitle = document.createElement("div");
spaceTitle.className = "modal-title";
const spaceCloseBtn = document.createElement("button");
spaceCloseBtn.className = "modal-close";
spaceCloseBtn.type = "button";
spaceCloseBtn.title = "Close";
spaceCloseBtn.textContent = "✕";
spaceHeader.appendChild(spaceTitle);
spaceHeader.appendChild(spaceCloseBtn);

// PICK mode block.
const spacePickWrap = document.createElement("div");
spacePickWrap.className = "modal-body";
const spacePickList = document.createElement("div");
spacePickList.className = "space-list";
const spaceNameInput = document.createElement("input");
spaceNameInput.className = "modal-input";
spaceNameInput.placeholder = "New space name…";
const spaceCreateBtn = document.createElement("button");
spaceCreateBtn.className = "modal-primary";
spaceCreateBtn.type = "button";
spaceCreateBtn.textContent = "Create and move here";
spacePickWrap.appendChild(spacePickList);
spacePickWrap.appendChild(spaceNameInput);
spacePickWrap.appendChild(spaceCreateBtn);

// MANAGE mode block.
const spaceManageWrap = document.createElement("div");
spaceManageWrap.className = "modal-body hidden";
const spaceRenameInput = document.createElement("input");
spaceRenameInput.className = "modal-input";
const spaceRenameBtn = document.createElement("button");
spaceRenameBtn.className = "modal-primary";
spaceRenameBtn.type = "button";
spaceRenameBtn.textContent = "Rename";
const spaceDeleteBtn = document.createElement("button");
spaceDeleteBtn.className = "modal-danger";
spaceDeleteBtn.type = "button";
spaceDeleteBtn.textContent = "Delete space";
spaceManageWrap.appendChild(spaceRenameInput);
spaceManageWrap.appendChild(spaceRenameBtn);
spaceManageWrap.appendChild(spaceDeleteBtn);

// CREATE mode block (sidebar background right-click): just the name field.
const spaceCreateWrap = document.createElement("div");
spaceCreateWrap.className = "modal-body hidden";
const spaceNewInput = document.createElement("input");
spaceNewInput.className = "modal-input";
spaceNewInput.placeholder = "New space name…";
const spaceNewBtn = document.createElement("button");
spaceNewBtn.className = "modal-primary";
spaceNewBtn.type = "button";
spaceNewBtn.textContent = "Create space";
spaceCreateWrap.appendChild(spaceNewInput);
spaceCreateWrap.appendChild(spaceNewBtn);

spaceModal.appendChild(spaceHeader);
spaceModal.appendChild(spacePickWrap);
spaceModal.appendChild(spaceManageWrap);
spaceModal.appendChild(spaceCreateWrap);
spaceOverlay.appendChild(spaceModal);
document.body.appendChild(spaceOverlay);

function openSpacePicker(ch) {
  spaceModalTarget = { ch };
  spaceTitle.textContent = `Move “${displayName(ch)}”`;
  spacePickWrap.classList.remove("hidden");
  spaceManageWrap.classList.add("hidden");
  spaceCreateWrap.classList.add("hidden");

  // One row per existing space — ✓ marks the one the conversation is in —
  // then the permanent way back to the default section.
  spacePickList.innerHTML = "";
  for (const s of spaces) {
    const row = document.createElement("div");
    row.className = "person-row"; // reuse the people-picker row for hover
    const nm = document.createElement("div");
    nm.className = "person-name";
    nm.textContent = s.name;
    row.appendChild(nm);
    if (spaceOf(ch.id) === s) {
      const check = document.createElement("span");
      check.className = "space-row-check";
      check.textContent = "✓";
      row.appendChild(check);
    }
    row.addEventListener("click", () => {
      assignToSpace(ch.id, s.id);
      closeSpaceModal();
    });
    spacePickList.appendChild(row);
  }
  const noneRow = document.createElement("div");
  noneRow.className = "person-row";
  const noneName = document.createElement("div");
  noneName.className = "person-name";
  noneName.textContent = "No space — back to its default section";
  noneRow.appendChild(noneName);
  noneRow.addEventListener("click", () => {
    assignToSpace(ch.id, null);
    closeSpaceModal();
  });
  spacePickList.appendChild(noneRow);

  spaceNameInput.value = "";
  spaceNewInput.value = "";
  spaceOverlay.classList.remove("hidden");
  spaceNameInput.focus();
}

function openSpaceMenu(space) {
  spaceModalTarget = { space };
  spaceTitle.textContent = `Space: ${space.name}`;
  spacePickWrap.classList.add("hidden");
  spaceManageWrap.classList.remove("hidden");
  spaceCreateWrap.classList.add("hidden");
  spaceRenameInput.value = space.name;
  spaceNameInput.value = "";
  spaceNewInput.value = "";
  spaceOverlay.classList.remove("hidden");
  spaceRenameInput.focus();
}

// CREATE mode (from the background menu's "New space…" row): the name field
// alone — no conversation is being moved, so creating only adds the section.
function openSpaceCreate() {
  spaceModalTarget = { create: true };
  spaceTitle.textContent = "New space";
  spacePickWrap.classList.add("hidden");
  spaceManageWrap.classList.add("hidden");
  spaceCreateWrap.classList.remove("hidden");
  spaceNameInput.value = "";
  spaceNewInput.value = "";
  spaceOverlay.classList.remove("hidden");
  spaceNewInput.focus();
}

function closeSpaceModal() {
  spaceOverlay.classList.add("hidden");
  spaceModalTarget = null;
}

// "Create and move here" (button click or Enter in the field). A rejected
// (blank) name changes nothing and leaves the modal open.
function createSpaceFromPicker() {
  const target = spaceModalTarget;
  if (!target || !target.ch) return;
  const created = createSpace(spaceNameInput.value);
  if (!created) return;
  assignToSpace(target.ch.id, created.id);
  closeSpaceModal();
}
spaceCreateBtn.addEventListener("click", createSpaceFromPicker);
spaceNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); createSpaceFromPicker(); }
});

// Same deal for "Rename": a blank name is rejected, the modal stays open.
function renameSpaceFromManage() {
  const target = spaceModalTarget;
  if (!target || !target.space) return;
  if (renameSpace(target.space.id, spaceRenameInput.value)) closeSpaceModal();
}
spaceRenameBtn.addEventListener("click", renameSpaceFromManage);
spaceRenameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); renameSpaceFromManage(); }
});
spaceDeleteBtn.addEventListener("click", () => {
  const target = spaceModalTarget;
  if (!target || !target.space) return;
  deleteSpace(target.space.id);
  closeSpaceModal();
});

// Same deal for "Create space" in CREATE mode: a blank name is rejected and
// the modal stays open. createSpace only persists, so re-render explicitly.
function createSpaceFromCreate() {
  const target = spaceModalTarget;
  if (!target || !target.create) return;
  if (!createSpace(spaceNewInput.value)) return;
  closeSpaceModal();
  renderSidebar();
}
spaceNewBtn.addEventListener("click", createSpaceFromCreate);
spaceNewInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); createSpaceFromCreate(); }
});

spaceCloseBtn.addEventListener("click", closeSpaceModal);
// Backdrop click dismisses — the pattern settingsOverlay uses.
spaceOverlay.addEventListener("click", (e) => {
  if (e.target === spaceOverlay) closeSpaceModal();
});

// Flip the silence flag and refresh whatever is showing it.
function toggleMuted(channelId) {
  setMuted(channelId, !isMuted(channelId));
  renderMuteBtn();
  renderSidebar();
}

// The bell in the conversation header, reflecting the open conversation.
function renderMuteBtn() {
  const muted = !!state.activeId && isMuted(state.activeId);
  muteBtn.textContent = muted ? "🔕" : "🔔";
  muteBtn.classList.toggle("muted", muted);
  muteBtn.title = muted ? "Unsilence this conversation" : "Silence this conversation";
  muteBtn.setAttribute("aria-pressed", String(muted));
}

// ================= CONVERSATION =================
async function openChannel(id) {
  closeMsgMenu();
  cancelEdit(); // an edit never survives a channel switch
  histReset(); // nor does composer undo history — it belongs to the conversation (#18)
  state.activeId = id;
  // #11: pin down where the unread part starts, before markViewed below wipes
  // the count — renderMessages drops the "New messages" divider that many
  // posts up from the bottom.
  state.unreadAtOpen = (state.unread[id] || 0) > 0 ? { channelId: id, count: state.unread[id] } : null;
  if (id !== state.keptUnreadId) state.keptUnreadId = (state.unread[id] || 0) > 0 ? id : null;
  markViewed(id); // clears the badge locally, reports the read to the server
  renderSidebar();

  const ch = state.channels.find((c) => c.id === id);
  emptyState.classList.add("hidden");
  chatPanel.classList.remove("hidden");
  chatTitle.textContent = displayName(ch);
  chatSub.textContent = subLabel(ch);
  renderMuteBtn();
  // Opening a conversation hands focus straight to the composer (#17): search →
  // click → type, with no extra click into the textbox. Done right away — the
  // async loads below never touch focus, so nothing steals it back.
  composerInput.focus();
  messagesEl.innerHTML = '<div class="loading">Loading messages…</div>';

  // reset paging for the newly opened conversation
  state.pageLoading = false;
  state.pageOldest = null;
  state.pageMore = false;

  // Stale-while-revalidate: paint the disk snapshot right away, then let the
  // network fetch below repaint with fresh data (get_posts also rewrites the
  // snapshot on the Rust side).
  let stalePainted = false;
  let freshPainted = false;
  try {
    const snapshot = JSON.parse(await invoke("get_cached_posts", { channelId: id }));
    if (state.activeId !== id) return;
    if (Array.isArray(snapshot) && snapshot.length) {
      renderMessages(snapshot);
      stalePainted = true;
      state.pageOldest = snapshot[0].id;
      state.pageMore = snapshot.length >= PAGE_SIZE;
      resolveUsers(snapshot.map((p) => p.user_id)).then(() => {
        if (state.activeId === id && !freshPainted) renderMessages(snapshot);
      });
    }
  } catch {
    // no snapshot on disk yet — keep the loading placeholder
  }

  try {
    // fetchPostsOnce joins an in-flight background warm (or a rapid
    // double-open) for this channel instead of firing a duplicate request.
    const posts = await fetchPostsOnce(id);
    if (state.activeId !== id) return; // user switched away while loading
    freshPainted = true;
    renderMessages(posts);
    state.pageOldest = posts.length ? posts[0].id : null; // posts are oldest→newest
    state.pageMore = posts.length >= PAGE_SIZE; // a full page hints there's more
    // Resolve any unknown authors, then relabel (no-op until get_users_by_ids exists).
    const authorIds = posts.map((p) => p.user_id);
    resolveUsers(authorIds).then(() => {
      if (state.activeId === id) renderMessages(posts);
    });
  } catch (e) {
    console.error("get_posts failed", e);
    // If the snapshot already painted, stale messages beat an error screen
    // (e.g. offline) — leave them up and fail quietly.
    if (!stalePainted) messagesEl.innerHTML = '<div class="error">Failed to load messages.</div>';
  }
}

// Load the page of messages that comes BEFORE the oldest one on screen, and
// prepend it without moving the viewport. Triggered by scrolling near the top.
async function loadOlder() {
  if (state.pageLoading || !state.pageMore || !state.activeId || !state.pageOldest) return;
  state.pageLoading = true;
  const channelId = state.activeId;
  const before = state.pageOldest;

  const spinner = document.createElement("div");
  spinner.className = "loading top-loading";
  spinner.textContent = "Loading older messages…";
  messagesEl.insertBefore(spinner, messagesEl.firstChild);

  try {
    const older = await invoke("get_posts", { channelId, before });
    if (state.activeId !== channelId) return;
    spinner.remove();

    if (!older || older.length === 0) { state.pageMore = false; return; }
    // Guard: if the backend doesn't understand `before` yet, it returns the same
    // latest page — the oldest id won't have moved. Stop instead of duplicating.
    if (older[0].id === before) { state.pageMore = false; return; }

    await resolveUsers(older.map((p) => p.user_id));
    if (state.activeId !== channelId) return;

    const prevH = messagesEl.scrollHeight;
    const prevFirstRow = messagesEl.querySelector(".msg-row"); // boundary partner below
    const frag = document.createDocumentFragment();
    let prevRow = null; // the page's top bubble has nothing above it yet
    for (const p of older) {
      const mine = state.me && p.user_id === state.me.id;
      const sender = mine ? null : realName(state.users[p.user_id]);
      const grouped = shouldGroupWith(prevRow, p.user_id, p.create_at);
      prevRow = bubbleEl({ mine, uid: p.user_id, sender, text: p.message, ts: p.create_at, files: p.file_ids, postId: p.id, reactions: p.metadata && p.metadata.reactions, edited: p.edit_at > 0, grouped });
      frag.appendChild(prevRow);
    }
    messagesEl.insertBefore(frag, messagesEl.firstChild);
    messagesEl.scrollTop += messagesEl.scrollHeight - prevH; // keep the view steady

    // Boundary pairing (#16): the previously-first bubble may now be the
    // continuation of the prepended page's last post — regroup it. The
    // adjacency check keeps any separator sitting between the pages (the #11
    // unread divider, loading placeholders …) from being treated as a
    // grouping partner.
    if (prevFirstRow && prevFirstRow.previousElementSibling === prevRow) {
      prevFirstRow.classList.toggle(
        "grouped",
        shouldGroupWith(prevRow, prevFirstRow.dataset.author, Number(prevFirstRow.dataset.ts))
      );
    }

    state.pageOldest = older[0].id;
    state.pageMore = older.length >= PAGE_SIZE;
  } catch (e) {
    console.error("get_posts (before) failed", e);
    spinner.remove();
    state.pageMore = false; // stop trying (e.g. backend not updated yet)
  } finally {
    state.pageLoading = false;
  }
}

function renderMessages(posts) {
  messagesEl.innerHTML = "";
  if (!posts || posts.length === 0) {
    const e = document.createElement("div");
    e.className = "loading";
    e.textContent = "No messages yet.";
    messagesEl.appendChild(e);
    return;
  }
  // Issue #11: the "New messages" divider goes before the first unread post.
  // The count was captured at openChannel time (state.unreadAtOpen) and
  // survives every repaint while the channel stays open, even though
  // markViewed has zeroed the badge since. Anchored at the bottom end — the
  // last `count` posts are the unread ones — so loadOlder prepends above
  // never shift it; more unread than loaded posts → it sits on top (the pages
  // in between were fetched but the boundary still marks "from here down").
  const uo = state.unreadAtOpen;
  const dividerAt =
    uo && uo.channelId === state.activeId && uo.count > 0
      ? Math.max(0, posts.length - uo.count)
      : -1;
  let prevRow = null; // grouping is pairwise: row N compares with row N−1
  let divider = null; // the #11 unread divider, when one is inserted
  posts.forEach((p, i) => {
    if (i === dividerAt) {
      divider = unreadDividerEl();
      messagesEl.appendChild(divider);
      prevRow = null; // the divider visually breaks a same-author run
    }
    const mine = state.me && p.user_id === state.me.id;
    const sender = mine ? null : realName(state.users[p.user_id]); // named once resolvable
    const grouped = shouldGroupWith(prevRow, p.user_id, p.create_at);
    prevRow = bubbleEl({ mine, uid: p.user_id, sender, text: p.message, ts: p.create_at, files: p.file_ids, postId: p.id, reactions: p.metadata && p.metadata.reactions, edited: p.edit_at > 0, grouped });
    messagesEl.appendChild(prevRow);
  });
  // Land on the unread boundary — that's what the user came to read — and
  // only fall to the latest when there is nothing unread.
  if (divider) divider.scrollIntoView({ block: "start" });
  else scrollToBottom();
}

// WhatsApp-style "New messages" divider: a full-width hairline with a
// centered pill (see styles.css). DOM nodes only, like everything else here.
function unreadDividerEl() {
  const el = document.createElement("div");
  el.className = "unread-divider";
  const pill = document.createElement("span");
  pill.className = "unread-pill";
  pill.textContent = "New messages";
  el.appendChild(pill);
  return el;
}

// ---------- message grouping (#16) ----------
// Is a new bubble a direct continuation of `prevRow` (the bubble rendered
// right before it)? bubbleEl stamps every row with data-author / data-ts, so
// the same helper serves the full repaint, live appends and the loadOlder
// boundary fix-up. No time window: the run only breaks on a different author
// or a non-message row (divider, ephemeral reply) — the monotonic guard just
// rejects out-of-order timestamps. An unknown author (live event for a user
// we haven't resolved yet) never groups — showing one header too many beats
// hiding one.
function shouldGroupWith(prevRow, uid, ts) {
  if (!prevRow || !uid || !ts) return false;
  const prevTs = Number(prevRow.dataset.ts);
  return prevRow.dataset.author === uid
    && Number.isFinite(prevTs)
    && ts - prevTs >= 0; // monotonic — the gap itself may be arbitrarily long
}

// The last rendered message bubble, skipping any non-message trailing nodes
// (ephemeral slash-command replies, the loadOlder spinner sit in the same
// list but are never a grouping partner).
function lastMsgRow() {
  const kids = messagesEl.children;
  for (let i = kids.length - 1; i >= 0; i--) {
    if (kids[i].classList.contains("msg-row")) return kids[i];
  }
  return null;
}

// A round avatar for a user. Starts as a colored initial, then swaps to the
// real image once get_avatar resolves. Every avatar for the same user carries
// a data-uid so we can fill them all in when the image arrives.
function paintAvatar(el, dataUrl) {
  // Defensive: only a well-formed image data URL may be interpolated into an
  // inline style — anything else could smuggle extra CSS declarations in.
  if (!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]*$/i.test(dataUrl)) return;
  el.style.backgroundImage = `url("${dataUrl}")`;
  el.style.backgroundColor = "transparent";
  // Inline so it wins over any `background:` shorthand on the element (the
  // sidebar avatar has one, which would otherwise reset the sizing to auto).
  el.style.backgroundSize = "cover";
  el.style.backgroundPosition = "center";
  el.style.backgroundRepeat = "no-repeat";
  el.textContent = "";
}

// Turn any circular element into an avatar for `uid`: real image if we have it,
// otherwise the initial + a background fetch. Works for message, sidebar and
// header avatars alike — they all carry data-uid so a late-arriving image fills
// every copy at once.
function decorateAvatar(el, uid, fallbackName) {
  if (uid) el.dataset.uid = uid;
  const cached = uid && state.avatars[uid];
  if (cached) {
    paintAvatar(el, cached);
  } else {
    el.textContent = (fallbackName || "?").replace(/^@/, "").charAt(0).toUpperCase() || "?";
    if (uid) ensureAvatar(uid);
  }
}

function avatarEl(uid, name) {
  const el = document.createElement("div");
  el.className = "msg-avatar";
  decorateAvatar(el, uid, name);
  return el;
}

async function ensureAvatar(uid) {
  if (!uid || state.avatars[uid] || state.avatarPending.has(uid) || !state.avatarLookupEnabled) return;
  state.avatarPending.add(uid);
  try {
    // Resolve the user first: last_picture_update versions the backend's disk
    // cache key, and sending 0 for a not-yet-resolved user would file the
    // avatar under a dead key on every startup.
    if (!state.users[uid]) await resolveUsers([uid]);
    const dataUrl = await invoke("get_avatar", {
      userId: uid,
      lastPictureUpdate: state.users[uid]?.last_picture_update ?? 0,
    });
    if (dataUrl) {
      state.avatars[uid] = dataUrl;
      for (const el of document.querySelectorAll(`[data-uid="${CSS.escape(uid)}"]`)) paintAvatar(el, dataUrl);
    }
  } catch (e) {
    // Only a missing command disables the feature for the session; any other
    // failure (network blip, deactivated user) just skips this uid.
    if (/not found|not allowed/i.test(String(e))) state.avatarLookupEnabled = false;
  } finally {
    state.avatarPending.delete(uid);
  }
}

// ---------- emoji ----------
// Unicode shortcodes come from the vendored EMOJI table; custom server emoji
// resolve name -> id via get_custom_emojis and render as small inline images.
async function loadCustomEmojis() {
  try {
    for (let page = 0; page < 25; page++) {
      const batch = await invoke("get_custom_emojis", { page });
      for (const e of batch || []) {
        if (e && e.name && e.id) state.customEmojis[e.name] = e.id;
      }
      if (!batch || batch.length < 200) break;
    }
  } catch (e) {
    console.warn("get_custom_emojis unavailable (custom emoji disabled). Is it in generate_handler!?", e);
  }
}

const emojiImagePending = new Set();
async function ensureEmojiImage(id) {
  if (!id || state.emojiImages[id] || emojiImagePending.has(id)) return;
  emojiImagePending.add(id);
  try {
    const dataUrl = await invoke("get_emoji_image", { emojiId: id });
    if (dataUrl) {
      state.emojiImages[id] = dataUrl;
      for (const el of document.querySelectorAll(`img[data-emoji-id="${CSS.escape(id)}"]`)) el.src = dataUrl;
    }
  } catch (e) {
    console.warn("get_emoji_image failed for", id, e);
  } finally {
    emojiImagePending.delete(id);
  }
}

// DOM node for :name:, or null when the code is unknown (caller keeps the text).
function emojiNode(name) {
  if (hasOwn(EMOJI, name)) return document.createTextNode(EMOJI[name]);
  const id = hasOwn(state.customEmojis, name) ? state.customEmojis[name] : null;
  if (id) {
    const img = document.createElement("img");
    img.className = "emoji";
    img.alt = `:${name}:`;
    img.title = `:${name}:`;
    img.dataset.emojiId = id;
    if (state.emojiImages[id]) img.src = state.emojiImages[id];
    else ensureEmojiImage(id);
    return img;
  }
  return null;
}

// ---------- markdown ----------
// Minimal chat-flavored markdown, rendered by BUILDING DOM NODES — message
// content never goes through innerHTML, so it can't inject markup. Supported:
// [label](url), bare http(s) URLs, **bold**, *italic*/_italic_, ~~strike~~,
// `code`, ``` fenced blocks ```, > quotes, -/*/+ and 1. lists (nested by
// indent), - [ ] / - [x] task items, # .. ###### headings, --- / ___ / ***
// horizontal rules, GFM pipe tables. Everything else is plain text.
// Headings (#32): the ATX marker #..###### maps to h2..h6 (h(n+1), capped at
// h6) — h1 is the app's own, nothing in a chat bubble should outrank it; CSS
// sizes them with rem so they follow --app-font-size and never blow up a
// bubble. Out of scope on purpose (#32 follow-ups): $..$ LaTeX (needs vendored
// KaTeX + fonts; stays literal) and fence language highlighting (needs a
// vendored highlighter; the info string only lands as a `lang-*` class hook).

// Open in the system browser via the opener plugin; never navigate the webview.
// Only http(s) may leave the app — the markdown regexes already guarantee that
// today, but this must not depend on every future call site remembering it
// (file:/smb: handed to the OS opener is how credential-leak tricks work).
async function openExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return;
    await window.__TAURI__.opener.openUrl(u.href);
  } catch (e) {
    console.warn("opener failed for", url, e);
  }
}

function linkEl(href, label) {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = label;
  a.title = href;
  a.addEventListener("click", (e) => {
    e.preventDefault();
    openExternal(href);
  });
  // Middle-click would otherwise navigate the webview itself to the URL —
  // a full-window page with no address bar is a phishing surface.
  a.addEventListener("auxclick", (e) => {
    e.preventDefault();
    if (e.button === 1) openExternal(href);
  });
  return a;
}

// Inline spans: code / bold / strike / italic / [label](url) / bare url.
function inlineMd(target, text, depth = 0) {
  if (!text) return;
  if (depth > 2) { target.appendChild(document.createTextNode(text)); return; }
  const re = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(~~([^~]+)~~)|(\*([^*\s][^*]*?)\*)|(\b_([^_\s][^_]*?)_\b)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>]+)|(:([a-z0-9_+'-]+):)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) target.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) {
      const c = document.createElement("code");
      c.textContent = m[2];
      target.appendChild(c);
    } else if (m[3]) {
      const b = document.createElement("strong");
      inlineMd(b, m[4], depth + 1);
      target.appendChild(b);
    } else if (m[5]) {
      const s = document.createElement("s");
      inlineMd(s, m[6], depth + 1);
      target.appendChild(s);
    } else if (m[7]) {
      const em = document.createElement("em");
      inlineMd(em, m[8], depth + 1);
      target.appendChild(em);
    } else if (m[9]) {
      const em = document.createElement("em");
      inlineMd(em, m[10], depth + 1);
      target.appendChild(em);
    } else if (m[11]) {
      target.appendChild(linkEl(m[13], m[12]));
    } else if (m[14]) {
      // bare URL — drop trailing punctuation that's almost never part of it
      let url = m[14];
      const trail = url.match(/[),.;:!?'"]+$/);
      if (trail && !(trail[0].startsWith(")") && url.includes("("))) {
        url = url.slice(0, -trail[0].length);
        re.lastIndex -= trail[0].length;
      }
      target.appendChild(linkEl(url, url));
    } else if (m[15]) {
      const node = emojiNode(m[16]);
      target.appendChild(node || document.createTextNode(m[15])); // unknown code stays literal
    }
    last = re.lastIndex;
  }
  if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
}

const FENCE_RE = /^\s*```/;
const QUOTE_RE = /^>\s?/;
// #32: ATX heading — 1-6 hashes then whitespace, so "#tag" stays plain text.
const HEADING_RE = /^(#{1,6})\s+/;
// #32: a line that is ONLY a run of 3+ of the same -, _ or *, optionally
// spaced ("- - -"). Checked BEFORE lists so "- - -" can't read as a bullet
// whose text is "- -", and after tables' lookahead consumed a well-formed
// "|---|" delimiter row — a bare "---" under a non-table pipe line (or any
// text, GFM-setext style) still becomes a rule, never a heading.
const HR_RE = /^\s*([*_-])(?:\s*\1){2,}\s*$/;
// One list item: leading indent, then a bullet (-/*/+) or an ordered "1."
// marker, then whitespace. The + bullet is Mattermost/markdown-standard (#32).
const LIST_ITEM_RE = /^(\s*)([-*+]|\d+\.)\s+/;
// A task item's checkbox marker right after the list marker (#32).
const CHECK_RE = /^\[([ xX])\]\s+/;
// One cell of a GFM table delimiter row: GFM allows ONE OR MORE hyphens
// with optional alignment colons (e.g. "-", "--:"), not the ≥3 a naive
// reading suggests — matching the native Mattermost client.
const TABLE_DELIM_CELL_RE = /^:?-+:?$/;

// Leading indent in display columns (a tab is 4) — nesting is relative, so a
// tab-indented sub-item nests exactly like a 4-space one.
function indentOf(line) {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

// A table row's cells, trimmed; surrounding pipes are optional (| a | b | and
// a | b both split to ["a", "b"]). Escaped pipes are out of scope on purpose.
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

// If lines[i] opens a GFM pipe table — a pipe line sitting directly above a
// |---|---| delimiter row — return { headers, aligns }, else null. Like
// commonmark/GFM the delimiter must have exactly the header's cell count:
// a mismatch (e.g. a "---" hr under a pipe-y line) stays plain text instead
// of morphing into a mangled table.
function tableStartAt(lines, i) {
  if (i + 1 >= lines.length || !lines[i].includes("|")) return null;
  const headers = splitTableRow(lines[i]);
  const delims = splitTableRow(lines[i + 1]);
  if (delims.length !== headers.length) return null;
  if (!delims.every((c) => TABLE_DELIM_CELL_RE.test(c))) return null;
  // :--- left, ---: right, :---: center, bare --- default (null → no class).
  const aligns = delims.map((c) =>
    c.startsWith(":") ? (c.endsWith(":") ? "center" : "left") : c.endsWith(":") ? "right" : null
  );
  return { headers, aligns };
}

// #32: a (possibly nested) list block, via an indent stack. A line indented
// ≥2 columns past the frame on top of the stack opens ONE nested list inside
// that frame's last <li> — 2, 4 or 8 extra spaces all nest a single level
// (forgiving, like the native client); dedenting below a frame's indent pops
// it, so "  + sub" then "- item" returns cleanly to the top level. Depth is
// unbounded and ul/ol mix freely; a switch of kind at the same indent ("-"
// ↔ "1.") opens a sibling list like GFM. A blank line ends the list unless
// another item follows further down. Returns { frag, next }.
function listBlock(lines, startIdx) {
  const frag = document.createDocumentFragment();
  const stack = []; // frames { indent, ordered, list, li, parent }, deepest last
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    if (HR_RE.test(line)) break; // "- - -" is a rule, not a bullet
    if (!/\S/.test(line)) {
      let j = i + 1;
      while (j < lines.length && !/\S/.test(lines[j])) j++;
      if (j < lines.length && LIST_ITEM_RE.test(lines[j]) && !HR_RE.test(lines[j])) { i = j; continue; }
      break;
    }
    const m = line.match(LIST_ITEM_RE);
    if (!m) break;
    const indent = indentOf(line);
    const ordered = /^\d/.test(m[2]);
    while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
    let frame = stack[stack.length - 1];
    if (!frame) {
      frame = { indent, ordered, li: null, parent: frag };
      frame.list = document.createElement(ordered ? "ol" : "ul");
      frag.appendChild(frame.list);
      stack.push(frame);
    } else if (indent >= frame.indent + 2 && frame.li) {
      frame = { indent, ordered, li: null, parent: stack[stack.length - 1].li };
      frame.list = document.createElement(ordered ? "ol" : "ul");
      frame.parent.appendChild(frame.list);
      stack.push(frame);
    } else if (frame.ordered !== ordered) {
      frame.list = document.createElement(ordered ? "ol" : "ul");
      frame.parent.appendChild(frame.list);
      frame.ordered = ordered;
    }
    const li = document.createElement("li");
    frame.list.appendChild(li);
    frame.li = li;
    let content = line.slice(m[0].length);
    const check = content.match(CHECK_RE);
    if (check) {
      // Display-only glyph — the state lives in the source text; there is no
      // server round-trip to toggle a real checkbox with (#32).
      li.className = "task";
      const box = document.createElement("span");
      box.className = "task-check";
      box.textContent = check[1] === " " ? "\u2610" : "\u2612"; // ☐ open / ☒ done
      li.appendChild(box);
      content = content.slice(check[0].length);
    }
    inlineMd(li, content);
    i++;
  }
  return { frag, next: i };
}

// Detects block starts at lines[i]; tables need the lookahead (a header row
// alone is just text — the delimiter line below is what makes it a table).
const startsBlock = (lines, i) =>
  FENCE_RE.test(lines[i]) || QUOTE_RE.test(lines[i]) || HEADING_RE.test(lines[i]) ||
  HR_RE.test(lines[i]) || LIST_ITEM_RE.test(lines[i]) || !!tableStartAt(lines, i);

function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text || "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (FENCE_RE.test(line)) {
      // #32: the info string (```bash) only lands as a `lang-*` class hook for
      // future CSS — actual highlighting needs a vendored lib we don't carry.
      const lang = /^(\w+)/.exec(line.slice(line.match(FENCE_RE)[0].length).trimStart());
      const buf = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence (or end of message)
      const pre = document.createElement("pre");
      if (lang) pre.className = `lang-${lang[1].toLowerCase()}`;
      const code = document.createElement("code");
      code.textContent = buf.join("\n");
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const bq = document.createElement("blockquote");
      let first = true;
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        if (!first) bq.appendChild(document.createElement("br"));
        inlineMd(bq, lines[i].replace(QUOTE_RE, ""));
        first = false;
        i++;
      }
      frag.appendChild(bq);
      continue;
    }

    const hm = HEADING_RE.exec(line);
    if (hm) {
      // #32: h(n+1), capped at h6 (h1 stays reserved for the app itself).
      const h = document.createElement(`h${Math.min(hm[1].length + 1, 6)}`);
      inlineMd(h, line.slice(hm[0].length));
      frag.appendChild(h);
      i++;
      continue;
    }

    if (HR_RE.test(line)) { // after tables' lookahead, before lists: see HR_RE
      frag.appendChild(document.createElement("hr"));
      i++;
      continue;
    }

    if (LIST_ITEM_RE.test(line)) {
      const { frag: listFrag, next } = listBlock(lines, i);
      frag.appendChild(listFrag);
      i = next;
      continue;
    }

    const tbl = tableStartAt(lines, i);
    if (tbl) {
      // Semantic table in a scroller: wide tables scroll sideways instead of
      // breaking the bubble. Cells run through inlineMd, so **x**, `y`, links
      // and :emoji: keep working inside them.
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      const table = document.createElement("table");
      table.className = "md-table";
      const thead = document.createElement("thead");
      const htr = document.createElement("tr");
      tbl.headers.forEach((h, c) => {
        const th = document.createElement("th");
        if (tbl.aligns[c]) th.className = `align-${tbl.aligns[c]}`;
        inlineMd(th, h);
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      i += 2; // header + delimiter
      // Body: consecutive pipe-lines. A line that starts another block (or a
      // fresh table header — chat users stack tables without blank lines)
      // ends it. Ragged rows are fine: short rows pad with empty cells,
      // extra cells just append (commonmark-table leniency — don't crash).
      while (i < lines.length && lines[i].includes("|") && !startsBlock(lines, i)) {
        const cells = splitTableRow(lines[i]);
        while (cells.length < tbl.headers.length) cells.push("");
        const tr = document.createElement("tr");
        cells.forEach((cell, c) => {
          const td = document.createElement("td");
          if (tbl.aligns[c]) td.className = `align-${tbl.aligns[c]}`;
          inlineMd(td, cell);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
        i++;
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      frag.appendChild(wrap);
      continue;
    }

    inlineMd(frag, line);
    i++;
    if (i < lines.length && !startsBlock(lines, i)) frag.appendChild(document.createElement("br"));
  }
  return frag;
}

// ---------- attachments ----------
// #29: an already-small image gets inlined at full fidelity — the thumbnail
// roundtrip only pays off when it actually shrinks something (the reporter's
// 333×30 banner must qualify, a multi-MB photo never may). Two probes:
const SMALL_IMAGE_MAX_DIM = 480; // px on the long edge, once FileInfo carries width/height
// …until then the byte size stands in: anything under 256 KiB is cheap enough
// to pull whole (get_file is NOT disk-cached like thumbnails are — the cap is
// also what keeps the per-open lightbox re-fetch negligible).
const SMALL_IMAGE_MAX_BYTES = 256 * 1024;

function isSmallImage(info) {
  const w = Number(info.width);
  const h = Number(info.height);
  if (w > 0 && h > 0) return Math.max(w, h) <= SMALL_IMAGE_MAX_DIM;
  return typeof info.size === "number" && info.size < SMALL_IMAGE_MAX_BYTES;
}

async function fileInfo(id) {
  if (state.fileInfos[id]) return state.fileInfos[id];
  const info = await invoke("get_file_info", { fileId: id });
  state.fileInfos[id] = info;
  return info;
}

function formatSize(bytes) {
  if (typeof bytes !== "number" || bytes < 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function attachmentsEl(fileIds) {
  const wrap = document.createElement("div");
  wrap.className = "attachments";
  for (const id of fileIds) {
    const el = document.createElement("div");
    el.className = "attachment";
    el.textContent = "📎 …";
    wrap.appendChild(el);
    hydrateAttachment(el, id);
  }
  return wrap;
}

// Fill an attachment placeholder: image (thumbnail, or the full image when
// small — see #29) with click = full view, or a name+size chip. Degrades to a
// plain tag until the file commands exist.
async function hydrateAttachment(el, id) {
  if (!state.fileLookupEnabled) { el.textContent = "📎 attachment"; return; }
  let info;
  try {
    info = await fileInfo(id);
  } catch (e) {
    state.fileLookupEnabled = false; // commands not registered yet
    console.warn("get_file_info unavailable (attachments shown as tags). Is it in generate_handler!?", e);
    el.textContent = "📎 attachment";
    return;
  }
  const isImage = (info.mime_type || "").startsWith("image/");
  if (!isImage) {
    el.classList.add("file-chip");
    el.textContent = `📎 ${info.name}` + (info.size ? ` · ${formatSize(info.size)}` : "");
    return;
  }
  // #29: small enough to show as-is — skip the miniature, the inline img gets
  // the full data URL. Click still opens the lightbox (uniform behavior).
  if (isSmallImage(info)) {
    try {
      renderImageAttachment(el, id, info, await invoke("get_file", { fileId: id, mime: info.mime_type }));
      return;
    } catch (_) {
      // full read failed — fall back to the thumbnail path below
    }
  }
  try {
    renderImageAttachment(el, id, info, await invoke("get_file_thumbnail", { fileId: id }));
  } catch (_) {
    // thumbnail failed (e.g. command missing) — at least name the file
    el.classList.add("file-chip");
    el.textContent = `🖼️ ${info.name}`;
  }
}

// Inline image + click → lightbox; shared by the thumbnail path and #29's
// full-fidelity small-image path.
function renderImageAttachment(el, id, info, src) {
  el.classList.add("image");
  el.textContent = "";
  const img = document.createElement("img");
  img.src = src;
  img.alt = info.name;
  el.appendChild(img);
  el.addEventListener("click", () => openLightbox(id, info));
}

// Full-size image over everything; click anywhere or Esc to close.
async function openLightbox(id, info) {
  const overlay = document.createElement("div");
  overlay.className = "lightbox";
  const img = document.createElement("img");
  img.alt = info.name;
  overlay.appendChild(img);
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  try {
    img.src = await invoke("get_file", { fileId: id, mime: info.mime_type });
  } catch (_) {
    close(); // full-size fetch not available — the thumbnail stays in the bubble
  }
}

// ---------- reactions ----------
// state.reactions holds post_id -> { emoji_name -> Set(user_id) }. Seeded from
// post metadata when history renders, kept live by the mm-reaction-* events,
// and updated optimistically when I click. Sets make double-application (echo
// of my own action) harmless.
function seedReactions(postId, arr) {
  if (state.reactions[postId]) return; // live state wins over a re-render
  const map = {};
  for (const r of arr || []) {
    if (!r || !r.emoji_name || !r.user_id) continue;
    (map[r.emoji_name] = map[r.emoji_name] || new Set()).add(r.user_id);
  }
  state.reactions[postId] = map;
}

function applyReaction(postId, name, userId, add) {
  const map = (state.reactions[postId] = state.reactions[postId] || {});
  const set = (map[name] = map[name] || new Set());
  if (add) set.add(userId);
  else set.delete(userId);
  for (const el of document.querySelectorAll(`.reactions[data-post-id="${CSS.escape(postId)}"]`)) {
    renderReactionsInto(el, postId);
  }
}

async function toggleReaction(postId, name) {
  const my = state.me?.id;
  if (!my || !postId) return;
  const cur = state.reactions[postId];
  const has = !!(cur && cur[name] && cur[name].has(my));
  applyReaction(postId, name, my, !has); // optimistic; reverted on failure
  try {
    if (has) await invoke("remove_reaction", { postId, emojiName: name, userId: my });
    else await invoke("add_reaction", { postId, emojiName: name, userId: my });
  } catch (e) {
    applyReaction(postId, name, my, has);
    console.warn("reaction command failed. Are add_reaction/remove_reaction in generate_handler!?", e);
  }
}

// Names listed in a reaction hovercard before the rest collapses into
// "and N more".
const REACTION_TIP_MAX = 10;

// GitHub-style hovercard text for a reaction chip: who reacted, "You" first
// (WhatsApp-style), everyone else in reaction order. Users we haven't
// resolved yet degrade to "someone" (never a raw id, never "undefined") and
// the text updates once resolveUsers brings their names in.
function reactionTipText(postId, name) {
  const set = state.reactions[postId] && state.reactions[postId][name];
  if (!set || !set.size) return `:${name}:`;
  const my = state.me?.id;
  const ids = [...set];
  if (my && set.has(my)) {
    ids.splice(ids.indexOf(my), 1);
    ids.unshift(my);
  }
  const shown = ids.slice(0, REACTION_TIP_MAX).map((id) =>
    id === my ? "You" : realName(state.users[id]) || "someone"
  );
  const extra = ids.length - shown.length;
  let names = shown.join(", ");
  if (extra > 0) names += ` and ${extra} more`;
  else if (shown.length > 1) names = shown.slice(0, -1).join(", ") + " and " + shown[shown.length - 1];
  return `${names} reacted with :${name}:`;
}

// Hovercard for a reaction chip: a plain child div of the pill, so it dies
// with the pill on every renderReactionsInto rebuild — nothing can leak
// across re-renders. Resolution of unknown reactor names refreshes it in
// place, but only while this exact hover is still alive.
function showReactionTip(pill, postId, name) {
  let tip = pill.querySelector(".reaction-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "reaction-tip";
    pill.appendChild(tip);
  }
  tip.textContent = reactionTipText(postId, name);
  const unknown = [...(state.reactions[postId]?.[name] || [])].filter((id) => !state.users[id]);
  if (unknown.length) {
    resolveUsers(unknown).then(() => {
      if (tip.parentNode === pill) tip.textContent = reactionTipText(postId, name);
    });
  }
}

function hideReactionTip(pill) {
  const tip = pill.querySelector(".reaction-tip");
  if (tip) tip.remove();
}

function renderReactionsInto(container, postId) {
  container.innerHTML = "";
  const map = state.reactions[postId] || {};
  const my = state.me?.id;
  for (const [name, users] of Object.entries(map)) {
    if (!users.size) continue;
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "reaction-pill" + (my && users.has(my) ? " mine" : "");
    pill.appendChild(emojiNode(name) || document.createTextNode(`:${name}:`));
    const cnt = document.createElement("span");
    cnt.className = "count";
    cnt.textContent = users.size;
    pill.appendChild(cnt);
    pill.addEventListener("click", () => toggleReaction(postId, name));
    pill.addEventListener("mouseenter", () => showReactionTip(pill, postId, name));
    pill.addEventListener("mouseleave", () => hideReactionTip(pill));
    container.appendChild(pill);
  }
  // Marks strips holding real pills. An empty strip is just the hover-revealed
  // "+"; inside a grouped run (#16) the CSS docks it beside the bubble instead
  // of letting it stretch the gap between balloons.
  container.classList.toggle("with-pills", container.childNodes.length > 0);
  const add = document.createElement("button");
  add.type = "button";
  add.className = "reaction-add";
  add.textContent = "+";
  add.title = "Add reaction";
  add.addEventListener("click", (e) => openReactionPicker(postId, e.currentTarget));
  container.appendChild(add);
}

// Small floating emoji picker anchored to the clicked "+".
const reactionPicker = document.createElement("div");
reactionPicker.className = "reaction-picker hidden";
document.body.appendChild(reactionPicker);

// One row of an emoji list — glyph (unicode char or custom-emoji image) plus
// the :name: label. Shared by the reaction picker and the composer autocomplete.
function emojiRowEl(c, selected) {
  const row = document.createElement("div");
  row.className = "emoji-row" + (selected ? " sel" : "");
  const glyph = document.createElement("span");
  glyph.className = "glyph";
  if (c.ch) {
    glyph.textContent = c.ch;
  } else {
    const img = document.createElement("img");
    img.className = "emoji";
    img.dataset.emojiId = c.id;
    if (state.emojiImages[c.id]) img.src = state.emojiImages[c.id];
    else ensureEmojiImage(c.id);
    glyph.appendChild(img);
  }
  const label = document.createElement("span");
  label.textContent = `:${c.name}:`;
  row.appendChild(glyph);
  row.appendChild(label);
  return row;
}

function openReactionPicker(postId, anchor) {
  reactionPicker.innerHTML = "";
  const input = document.createElement("input");
  input.placeholder = "Search emoji…";
  const list = document.createElement("div");
  list.className = "reaction-picker-list";
  reactionPicker.appendChild(input);
  reactionPicker.appendChild(list);
  const refresh = () => {
    list.innerHTML = "";
    for (const c of emojiCandidates(input.value.trim().toLowerCase())) {
      const row = emojiRowEl(c, false);
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        toggleReaction(postId, c.name);
        closeReactionPicker();
      });
      list.appendChild(row);
    }
  };
  input.addEventListener("input", refresh);
  refresh();
  const r = anchor.getBoundingClientRect();
  reactionPicker.classList.remove("hidden");
  reactionPicker.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 250)) + "px";
  reactionPicker.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - 320)) + "px";
  input.focus();
}

function closeReactionPicker() {
  reactionPicker.classList.add("hidden");
}

document.addEventListener("mousedown", (e) => {
  if (!reactionPicker.classList.contains("hidden") && !reactionPicker.contains(e.target)) {
    closeReactionPicker();
  }
  if (!channelMenu.classList.contains("hidden") && !channelMenu.contains(e.target)) {
    closeChannelMenu();
  }
  if (!msgMenu.classList.contains("hidden") && !msgMenu.contains(e.target)) {
    closeMsgMenu();
  }
});

muteBtn.addEventListener("click", () => {
  if (state.activeId) toggleMuted(state.activeId);
});
// The menus are placed at a viewport position, so anything that moves the
// content out from under them should dismiss them rather than let them float loose.
channelList.addEventListener("scroll", closeChannelMenu);
window.addEventListener("blur", closeChannelMenu);
messagesEl.addEventListener("scroll", closeMsgMenu);
window.addEventListener("blur", closeMsgMenu);

function bubbleEl({ mine, uid, sender, text, ts, files, postId, reactions, edited, grouped }) {
  const row = document.createElement("div");
  row.className = "msg-row" + (mine ? " mine" : "") + (grouped ? " grouped" : "");
  if (postId) row.dataset.postId = postId; // how edits/locators find this bubble
  // Grouping glue (#16): who sent this bubble and when. NB: deliberately NOT
  // data-uid — that attribute signals "paint the avatar into this element"
  // (see ensureAvatar), which a row must never be subject to.
  if (uid) row.dataset.author = uid;
  if (ts) row.dataset.ts = String(ts); // … and when

  row.appendChild(avatarEl(uid, mine ? state.me?.username : sender));

  const el = document.createElement("div");
  el.className = "msg " + (mine ? "msg-me" : "msg-other");

  if (sender || ts) {
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    // The sender gets its own span so a grouped row can hide just it via CSS
    // (.msg-row.grouped .msg-sender) while keeping the small timestamp —
    // that way a bubble can flip in and out of a group (loadOlder boundary
    // fix-up) without rebuilding any text.
    if (sender) {
      const who = document.createElement("span");
      who.className = "msg-sender";
      who.textContent = sender + " · ";
      meta.appendChild(who);
    }
    meta.appendChild(document.createTextNode(formatTime(ts)));
    if (edited) meta.appendChild(editedMarkerEl()); // history posts carrying edit_at
    el.appendChild(meta);
  }
  if (text) {
    const body = document.createElement("div");
    body.className = "msg-body";
    body.appendChild(renderMarkdown(text)); // DOM nodes only — never innerHTML
    el.appendChild(body);
  }
  if (files && files.length) el.appendChild(attachmentsEl(files));

  // The corner timestamp every bubble carries (#16): hidden on ungrouped rows,
  // docked just OUTSIDE the balloon's trailing bottom edge once the row goes
  // .grouped (pure CSS flip — so the loadOlder boundary pairing can retag a
  // rendered row with zero DOM surgery). Mirrors the meta line's time + edited
  // marker.
  if (ts) el.appendChild(stampEl(ts, !!edited));

  if (postId) {
    seedReactions(postId, reactions);
    const rx = document.createElement("div");
    rx.className = "reactions";
    rx.dataset.postId = postId;
    renderReactionsInto(rx, postId);
    el.appendChild(rx);
  }

  row.appendChild(el);

  // Right-click on my own bubble offers editing — only while the backend has
  // the edit_message command (one not-found flips the flag off for the session).
  row.addEventListener("contextmenu", (e) => {
    if (!mine || !postId || !state.editMessageEnabled) return;
    e.preventDefault();
    openMsgMenu(e.clientX, e.clientY, postId, text || "");
  });
  return row;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// The one time read of the app: feeds BOTH the meta line and the corner
// stamp (#16), so the two can never disagree. Messages from today get the
// bare clock ("14:22"); anything older gets a short date prefix
// ("23/09 14:22", locale-shaped) — with gap-less grouping a run can now span
// midnight, and a lone "14:22" on yesterday's bubble is as misleading as a
// missing one was before.
function formatTime(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return time;
    return d.toLocaleDateString([], { day: "2-digit", month: "2-digit" }) + " " + time;
  } catch {
    return "";
  }
}

// The grouped-row clock (#16): "edited" tag (when already edited) followed by
// the time. Hidden unless the row is .grouped, and then docked outside the
// balloon's trailing edge, on the chat background — see styles.css.
function stampEl(ts, edited) {
  const stamp = document.createElement("div");
  stamp.className = "msg-stamp";
  if (edited) stamp.appendChild(editedMarkerEl());
  stamp.appendChild(document.createTextNode(formatTime(ts)));
  return stamp;
}

// ================= LIVE EVENTS =================
// Desktop notification via the Tauri notification plugin. No-op (and silent)
// until the plugin is registered on the Rust side, so it never errors early.
async function notify(title, body) {
  try {
    const n = window.__TAURI__ && window.__TAURI__.notification;
    if (!n) { console.warn("[notify] plugin API not present on window.__TAURI__"); return; }
    let granted = await n.isPermissionGranted();
    console.log("[notify] permission granted:", granted);
    if (!granted) {
      const res = await n.requestPermission();
      console.log("[notify] requestPermission ->", res);
      granted = res === "granted";
    }
    if (granted) {
      n.sendNotification({ title, body: body || "" });
      console.log("[notify] sent:", title);
    } else {
      console.warn("[notify] permission not granted — no notification shown");
    }
  } catch (e) {
    console.warn("[notify] failed:", e);
  }
}

const seenPostIds = new Set(); // dedupe guard (needs `id` on the WS payload)

function onIncoming(event) {
  const p = event.payload; // { channel_id, sender, message, id? }
  console.log("[mm-post]", p && p.channel_id, p && p.id, p && p.sender, p && p.file_ids);
  if (!p) return;

  // Same post delivered twice (duplicate WS connection, reconnect race) → drop.
  // Only possible once the backend includes the post id in IncomingMessage.
  if (p.id) {
    if (seenPostIds.has(p.id)) return;
    seenPostIds.add(p.id);
    if (seenPostIds.size > 500) {
      const oldest = seenPostIds.values().next().value;
      seenPostIds.delete(oldest);
    }
  }

  // Bump this conversation up the list (live activity ordering).
  state.activity[p.channel_id] = Date.now();

  const ch = state.channels.find((c) => c.id === p.channel_id);
  const myName = state.me?.username;
  const senderClean = (p.sender || "").replace(/^@/, "");
  const mine = myName && senderClean === myName;

  // Fallback: learn a 1:1 channel's name from the other party's live message.
  if (ch && ch.type === "D" && p.sender && !mine && !state.dmNames[ch.id]) {
    state.dmNames[ch.id] = p.sender;
    if (p.channel_id === state.activeId) chatTitle.textContent = displayName(ch);
  }

  // Notify for others' messages we'd otherwise miss: window unfocused, or the
  // message is in a conversation that isn't the one currently open.
  // Wrapped so a notification hiccup can never block rendering the message —
  // an undefined helper here once silently ate all incoming messages.
  try {
    // Never notify for my own messages, no matter which device they came from.
    if (!mine && !isMuted(p.channel_id) && (!document.hasFocus() || p.channel_id !== state.activeId)) {
      const su = state.usersByName[senderClean];
      const who = (su && realName(su)) || p.sender || "New message";
      const title = ch && !isDM(ch) ? `${who} · ${displayName(ch)}` : who;
      const nFiles = p.file_ids ? p.file_ids.length : 0;
      const body = p.message || (nFiles ? (nFiles === 1 ? "📎 Sent an attachment" : `📎 Sent ${nFiles} attachments`) : "");
      notify(title, body);
    }
  } catch (e) {
    console.error("notification failed (message still rendered)", e);
  }

  if (p.channel_id === state.activeId) {
    // Drop the "No messages yet." / "Loading messages…" placeholder if present.
    // Only that node — .top-loading is the loadOlder spinner sitting above real
    // bubbles, and wiping innerHTML here would destroy the whole conversation.
    const placeholder = messagesEl.querySelector(".loading:not(.top-loading)");
    if (placeholder) placeholder.remove();
    // live events carry the username but not the user_id — resolve it if we can
    const uid = mine ? state.me?.id : state.usersByName[senderClean]?.id;
    // A live bubble from the same author as the last one on screen joins its
    // group (#16); a different author (or an unresolved sender) restarts it.
    const grouped = shouldGroupWith(lastMsgRow(), uid, Date.now());
    messagesEl.appendChild(
      bubbleEl({ mine, uid, sender: mine ? null : p.sender, text: p.message, ts: Date.now(), files: p.file_ids, postId: p.id, grouped })
    );
    scrollToBottom();
    if (document.hasFocus()) {
      markViewed(p.channel_id); // keep the server's watermark caught up
    } else if (!mine) {
      // open but not looking — badge it; cleared when the window regains focus
      state.unread[p.channel_id] = (state.unread[p.channel_id] || 0) + 1;
    }
  } else if (!mine) {
    state.unread[p.channel_id] = (state.unread[p.channel_id] || 0) + 1;
  }
  renderSidebar();
}

// ================= COMPOSER =================
// Sends only on explicit user action (button / Enter). Nothing auto-sends.
composer.addEventListener("submit", (e) => {
  e.preventDefault();
  sendCurrent();
});
composerInput.addEventListener("keydown", (e) => {
  if (handleEmojiPopupKey(e)) return; // popup swallows Enter/arrows while open
  if (handleMentionPopupKey(e)) return; // same for the @mention popup (#21)
  if (e.key === "Escape" && state.editing) {
    e.preventDefault();
    cancelEdit(); // bail out of edit mode without saving
    return;
  }
  // The webview has no usable native textarea undo (#18) — our own history
  // lives below. preventDefault unconditionally: the webview must never try
  // its (broken) native undo behind our back.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && "zZyY".includes(e.key)) {
    e.preventDefault();
    if (e.shiftKey || e.key === "y" || e.key === "Y") histRedo(); else histUndo();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendCurrent();
  }
});
composerInput.addEventListener("input", autoResize);
composerInput.addEventListener("input", updateEmojiPopup);
composerInput.addEventListener("input", updateMentionPopup);
composerInput.addEventListener("input", histInput);
composerInput.addEventListener("blur", () => setTimeout(() => { hideEmojiPopup(); hideMentionPopup(); }, 150)); // let clicks land first

// ---------- undo / redo (#18) ----------
// WebKitGTK (and WKWebView/WebView2) give a textarea no usable native undo —
// paste → Ctrl+Z did nothing. So the composer keeps its own bounded history of
// {value, selectionStart, selectionEnd} snapshots.
//
// Step grouping: a run of same-kind inputs (typing, deleting) merges into ONE
// step; a kind switch or a >HISTORY_IDLE_MS pause breaks it. Paste / drop /
// cut are ALWAYS atomic — one Ctrl+Z removes exactly the paste, never more.
// Rewrites the app performs itself (emoji insert, …) use the histPush() /
// histSettle() bookends; histReset() wipes the stacks wherever the composer is
// already reset (send, channel switch, edit arm/cancel) and re-bases onto the
// content standing there at that moment.
const HISTORY_MAX = 100;
const HISTORY_IDLE_MS = 1000;
const HISTORY_ATOMIC = new Set(["insertFromPaste", "insertFromDrop", "deleteByCut"]);

const composerHistory = {
  undo: [], // settled snapshots, oldest first — each is the state BEFORE a step
  redo: [], // undone snapshots, newest last
  pending: histSnap(), // state as of the last accounted change (= pre-state of the next input)
  lastType: null, // inputType of the open burst (null = the next input breaks)
  lastAt: 0, // when the open burst last moved
};

function histSnap() {
  return { value: composerInput.value, s: composerInput.selectionStart, e: composerInput.selectionEnd };
}

function histPushStack(snap) {
  composerHistory.undo.push(snap);
  if (composerHistory.undo.length > HISTORY_MAX) composerHistory.undo.shift(); // drop the oldest
}

// input listener: decides the step boundaries around typed/pasted text.
// NB: pending is always EAGER — snapshotted while the textarea still holds the
// state it describes; an `input` event itself already fires post-mutation.
function histInput(e) {
  const h = composerHistory;
  const now = Date.now();
  const breaks = h.lastType === null
    || (e.inputType && HISTORY_ATOMIC.has(e.inputType))
    || e.inputType !== h.lastType
    || now - h.lastAt > HISTORY_IDLE_MS;
  if (breaks) histPushStack(h.pending);
  h.redo.length = 0; // any new input kills the redo branch
  h.lastType = e.inputType || null;
  h.lastAt = now;
  h.pending = histSnap();
}

// Bookends for rewrites the app performs itself (no input event fires there):
// push the pre-rewrite state first, then re-base onto the rewritten content.
function histPush() {
  const h = composerHistory;
  histPushStack(h.pending);
  h.redo.length = 0;
  h.lastType = null; // the next typed char starts a fresh step
}

function histSettle() {
  composerHistory.pending = histSnap();
  composerHistory.lastType = null;
}

// Forget everything (send, channel switch, edit arm/cancel): whatever is in
// the box right now becomes the new base — no undo past this point.
function histReset() {
  composerHistory.undo.length = 0;
  composerHistory.redo.length = 0;
  composerHistory.pending = histSnap();
  composerHistory.lastType = null;
}

function histApply(snap) {
  composerInput.value = snap.value;
  composerInput.setSelectionRange(snap.s, snap.e);
  composerHistory.pending = histSnap();
  composerHistory.lastType = null; // the next input breaks from the restored state
  autoResize();
  updateEmojiPopup(); // re-filter (or hide) against the restored text
  updateMentionPopup();
}

function histUndo() {
  const h = composerHistory;
  if (!h.undo.length) return; // nothing to undo — already preventDefault'ed
  h.redo.push(histSnap());
  histApply(h.undo.pop());
}

function histRedo() {
  const h = composerHistory;
  if (!h.redo.length) return;
  histPushStack(histSnap());
  histApply(h.redo.pop());
}

// ---------- emoji autocomplete ----------
// Typing ":na" in the composer suggests matching emoji; Enter/Tab/click inserts.
const emojiPopup = document.createElement("div");
emojiPopup.className = "emoji-popup hidden";
composer.appendChild(emojiPopup);
let emojiCands = [];
let emojiSel = 0;

const EMOJI_PREFIX_RE = /(^|\s):([a-z0-9_+'-]{2,})$/;

function emojiCandidates(prefix) {
  const out = [];
  for (const name of Object.keys(EMOJI)) {
    if (name.startsWith(prefix)) out.push({ name, ch: EMOJI[name] });
    if (out.length >= 8) return out;
  }
  for (const name of Object.keys(state.customEmojis)) {
    if (name.startsWith(prefix)) out.push({ name, id: state.customEmojis[name] });
    if (out.length >= 8) break;
  }
  return out;
}

function updateEmojiPopup() {
  const upToCaret = composerInput.value.slice(0, composerInput.selectionStart);
  const m = upToCaret.match(EMOJI_PREFIX_RE);
  emojiCands = m ? emojiCandidates(m[2]) : [];
  emojiSel = 0;
  renderEmojiPopup();
}

function renderEmojiPopup() {
  emojiPopup.innerHTML = "";
  emojiPopup.classList.toggle("hidden", emojiCands.length === 0);
  emojiCands.forEach((c, i) => {
    const row = emojiRowEl(c, i === emojiSel);
    row.addEventListener("mousedown", (e) => { e.preventDefault(); applyEmoji(c); });
    emojiPopup.appendChild(row);
  });
}

function hideEmojiPopup() {
  emojiCands = [];
  emojiPopup.classList.add("hidden");
}

// Returns true when the key was consumed by the popup.
function handleEmojiPopupKey(e) {
  if (!emojiCands.length) return false;
  if (e.key === "ArrowDown") {
    emojiSel = (emojiSel + 1) % emojiCands.length;
  } else if (e.key === "ArrowUp") {
    emojiSel = (emojiSel + emojiCands.length - 1) % emojiCands.length;
  } else if (e.key === "Enter" || e.key === "Tab") {
    applyEmoji(emojiCands[emojiSel]);
  } else if (e.key === "Escape") {
    hideEmojiPopup();
  } else {
    return false; // regular typing — let it through (input handler re-filters)
  }
  e.preventDefault();
  renderEmojiPopup();
  return true;
}

function applyEmoji(cand) {
  const pos = composerInput.selectionStart;
  const before = composerInput.value.slice(0, pos);
  const after = composerInput.value.slice(pos);
  const m = before.match(EMOJI_PREFIX_RE);
  if (!m) { hideEmojiPopup(); return; }
  const start = before.length - m[2].length - 1; // strip ":prefix"
  // Unicode -> insert the character itself; custom -> keep the :name: code.
  const insert = cand.ch ? cand.ch + " " : `:${cand.name}: `;
  histPush(); // one Ctrl+Z restores the typed ":prefix" (#18)
  composerInput.value = before.slice(0, start) + insert + after;
  const caret = start + insert.length;
  composerInput.setSelectionRange(caret, caret);
  histSettle();
  hideEmojiPopup();
  composerInput.focus();
  autoResize();
}

// ---------- @mention autocomplete (#21) ----------
// Mirrors the emoji autocomplete above, GitHub-style: typing "@al" lists known
// users; ArrowUp/Down + Enter/Tab/click inserts "@username ". Candidates come
// from state.users (filled by get_users_by_ids / search_users bookkeeping) and
// match the prefix against the username OR first/last/nick name — insertion
// always uses the username. The two autocompletes key on disjoint tokens
// (":" vs "@"), so at most one popup ever has candidates.
const MENTION_PREFIX_RE = /(^|\s)@([a-z0-9._-]{1,})$/i;
const MENTION_MAX = 8;

const mentionPopup = document.createElement("div");
mentionPopup.className = "mention-popup hidden";
composer.appendChild(mentionPopup);
let mentionCands = [];
let mentionSel = 0;

function mentionCandidates(prefix) {
  const p = prefix.toLowerCase();
  const byUsername = [];
  const byName = [];
  const seen = new Set();
  for (const u of Object.values(state.users)) {
    if (!u || !u.username || seen.has(u.username)) continue;
    if (state.me && u.id === state.me.id) continue; // mentioning myself is noise
    seen.add(u.username);
    const rec = { username: u.username, name: realName(u) };
    if (u.username.toLowerCase().startsWith(p)) byUsername.push(rec);
    else if (
      (u.first_name || "").toLowerCase().startsWith(p)
      || (u.last_name || "").toLowerCase().startsWith(p)
      || (u.nickname || "").toLowerCase().startsWith(p)
    ) byName.push(rec);
  }
  return byUsername.concat(byName).slice(0, MENTION_MAX);
}

function updateMentionPopup() {
  const upToCaret = composerInput.value.slice(0, composerInput.selectionStart);
  const m = upToCaret.match(MENTION_PREFIX_RE);
  mentionCands = m ? mentionCandidates(m[2]) : [];
  mentionSel = 0;
  renderMentionPopup();
}

function mentionRowEl(u, selected) {
  const row = document.createElement("div");
  row.className = "mention-row" + (selected ? " sel" : "");
  const un = document.createElement("span");
  un.className = "un";
  un.textContent = "@" + u.username;
  row.appendChild(un);
  if (u.name && u.name !== u.username) {
    const rn = document.createElement("span");
    rn.className = "rn";
    rn.textContent = u.name;
    row.appendChild(rn);
  }
  return row;
}

function renderMentionPopup() {
  mentionPopup.innerHTML = "";
  mentionPopup.classList.toggle("hidden", mentionCands.length === 0);
  mentionCands.forEach((u, i) => {
    const row = mentionRowEl(u, i === mentionSel);
    // mousedown, not click: the composer must not lose the caret first.
    row.addEventListener("mousedown", (e) => { e.preventDefault(); applyMention(u); });
    mentionPopup.appendChild(row);
  });
}

function hideMentionPopup() {
  mentionCands = [];
  mentionPopup.classList.add("hidden");
}

// Returns true when the key was consumed by the popup.
function handleMentionPopupKey(e) {
  if (!mentionCands.length) return false;
  if (e.key === "ArrowDown") {
    mentionSel = (mentionSel + 1) % mentionCands.length;
  } else if (e.key === "ArrowUp") {
    mentionSel = (mentionSel + mentionCands.length - 1) % mentionCands.length;
  } else if (e.key === "Enter" || e.key === "Tab") {
    applyMention(mentionCands[mentionSel]);
  } else if (e.key === "Escape") {
    hideMentionPopup();
  } else {
    return false; // regular typing — let it through (input handler re-filters)
  }
  e.preventDefault();
  renderMentionPopup();
  return true;
}

function applyMention(u) {
  const pos = composerInput.selectionStart;
  const before = composerInput.value.slice(0, pos);
  const after = composerInput.value.slice(pos);
  const m = before.match(MENTION_PREFIX_RE);
  if (!m) { hideMentionPopup(); return; }
  const start = before.length - m[2].length - 1; // strip "@prefix"
  const insert = "@" + u.username + " "; // trailing space: keep typing right away
  histPush(); // one Ctrl+Z restores the typed "@prefix" (#18)
  composerInput.value = before.slice(0, start) + insert + after;
  const caret = start + insert.length;
  composerInput.setSelectionRange(caret, caret);
  histSettle();
  hideMentionPopup();
  composerInput.focus();
  autoResize();
}

// ---------- emoji picker (composer) ----------
// The ":na…" autocomplete above only helps when you already know the name.
// This is the browse-and-search half: the 😊 button opens a grid of every
// shortcode we know — the server's custom emoji first, since those are the
// ones you cannot type from a keyboard — and clicking one inserts it.
const EMOJI_PICKER_MAX = 400; // a big server emoji set should not build 5000 nodes

const emojiBtn = $("emoji-btn");
const emojiPicker = document.createElement("div");
emojiPicker.className = "emoji-picker hidden";
const emojiPickerInput = document.createElement("input");
emojiPickerInput.placeholder = "Search emoji…";
const emojiPickerGrid = document.createElement("div");
emojiPickerGrid.className = "emoji-grid";
emojiPicker.appendChild(emojiPickerInput);
emojiPicker.appendChild(emojiPickerGrid);
composer.appendChild(emojiPicker);

// Name matches, prefix hits before substring hits ("smile" lists :smile:
// before :big_smile:). Unlike emojiCandidates this matches anywhere in the
// name, because when browsing you rarely know how a code starts.
function emojiSearch(q) {
  const all = [
    ...Object.keys(state.customEmojis).map((name) => ({ name, id: state.customEmojis[name] })),
    ...Object.keys(EMOJI).map((name) => ({ name, ch: EMOJI[name] })),
  ];
  if (!q) return all.slice(0, EMOJI_PICKER_MAX);
  const starts = [];
  const contains = [];
  for (const c of all) {
    if (c.name.startsWith(q)) starts.push(c);
    else if (c.name.includes(q)) contains.push(c);
  }
  return starts.concat(contains).slice(0, EMOJI_PICKER_MAX);
}

function renderEmojiPicker() {
  const q = emojiPickerInput.value.trim().toLowerCase();
  emojiPickerGrid.innerHTML = "";
  const found = emojiSearch(q);
  if (!found.length) {
    const none = document.createElement("div");
    none.className = "emoji-grid-empty";
    none.textContent = "No emoji matches that.";
    emojiPickerGrid.appendChild(none);
    return;
  }
  for (const c of found) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "emoji-cell";
    cell.title = `:${c.name}:`;
    if (c.ch) {
      cell.textContent = c.ch;
    } else {
      const img = document.createElement("img");
      img.className = "emoji";
      img.dataset.emojiId = c.id;
      if (state.emojiImages[c.id]) img.src = state.emojiImages[c.id];
      else ensureEmojiImage(c.id); // fills in via the data-emoji-id sweep
      cell.appendChild(img);
    }
    // mousedown, not click: the composer must not lose the caret first.
    cell.addEventListener("mousedown", (e) => {
      e.preventDefault();
      insertEmoji(c);
    });
    emojiPickerGrid.appendChild(cell);
  }
}

// Unicode goes in as the character; a custom emoji has to stay a :code: for
// the server to resolve it — same split as the autocomplete's applyEmoji.
function insertEmoji(c) {
  const insert = c.ch ? c.ch : `:${c.name}:`;
  const pos = composerInput.selectionStart ?? composerInput.value.length;
  const before = composerInput.value.slice(0, pos);
  const after = composerInput.value.slice(pos);
  histPush(); // picker inserts participate in composer undo (#18), one step each
  composerInput.value = before + insert + after;
  const caret = pos + insert.length;
  composerInput.setSelectionRange(caret, caret);
  histSettle();
  autoResize();
  // Focus stays in the picker so several emoji can be picked in a row; Escape
  // or a click outside hands it back to the composer.
}

function openEmojiPicker() {
  emojiPickerInput.value = "";
  renderEmojiPicker();
  emojiPicker.classList.remove("hidden");
  emojiPickerInput.focus();
}

function closeEmojiPicker(focusComposer) {
  if (emojiPicker.classList.contains("hidden")) return;
  emojiPicker.classList.add("hidden");
  if (focusComposer) composerInput.focus();
}

emojiBtn.addEventListener("click", () => {
  if (emojiPicker.classList.contains("hidden")) {
    closeGifPicker(false); // the two panels share the same corner
    openEmojiPicker();
  } else {
    closeEmojiPicker(true);
  }
});
emojiPickerInput.addEventListener("input", renderEmojiPicker);
emojiPickerInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation(); // don't also close a modal underneath
    closeEmojiPicker(true);
  }
});
document.addEventListener("mousedown", (e) => {
  if (!emojiPicker.contains(e.target) && e.target !== emojiBtn) closeEmojiPicker(false);
});

// ---------- GIF picker (composer) ----------
// Giphy search, keyed by whatever you pasted into Settings — no API key ships
// with the app, and the picker says so until one is set. The webview calls
// api.giphy.com directly (their API answers with `access-control-allow-origin:
// *`); nothing is proxied through the Rust side, so Giphy sees your IP.
// A chosen GIF is downloaded here and queued like any other attachment, so it
// lands in Mattermost as a real uploaded file rather than a hotlink.
const GIF_LIMIT = 24;
const GIF_SEARCH_DEBOUNCE = 300;

const gifBtn = $("gif-btn");
const gifPicker = document.createElement("div");
gifPicker.className = "gif-picker hidden";
const gifInput = document.createElement("input");
gifInput.placeholder = "Search GIFs…";
const gifGrid = document.createElement("div");
gifGrid.className = "gif-grid";
const gifNote = document.createElement("div");
gifNote.className = "gif-note";
gifPicker.appendChild(gifInput);
gifPicker.appendChild(gifGrid);
gifPicker.appendChild(gifNote);
composer.appendChild(gifPicker);

let gifTimer = null;
let gifReqId = 0; // only the newest search may paint (typing races otherwise)

function gifNoteText(text) {
  gifNote.textContent = text;
}

// One Giphy endpoint call. `trending` when there is nothing to search for.
async function giphyFetch(path, params) {
  const qs = new URLSearchParams({
    api_key: settings.giphyKey,
    limit: String(GIF_LIMIT),
    rating: "g",
    ...params,
  });
  const res = await fetch(`https://api.giphy.com/v1/gifs/${path}?${qs}`);
  if (res.status === 401 || res.status === 403) throw new Error("Giphy rejected the key — check it in Settings.");
  if (!res.ok) throw new Error(`Giphy request failed (${res.status}).`);
  const body = await res.json();
  return Array.isArray(body.data) ? body.data : [];
}

// Giphy hands back a bundle of renditions; take the smallest sane one for the
// grid and a middleweight one for the actual upload (an "original" can be tens
// of megabytes). Anything not https is ignored rather than put into an <img>.
function gifUrl(g, keys) {
  const images = (g && g.images) || {};
  for (const k of keys) {
    const url = images[k] && images[k].url;
    if (typeof url === "string" && url.startsWith("https://")) return url;
  }
  return null;
}

async function renderGifs() {
  const q = gifInput.value.trim();
  if (!settings.giphyKey) {
    gifGrid.innerHTML = "";
    gifNoteText("Add a Giphy API key in Settings (⚙) to search GIFs.");
    return;
  }
  const mine = ++gifReqId;
  gifNoteText("Searching…");
  try {
    const results = q ? await giphyFetch("search", { q }) : await giphyFetch("trending", {});
    if (mine !== gifReqId) return; // a newer search already won
    gifGrid.innerHTML = "";
    for (const g of results) {
      const thumb = gifUrl(g, ["fixed_width_small", "preview_gif", "fixed_width"]);
      if (!thumb) continue;
      const img = document.createElement("img");
      img.className = "gif-cell";
      img.src = thumb;
      img.loading = "lazy";
      img.alt = g.title || "GIF";
      img.title = g.title || "GIF";
      img.addEventListener("click", () => attachGif(g));
      gifGrid.appendChild(img);
    }
    gifNoteText(gifGrid.childElementCount ? "Powered by GIPHY" : "Nothing found.");
  } catch (e) {
    if (mine !== gifReqId) return;
    gifGrid.innerHTML = "";
    gifNoteText(String(e.message || e));
  }
}

// Download the chosen GIF and queue it with the other pending attachments, so
// the existing send path uploads it and a caption can still be typed.
async function attachGif(g) {
  const url = gifUrl(g, ["downsized_medium", "fixed_height", "original"]);
  if (!url) return;
  gifNoteText("Fetching GIF…");
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const blob = await res.blob();
    pendingFiles.push(new File([blob], `giphy-${g.id || "gif"}.gif`, { type: blob.type || "image/gif" }));
    renderPendingFiles();
    closeGifPicker(true);
  } catch (e) {
    gifNoteText("Could not fetch that GIF: " + (e.message || e));
  }
}

function openGifPicker() {
  gifInput.value = "";
  gifPicker.classList.remove("hidden");
  gifInput.focus();
  renderGifs();
}

function closeGifPicker(focusComposer) {
  if (gifPicker.classList.contains("hidden")) return;
  gifPicker.classList.add("hidden");
  gifReqId++; // abandon any in-flight search
  if (focusComposer) composerInput.focus();
}

gifBtn.addEventListener("click", () => {
  if (gifPicker.classList.contains("hidden")) {
    closeEmojiPicker(false); // the two panels share the same corner
    openGifPicker();
  } else {
    closeGifPicker(true);
  }
});
gifInput.addEventListener("input", () => {
  clearTimeout(gifTimer);
  gifTimer = setTimeout(renderGifs, GIF_SEARCH_DEBOUNCE); // don't call Giphy per keystroke
});
gifInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeGifPicker(true);
  }
});
document.addEventListener("mousedown", (e) => {
  if (!gifPicker.contains(e.target) && e.target !== gifBtn) closeGifPicker(false);
});

// Scroll near the top of the message pane → pull in older history.
messagesEl.addEventListener("scroll", () => {
  if (messagesEl.scrollTop < 80) loadOlder();
});

// Coming back to the window means reading the open conversation. Also a cheap
// moment to catch an OS theme flip the change event didn't deliver.
window.addEventListener("focus", () => {
  onSchemeChange();
  if (!state.activeId) return;
  markViewed(state.activeId);
  renderSidebar();
});

// ---------- outgoing attachments ----------
const attachBtn = $("attach-btn");
const fileInput = $("file-input");
const pendingFilesEl = $("pending-files");
const pendingFiles = []; // File objects queued for the next send
const sendBtn = $("send-btn");

attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  for (const f of fileInput.files) pendingFiles.push(f);
  fileInput.value = ""; // allow re-picking the same file later
  renderPendingFiles();
});

// Paste images/files anywhere in the window → queue them as attachments for
// the open conversation (like the native client). Text pastes pass through.
// Document-level so this also works when the composer isn't focused, and with
// a files fallback for webviews that don't expose pasted images via items.
// WebKitGTK (Linux) fires paste with a completely EMPTY DataTransfer — in that
// case the clipboard image is read directly from the OS via the
// clipboard-manager plugin (see queueClipboardImage). Same remedy (#20
// follow-up) when the transfer is NOT empty but textually useless: copying an
// image in Firefox fills the clipboard with a text/html flavor (an <img>
// fragment) beside the pixels — that item blocks the empty-transfer branch
// and natively inserts "" into the composer. The rule: if the text the
// clipboard would insert is empty, try the OS clipboard for an image.
document.addEventListener("paste", (e) => {
  if (!state.activeId) return;
  const cd = e.clipboardData;
  let got = false;
  if (cd) {
    for (const it of Array.from(cd.items || [])) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) { pendingFiles.push(f); got = true; }
      }
    }
    if (!got && cd.files && cd.files.length) {
      for (const f of Array.from(cd.files)) { pendingFiles.push(f); got = true; }
    }
  }
  if (got) {
    e.preventDefault();
    renderPendingFiles();
    composerInput.focus();
    return;
  }
  const plain = cd && cd.getData ? cd.getData("text/plain") : "";
  if (cd && cd.items && cd.items.length && plain && plain.trim()) return; // real text → native insert
  queueClipboardImage();
});

// Reads an image straight from the OS clipboard (bypasses the webview, which
// hides clipboard contents from us) and queues it as a PNG attachment.
async function queueClipboardImage() {
  try {
    const cm = window.__TAURI__ && window.__TAURI__.clipboardManager;
    if (!cm || !cm.readImage) return;
    const img = await cm.readImage();
    const { width, height } = await img.size();
    if (!width || !height) return;
    const rgba = new Uint8ClampedArray(await img.rgba());
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) return;
    pendingFiles.push(new File([blob], `pasted-${Date.now()}.png`, { type: "image/png" }));
    renderPendingFiles();
    composerInput.focus();
  } catch (e) {
    // No image on the clipboard (e.g. a text paste) — the plugin throws.
    console.warn("[paste] no clipboard image:", e);
  }
}

function renderPendingFiles(errorText) {
  pendingFilesEl.innerHTML = "";
  pendingFilesEl.classList.toggle("hidden", pendingFiles.length === 0 && !errorText);
  pendingFiles.forEach((f, idx) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    const label = document.createElement("span");
    label.textContent = `📎 ${f.name || "image"} · ${formatSize(f.size)}`;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "✕";
    x.addEventListener("click", () => {
      pendingFiles.splice(idx, 1);
      renderPendingFiles();
    });
    chip.appendChild(label);
    chip.appendChild(x);
    pendingFilesEl.appendChild(chip);
  });
  if (errorText) {
    const err = document.createElement("div");
    err.className = "pending-error";
    err.textContent = errorText;
    pendingFilesEl.appendChild(err);
  }
}

// Drag & drop files onto the conversation to attach them. NOTE: needs
// "dragDropEnabled": false on the window in tauri.conf.json — with Tauri's
// own drag-drop handling on (the default), these HTML5 events never fire.
let dragDepth = 0; // enter/leave fire per child element; count to know when we're really out

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault()); // never let the webview navigate to a dropped file

chatPanel.addEventListener("dragenter", (e) => {
  if (!state.activeId) return;
  const types = e.dataTransfer ? Array.from(e.dataTransfer.types) : [];
  if (!types.includes("Files")) return;
  dragDepth++;
  chatPanel.classList.add("drag-over");
});
chatPanel.addEventListener("dragleave", () => {
  if (dragDepth > 0 && --dragDepth === 0) chatPanel.classList.remove("drag-over");
});
chatPanel.addEventListener("drop", (e) => {
  dragDepth = 0;
  chatPanel.classList.remove("drag-over");
  if (!state.activeId || !e.dataTransfer) return;
  let got = false;
  for (const f of e.dataTransfer.files) {
    pendingFiles.push(f);
    got = true;
  }
  if (got) renderPendingFiles();
});

// File -> bare base64 (data URL prefix stripped) for the invoke bridge.
function readFileB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] || "");
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsDataURL(file);
  });
}

// After a send triggered by clicking ➤, the button keeps the focus — hand it
// back to the composer so the next message can be typed right away (#17).
// Only then: an Enter-send never left the textarea, and if the user meanwhile
// clicked into another control (e.g. search) we must not yank focus back.
function refocusComposer() {
  if (document.activeElement === sendBtn) composerInput.focus();
}

async function sendCurrent() {
  // Edit mode (right-click one of my bubbles → "✏️ Edit message") reroutes the
  // composer: Enter now saves the edit instead of posting a new message.
  if (state.editing) {
    const { postId, original } = state.editing;
    const newText = composerInput.value.trim();
    if (newText === "") return; // empty is not a delete — stay in edit mode
    if (newText === original) { cancelEdit(); return; } // no change → close quietly
    sendBtn.disabled = true;
    try {
      await invoke("edit_message", { postId, message: newText });
      // Optimistic repaint; the server's own echo arrives as "mm-post-edited"
      // and applies the same (idempotent) update again.
      // NB: attachments can't be edited — any staged pendingFiles stay staged.
      applyEditToBubble(postId, newText);
      cancelEdit();
    } catch (e) {
      if (/not found|unknown|no stub handler|not registered|not a valid command/i.test(String(e))) {
        // Backend built before edit_message: fold the feature away silently.
        state.editMessageEnabled = false;
        cancelEdit();
      } else {
        // A real failure (network, permissions, …): keep edit mode and the text.
        editBarError.textContent = String(e);
        editBarError.classList.remove("hidden");
      }
    } finally {
      sendBtn.disabled = false;
      refocusComposer();
    }
    return;
  }

  const text = composerInput.value.trim();
  const files = pendingFiles.slice();
  if ((!text && !files.length) || !state.activeId) return;
  const channelId = state.activeId;
  composerInput.value = "";
  autoResize();
  histReset(); // a sent draft must never come back through undo (#18)
  sendBtn.disabled = true;
  try {
    // Slash command: "/away", "/shrug lol", … → execute, don't post as text.
    if (text.startsWith("/") && files.length === 0) {
      const ch = state.channels.find((c) => c.id === channelId);
      const teamId = (ch && ch.team_id) || Object.keys(state.teams)[0] || "";
      try {
        const res = await invoke("execute_command", { channelId, teamId, command: text });
        // Ephemeral responses (visible only to me) come back directly.
        if (res && res.text) ephemeralBubble(res.text);
      } catch (e) {
        console.warn("execute_command unavailable — sent as plain message. Is it in generate_handler!?", e);
        await invoke("send_message", { channelId, message: text });
      }
      return;
    }

    const fileIds = [];
    for (const f of files) {
      const b64 = await readFileB64(f);
      const id = await invoke("upload_file", { channelId, filename: f.name || "image.png", dataB64: b64 });
      if (id) fileIds.push(id);
    }
    const args = { channelId, message: text };
    if (fileIds.length) args.fileIds = fileIds;
    await invoke("send_message", args);
    // The message echoes back via the "mm-post" event and is appended there,
    // so we don't render it manually here.
    pendingFiles.length = 0;
    renderPendingFiles();
  } catch (e) {
    console.error("send failed", e);
    // put the text back and keep the files so nothing is lost
    composerInput.value = text;
    autoResize();
    histReset(); // the rescued draft is the fresh base — no undo into the void
    renderPendingFiles("Sending failed: " + e);
  } finally {
    sendBtn.disabled = false;
    refocusComposer();
  }
}

// Server reply to a slash command that only I should see.
function ephemeralBubble(text) {
  const wrap = document.createElement("div");
  wrap.className = "ephemeral";
  const body = document.createElement("div");
  body.className = "ephemeral-body";
  body.appendChild(renderMarkdown(text));
  const tag = document.createElement("div");
  tag.className = "ephemeral-tag";
  tag.textContent = "Only visible to you";
  wrap.appendChild(body);
  wrap.appendChild(tag);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

// max-height normally lives in CSS; JS mirrors it inline so a user floor
// taller than COMPOSER_AUTO_CAP can win, and the floor itself keeps the box
// open to the dragged size even while empty. floor 0 = the classic behavior.
function autoResize() {
  composerInput.style.maxHeight = composerCap() + "px";
  composerInput.style.height = "auto";
  composerInput.style.height = Math.max(Math.min(composerInput.scrollHeight, composerCap()), panes.composer) + "px";
}

// ================= MESSAGE EDITING =================
// WhatsApp-style editing of my own messages: right-click a bubble → "✏️ Edit
// message" arms edit mode — the bar above the composer shows the original
// text, the composer holds it for editing, Enter/✔ saves (PUT via the
// backend's edit_message) and ✕ / Esc / switching channel cancels. History
// bubbles with edit_at > 0 and freshly edited ones carry an "edited" tag on
// their meta line. Degrades silently when the backend lacks edit_message.

// Right-click menu on a message bubble. Mirrors channelMenu: JS-created,
// cursor-positioned, dismissed by any outside mousedown (see the closer above).
const msgMenu = document.createElement("div");
msgMenu.className = "context-menu hidden";
document.body.appendChild(msgMenu);

function openMsgMenu(x, y, postId, original) {
  msgMenu.innerHTML = "";
  const row = document.createElement("div");
  row.className = "context-menu-row";
  row.textContent = "✏️  Edit message";
  row.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startEdit({ postId, original });
    closeMsgMenu();
  });
  msgMenu.appendChild(row);

  closeChannelMenu(); // one floating menu at a time
  msgMenu.classList.remove("hidden");
  const r = msgMenu.getBoundingClientRect(); // measurable now that it is shown
  msgMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
  msgMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
}

function closeMsgMenu() {
  msgMenu.classList.add("hidden");
}

// The bar shown right above the composer while an edit is armed.
const editBar = document.createElement("div");
editBar.className = "edit-bar hidden";
const editBarText = document.createElement("div");
editBarText.className = "edit-bar-text";
const editBarTitle = document.createElement("div");
editBarTitle.className = "edit-bar-title";
editBarTitle.textContent = "Edit message";
const editBarPreview = document.createElement("div");
editBarPreview.className = "edit-bar-preview";
editBarText.appendChild(editBarTitle);
editBarText.appendChild(editBarPreview);
const editBarCancel = document.createElement("button");
editBarCancel.type = "button";
editBarCancel.className = "edit-bar-cancel";
editBarCancel.title = "Cancel";
editBarCancel.textContent = "✕";
editBarCancel.addEventListener("click", cancelEdit);
const editBarError = document.createElement("div");
editBarError.className = "edit-bar-error hidden";
editBar.appendChild(editBarText);
editBar.appendChild(editBarCancel);
editBar.appendChild(editBarError);
composer.parentNode.insertBefore(editBar, composer); // sits right above the composer

function startEdit({ postId, original }) {
  state.editing = { postId, original };
  editBarPreview.textContent = original;
  editBarError.textContent = "";
  editBarError.classList.add("hidden");
  editBar.classList.remove("hidden");
  composerInput.value = original;
  autoResize();
  composerInput.focus();
  composerInput.setSelectionRange(original.length, original.length);
  histReset(); // the edit draft is a fresh base — undo stays inside it (#18)
  sendBtn.textContent = "✔";
  sendBtn.title = "Save edit";
}

function cancelEdit() {
  if (!state.editing) return; // nothing armed — leave the composer alone
  state.editing = null;
  editBar.classList.add("hidden");
  editBarError.textContent = "";
  editBarError.classList.add("hidden");
  composerInput.value = "";
  autoResize();
  histReset(); // leave no undo trail from the edit into the next draft
  sendBtn.textContent = "➤";
  sendBtn.title = "Send";
}

// The small "edited" tag on a bubble's meta line.
function editedMarkerEl() {
  const tag = document.createElement("span");
  tag.className = "msg-edited";
  tag.textContent = "edited";
  return tag;
}

// Stamps the "edited" tag onto a rendered bubble; idempotent (the server
// echoes our own edits back over the websocket). Tags BOTH time reads — the
// meta line (ungrouped look) and the corner stamp (grouped look, #16).
function markEdited(postId) {
  const row = messagesEl.querySelector(`.msg-row[data-post-id="${CSS.escape(postId)}"]`);
  if (!row) return false;
  const meta = row.querySelector(".msg .msg-meta"); // bubbles always render a meta line; guard anyway
  if (meta && !meta.querySelector(".msg-edited")) meta.appendChild(editedMarkerEl());
  // The stamp leads with its marker ("edited · 12:34"), the meta trails with it.
  const stamp = row.querySelector(".msg .msg-stamp");
  if (stamp && !stamp.querySelector(".msg-edited")) stamp.insertBefore(editedMarkerEl(), stamp.firstChild);
  return true;
}

// Rewrites a rendered bubble's text in place (my own save + live mm-post-edited).
function applyEditToBubble(postId, text) {
  const row = messagesEl.querySelector(`.msg-row[data-post-id="${CSS.escape(postId)}"]`);
  if (!row) return false;
  const msg = row.querySelector(".msg");
  if (!msg) return false;
  let body = msg.querySelector(".msg-body");
  if (!body && text) {
    // A body-less bubble (attachment-only) gaining text: build the body
    // directly after the meta line. In a real browser `childNodes` is a
    // NodeList with no .indexOf — copy to an Array first.
    body = document.createElement("div");
    body.className = "msg-body";
    const meta = msg.querySelector(".msg-meta");
    const kids = Array.from(msg.childNodes);
    const i = meta ? kids.indexOf(meta) + 1 : 0;
    msg.insertBefore(body, kids[i] || null);
  }
  if (body) {
    body.innerHTML = ""; // clear only — never assigns markup
    body.appendChild(renderMarkdown(text)); // DOM nodes only, same as a fresh render
  }
  markEdited(postId);
  return true;
}

// A message was edited (by me elsewhere, or by its author) — repaint in place.
function onPostEdited(event) {
  const p = event.payload; // { id, channel_id, message, edit_at }
  if (!p || p.channel_id !== state.activeId) return;
  applyEditToBubble(p.id, p.message || "");
}

// ================= NEW CONVERSATION MODAL =================
const newBtn = $("new-btn");
const modalOverlay = $("modal-overlay");
const modalClose = $("modal-close");
const segChat = $("seg-chat");
const segChannel = $("seg-channel");
const modeChat = $("mode-chat");
const modeChannel = $("mode-channel");
const chatChips = $("chat-chips");
const peopleSearch = $("people-search");
const peopleResults = $("people-results");
const chatError = $("chat-error");
const chatCreate = $("chat-create");
const channelTeam = $("channel-team");
const channelName = $("channel-name");
const channelError = $("channel-error");
const channelCreate = $("channel-create");

const picked = new Map(); // user_id -> user object (people chosen for a new chat)
let lastResults = []; // most recent search results (to re-render on pick)
let searchTimer = null;

newBtn.addEventListener("click", openModal);
modalClose.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });
segChat.addEventListener("click", () => switchMode("chat"));
segChannel.addEventListener("click", () => switchMode("channel"));

function openModal() {
  picked.clear();
  lastResults = [];
  peopleSearch.value = "";
  peopleResults.innerHTML = "";
  chatError.textContent = "";
  channelError.textContent = "";
  channelName.value = "";
  renderChips();
  updateChatCreate();
  populateTeams();
  switchMode("chat");
  modalOverlay.classList.remove("hidden");
  peopleSearch.focus();
}

function closeModal() {
  modalOverlay.classList.add("hidden");
}

function switchMode(mode) {
  const chat = mode === "chat";
  segChat.classList.toggle("active", chat);
  segChannel.classList.toggle("active", !chat);
  modeChat.classList.toggle("hidden", !chat);
  modeChannel.classList.toggle("hidden", chat);
}

// ---- chat mode: people picker ----
peopleSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const term = peopleSearch.value.trim();
  if (term.length < 2) { peopleResults.innerHTML = ""; lastResults = []; return; }
  searchTimer = setTimeout(() => doSearch(term), 220);
});

async function doSearch(term) {
  try {
    const users = await invoke("search_users", { term });
    lastResults = (users || []).filter((u) => u && u.id && u.id !== state.me?.id);
    for (const u of lastResults) rememberUser(u);
    renderPeople();
    chatError.textContent = "";
  } catch (_) {
    peopleResults.innerHTML = "";
    chatError.textContent = "Backend: the search_users command is missing.";
  }
}

function renderPeople() {
  peopleResults.innerHTML = "";
  for (const u of lastResults) {
    const row = document.createElement("div");
    row.className = "person-row" + (picked.has(u.id) ? " picked" : "");
    const av = document.createElement("div");
    av.className = "person-avatar";
    decorateAvatar(av, u.id, u.username);
    const main = document.createElement("div");
    main.className = "person-main";
    const nm = document.createElement("div");
    nm.className = "person-name";
    nm.textContent = realName(u);
    const sub = document.createElement("div");
    sub.className = "person-sub";
    sub.textContent = "@" + (u.username || "");
    main.appendChild(nm); main.appendChild(sub);
    row.appendChild(av); row.appendChild(main);
    row.addEventListener("click", () => togglePick(u));
    peopleResults.appendChild(row);
  }
}

function togglePick(u) {
  if (picked.has(u.id)) picked.delete(u.id);
  else picked.set(u.id, u);
  renderChips();
  renderPeople();
  updateChatCreate();
}

function renderChips() {
  chatChips.innerHTML = "";
  for (const [id, u] of picked) {
    const chip = document.createElement("div");
    chip.className = "chip";
    const label = document.createElement("span");
    label.textContent = realName(u);
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "✕";
    x.addEventListener("click", () => { picked.delete(id); renderChips(); renderPeople(); updateChatCreate(); });
    chip.appendChild(label); chip.appendChild(x);
    chatChips.appendChild(chip);
  }
}

function updateChatCreate() {
  chatCreate.disabled = picked.size < 1;
  chatCreate.textContent = picked.size >= 2 ? "Start group" : "Start chat";
}

chatCreate.addEventListener("click", async () => {
  if (picked.size < 1 || !state.me?.id) return;
  const ids = [...new Set([state.me.id, ...picked.keys()])]; // include me
  chatCreate.disabled = true;
  chatError.textContent = "";
  try {
    const ch = await invoke("create_chat", { userIds: ids });
    onChannelCreated(ch);
  } catch (e) {
    chatError.textContent = "Couldn't create the chat: " + e;
    chatCreate.disabled = false;
  }
});

// ---- channel mode: named channel ----
function populateTeams() {
  channelTeam.innerHTML = "";
  const entries = Object.entries(state.teams);
  if (entries.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No teams available";
    opt.value = "";
    channelTeam.appendChild(opt);
  }
  for (const [id, name] of entries) {
    const opt = document.createElement("option");
    opt.value = id; opt.textContent = name;
    channelTeam.appendChild(opt);
  }
  updateChannelCreate();
}

channelName.addEventListener("input", updateChannelCreate);
channelTeam.addEventListener("change", updateChannelCreate);

function updateChannelCreate() {
  channelCreate.disabled = !channelTeam.value || !channelName.value.trim();
}

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

channelCreate.addEventListener("click", async () => {
  const teamId = channelTeam.value;
  const display = channelName.value.trim();
  if (!teamId || !display) return;
  const type = document.querySelector('input[name="ch-type"]:checked')?.value || "O";
  const slug = slugify(display) || "channel";
  channelCreate.disabled = true;
  channelError.textContent = "";
  try {
    const ch = await invoke("create_named_channel", {
      teamId, name: slug, displayName: display, channelType: type,
    });
    onChannelCreated(ch);
  } catch (e) {
    channelError.textContent = "Couldn't create the channel: " + e;
    channelCreate.disabled = false;
  }
});

// Shared: a channel was just created → add it, open it, close the modal.
function onChannelCreated(ch) {
  if (!ch || !ch.id) { chatError.textContent = "Unexpected response from the backend."; return; }
  if (!state.channels.find((c) => c.id === ch.id)) state.channels.push(ch);
  closeModal();
  renderSidebar();
  openChannel(ch.id);
}

// ================= SETTINGS MODAL =================
// Each .option-seg is a segmented control bound to one settings key via
// data-setting / data-value; clicking saves and applies immediately.
const settingsBtn = $("settings-btn");
const settingsOverlay = $("settings-overlay");
const settingsClose = $("settings-close");

function renderSettingsControls() {
  giphyKeyInput.value = settings.giphyKey;
  for (const seg of settingsOverlay.querySelectorAll(".option-seg")) {
    const key = seg.dataset.setting;
    for (const btn of seg.querySelectorAll(".seg-btn")) {
      const active = btn.dataset.value === settings[key];
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    }
  }
}

function openSettings() {
  renderSettingsControls();
  settingsOverlay.classList.remove("hidden");
}
function closeSettings() {
  settingsOverlay.classList.add("hidden");
}

const giphyKeyInput = $("giphy-key");
giphyKeyInput.addEventListener("input", () => {
  settings.giphyKey = giphyKeyInput.value.trim();
  saveSettings();
});

settingsBtn.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

// One delegated listener; the handler resolves which segment was hit.
settingsOverlay.addEventListener("click", (e) => {
  const btn = e.target.closest(".option-seg .seg-btn");
  if (!btn) return;
  const key = btn.closest(".option-seg").dataset.setting;
  if (!hasOwn(SETTINGS_VALUES, key) || !SETTINGS_VALUES[key].includes(btn.dataset.value)) return;
  settings[key] = btn.dataset.value;
  saveSettings();
  applySettings();
  renderSettingsControls();
});

// Escape closes whichever modal is open (the lightbox handles its own).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!channelMenu.classList.contains("hidden")) closeChannelMenu();
  else if (!emojiPicker.classList.contains("hidden")) closeEmojiPicker(true);
  else if (!gifPicker.classList.contains("hidden")) closeGifPicker(true);
  else if (!spaceOverlay.classList.contains("hidden")) closeSpaceModal();
  else if (!settingsOverlay.classList.contains("hidden")) closeSettings();
  else if (!modalOverlay.classList.contains("hidden")) closeModal();
});
