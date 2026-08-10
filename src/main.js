// rustermost — frontend logic.
//
// Talks ONLY to the existing Rust commands (no backend changes required to run):
//   open_sso_window, capture_session, fetch_me, fetch_all_channels,
//   get_posts, send_message, connect_websocket
// plus the "mm-post" event from the WebSocket task.
//
// FORWARD-COMPATIBLE HOOKS (light up automatically when you add the backend bits):
//   1. Channel.last_post_at (i64) — if present on a channel, the sidebar sorts
//      by it (most recent conversation first). Until then it falls back to
//      live activity learned during the session, then to the server's order.
//   2. get_users_by_ids(ids) command — if present, it resolves user_id -> username,
//      which fills in:
//        - the name of 1:1 direct messages (their display_name is empty),
//        - the author label on history bubbles,
//        - searching direct messages by person name.
//      Until then those degrade gracefully (anonymous "Direct message", no author
//      label on history), and the command is probed once and then left alone.
//   3. fetch_all_channels_with_members + view_channel commands — unread badges
//      are seeded from the server's read-state (total_msg_count - member.msg_count)
//      and reads are reported back so other devices clear their badges too.
//      Falls back to fetch_all_channels and session-local badges.
//   4. "mm-viewed" event — once the WS loop forwards channel_viewed, channels
//      read on my other devices clear their badge here live.
//   5. get_file_info / get_file_thumbnail / get_file commands — attachments on
//      posts (Post.file_ids) render as inline images (click = full view) or
//      file chips. Until then attachments show as a plain "📎 attachment" tag.
//   6. upload_file command (+ send_message accepting file_ids) — the 📎 button
//      and pasted images actually send. Until then attaching shows an error
//      chip and the message text is preserved.

const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

const state = {
  baseUrl: "",
  me: null, // { id, username, ... }
  channels: [], // from fetch_all_channels
  activeId: null,
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
  collapsed: {}, // section title -> true when folded
  avatars: {}, // user_id -> data URL (in-memory; the disk cache comes later)
  avatarPending: new Set(), // user_ids currently being fetched
  avatarLookupEnabled: true, // flips off if get_avatar isn't in the backend yet
  pageOldest: null, // id of the oldest post currently shown (paging cursor)
  pageMore: false, // might there be older posts to load?
  pageLoading: false, // a page load is in flight
};

const PAGE_SIZE = 100; // matches the backend's per_page

// ---------- element refs ----------
const $ = (id) => document.getElementById(id);
const loginView = $("login-view");
const appView = $("app-view");
const urlForm = $("url-form");
const urlInput = $("url-input");
const loginStatus = $("login-status");
const meAvatar = $("me-avatar");
const meName = $("me-name");
const searchInput = $("search-input");
const channelList = $("channel-list");
const emptyState = $("empty-state");
const chatPanel = $("chat-panel");
const chatTitle = $("chat-title");
const chatSub = $("chat-sub");
const messagesEl = $("messages");
const composer = $("composer");
const composerInput = $("composer-input");

// ================= PERSISTENCE =================
// The Tauri webview keeps localStorage on disk across restarts, so we remember
// the server URL and the session token here. NOTE: the token is stored in
// plaintext in the app's webview data — fine for a dev tool, but the proper
// version would use the OS keychain (see the roadmap).
// Only the server URL is kept here — it is not sensitive. The token is
// deliberately NOT stored in localStorage (that would be plaintext on disk);
// its secure-storage path is wired in separately.
const URL_KEY = "rustermost.url";
function saveUrl(url) { try { localStorage.setItem(URL_KEY, url); } catch (_) {} }
function loadUrl() { try { return localStorage.getItem(URL_KEY) || ""; } catch (_) { return ""; } }

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

// On startup, prefill the last-used server URL. Secure token restore is added
// on top of this once the storage mechanism is chosen.
function tryRestore() {
  const url = loadUrl();
  if (url) urlInput.value = url;
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
  await listen("mm-viewed", onViewedElsewhere);
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

  // channels + read-state (slow: hits every team twice)
  try {
    state.channels = await loadChannels();
    seedUnread();
    renderSidebar();
    // Try to name the 1:1 DM partners (no-op until get_users_by_ids exists).
    resolveUsers(collectDmPartnerIds()).then(() => renderSidebar());
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

function renderSidebar() {
  const q = (searchInput.value || "").toLowerCase();
  const match = (ch) => searchText(ch).includes(q);

  const unread = state.channels.filter((c) => (state.unread[c.id] || 0) > 0 && match(c));
  const direct = state.channels.filter((c) => c.type === "D" && match(c));
  const groups = state.channels.filter((c) => c.type === "G" && match(c));
  const community = state.channels.filter((c) => (c.type === "O" || c.type === "P") && match(c));

  // Most-recent conversation first (stable when timestamps are equal).
  const byRecency = (a, b) => activityOf(b) - activityOf(a);
  unread.sort(byRecency);
  direct.sort(byRecency);
  groups.sort(byRecency);
  community.sort(byRecency);

  const searching = q.length > 0;
  channelList.innerHTML = "";
  // Pinned on top, only while something is actually unread; conversations
  // stay in their own section below as well.
  if (unread.length) channelList.appendChild(sectionEl("Unread", unread, searching));
  channelList.appendChild(sectionEl("Direct messages", direct, searching));
  channelList.appendChild(sectionEl("Groups", groups, searching));
  channelList.appendChild(sectionEl("Community", community, searching));
}

// While searching, sections are forced open so matches are never hidden.
function sectionEl(title, items, forceOpen) {
  const collapsed = !forceOpen && !!state.collapsed[title];

  const wrap = document.createElement("div");
  wrap.className = "section";

  const h = document.createElement("div");
  h.className = "section-title";
  const chev = document.createElement("span");
  chev.className = "chevron";
  chev.textContent = collapsed ? "▸" : "▾"; // ▸ / ▾
  const label = document.createElement("span");
  label.textContent = `${title} · ${items.length}`;
  h.appendChild(chev);
  h.appendChild(label);
  h.addEventListener("click", () => {
    state.collapsed[title] = !state.collapsed[title];
    renderSidebar();
  });
  wrap.appendChild(h);

  if (collapsed) return wrap;

  if (items.length === 0) {
    const e = document.createElement("div");
    e.className = "list-empty";
    e.textContent = "Nothing here.";
    wrap.appendChild(e);
  }
  for (const ch of items) wrap.appendChild(channelItemEl(ch));
  return wrap;
}

function channelItemEl(ch) {
  const name = displayName(ch);
  const dm = ch.type === "D" || ch.type === "G";
  const row = document.createElement("div");
  row.className = "channel-item" + (ch.id === state.activeId ? " active" : "");
  row.addEventListener("click", () => openChannel(ch.id));

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
  if (unread > 0) {
    const b = document.createElement("div");
    b.className = "badge";
    b.textContent = unread > 99 ? "99+" : String(unread);
    row.appendChild(b);
  }
  return row;
}

// ================= CONVERSATION =================
async function openChannel(id) {
  state.activeId = id;
  markViewed(id); // clears the badge locally, reports the read to the server
  renderSidebar();

  const ch = state.channels.find((c) => c.id === id);
  emptyState.classList.add("hidden");
  chatPanel.classList.remove("hidden");
  chatTitle.textContent = displayName(ch);
  chatSub.textContent = subLabel(ch);
  messagesEl.innerHTML = '<div class="loading">Loading messages…</div>';

  // reset paging for the newly opened conversation
  state.pageLoading = false;
  state.pageOldest = null;
  state.pageMore = false;

  try {
    const posts = await invoke("get_posts", { channelId: id });
    if (state.activeId !== id) return; // user switched away while loading
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
    messagesEl.innerHTML = '<div class="error">Failed to load messages.</div>';
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
    const frag = document.createDocumentFragment();
    for (const p of older) {
      const mine = state.me && p.user_id === state.me.id;
      const sender = mine ? null : realName(state.users[p.user_id]);
      frag.appendChild(bubbleEl({ mine, uid: p.user_id, sender, text: p.message, ts: p.create_at, files: p.file_ids }));
    }
    messagesEl.insertBefore(frag, messagesEl.firstChild);
    messagesEl.scrollTop += messagesEl.scrollHeight - prevH; // keep the view steady

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
  for (const p of posts) {
    const mine = state.me && p.user_id === state.me.id;
    const sender = mine ? null : realName(state.users[p.user_id]); // named once resolvable
    messagesEl.appendChild(
      bubbleEl({ mine, uid: p.user_id, sender, text: p.message, ts: p.create_at, files: p.file_ids })
    );
  }
  scrollToBottom();
}

// A round avatar for a user. Starts as a colored initial, then swaps to the
// real image once get_avatar resolves. Every avatar for the same user carries
// a data-uid so we can fill them all in when the image arrives.
function paintAvatar(el, dataUrl) {
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
    const dataUrl = await invoke("get_avatar", { userId: uid });
    if (dataUrl) {
      state.avatars[uid] = dataUrl;
      for (const el of document.querySelectorAll(`[data-uid="${uid}"]`)) paintAvatar(el, dataUrl);
    }
  } catch (_) {
    state.avatarLookupEnabled = false; // command not registered yet
  } finally {
    state.avatarPending.delete(uid);
  }
}

// ---------- markdown ----------
// Minimal chat-flavored markdown, rendered by BUILDING DOM NODES — message
// content never goes through innerHTML, so it can't inject markup. Supported:
// [label](url), bare http(s) URLs, **bold**, *italic*/_italic_, ~~strike~~,
// `code`, ``` fenced blocks ```, > quotes, -/*/1. lists. Everything else is
// plain text.

// Open in the system browser via the opener plugin; never navigate the webview.
async function openExternal(url) {
  try {
    await window.__TAURI__.opener.openUrl(url);
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
  return a;
}

// Inline spans: code / bold / strike / italic / [label](url) / bare url.
function inlineMd(target, text, depth = 0) {
  if (!text) return;
  if (depth > 2) { target.appendChild(document.createTextNode(text)); return; }
  const re = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(~~([^~]+)~~)|(\*([^*\s][^*]*?)\*)|(\b_([^_\s][^_]*?)_\b)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>]+)/g;
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
    }
    last = re.lastIndex;
  }
  if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
}

const FENCE_RE = /^\s*```/;
const QUOTE_RE = /^>\s?/;
const UL_RE = /^\s*[-*]\s+/;
const OL_RE = /^\s*\d+\.\s+/;
const startsBlock = (line) => FENCE_RE.test(line) || QUOTE_RE.test(line) || UL_RE.test(line) || OL_RE.test(line);

function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text || "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (FENCE_RE.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence (or end of message)
      const pre = document.createElement("pre");
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

    if (UL_RE.test(line) || OL_RE.test(line)) {
      const itemRe = OL_RE.test(line) ? OL_RE : UL_RE;
      const list = document.createElement(itemRe === OL_RE ? "ol" : "ul");
      while (i < lines.length && itemRe.test(lines[i])) {
        const li = document.createElement("li");
        inlineMd(li, lines[i].replace(itemRe, ""));
        list.appendChild(li);
        i++;
      }
      frag.appendChild(list);
      continue;
    }

    inlineMd(frag, line);
    i++;
    if (i < lines.length && !startsBlock(lines[i])) frag.appendChild(document.createElement("br"));
  }
  return frag;
}

// ---------- attachments ----------
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

// Fill an attachment placeholder: image thumbnail (click = full view) or a
// name+size chip. Degrades to a plain tag until the file commands exist.
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
  try {
    const thumb = await invoke("get_file_thumbnail", { fileId: id });
    el.classList.add("image");
    el.textContent = "";
    const img = document.createElement("img");
    img.src = thumb;
    img.alt = info.name;
    el.appendChild(img);
    el.addEventListener("click", () => openLightbox(id, info));
  } catch (_) {
    // thumbnail failed (e.g. command missing) — at least name the file
    el.classList.add("file-chip");
    el.textContent = `🖼️ ${info.name}`;
  }
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

function bubbleEl({ mine, uid, sender, text, ts, files }) {
  const row = document.createElement("div");
  row.className = "msg-row" + (mine ? " mine" : "");
  row.appendChild(avatarEl(uid, mine ? state.me?.username : sender));

  const el = document.createElement("div");
  el.className = "msg " + (mine ? "msg-me" : "msg-other");

  if (sender || ts) {
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.textContent = (sender ? sender + " · " : "") + formatTime(ts);
    el.appendChild(meta);
  }
  if (text) {
    const body = document.createElement("div");
    body.className = "msg-body";
    body.appendChild(renderMarkdown(text)); // DOM nodes only — never innerHTML
    el.appendChild(body);
  }
  if (files && files.length) el.appendChild(attachmentsEl(files));

  row.appendChild(el);
  return row;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function formatTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// ================= LIVE EVENTS =================
// Desktop notification via the Tauri notification plugin. No-op (and silent)
// until the plugin is registered on the Rust side, so it never errors early.
async function notify(title, body) {
  try {
    const n = window.__TAURI__ && window.__TAURI__.notification;
    if (!n) return;
    let granted = await n.isPermissionGranted();
    if (!granted) granted = (await n.requestPermission()) === "granted";
    if (granted) n.sendNotification({ title, body: body || "" });
  } catch (_) {
    /* plugin missing or permission denied — ignore */
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
    if (!mine && (!document.hasFocus() || p.channel_id !== state.activeId)) {
      const su = state.usersByName[senderClean];
      const who = (su && realName(su)) || p.sender || "New message";
      const title = ch && !isDM(ch) ? `${who} · ${displayName(ch)}` : who;
      notify(title, p.message);
    }
  } catch (e) {
    console.error("notification failed (message still rendered)", e);
  }

  if (p.channel_id === state.activeId) {
    // drop the "No messages yet." placeholder if present
    if (messagesEl.querySelector(".loading")) messagesEl.innerHTML = "";
    // live events carry the username but not the user_id — resolve it if we can
    const uid = mine ? state.me?.id : state.usersByName[senderClean]?.id;
    messagesEl.appendChild(
      bubbleEl({ mine, uid, sender: mine ? null : p.sender, text: p.message, ts: Date.now(), files: p.file_ids })
    );
    scrollToBottom();
    if (document.hasFocus()) {
      markViewed(p.channel_id); // keep the server's watermark caught up
    } else if (!mine) {
      // open but not looking — badge it; cleared when the window regains focus
      state.unread[p.channel_id] = (state.unread[p.channel_id] || 0) + 1;
    }
  } else {
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
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendCurrent();
  }
});
composerInput.addEventListener("input", autoResize);

// Scroll near the top of the message pane → pull in older history.
messagesEl.addEventListener("scroll", () => {
  if (messagesEl.scrollTop < 80) loadOlder();
});

// Coming back to the window means reading the open conversation.
window.addEventListener("focus", () => {
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

// Paste an image (screenshot) straight into the composer.
composerInput.addEventListener("paste", (e) => {
  const items = e.clipboardData ? e.clipboardData.items : [];
  let got = false;
  for (const it of items) {
    if (it.kind === "file") {
      const f = it.getAsFile();
      if (f) { pendingFiles.push(f); got = true; }
    }
  }
  if (got) {
    e.preventDefault();
    renderPendingFiles();
  }
});

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

async function sendCurrent() {
  const text = composerInput.value.trim();
  const files = pendingFiles.slice();
  if ((!text && !files.length) || !state.activeId) return;
  const channelId = state.activeId;
  composerInput.value = "";
  autoResize();
  sendBtn.disabled = true;
  try {
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
    renderPendingFiles("Sending failed: " + e);
  } finally {
    sendBtn.disabled = false;
  }
}

function autoResize() {
  composerInput.style.height = "auto";
  composerInput.style.height = Math.min(composerInput.scrollHeight, 140) + "px";
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
    chatError.textContent = "Backend: manca il comando search_users.";
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
    chatError.textContent = "Impossibile creare la chat: " + e;
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
    channelError.textContent = "Impossibile creare il canale: " + e;
    channelCreate.disabled = false;
  }
});

// Shared: a channel was just created → add it, open it, close the modal.
function onChannelCreated(ch) {
  if (!ch || !ch.id) { chatError.textContent = "Risposta inattesa dal backend."; return; }
  if (!state.channels.find((c) => c.id === ch.id)) state.channels.push(ch);
  closeModal();
  renderSidebar();
  openChannel(ch.id);
}
