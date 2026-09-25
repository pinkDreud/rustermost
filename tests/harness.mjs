// tests/harness.mjs — dependency-free browser double for the frontend.
//
// Boots the real src/main.js in Node by installing a fake DOM (document,
// window, localStorage, matchMedia, …) plus a stubbed window.__TAURI__ bridge
// whose restore_session / fetch_me commands resolve — so the app's own
// tryRestore() → init() runs end to end. Tests then drive the app with fake
// events (fire) or fake backend pushes (emitEvent), and assert on the fake
// DOM. Usage: see tests/fe/harness-smoke.test.mjs.
//
// The fake DOM models ONLY what src/main.js uses: className/classList/
// dataset/style(+setProperty), textContent, an innerHTML setter limited to ""
// and literal `<div class="x">text</div>` placeholders, appendChild/
// insertBefore (fragments splice their children in), remove(), contains(),
// closest(), querySelector(All) with a tiny selector matcher (tag, .cls, .a.b,
// tag.cls, [attr="v"], [data-x="v"], :not(.cls), :checked, one-level
// descendant), inputs' value/selection*/setSelectionRange, focus() tracking
// document.activeElement, getBoundingClientRect() zeros, scrollTop/
// scrollHeight numbers, and a no-op scrollIntoView that records the call.
// Adapt the harness when the app changes, never the
// other way around.

import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main.js");
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const ELEMENT = 1, TEXT = 3, FRAGMENT = 11;

// ================= FAKE EVENTS =================
class FakeEvent {
  constructor(type, target, props = {}) {
    this.type = type;
    this.target = target; // node the event was fired on (read by delegated listeners)
    this.currentTarget = target;
    this.defaultPrevented = false;
    this.cancelBubble = false;
    Object.assign(this, props); // key, shiftKey, clientX/Y, clipboardData, dataTransfer, …
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.cancelBubble = true; }
}

// Synchronously runs listeners of `type` on the target, then bubbles up the
// parent chain (el → … → body → html → document → window). This is what makes
// the app's document-level delegated listeners (popovers, settings segs) work
// exactly as in a browser.
function dispatch(target, type, props = {}) {
  if (!target) throw new Error(`[harness] fire: no target for "${type}" (element not found?)`);
  const ev = new FakeEvent(type, target, props);
  for (let n = target; n && !ev.cancelBubble; n = n.parentNode) {
    ev.currentTarget = n;
    for (const fn of [...(n._listeners.get(type) || [])]) fn(ev);
  }
  return ev;
}

// ================= SELECTOR MATCHING =================
const splitSel = (sel) => sel.trim().split(/\s+/);

// One compound selector (no spaces): tag, .cls, tag.cls, .a.b,
// [attr="v"] (data-* resolved from dataset, others from direct props/attrs),
// :not(compound), :checked. That covers every selector the app emits.
function matchOne(el, part) {
  if (!el || el.nodeType !== ELEMENT) return false;
  const tagM = part.match(/^[a-zA-Z][\w-]*/);
  let rest = part;
  if (tagM) {
    if (el.tagName !== tagM[0].toLowerCase()) return false;
    rest = rest.slice(tagM[0].length);
  }
  while (rest) {
    let m;
    if ((m = rest.match(/^\.([\w-]+)/))) {
      if (!el.classList.contains(m[1])) return false;
    } else if ((m = rest.match(/^\[([\w-]+)(?:="([^"]*)")?\]/))) {
      const v = m[1].startsWith("data-")
        ? el.dataset[camel(m[1].slice(5))]
        : m[1] === "id" ? el.id : hasOwn(el.attrs, m[1]) ? el.attrs[m[1]] : el[m[1]];
      if (m[2] === undefined ? v == null : String(v) !== m[2]) return false;
    } else if ((m = rest.match(/^:not\(([^)]*)\)/))) {
      if (matchOne(el, m[1])) return false;
    } else if ((m = rest.match(/^:checked/))) {
      if (!el.checked) return false;
    } else {
      throw new Error(`[harness] unsupported selector fragment "${rest}" (in "${part}")`);
    }
    rest = rest.slice(m[0].length);
  }
  return true;
}

// parts[0..n-2] must match an ordered chain of el's ancestors (descendant
// combinator; today only ever one space, e.g. ".option-seg .seg-btn").
function ancestorsMatch(el, parts) {
  let i = parts.length - 2;
  for (let n = el.parentNode; n && i >= 0; n = n.parentNode) if (matchOne(n, parts[i])) i--;
  return i < 0;
}

function findAll(root, sel) {
  const parts = splitSel(sel);
  const last = parts[parts.length - 1];
  const out = [];
  (function walk(node) {
    for (const c of node.childNodes) {
      if (c.nodeType !== ELEMENT) continue;
      if (matchOne(c, last) && ancestorsMatch(c, parts)) out.push(c);
      walk(c);
    }
  })(root);
  return out;
}

// ================= FAKE NODES =================
let currentDoc = null; // where focus() parks activeElement

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = new Map(); // event type -> handler[]
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    if (!this._listeners.get(type).includes(fn)) this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners.get(type);
    if (l && l.includes(fn)) l.splice(l.indexOf(fn), 1);
  }

  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, ref) {
    if (child && child.nodeType === FRAGMENT) { // fragments splice their children in
      for (const k of [...child.childNodes]) this.insertBefore(k, ref);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(child);
    else this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) { this.childNodes.splice(i, 1); child.parentNode = null; }
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === ELEMENT); }
  get childElementCount() { return this.children.length; }
  get previousElementSibling() {
    const kids = this.parentNode ? this.parentNode.children : [];
    return kids[kids.indexOf(this) - 1] || null;
  }

  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(v) {
    this._clearChildren();
    if (String(v) !== "") this.appendChild(new FakeText(String(v)));
  }

  // The app's rule: innerHTML is only ever "" (clear) or a fixed literal
  // placeholder div — anything else is a bug, so fail loudly instead of
  // pretending to parse HTML.
  set innerHTML(html) {
    if (html === "") return this._clearChildren();
    const m = String(html).match(/^<div class="([^"]*)">([^<]*)<\/div>$/);
    if (!m) throw new Error(`[harness] innerHTML only supports "" or a literal <div class="…">…</div>, got: ${html}`);
    this._clearChildren();
    const div = new FakeElement("div");
    div.className = m[1];
    div.textContent = m[2];
    this.appendChild(div);
  }

  _clearChildren() {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes.length = 0;
  }

  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  // Element matching the last compound, with the rest matching ancestors.
  closest(sel) {
    const parts = splitSel(sel);
    let i = parts.length - 1;
    let hit = null;
    for (let n = this; n; n = n.parentNode) {
      if (!matchOne(n, parts[i])) continue;
      if (i === parts.length - 1) hit = n;
      if (--i < 0) return hit;
    }
    return null;
  }
  querySelector(sel) { return findAll(this, sel)[0] || null; }
  querySelectorAll(sel) { return findAll(this, sel); }
}

class FakeText extends FakeNode {
  constructor(text) { super(TEXT); this.text = text; }
  get textContent() { return this.text; }
  set textContent(v) { this.text = String(v); }
}

// style: a plain object main.js can assign onto (el.style.left = …), plus
// setProperty for the CSS-variable writes on <html>.
function makeStyle() {
  const s = {};
  s.setProperty = (k, v) => { s[k] = String(v); };
  return s;
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super(ELEMENT);
    this.tagName = tag.toLowerCase();
    this.className = "";
    this.attrs = {};   // setAttribute values (aria-pressed, …)
    this.dataset = {}; // data-* reads/writes live here; the attr matcher reads from here too
    this.style = makeStyle();
    // input/textarea surface (harmless on other elements):
    this.value = ""; this.checked = false; this.disabled = false;
    this.selectionStart = 0; this.selectionEnd = 0; this.files = [];
    // layout: everything is a zero-size box
    this.scrollTop = 0; this.scrollHeight = 0;
  }
  get classList() {
    const el = this;
    const read = () => el.className.split(/\s+/).filter(Boolean);
    const write = (a) => { el.className = a.join(" "); };
    return {
      add: (...cs) => write([...new Set([...read(), ...cs])]),
      remove: (...cs) => write(read().filter((c) => !cs.includes(c))),
      contains: (c) => read().includes(c),
      toggle: (c, force) => {
        const want = force === undefined ? !read().includes(c) : !!force;
        write(want ? [...new Set([...read(), c])] : read().filter((x) => x !== c));
        return want;
      },
    };
  }
  setAttribute(name, v) { this.attrs[name] = String(v); }
  getAttribute(name) { return hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  // Zero-size boxes can't really scroll; record the call so tests can assert
  // the intent (like focus() parking document.activeElement).
  scrollIntoView() { this.scrolledIntoView = true; }
  focus() { if (currentDoc) currentDoc.activeElement = this; this.focused = true; }
  blur() { this.focused = false; }
  click() { dispatch(this, "click"); }
}

class FakeDocument extends FakeNode {
  constructor() {
    super(9);
    currentDoc = this;
    this.activeElement = null;
    this.documentElement = new FakeElement("html");
    this.documentElement.appendChild(new FakeElement("body"));
    this.appendChild(this.documentElement);
    // FontFaceSet stand-in: the app registers/deletes the "Rustermost Emoji"
    // family here as the Emoji set setting changes (see applyEmojiSet).
    this.fonts = {
      faces: [],
      add(f) { if (!this.faces.includes(f)) this.faces.push(f); },
      delete(f) { const i = this.faces.indexOf(f); if (i >= 0) this.faces.splice(i, 1); },
      has(f) { return this.faces.includes(f); },
      load() { return Promise.resolve({}); },
    };
  }
  get body() { return this.documentElement.firstChild; }
  createElement(tag) {
    const el = new FakeElement(tag);
    if (tag === "canvas") { // only the tray/paste paths reach these; stubbed just in case
      el.getContext = () => ({ drawImage() {}, putImageData() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) });
      el.toBlob = (cb) => cb(new Blob());
    }
    return el;
  }
  createTextNode(text) { return new FakeText(text); }
  createDocumentFragment() { return new FakeNode(FRAGMENT); }
  getElementById(id) {
    let hit = null;
    (function walk(node) {
      for (const c of node.childNodes) {
        if (c.nodeType !== ELEMENT || hit) continue;
        if (c.id === id) hit = c;
        walk(c);
      }
    })(this);
    return hit;
  }
  hasFocus() { return true; }
}

// The static skeleton mirrors src/index.html: every id the app binds at
// startup, plus the structure it navigates by class (settings .option-seg /
// .seg-btn, the ch-type radios). Keep it in sync if index.html changes.
function buildSkeleton(doc) {
  const h = (tag, props = {}, ...kids) => {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") el.className = v;
      else if (k.startsWith("data-")) el.dataset[camel(k.slice(5))] = v;
      else el[k] = v;
    }
    for (const k of kids) el.appendChild(k);
    return el;
  };
  const seg = (setting, values) =>
    h("div", { class: "seg option-seg", "data-setting": setting },
      ...values.map((v) => h("button", { class: "seg-btn", type: "button", "data-value": v })));

  const login = h("div", { id: "login-view", class: "login-view" },
    h("form", { id: "url-form" }, h("input", { id: "url-input" }), h("button", { id: "connect-btn", type: "submit" })),
    h("p", { id: "login-status" }));

  const app = h("div", { id: "app-view", class: "app-view hidden" },
    h("div", { id: "me-avatar" }), h("div", { id: "me-name" }),
    h("button", { id: "settings-btn" }), h("button", { id: "new-btn" }),
    h("input", { id: "search-input" }),
    h("button", { id: "search-clear-btn", type: "button", class: "search-clear hidden", "aria-label": "Clear search" },
      doc.createTextNode("✕")),
    h("div", { id: "channel-list" }), h("div", { id: "sidebar-resizer", class: "sidebar-resizer" }),
    h("div", { id: "empty-state" }),
    h("div", { id: "chat-panel", class: "chat-panel hidden" },
      h("div", { id: "chat-title" }), h("div", { id: "chat-sub" }), h("button", { id: "mute-btn", type: "button" }),
      h("div", { id: "messages" }), h("div", { id: "pending-files", class: "pending-files hidden" }),
      h("form", { id: "composer" },
        h("div", { id: "composer-resizer", class: "composer-resizer" }),
        h("button", { id: "attach-btn", type: "button" }), h("button", { id: "emoji-btn", type: "button" }),
        h("button", { id: "gif-btn", type: "button" }), h("input", { id: "file-input", type: "file" }),
        h("textarea", { id: "composer-input" }), h("button", { id: "send-btn", type: "submit" }))));

  const modal = h("div", { id: "modal-overlay", class: "modal-overlay hidden" },
    h("button", { id: "seg-chat", class: "seg-btn active", type: "button" }),
    h("button", { id: "seg-channel", class: "seg-btn", type: "button" }), h("button", { id: "modal-close", type: "button" }),
    h("div", { id: "mode-chat" },
      h("div", { id: "chat-chips" }), h("input", { id: "people-search" }), h("div", { id: "people-results" }),
      h("p", { id: "chat-error" }), h("button", { id: "chat-create", type: "button" })),
    h("div", { id: "mode-channel", class: "modal-body hidden" },
      h("select", { id: "channel-team" }), h("input", { id: "channel-name" }),
      h("input", { type: "radio", name: "ch-type", value: "O", checked: true }),
      h("input", { type: "radio", name: "ch-type", value: "P" }),
      h("p", { id: "channel-error" }), h("button", { id: "channel-create", type: "button" })));

  const settings = h("div", { id: "settings-overlay", class: "modal-overlay hidden" },
    h("button", { id: "settings-close", type: "button" }),
    seg("fontSize", ["small", "medium", "large"]), seg("theme", ["dark", "light", "system"]),
    seg("density", ["comfortable", "compact"]),
    seg("emojiSet", ["twemoji", "system", "custom"]),
    h("div", { id: "emoji-custom-row", class: "setting-row hidden" },
      h("input", { id: "emoji-font-file", type: "file", class: "hidden" }),
      h("button", { id: "emoji-font-btn", class: "modal-primary", type: "button" }),
      h("p", { id: "emoji-font-status", class: "modal-hint" })),
    h("input", { id: "giphy-key" }));

  for (const el of [login, app, modal, settings]) doc.body.appendChild(el);
}

// ================= BROWSER / TAURI GLOBALS =================
function makeLocalStorage() {
  let store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { store = {}; },
  };
}

function makeWindow(tauri) {
  const win = new FakeNode(9); // a non-element: never matches selectors when events bubble past document
  win.window = win;
  win.__TAURI__ = tauri;
  win.innerWidth = 1280;
  win.innerHeight = 800;
  win.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  return win;
}

// Stubbed Tauri bridge. Commands route into the per-boot `handlers` map;
// unknown commands REJECT — the app is built to catch and degrade around
// exactly that, so the harness never has to fake success for everything.
// menu/tray/image only run on Linux; the Windows UA below skips them, but
// stub them so Linux-path tests could ride along later.
function makeTauri(handlers, invokeLog, wsListeners) {
  const noOp = async () => {};
  const fakeWin = { show: noOp, hide: noOp, unminimize: noOp, setFocus: noOp, destroy: noOp, onCloseRequested: noOp };
  return {
    core: {
      invoke: async (cmd, args) => {
        invokeLog.push({ cmd, args });
        if (!hasOwn(handlers, cmd)) throw new Error(`[harness] no stub handler for command "${cmd}"`);
        return handlers[cmd](args || {});
      },
    },
    event: {
      listen: async (name, fn) => {
        if (!wsListeners.has(name)) wsListeners.set(name, []);
        wsListeners.get(name).push(fn);
        return () => {}; // unlisten
      },
    },
    opener: { openUrl: noOp },
    notification: { isPermissionGranted: async () => true, requestPermission: async () => "granted", sendNotification() {} },
    clipboardManager: { readImage: async () => { throw new Error("[harness] no clipboard image"); } },
    window: { getCurrentWindow: () => fakeWin, getAllWindows: async () => [fakeWin] },
    menu: { Menu: { new: async (o) => o }, MenuItem: { new: async (o) => o } },
    tray: { TrayIcon: { new: async (o) => o } },
    image: { Image: { new: async (...a) => a } },
  };
}

// FontFace / FileReader: the app registers the "Rustermost Emoji" family at
// runtime (Emoji set setting) and reads custom font files into data: URLs.
// The fake FontFace just captures family/source for assertions; the fake
// FileReader always resolves to one fixed payload — the font bytes never
// matter to assertions, only the flow through the app. Both are installed
// per boot with the other globals below.
class FakeFontFace {
  constructor(family, source) { this.family = family; this.source = source; }
  load() { return Promise.resolve(this); }
}
class FakeFileReader {
  readAsDataURL() {
    this.result = "data:application/octet-stream;base64,AAAA";
    setTimeout(() => { if (this.onload) this.onload(); if (this.onloadend) this.onloadend(); }, 0);
  }
}

// Install the browser globals the app reads at module scope. Every boot
// replaces them wholesale, so runs can't leak state into each other
// ("Windows" in the UA keeps the Linux tray path dormant; CSS.escape is only
// ever fed server ids, which are \w-safe already). The world OWNS its
// localStorage (created once in boot and passed here) — re-pointing globals
// mid-test must not wipe it, a browser's store survives arbitrary events.
function installGlobals(win, doc, storage) {
  const globals = {
    window: win,
    document: doc,
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) rustermost-harness" },
    localStorage: storage || makeLocalStorage(),
    CSS: { escape: (s) => String(s).replace(/([^\w-])/g, "\\$1") },
    FontFace: FakeFontFace,
    FileReader: FakeFileReader,
  };
  for (const k of Object.keys(globals)) {
    Object.defineProperty(globalThis, k, { value: globals[k], configurable: true, writable: true });
  }
}

// ================= BOOT =================
const DEFAULT_ME = { id: "me1", username: "me", first_name: "Me", last_name: "" };
let bootCount = 0;

// Drain pending microtasks: invoke stubs resolve through promises, so the
// app's async work advances one macrotask tick at a time — a few rounds is
// plenty for boot / click / message-render cycles.
export async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

export async function boot({ handlers = {}, channels = [], posts = {}, users = {}, me = DEFAULT_ME, seeds = {} } = {}) {
  // Handlers for a realistic, quiet boot; per-test overrides win.
  const allHandlers = {
    restore_session: async () => "https://mm.example.org",
    fetch_me: async () => me,
    fetch_teams: async () => [],
    fetch_all_channels_with_members: async () => channels,
    fetch_all_channels: async () => channels, // fallback probe target
    get_users_by_ids: async ({ ids } = {}) => (ids || []).map((id) => users[id]).filter(Boolean),
    get_posts: async ({ channelId } = {}) => posts[channelId] || [],
    get_cached_posts: async () => { throw new Error("no snapshot"); },
    connect_websocket: async () => undefined,
    get_custom_emojis: async () => [],
    view_channel: async () => undefined,
    ...handlers,
  };

  const doc = new FakeDocument();
  buildSkeleton(doc);
  const invokeLog = [];
  const wsListeners = new Map();
  const tauri = makeTauri(allHandlers, invokeLog, wsListeners);
  const win = makeWindow(tauri);
  const storage = makeLocalStorage(); // one store per world; survives reown()
  doc.parentNode = win; // events bubble el → … → body → document → window
  installGlobals(win, doc, storage);
  // Pre-populate localStorage (saved settings/panes) so tests can cover the
  // "restart with persisted state" path; module scope reads it during import.
  for (const [k, v] of Object.entries(seeds)) globalThis.localStorage.setItem(k, v);

  // Cache-bust so each boot re-evaluates main.js fresh — module scope IS app state.
  await import(pathToFileURL(MAIN_JS).href + "?boot=" + ++bootCount);

  // main.js reads globals dynamically, so a later boot() in the same process
  // would otherwise hijack this world's document/localStorage. Re-pointing
  // them at interaction time keeps older worlds drivable.
  const reown = () => installGlobals(win, doc, storage);

  const world = {
    document: doc,
    window: win,
    el: (id) => doc.getElementById(id),
    q: (sel, root) => (root || doc).querySelector(sel),
    qa: (sel, root) => findAll(root || doc, sel),
    invokeLog, // every command the app issued: [{ cmd, args }, …]
    invoked: (cmd) => invokeLog.filter((c) => c.cmd === cmd),
    fire: (target, type, props = {}) => {
      reown();
      return dispatch(typeof target === "string" ? doc.getElementById(target) : target, type, props);
    },
    emitEvent: (name, payload) => { reown(); for (const fn of wsListeners.get(name) || []) fn({ payload }); },
    flush,
  };

  // init() runs asynchronously (restore_session → fetch_me → init); spin
  // until the app view shows, then settle the trailing user-resolution
  // microtasks before handing the world to the test.
  for (let i = 0; i < 20 && doc.getElementById("app-view").classList.contains("hidden"); i++) await flush(1);
  if (doc.getElementById("app-view").classList.contains("hidden")) {
    throw new Error("[harness] boot: app-view never became visible — did restore_session / fetch_me resolve?");
  }
  await flush();
  return world;
}

// ================= TINY TEST FRAMEWORK =================
// Tests self-register via test(); tests/run.mjs imports the files, then
// runAll() executes them sequentially.
const registry = [];

export function test(name, fn) { registry.push({ name, fn }); }

export async function runAll() {
  let failures = 0;
  for (const { name, fn } of registry) {
    try {
      await fn();
      console.log("ok - " + name);
    } catch (e) {
      failures++;
      console.error("FAIL - " + name);
      console.error(e && e.stack ? e.stack : e);
    }
  }
  console.log(`${registry.length - failures}/${registry.length} passed`);
  return failures;
}

export function ok(cond, msg = "expected a truthy value") {
  if (!cond) throw new Error(msg);
}

export function eq(actual, expected, msg = "values differ") {
  if (!Object.is(actual, expected)) {
    throw new Error(`${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}
