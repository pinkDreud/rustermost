// tests/fe/sidebar-spaces.test.mjs — sidebar "spaces": user-named custom
// conversation sections (Firefox tab-group style).
//
// Covers: the channel-menu "Move to space…" entry and the picker modal,
// create-and-move (incl. persisting), assigning via the pick list (✓ marks
// the current space), fold/unfold + search force-open, the "No space" way
// back (an emptied space never vanishes), manage mode (rename incl. rejecting
// blanks, delete), seeded + garbage persistence, and the by-design duplicate
// of an unread spaced conversation in the pinned Unread section.

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
