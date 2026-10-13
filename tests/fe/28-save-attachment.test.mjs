// tests/fe/28-save-attachment.test.mjs — issue #28: "Save image as" did
// nothing. Right-clicking an attachment now offers "💾 Save as…": the native
// save dialog (tauri-plugin-dialog) picks the destination, then the backend's
// save_file writes the ORIGINAL file there.
//
// Covers images and plain file chips, cancel = no-op, Windows-invalid name
// characters scrubbed from the suggested name, Save + Edit side by side on my
// own bubble, real failures surfacing an error dialog, and the graceful
// degradation when save_file or the dialog plugin is missing.

import { boot, test, ok, eq } from "../harness.mjs";

const ME = { id: "me1", username: "me", first_name: "Me", last_name: "" };
const CHANNELS = [
  { id: "c1", name: "town-square", display_name: "Town Square", type: "O", team_id: "", total_msg_count: 9, member: { msg_count: 8 } },
];
const USERS = { u2: { id: "u2", username: "anna", first_name: "Anna", last_name: "Doe" } };
const INFOS = {
  f1: { id: "f1", name: "photo.jpg", size: 3 * 1024 * 1024, mime_type: "image/jpeg" },
  f2: { id: "f2", name: "paper.pdf", size: 2048, mime_type: "application/pdf" },
  f3: { id: "f3", name: 'a:b/c?.txt', size: 10, mime_type: "text/plain" },
};
const POSTS = {
  c1: [
    { id: "p1", user_id: "u2", channel_id: "c1", message: "", create_at: 1728000000000, file_ids: ["f1"] },
    { id: "p2", user_id: "u2", channel_id: "c1", message: "", create_at: 1728000000001, file_ids: ["f2"] },
    { id: "p3", user_id: "u2", channel_id: "c1", message: "", create_at: 1728000000002, file_ids: ["f3"] },
    { id: "p4", user_id: "me1", channel_id: "c1", message: "mine", create_at: 1728000000003, file_ids: ["f2"] },
    { id: "p5", user_id: "u2", channel_id: "c1", message: "just text", create_at: 1728000000004 },
  ],
};

async function bootSave(extra = {}) {
  const w = await boot({
    handlers: {
      get_file_info: async ({ fileId }) => INFOS[fileId],
      get_file_thumbnail: async ({ fileId }) => "data:image/png;base64,T-" + fileId,
      get_file: async ({ fileId }) => "data:image/png;base64,F-" + fileId,
      "plugin:dialog|save": async () => "/home/me/Downloads/picked.bin",
      "plugin:dialog|message": async () => undefined,
      save_file: async () => undefined,
      ...extra,
    },
    channels: CHANNELS, posts: POSTS, users: USERS, me: ME,
  });
  const row = w.qa(".channel-item").find((r) => r.textContent.includes("Town Square"));
  w.fire(row, "click");
  await w.flush();
  return w;
}

const attOf = (w, p) => w.q(`.msg-row[data-post-id="${p}"] .attachment`);
const menu = (w) => w.qa(".context-menu").find((m) => !m.classList.contains("hidden"));
const menuRows = (w) => { const m = menu(w); return m ? w.qa(".context-menu-row", m).map((r) => r.textContent) : []; };

// Right-click the attachment's inner node (img for images) so the event
// bubbles up to the row's handler like a real click would.
function rightClick(w, p) {
  const att = attOf(w, p);
  const target = w.q("img", att) || att;
  return w.fire(target, "contextmenu", { clientX: 10, clientY: 10 });
}

async function pick(w, label) {
  const row = w.qa(".context-menu-row", menu(w)).find((r) => r.textContent.includes(label));
  ok(row, `menu row "${label}" present`);
  w.fire(row, "mousedown");
  await w.flush();
}

test("28: right-click an image → Save as… → dialog then save_file with the chosen path", async () => {
  const w = await bootSave();
  const ev = rightClick(w, "p1");
  ok(ev.defaultPrevented, "native menu suppressed over the image");
  eq(menuRows(w).length, 1, "only Save as… on someone else's bubble");
  ok(menuRows(w)[0].includes("Save as"), "Save as… offered");

  await pick(w, "Save as");
  ok(!menu(w), "menu closes");
  const dlg = w.invoked("plugin:dialog|save");
  eq(dlg.length, 1, "save dialog opened once");
  eq(dlg[0].args.options.defaultPath, "photo.jpg", "server file name suggested");
  const saves = w.invoked("save_file");
  eq(saves.length, 1, "save_file invoked once");
  eq(saves[0].args.fileId, "f1", "the original file id, not a thumbnail");
  eq(saves[0].args.destPath, "/home/me/Downloads/picked.bin", "destination from the dialog");
  eq(w.invoked("plugin:dialog|message").length, 0, "no error shown on success");
});

test("28: non-image file chips are saveable too", async () => {
  const w = await bootSave();
  rightClick(w, "p2");
  await pick(w, "Save as");
  eq(w.invoked("save_file")[0].args.fileId, "f2", "pdf saved");
});

test("28: cancelling the dialog saves nothing", async () => {
  const w = await bootSave({ "plugin:dialog|save": async () => null });
  rightClick(w, "p1");
  await pick(w, "Save as");
  eq(w.invoked("plugin:dialog|save").length, 1, "dialog shown");
  eq(w.invoked("save_file").length, 0, "no save_file after cancel");
});

test("28: Windows-invalid characters scrubbed from the suggested name", async () => {
  const w = await bootSave();
  rightClick(w, "p3");
  await pick(w, "Save as");
  eq(w.invoked("plugin:dialog|save")[0].args.options.defaultPath, "a_b_c_.txt", "<>:\"/\\|?* replaced");
});

test("28: my own bubble with an attachment offers Save as… AND Edit", async () => {
  const w = await bootSave();
  rightClick(w, "p4");
  const rows = menuRows(w);
  eq(rows.length, 2, "two rows");
  ok(rows[0].includes("Save as") && rows[1].includes("Edit"), "Save first, then Edit");

  // Right-click on the text body (not the attachment) → only Edit.
  w.fire(w.q('.msg-row[data-post-id="p4"] .msg-body'), "contextmenu", { clientX: 1, clientY: 1 });
  eq(menuRows(w).length, 1, "body → one row");
  ok(menuRows(w)[0].includes("Edit"), "…and it's Edit");
});

test("28: someone else's text-only bubble keeps the native menu", async () => {
  const w = await bootSave();
  const ev = w.fire(w.q('.msg-row[data-post-id="p5"] .msg-body'), "contextmenu", { clientX: 1, clientY: 1 });
  ok(!ev.defaultPrevented, "native menu not suppressed");
  ok(!menu(w), "no custom menu");
});

test("28: a real save_file failure shows an error dialog; the item stays available", async () => {
  const w = await bootSave({ save_file: async () => { throw new Error("Permission denied (os error 13)"); } });
  rightClick(w, "p1");
  await pick(w, "Save as");
  const msgs = w.invoked("plugin:dialog|message");
  eq(msgs.length, 1, "error dialog shown");
  ok(msgs[0].args.message.includes("Permission denied"), "carries the backend error");
  eq(msgs[0].args.kind, "error", "error kind");
  rightClick(w, "p1");
  ok(menuRows(w).some((r) => r.includes("Save as")), "Save as… still offered after a transient failure");
});

test("28: backend without save_file → item folds away for the session", async () => {
  const w = await bootSave({ save_file: async () => { throw new Error("command save_file not found"); } });
  rightClick(w, "p1");
  await pick(w, "Save as");
  eq(w.invoked("plugin:dialog|message").length, 0, "no error dialog for a missing command");
  const ev = rightClick(w, "p1");
  ok(!ev.defaultPrevented, "native menu back");
  ok(!menu(w), "no Save as… anymore");
});

test("28: dialog plugin missing/denied → item folds away", async () => {
  const w = await bootSave({ "plugin:dialog|save": async () => { throw new Error("dialog.save not allowed"); } });
  rightClick(w, "p1");
  await pick(w, "Save as");
  eq(w.invoked("save_file").length, 0, "no save without a path");
  ok(!rightClick(w, "p1").defaultPrevented, "native menu back");
});

test("28: a server 404 (deleted file) is a real failure — reported, item NOT folded away", async () => {
  const w = await bootSave({ save_file: async () => { throw new Error("Network error: HTTP status client error (404 Not Found) for url (https://mm.example.org/api/v4/files/f1)"); } });
  rightClick(w, "p1");
  await pick(w, "Save as");
  eq(w.invoked("plugin:dialog|message").length, 1, "error dialog shown for the 404");
  rightClick(w, "p1");
  ok(menuRows(w).some((r) => r.includes("Save as")), "Save as… still offered");
});
