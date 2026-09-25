// tests/fe/14-search-clear.test.mjs — issue #14: ✕ clear button on the search
// field, overlaid at its right edge.
//
// Covers: hidden while the field is empty, accessible non-submit markup,
// appears on typing and filters the sidebar, click clears the field + resets
// the filter (every conversation listed again) + returns focus to the input,
// the button hides again after clearing, and the sync happening inside
// renderSidebar means any render path re-agrees the icon with the field.

import { boot, test, ok, eq } from "../harness.mjs";

const ME = { id: "me1", username: "me", first_name: "Me", last_name: "" };

const CHANNELS = [
  // both fully read — nothing is pinned into Unread, so sections start folded
  { id: "c1", name: "town-square", display_name: "Town Square", type: "O", team_id: "", total_msg_count: 3, member: { msg_count: 3 } },
  { id: "c2", name: "u2__me1", display_name: "", type: "D", team_id: "", total_msg_count: 2, member: { msg_count: 2 } },
];
const USERS = { u2: { id: "u2", username: "anna", first_name: "Anna", last_name: "Doe" } };

function typeInSearch(w, text) {
  w.el("search-input").value = text;
  w.fire("search-input", "input");
}

function unfold(w, label) {
  const title = w.qa(".section-title", w.el("channel-list")).find((t) => t.textContent.includes(label));
  ok(title, `"${label}" section header rendered`);
  w.fire(title, "click");
}

test("14: clear button starts hidden and is an accessible non-submit button", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME });

  const btn = w.el("search-clear-btn");
  ok(btn, "clear button rendered");
  ok(btn.classList.contains("hidden"), "hidden while the field is empty");
  eq(btn.type, "button", 'type="button" — it can never submit a form');
  eq(btn["aria-label"], "Clear search", "screen-reader label present");
  eq(btn.textContent, "✕", "small × glyph");
});

test("14: typing shows the ✕ and filters; clicking clears, resets, refocuses", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME });
  const btn = w.el("search-clear-btn");
  const input = w.el("search-input");
  const rows = () => w.qa(".channel-item", w.el("channel-list"));

  // Unfold the two sections so both conversations render as rows (Community
  // nests its channels under a per-team sub-group, folded by default too).
  unfold(w, "Direct messages");
  unfold(w, "Community");
  unfold(w, "Other");
  eq(rows().length, 2, "both conversations listed before searching");
  ok(btn.classList.contains("hidden"), "✕ still hidden with an empty field");

  typeInSearch(w, "town");
  ok(!btn.classList.contains("hidden"), "✕ appears once there is text");
  eq(rows().length, 1, "filter narrows the list");
  ok(rows()[0].textContent.includes("Town Square"), "only the matching conversation remains");

  w.fire(btn, "click");
  eq(input.value, "", "click clears the field");
  ok(btn.classList.contains("hidden"), "✕ hides again once the field is empty");
  eq(rows().length, 2, "filter reset — every conversation listed again");
  eq(w.document.activeElement, input, "focus returns to the search field");
});

test("14: the icon can never disagree with the field across renders", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME });
  const btn = w.el("search-clear-btn");

  // Emptying the field by typing (select-all + delete) hides the button.
  typeInSearch(w, "anna");
  ok(!btn.classList.contains("hidden"), "✕ shown while there is a query");
  typeInSearch(w, "");
  ok(btn.classList.contains("hidden"), "✕ hidden when the text is deleted");

  // A value change that did NOT come through an input event (autofill, a
  // future restore-the-draft feature, …) is re-synced by the next sidebar
  // render from any source — here, folding a section.
  w.el("search-input").value = "anna";
  ok(btn.classList.contains("hidden"), "no render yet: nothing has re-synced");
  unfold(w, "Direct messages");
  ok(!btn.classList.contains("hidden"), "✕ appears after the next renderSidebar");
});

test("14: Escape empties the search field and keeps focus", async () => {
  const w = await boot({ channels: CHANNELS, users: USERS, me: ME });
  const btn = w.el("search-clear-btn");
  const input = w.el("search-input");
  const rows = () => w.qa(".channel-item", w.el("channel-list"));

  unfold(w, "Direct messages");
  unfold(w, "Community");
  unfold(w, "Other");
  eq(rows().length, 2, "both conversations listed before searching");

  typeInSearch(w, "town");
  ok(!btn.classList.contains("hidden"), "✕ appears once there is text");
  eq(rows().length, 1, "filter narrows the list");

  input.focus(); // Escape arrives while the user is typing in the field
  w.fire("search-input", "keydown", { key: "Escape" });
  eq(input.value, "", "Escape clears the field");
  ok(btn.classList.contains("hidden"), "✕ hides again once the field is empty");
  eq(rows().length, 2, "filter reset — every conversation listed again");
  eq(w.document.activeElement, input, "focus stays in the search field");

  w.fire("search-input", "keydown", { key: "Escape" });
  eq(input.value, "", "second Escape on an empty field is a harmless no-op");
  eq(rows().length, 2, "list still full");
  eq(w.document.activeElement, input, "focus still in the field");
});
