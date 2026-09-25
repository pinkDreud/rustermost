// tests/fe/sidebar-spaces.test.mjs — sidebar "spaces": user-named custom
// conversation sections (Firefox tab-group style).
//
// Covers: the channel-menu "Move to space…" entry and the picker modal,
// create-and-move (incl. persisting), assigning via the pick list (✓ marks
// the current space), fold/unfold + search force-open, the "No space" way
// back (an emptied space never vanishes), manage mode (rename incl. rejecting
// blanks, delete), seeded + garbage persistence, and the by-design duplicate
// of an unread spaced conversation in the pinned Unread section. Extended by:
// create-from-background (right-click empty sidebar → "New space…" → CREATE
// mode) and HTML5 drag & drop into/out of spaces (module-level dragged id,
// type-gated default headers, dragend cleanup).

import { boot, test, ok, eq } from "../harness.mjs";

const ME = { id: "me1", username: "me", first_name: "Me", last_name: "" };

const CHANNELS = [
  // all fully read — nothing is pinned into Unread; sections start folded
  { id: "c1", name: "u2__me1", display_name: "", type: "D", team_id: "", last_post_at: 4000, total_msg_count: 4, member: { msg_count: 4 } }, // Anna Doe
  { id: "c2", name: "u3__me1", display_name: "", type: "D", team_id: "", last_post_at: 3000, total_msg_count: 3, member: { msg_count: 3 } }, // Bob Ray
  { id: "c3", name: "book-club", display_name: "Book Club", type: "G", team_id: "", last_post_at: 2000, total_msg_count: 2, member: { msg_count: 2 } },
  { id: "c4", name: "town-square", display_name: "Town Square", type: "O", team_id: "", last_post_at: 1000, total_msg_count: 6, member: { msg_count: 6 } },
];
const USERS = {
  u2: { id: "u2", username: "anna", first_name: "Anna", last_name: "Doe" },
  u3: { id: "u3", username: "bob", first_name: "Bob", last_name: "Ray" },
};
const WORK_SEED = { "rustermost.spaces": JSON.stringify([{ id: "s1", name: "Work", channelIds: ["c1"] }]) };

const savedSpaces = () => JSON.parse(localStorage.getItem("rustermost.spaces"));
const channelRows = (w) => w.qa(".channel-item", w.el("channel-list"));
const rowNamed = (w, name) => channelRows(w).find((r) => r.textContent.includes(name)) || null;
const sectionTitles = (w) => w.qa(".section-title", w.el("channel-list"));
const sectionTitle = (w, label) => sectionTitles(w).find((t) => t.textContent.includes(label)) || null;
const sectionOf = (title) => title.closest(".section");

function toggleSection(w, label) {
  const t = sectionTitle(w, label);
  ok(t, `"${label}" section header rendered`);
  w.fire(t, "click");
}

// The space modal is the one .modal-overlay holding a Delete-space button.
const spaceOverlay = (w) => w.qa(".modal-overlay").find((o) => o.textContent.includes("Delete space"));
// … and its two mode blocks are its .modal-body children.
const pickBody = (w) => w.qa(".modal-body", spaceOverlay(w)).find((b) => b.textContent.includes("Create and move here"));
const manageBody = (w) => w.qa(".modal-body", spaceOverlay(w)).find((b) => b.textContent.includes("Delete space"));

// Right-click a sidebar row and pick "Move to space…" from its menu.
function openPicker(w, rowName) {
  const row = rowNamed(w, rowName);
  ok(row, `row "${rowName}" rendered`);
  w.fire(row, "contextmenu", { clientX: 20, clientY: 20 });
  const menu = w.q(".context-menu");
  ok(menu && !menu.classList.contains("hidden"), "channel context menu opened");
  const moveRow = w.qa(".context-menu-row", menu).find((r) => r.textContent.includes("space"));
  ok(moveRow, "menu offers a move-to-space row");
  w.fire(moveRow, "mousedown");
}

test("spaces: right-click offers Move to space, opening the picker modal", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME });
  toggleSection(w, "Direct messages");
  openPicker(w, "Anna Doe");

  ok(!spaceOverlay(w).classList.contains("hidden"), "space modal overlay shown");
  ok(w.q(".context-menu").classList.contains("hidden"), "context menu closed once the picker opened");
  ok(!pickBody(w).classList.contains("hidden"), "PICK block visible");
  ok(manageBody(w).classList.contains("hidden"), "MANAGE block hidden");
  ok(spaceOverlay(w).textContent.includes("Move "), "picker title set");
  ok(spaceOverlay(w).textContent.includes("Anna Doe"), "title names the conversation");
  ok(w.qa(".person-row", pickBody(w)).some((r) => r.textContent.includes("No space")), "the No-space row is always offered");

  w.fire(w.q(".modal-close", spaceOverlay(w)), "click");
  ok(spaceOverlay(w).classList.contains("hidden"), "the ✕ button closes the modal");
});

test("spaces: create-and-move parks the conversation under the new space", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME });
  toggleSection(w, "Direct messages");
  openPicker(w, "Anna Doe");
  const input = w.q("input.modal-input", pickBody(w));
  input.value = "Work";
  w.fire(input, "keydown", { key: "Enter" });

  const saved = savedSpaces();
  eq(saved.length, 1, "one space persisted");
  eq(saved[0].name, "Work", "space name persisted (trimmed)");
  eq(JSON.stringify(saved[0].channelIds), JSON.stringify(["c1"]), "conversation assigned");
  ok(spaceOverlay(w).classList.contains("hidden"), "modal closed after create");

  const header = sectionTitle(w, "Work · 1");
  ok(header, '"Work · 1" section header rendered');
  w.fire(header, "click"); // spaces start folded
  const inSpace = w.qa(".channel-item", sectionOf(sectionTitle(w, "Work · 1")));
  eq(inSpace.length, 1, "one row inside the space section");
  ok(inSpace[0].textContent.includes("Anna Doe"), "the conversation sits in its space");
  const inDefault = w.qa(".channel-item", sectionOf(sectionTitle(w, "Direct messages")));
  ok(!inDefault.some((r) => r.textContent.includes("Anna Doe")), "… and no longer under Direct messages");
});

test("spaces: blank names are rejected (nothing created, modal stays open)", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME });
  toggleSection(w, "Direct messages");
  openPicker(w, "Anna Doe");
  const input = w.q("input.modal-input", pickBody(w));
  input.value = "   ";
  w.fire(input, "keydown", { key: "Enter" });
  eq(localStorage.getItem("rustermost.spaces"), null, "blank name persists nothing");
  ok(!spaceOverlay(w).classList.contains("hidden"), "modal stays open");
  eq(sectionTitles(w).length, 3, "no space section created (only the default sections)");
});

test("spaces: a second conversation joins via the pick-list row (✓ tracks it)", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME });
  toggleSection(w, "Direct messages");
  openPicker(w, "Anna Doe");
  const input = w.q("input.modal-input", pickBody(w));
  input.value = "Work";
  w.fire(w.q("button.modal-primary", pickBody(w)), "click"); // click path (not Enter)

  openPicker(w, "Bob Ray");
  let workRow = w.qa(".person-row", pickBody(w)).find((r) => r.textContent.includes("Work"));
  ok(workRow, "existing space listed in the picker");
  ok(!workRow.textContent.includes("✓"), "no ✓ for a conversation that isn't in the space");
  w.fire(workRow, "click");
  ok(spaceOverlay(w).classList.contains("hidden"), "modal closed after picking");
  ok(sectionTitle(w, "Work · 2"), "header count bumped to 2");
  const saved = savedSpaces();
  eq(JSON.stringify(saved[0].channelIds), JSON.stringify(["c1", "c2"]), "both assigned, arrival order");

  toggleSection(w, "Work · 2"); // Bob's row now lives under the (folded) space
  openPicker(w, "Bob Ray");
  workRow = w.qa(".person-row", pickBody(w)).find((r) => r.textContent.includes("Work"));
  ok(workRow.textContent.includes("✓"), "✓ marks the conversation's current space");
});

test("spaces: sections start folded; click unfolds; search force-opens", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME, seeds: WORK_SEED });
  ok(sectionTitle(w, "Work · 1"), "space section rendered at boot");
  ok(!rowNamed(w, "Anna Doe"), "folded: the row renders nowhere (it left its default section)");

  toggleSection(w, "Work");
  ok(rowNamed(w, "Anna Doe"), "visible after unfolding");
  toggleSection(w, "Work");
  ok(!rowNamed(w, "Anna Doe"), "hidden again after refolding");

  w.el("search-input").value = "anna";
  w.fire("search-input", "input");
  ok(rowNamed(w, "Anna Doe"), "a matching query force-opens the space");
  w.el("search-input").value = "";
  w.fire("search-input", "input");
  ok(!rowNamed(w, "Anna Doe"), "folds again once the query clears");
});

test("spaces: 'No space' sends it back; an emptied space never vanishes", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME, seeds: WORK_SEED });
  toggleSection(w, "Work");
  openPicker(w, "Anna Doe");
  const noneRow = w.qa(".person-row", pickBody(w)).find((r) => r.textContent.includes("No space"));
  ok(noneRow, "No-space row offered");
  w.fire(noneRow, "click");

  ok(sectionTitle(w, "Work · 0"), "space header now counts zero");
  const sec = sectionOf(sectionTitle(w, "Work · 0")); // still unfolded from above
  const emptyRow = w.q(".list-empty", sec);
  ok(emptyRow && emptyRow.textContent === "Nothing here.", "empty space still renders, with the standard empty row");
  const saved = savedSpaces();
  eq(saved.length, 1, "the emptied space is kept");
  eq(JSON.stringify(saved[0].channelIds), "[]", "membership removed");

  toggleSection(w, "Direct messages");
  const inDefault = w.qa(".channel-item", sectionOf(sectionTitle(w, "Direct messages")));
  ok(inDefault.some((r) => r.textContent.includes("Anna Doe")), "conversation reappears under its default section");
});

test("spaces: right-click a space header manages it — rename (blank rejected)", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME, seeds: WORK_SEED });
  w.fire(sectionTitle(w, "Work · 1"), "contextmenu", { clientX: 15, clientY: 15 });

  ok(!spaceOverlay(w).classList.contains("hidden"), "space modal opened");
  ok(!manageBody(w).classList.contains("hidden"), "MANAGE block visible");
  ok(pickBody(w).classList.contains("hidden"), "PICK block hidden in manage mode");
  ok(spaceOverlay(w).textContent.includes("Space: Work"), "title names the space");
  const input = w.q("input.modal-input", manageBody(w));
  eq(input.value, "Work", "field prefilled with the current name");

  input.value = "   ";
  w.fire(input, "keydown", { key: "Enter" });
  ok(sectionTitle(w, "Work · 1"), "blank rename rejected, header unchanged");
  ok(!spaceOverlay(w).classList.contains("hidden"), "modal stays open on a rejected rename");

  input.value = "Ops";
  w.fire(w.q("button.modal-primary", manageBody(w)), "click"); // Rename
  ok(spaceOverlay(w).classList.contains("hidden"), "modal closed after rename");
  ok(sectionTitle(w, "Ops · 1"), "header renamed");
  eq(savedSpaces()[0].name, "Ops", "rename persisted");
});

test("spaces: Delete space drops the section, conversations fall back", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME, seeds: WORK_SEED });
  w.fire(sectionTitle(w, "Work · 1"), "contextmenu", { clientX: 15, clientY: 15 });
  w.fire(w.q("button.modal-danger", manageBody(w)), "click");

  ok(spaceOverlay(w).classList.contains("hidden"), "modal closed after delete");
  ok(!sectionTitles(w).some((t) => t.textContent.includes("Work")), "space section gone");
  eq(savedSpaces().length, 0, "deletion persisted");
  toggleSection(w, "Direct messages");
  ok(rowNamed(w, "Anna Doe"), "conversation back under its default section");
});

test("spaces: seeded spaces render at boot; garbage seeds load as none", async () => {
  const seeded = await boot({
    channels: CHANNELS, users: USERS, me: ME,
    seeds: { "rustermost.spaces": JSON.stringify([{ id: "s1", name: "Pinned", channelIds: ["c1", "c3"] }]) },
  });
  ok(sectionTitle(seeded, "Pinned · 2"), "seeded space renders at boot with its count");
  toggleSection(seeded, "Pinned");
  eq(seeded.qa(".channel-item", sectionOf(sectionTitle(seeded, "Pinned · 2"))).length, 2, "both seeded conversations listed");

  for (const bad of ["[]", "not json", '{"x":1}', '[{"id":"s9","name":7,"channelIds":[]},{"id":"s8","name":"Half","channelIds":"oops"}]']) {
    const w = await boot({ channels: CHANNELS, users: USERS, me: ME, seeds: { "rustermost.spaces": bad } });
    ok(sectionTitle(w, "Direct messages"), `default sections render with garbage seed ${JSON.stringify(bad)}`);
    ok(!sectionTitles(w).some((t) => /Pinned|Half/.test(t.textContent)), "no space section from garbage");
    eq(sectionTitles(w).length, 3, "only the three default sections");
  }
});

test("spaces: an unread spaced conversation also stays in pinned Unread", async () => {
  const chans = CHANNELS.map((c) => ({ ...c }));
  chans[0] = { ...chans[0], total_msg_count: 7, member: { msg_count: 5 } }; // c1: 2 unread
  const w = await boot({ channels: chans, users: USERS, me: ME, seeds: WORK_SEED });

  const unreadTitle = sectionTitle(w, "Unread · 1");
  ok(unreadTitle, "pinned Unread section shows the spaced conversation");
  ok(!unreadTitle.textContent.includes("Work"), "Unread is pinned separately, above the space");
  const inUnread = w.qa(".channel-item", sectionOf(unreadTitle));
  ok(inUnread.some((r) => r.textContent.includes("Anna Doe")), "row present under Unread (kept despite the space)");

  toggleSection(w, "Work"); // spaces start folded
  eq(channelRows(w).filter((r) => r.textContent.includes("Anna Doe")).length, 2, "by design: Unread + space both list it");
});

test("spaces: Escape and a backdrop click both close the modal", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME });
  toggleSection(w, "Direct messages");

  openPicker(w, "Anna Doe");
  w.fire(w.q("input.modal-input", pickBody(w)), "keydown", { key: "Escape" });
  ok(spaceOverlay(w).classList.contains("hidden"), "Escape closes the modal");

  openPicker(w, "Anna Doe");
  w.fire(spaceOverlay(w), "click"); // target === overlay → backdrop
  ok(spaceOverlay(w).classList.contains("hidden"), "backdrop click closes the modal");
});

// ================= CREATE-from-background + DRAG & DROP =================
// The CREATE block is the one .modal-body offering a "Create space" button.
const createBody = (w) => w.qa(".modal-body", spaceOverlay(w)).find((b) => b.textContent.includes("Create space"));

// Minimal DataTransfer stand-in; plain-object assignment of effectAllowed /
// dropEffect must not throw. The app's real source of truth is module-level,
// so half the drags below don't even need this — browsers may expose it only
// at drop time, and degenerate environments may lack it entirely.
const fakeDt = () => ({
  data: {},
  setData(k, v) { this.data[k] = v; },
  getData(k) { return this.data[k]; },
});

// Right-click the empty sidebar background and pick "🗂  New space…".
function openCreate(w) {
  w.fire(w.el("channel-list"), "contextmenu", { clientX: 30, clientY: 700 });
  const menu = w.q(".context-menu");
  ok(menu && !menu.classList.contains("hidden"), "background context menu opened");
  const row = w.qa(".context-menu-row", menu).find((r) => r.textContent.includes("New space"));
  ok(row, "background menu offers a New-space row");
  w.fire(row, "mousedown");
  return menu;
}

test("spaces: right-clicking empty sidebar offers New space… → CREATE mode", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME });
  const menu = openCreate(w); // asserts the menu + row along the way

  ok(menu.classList.contains("hidden"), "menu closed once the row was picked");
  ok(!spaceOverlay(w).classList.contains("hidden"), "space modal shown");
  ok(pickBody(w).classList.contains("hidden"), "PICK block hidden in CREATE mode");
  ok(manageBody(w).classList.contains("hidden"), "MANAGE block hidden in CREATE mode");
  ok(createBody(w) && !createBody(w).classList.contains("hidden"), "CREATE block visible");
  eq(w.q(".modal-title", spaceOverlay(w)).textContent, "New space", "modal title set");
  const input = w.q("input.modal-input", createBody(w));
  eq(input.placeholder, "New space name…", "placeholder set");
  eq(input.value, "", "name field starts empty");

  w.fire(input, "keydown", { key: "Enter" }); // blank first
  eq(localStorage.getItem("rustermost.spaces"), null, "blank name creates nothing");
  ok(!spaceOverlay(w).classList.contains("hidden"), "modal stays open on a blank name");

  input.value = "Ideas";
  w.fire(input, "keydown", { key: "Enter" });
  ok(spaceOverlay(w).classList.contains("hidden"), "modal closed after create");
  const saved = savedSpaces();
  eq(saved.length, 1, "space persisted");
  eq(saved[0].name, "Ideas", "name persisted");
  eq(JSON.stringify(saved[0].channelIds), "[]", "no assignment target — created empty");

  const header = sectionTitle(w, "Ideas · 0");
  ok(header, "a folded 'Ideas · 0' section appears in the sidebar");
  eq(w.q(".chevron", header).textContent, "▸", "collapsed chevron");
  eq(w.qa(".channel-item", sectionOf(header)).length, 0, "folded: no rows rendered");
});

test("spaces: right-click on a conversation row still opens ITS menu", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME });
  toggleSection(w, "Direct messages");
  w.fire(rowNamed(w, "Anna Doe"), "contextmenu", { clientX: 20, clientY: 20 });

  const menu = w.q(".context-menu");
  ok(!menu.classList.contains("hidden"), "context menu opened");
  const labels = w.qa(".context-menu-row", menu).map((r) => r.textContent);
  eq(labels.length, 2, "exactly one menu-open outcome: the two conversation rows");
  ok(labels.some((t) => t.includes("Silence conversation")), "silence row present");
  ok(labels.some((t) => t.includes("Move to space…")), "move-to-space row present");
  ok(!labels.some((t) => t.includes("New space")), "background row kept out of the row menu");
  ok(spaceOverlay(w).classList.contains("hidden"), "no space modal opened");
});

test("spaces: right-click on a space header opens MANAGE, not the background menu", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME, seeds: WORK_SEED });
  const header = sectionTitle(w, "Work · 1");
  ok(header.classList.contains("space-title"), "space header carries the space-title marker");
  w.fire(header, "contextmenu", { clientX: 15, clientY: 15 });

  ok(!spaceOverlay(w).classList.contains("hidden"), "space modal opened");
  ok(!manageBody(w).classList.contains("hidden"), "MANAGE block visible");
  ok(w.q(".context-menu").classList.contains("hidden"), "background menu stayed closed");
});

test("spaces: drag onto a folded space HEADER assigns the conversation", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME, seeds: WORK_SEED });
  toggleSection(w, "Direct messages");
  const row = rowNamed(w, "Bob Ray"); // c2 — Work holds only c1, and is folded
  const header = sectionTitle(w, "Work · 1");
  const dt = fakeDt();

  w.fire(row, "dragstart", { dataTransfer: dt });
  eq(dt.data["text/plain"], "c2", "dataTransfer primed for real-world interop");
  ok(row.classList.contains("drag-source"), "row marked as the drag source");

  let ev = w.fire(header, "dragover", { dataTransfer: dt });
  ok(ev.defaultPrevented, "dragover on a space header allows the drop");
  eq(dt.dropEffect, "move", "dropEffect set");
  ok(header.classList.contains("drop-target"), "header highlighted");

  w.fire(header, "dragleave");
  ok(!header.classList.contains("drop-target"), "dragleave removes the highlight");

  ev = w.fire(header, "dragover", { dataTransfer: dt });
  ok(ev.defaultPrevented, "dragover again before the drop");
  ev = w.fire(header, "drop", { dataTransfer: dt });
  ok(ev.defaultPrevented, "drop handled");
  ok(!header.classList.contains("drop-target"), "highlight removed on drop");
  eq(JSON.stringify(savedSpaces()[0].channelIds), JSON.stringify(["c1", "c2"]), "assignment persisted, arrival order");

  // Re-render happened on drop; re-query everything.
  toggleSection(w, "Work · 2"); // still folded after the drop
  const inSpace = w.qa(".channel-item", sectionOf(sectionTitle(w, "Work · 2")));
  ok(inSpace.some((r) => r.textContent.includes("Bob Ray")), "conversation rendered under the space");
  const inDefault = w.qa(".channel-item", sectionOf(sectionTitle(w, "Direct messages")));
  ok(!inDefault.some((r) => r.textContent.includes("Bob Ray")), "… and removed from its default section");
  w.fire(row, "dragend");
});

test("spaces: drag onto an open space's SECTION BODY assigns the same way", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME, seeds: WORK_SEED });
  toggleSection(w, "Work");
  toggleSection(w, "Groups");
  const dragged = rowNamed(w, "Book Club"); // c3
  const innerRow = rowNamed(w, "Anna Doe"); // a row inside the open section
  const sec = sectionOf(sectionTitle(w, "Work · 1"));
  const dt = fakeDt();

  w.fire(dragged, "dragstart", { dataTransfer: dt });
  let ev = w.fire(innerRow, "dragover", { dataTransfer: dt }); // bubbles to the section
  ok(ev.defaultPrevented, "drop allowed over the section body");
  ok(sec.classList.contains("drop-target"), "section body highlighted");
  w.fire(sec, "dragleave");
  ok(!sec.classList.contains("drop-target"), "dragleave clears the section too");

  ev = w.fire(innerRow, "dragover", { dataTransfer: dt });
  ok(ev.defaultPrevented, "hovered again");
  w.fire(innerRow, "drop", { dataTransfer: dt });
  eq(JSON.stringify(savedSpaces()[0].channelIds), JSON.stringify(["c1", "c3"]), "assigned via the section body");
  ok(sectionTitle(w, "Work · 2"), "count bumped");
  const inGroups = w.qa(".channel-item", sectionOf(sectionTitle(w, "Groups")));
  ok(!inGroups.some((r) => r.textContent.includes("Book Club")), "gone from Groups");
  w.fire(dragged, "dragend");
});

test("spaces: drag onto the matching default section header takes it back out", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME, seeds: WORK_SEED });
  toggleSection(w, "Work");
  const row = rowNamed(w, "Anna Doe"); // c1, type D
  const dmHeader = sectionTitle(w, "Direct messages"); // folded — headers are always targets
  const dt = fakeDt();

  w.fire(row, "dragstart", { dataTransfer: dt });
  const ev = w.fire(dmHeader, "dragover", { dataTransfer: dt });
  ok(ev.defaultPrevented, "a DM may drop on the Direct messages header");
  w.fire(dmHeader, "drop", { dataTransfer: dt });

  eq(JSON.stringify(savedSpaces()[0].channelIds), "[]", "membership removed");
  ok(sectionTitle(w, "Work · 0"), "emptied space never vanishes");
  ok(!sectionOf(sectionTitle(w, "Work · 0")).textContent.includes("Anna Doe"), "gone from the space");
  toggleSection(w, "Direct messages");
  const inDefault = w.qa(".channel-item", sectionOf(sectionTitle(w, "Direct messages")));
  ok(inDefault.some((r) => r.textContent.includes("Anna Doe")), "back in its default section");
  w.fire(row, "dragend");
});

test("spaces: a DM dragged over the Community header is refused", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME });
  toggleSection(w, "Direct messages");
  const row = rowNamed(w, "Anna Doe"); // type D
  const dt = fakeDt();

  w.fire(row, "dragstart", { dataTransfer: dt });
  const header = sectionTitle(w, "Community");
  const ev = w.fire(header, "dragover", { dataTransfer: dt });
  ok(!ev.defaultPrevented, "dragover NOT prevented — native no-drop cursor");
  ok(!header.classList.contains("drop-target"), "no highlight on a refused target");

  w.fire(header, "drop", { dataTransfer: dt }); // even a forced drop …
  eq(localStorage.getItem("rustermost.spaces"), null, "… does nothing (never even persisted)");
  ok(rowNamed(w, "Anna Doe"), "conversation unmoved (the DM section was never re-rendered)");
  w.fire(row, "dragend");
});

test("spaces: the pinned Unread header is never a drop target", async () => {
  const chans = CHANNELS.map((c) => ({ ...c }));
  chans[0] = { ...chans[0], total_msg_count: 7, member: { msg_count: 5 } }; // c1: 2 unread
  const w = await boot({ channels: chans, users: USERS, me: ME });
  const unreadHeader = sectionTitle(w, "Unread · 1");
  ok(unreadHeader, "pinned Unread section rendered");
  toggleSection(w, "Direct messages");
  const row = rowNamed(w, "Bob Ray");
  const dt = fakeDt();

  w.fire(row, "dragstart", { dataTransfer: dt });
  const ev = w.fire(unreadHeader, "dragover", { dataTransfer: dt });
  ok(!ev.defaultPrevented, "dragover on Unread is not prevented");
  ok(!unreadHeader.classList.contains("drop-target"), "no highlight");
  w.fire(unreadHeader, "drop", { dataTransfer: dt });
  ok(sectionTitle(w, "Direct messages"), "sidebar unchanged after a drop on Unread");
  eq(localStorage.getItem("rustermost.spaces"), null, "nothing persisted");
  w.fire(row, "dragend");
});

test("spaces: dragend cleans up — no drag classes survive a drop or a cancel", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME, seeds: WORK_SEED });
  toggleSection(w, "Direct messages");
  const list = () => w.el("channel-list");
  const noDragClasses = () =>
    w.qa(".drop-target", list()).length === 0 && w.qa(".drag-source", list()).length === 0;

  // Plain dragstart + dragend, no drop — and no dataTransfer at all.
  const row = rowNamed(w, "Bob Ray");
  w.fire(row, "dragstart");
  ok(row.classList.contains("drag-source"), "source marked even without dataTransfer (guard held)");
  w.fire(row, "dragend");
  ok(!row.classList.contains("drag-source"), "drag-source removed by dragend");
  ok(noDragClasses(), "a cancelled drag leaves nothing behind");

  // Mid-drag highlight, then cancelled: the stranded tint must be swept too.
  const dt = fakeDt();
  w.fire(row, "dragstart", { dataTransfer: dt });
  const dmHeader = sectionTitle(w, "Direct messages");
  w.fire(dmHeader, "dragover", { dataTransfer: dt });
  ok(dmHeader.classList.contains("drop-target"), "header highlighted mid-drag");
  w.fire(row, "dragend");
  ok(noDragClasses(), "cancel sweeps the stranded highlight");

  // A completed drop leaves no classes on the freshly re-rendered sidebar.
  const dt2 = fakeDt();
  w.fire(row, "dragstart", { dataTransfer: dt2 });
  const workHeader = sectionTitle(w, "Work · 1");
  w.fire(workHeader, "dragover", { dataTransfer: dt2 });
  w.fire(workHeader, "drop", { dataTransfer: dt2 });
  eq(JSON.stringify(savedSpaces()[0].channelIds), JSON.stringify(["c1", "c2"]), "the drop itself still landed");
  w.fire(row, "dragend");
  ok(noDragClasses(), "post-drop render carries no drag classes (fresh query)");
});

test("spaces: CREATE/PICK mode switches reset the modal fully", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME });
  toggleSection(w, "Direct messages");

  // CREATE, type a name, abandon with Escape.
  openCreate(w);
  const newInput = () => w.q("input.modal-input", createBody(w));
  newInput().value = "Draft";
  w.fire(newInput(), "keydown", { key: "Escape" });
  ok(spaceOverlay(w).classList.contains("hidden"), "Escape closes CREATE too");

  // Switch to PICK: its block rebuilt+shown, CREATE hidden, both fields empty.
  openPicker(w, "Anna Doe");
  ok(!pickBody(w).classList.contains("hidden"), "PICK visible again");
  ok(createBody(w).classList.contains("hidden"), "CREATE hidden in PICK mode");
  eq(w.q("input.modal-input", pickBody(w)).value, "", "PICK field reset");
  eq(newInput().value, "", "the abandoned draft is gone too");
  ok(w.qa(".person-row", pickBody(w)).some((r) => r.textContent.includes("No space")), "pick list rebuilt");
  w.fire(w.q(".modal-close", spaceOverlay(w)), "click");

  // And back to CREATE for a real creation via the button (not Enter).
  openCreate(w);
  ok(!createBody(w).classList.contains("hidden"), "CREATE visible again");
  eq(w.q(".modal-title", spaceOverlay(w)).textContent, "New space", "title reset to CREATE");
  eq(newInput().value, "", "CREATE field empty on reopen");
  eq(w.q("input.modal-input", pickBody(w)).value, "", "PICK field untouched");
  newInput().value = "Actual";
  w.fire(w.q("button.modal-primary", createBody(w)), "click");
  ok(spaceOverlay(w).classList.contains("hidden"), "modal closed after button create");
  eq(savedSpaces()[0].name, "Actual", "created via the button");
  ok(sectionTitle(w, "Actual · 0"), "new empty section rendered");
});
