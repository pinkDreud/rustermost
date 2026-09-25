// tests/fe/emoji-font.test.mjs — "Emoji set" setting (no issue number).
//
// The "Rustermost Emoji" family in the styles.css font stacks has no static
// @font-face: main.js registers it at runtime through the FontFace API so the
// setting can switch its source — Twemoji (bundled, default), System
// (unregistered → glossy system emoji font), or Custom (a user-picked file
// persisted as a data: URL under rustermost.emojiFont). Behavioral assertions
// boot the app; file pins guard the bundled font and the stacks.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, ok, eq, boot, flush } from "../harness.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// The currently-registered face for our family, or undefined.
const emojiFace = (w) => w.document.fonts.faces.find((f) => f.family === "Rustermost Emoji");
const emojiSegBtn = (w, value) => w.qa('[data-setting="emojiSet"] .seg-btn').find((b) => b.dataset.value === value);

test("default boot (Twemoji) registers the bundled font face", async () => {
  const w = await boot();
  const face = emojiFace(w);
  ok(face, "a Rustermost Emoji face is registered at boot");
  ok(face.source.includes("fonts/twemoji-mozilla.woff2"), "the face sources the bundled Twemoji webfont");
});

test("switching the Emoji set seg to System unregisters the family", async () => {
  const w = await boot();
  ok(emojiFace(w), "starts with the bundled face");
  w.fire(emojiSegBtn(w, "system"), "click");
  await flush();
  eq(w.document.fonts.faces.length, 0, "no face registered after System");
  eq(w.document.fonts.faces.includes(undefined), false, "no leftover face");
  const saved = JSON.parse(globalThis.localStorage.getItem("rustermost.settings"));
  eq(saved.emojiSet, "system", "emojiSet persisted to settings");
});

test("Custom pick shows the row, persists {name, data}, registers the data: URL", async () => {
  const w = await boot();
  const customRow = w.el("emoji-custom-row");
  ok(customRow.classList.contains("hidden"), "custom row hidden until Custom is chosen");

  w.fire(emojiSegBtn(w, "custom"), "click");
  await flush();
  ok(!customRow.classList.contains("hidden"), "custom row is visible for Custom");
  eq(emojiFace(w), undefined, "no face until a file is actually picked (behaves like System)");

  const input = w.el("emoji-font-file");
  input.files = [{ name: "mind.woff2", size: 500000 }];
  w.fire(input, "change");
  await flush();

  eq(w.el("emoji-font-status").textContent, "Loaded: mind.woff2", "status shows the loaded file name");
  const stored = JSON.parse(globalThis.localStorage.getItem("rustermost.emojiFont"));
  eq(stored.name, "mind.woff2", "stored entry keeps the file name");
  ok(typeof stored.data === "string" && stored.data.startsWith("data:"), "stored entry holds a data: URL");
  const face = emojiFace(w);
  ok(face, "custom pick registers a Rustermost Emoji face");
  ok(face.source.startsWith('url("data:'), "the registered face sources the stored data: URL");

  w.fire(emojiSegBtn(w, "twemoji"), "click");
  await flush();
  ok(customRow.classList.contains("hidden"), "custom row hides again when leaving Custom");
});

test("a bad pick is rejected with a hint and changes nothing", async () => {
  const w = await boot();
  w.fire(emojiSegBtn(w, "custom"), "click");
  await flush();

  const input = w.el("emoji-font-file");
  const status = w.el("emoji-font-status");
  const HINT = "That file doesn't look like a font (max 4 MB: .woff2/.ttf/.otf).";

  input.files = [{ name: "x.exe", size: 500000 }];
  w.fire(input, "change");
  await flush();
  eq(status.textContent, HINT, "wrong extension gets the hint");
  eq(globalThis.localStorage.getItem("rustermost.emojiFont"), null, "nothing persisted for a bad file");
  eq(w.document.fonts.faces.length, 0, "fonts untouched by a bad file");

  input.files = [{ name: "big.woff2", size: 5 * 1024 * 1024 }];
  w.fire(input, "change");
  await flush();
  eq(status.textContent, HINT, "oversize font gets the hint");
  eq(globalThis.localStorage.getItem("rustermost.emojiFont"), null, "nothing persisted for an oversize file");
  eq(w.document.fonts.faces.length, 0, "fonts untouched by an oversize file");
});

test("boot seeded with a corrupt stored custom font still completes and renders", async () => {
  const w = await boot({
    channels: [{ id: "c1", name: "town-square", display_name: "Town Square", type: "O", team_id: "", total_msg_count: 1, member: { msg_count: 0 } }],
    seeds: {
      "rustermost.settings": JSON.stringify({ emojiSet: "custom" }),
      // Passes loadEmojiFont's shape check (starts with "data:"), but the
      // payload is malformed: embedded in url("…") it is invalid CSS, and a
      // real browser's new FontFace would throw. registerEmojiFont's try/catch
      // must absorb that so boot is never crashed by a tampered localStorage.
      "rustermost.emojiFont": JSON.stringify({ name: "oops.woff2", data: 'data:broken"oops' }),
    },
  });
  ok(!w.el("app-view").classList.contains("hidden"), "app view visible despite the corrupt font payload");
  // The harness's FakeFontFace tolerates any source, so a (harmless, failed in
  // a real browser) face may be registered here; in a real browser none is.
  // Either way no face crash: assert only that rendering survived.
  ok(w.qa(".channel-item").length > 0, "sidebar channel rows render despite the corrupt font payload");
});

test("a rejected custom-font pick clears the file input so re-picking re-fires change", async () => {
  const w = await boot();
  w.fire(emojiSegBtn(w, "custom"), "click");
  await flush();

  const input = w.el("emoji-font-file");
  // Real browsers hold the selection as a fakepath in .value; seed it.
  input.files = [{ name: "x.exe", size: 500000 }];
  input.value = "C:\\fakepath\\x.exe";
  w.fire(input, "change");
  await flush();
  eq(input.value, "", "wrong-extension pick resets the input value");
  eq(w.el("emoji-font-status").textContent, "That file doesn't look like a font (max 4 MB: .woff2/.ttf/.otf).", "hint still shown");

  input.files = [{ name: "big.woff2", size: 5 * 1024 * 1024 }];
  input.value = "C:\\fakepath\\big.woff2";
  w.fire(input, "change");
  await flush();
  eq(input.value, "", "oversize pick resets the input value too");
});

test("boot seeded with a stored custom font + emojiSet=custom registers it at boot", async () => {
  const w = await boot({
    seeds: {
      "rustermost.settings": JSON.stringify({ emojiSet: "custom" }),
      "rustermost.emojiFont": JSON.stringify({ name: "keep.woff2", data: "data:font/woff2;base64,AAAA" }),
    },
  });
  const face = emojiFace(w);
  ok(face, "stored custom face is registered at boot");
  ok(face.source.includes("data:font/woff2;base64,AAAA"), "the registered face sources the stored data: URL");

  w.fire("settings-btn", "click"); // renderSettingsControls syncs the modal UI
  ok(!w.el("emoji-custom-row").classList.contains("hidden"), "custom row visible for a seeded Custom");
  eq(w.el("emoji-font-status").textContent, "Loaded: keep.woff2", "status remembers the stored file name");
});

test("bundled Twemoji webfont exists and is the picker-catalog+chrome subset", () => {
  const font = path.join(root, "src", "fonts", "twemoji-mozilla.woff2");
  const bytes = readFileSync(font);
  eq(bytes.subarray(0, 4).toString("latin1"), "wOF2", "the bundled font is a woff2 (magic bytes)");
  // The subset (packaging/subset-emoji-font.py) keeps only the picker catalog
  // + app chrome out of the ~465KB full upstream font — pin a sanity range so
  // neither an empty/stub file nor the full font can be committed by mistake.
  ok(bytes.length > 20 * 1024 && bytes.length < 300 * 1024, `subset size in (20KB, 300KB), got ${bytes.length}`);
});

test("stacks keep 'Rustermost Emoji' before the generics; the face is registered at runtime", () => {
  const css = readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const main = readFileSync(path.join(root, "src", "main.js"), "utf8");
  ok(!css.includes("@font-face"), "styles.css declares NO static @font-face (runtime registration only)");
  ok(
    css.includes('"Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, "Rustermost Emoji", sans-serif'),
    'html/body stack lists "Rustermost Emoji" before sans-serif',
  );
  ok(
    css.includes('ui-monospace, "SF Mono", Menlo, Consolas, "Rustermost Emoji", monospace'),
    'code stack lists "Rustermost Emoji" before monospace',
  );
  ok(main.includes('fonts/twemoji-mozilla.woff2'), "main.js registers the bundled Twemoji file");
});
