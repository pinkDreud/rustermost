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
  activity: {}, // channelId -> last-activity ms (learned live; complements last_post_at)
  userLookupEnabled: true, // flips off if get_users_by_ids isn't in the backend yet
  collapsed: {}, // section title -> true when folded
};

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

// ================= LOGIN =================
urlForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim().replace(/\/+$/, "");
  if (!url) return;
  state.baseUrl = url;
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
  try {
    await invoke("connect_websocket");
  } catch (e) {
    console.error("connect_websocket failed", e);
  }

  // channels (slow: hits every team once)
  try {
    state.channels = await invoke("fetch_all_channels");
    renderSidebar();
    // Try to name the 1:1 DM partners (no-op until get_users_by_ids exists).
    resolveUsers(collectDmPartnerIds()).then(() => renderSidebar());
  } catch (e) {
    console.error("fetch_all_channels failed", e);
    channelList.innerHTML = '<div class="list-empty">Failed to load channels.</div>';
  }
}

function renderMe() {
  const name = state.me?.username || "me";
  meName.textContent = "@" + name;
  meAvatar.textContent = name.charAt(0) || "?";
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

function typeLabel(ch) {
  return { D: "Direct message", G: "Group", O: "Public channel", P: "Private channel" }[ch.type] || "Channel";
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

  const direct = state.channels.filter((c) => c.type === "D" && match(c));
  const groups = state.channels.filter((c) => c.type === "G" && match(c));
  const community = state.channels.filter((c) => (c.type === "O" || c.type === "P") && match(c));

  // Most-recent conversation first (stable when timestamps are equal).
  const byRecency = (a, b) => activityOf(b) - activityOf(a);
  direct.sort(byRecency);
  groups.sort(byRecency);
  community.sort(byRecency);

  const searching = q.length > 0;
  channelList.innerHTML = "";
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
  av.textContent = (name.replace(/^@/, "").charAt(0) || "#");
  row.appendChild(av);

  const main = document.createElement("div");
  main.className = "item-main";
  const nm = document.createElement("div");
  nm.className = "item-name";
  nm.textContent = name;
  const sub = document.createElement("div");
  sub.className = "item-sub";
  sub.textContent = typeLabel(ch);
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
  state.unread[id] = 0;
  renderSidebar();

  const ch = state.channels.find((c) => c.id === id);
  emptyState.classList.add("hidden");
  chatPanel.classList.remove("hidden");
  chatTitle.textContent = displayName(ch);
  chatSub.textContent = typeLabel(ch);
  messagesEl.innerHTML = '<div class="loading">Loading messages…</div>';

  try {
    const posts = await invoke("get_posts", { channelId: id });
    if (state.activeId !== id) return; // user switched away while loading
    renderMessages(posts);
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
      bubbleEl({ mine, sender, text: p.message, ts: p.create_at })
    );
  }
  scrollToBottom();
}

function bubbleEl({ mine, sender, text, ts }) {
  const el = document.createElement("div");
  el.className = "msg " + (mine ? "msg-me" : "msg-other");

  if (sender || ts) {
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.textContent = (sender ? sender + " · " : "") + formatTime(ts);
    el.appendChild(meta);
  }
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = text; // textContent — never inject message HTML
  el.appendChild(body);
  return el;
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
function onIncoming(event) {
  const p = event.payload; // { channel_id, sender, message }
  if (!p) return;

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

  if (p.channel_id === state.activeId) {
    // drop the "No messages yet." placeholder if present
    if (messagesEl.querySelector(".loading")) messagesEl.innerHTML = "";
    messagesEl.appendChild(
      bubbleEl({ mine, sender: mine ? null : p.sender, text: p.message, ts: Date.now() })
    );
    scrollToBottom();
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

async function sendCurrent() {
  const text = composerInput.value.trim();
  if (!text || !state.activeId) return;
  composerInput.value = "";
  autoResize();
  try {
    await invoke("send_message", { channelId: state.activeId, message: text });
    // The message echoes back via the "mm-post" event and is appended there,
    // so we don't render it manually here.
  } catch (e) {
    console.error("send_message failed", e);
    // put the text back so it isn't lost
    composerInput.value = text;
    autoResize();
  }
}

function autoResize() {
  composerInput.style.height = "auto";
  composerInput.style.height = Math.min(composerInput.scrollHeight, 140) + "px";
}
