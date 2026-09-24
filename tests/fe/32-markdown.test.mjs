// tests/fe/32-markdown.test.mjs — issue #32: full Mattermost markdown.
//
// The issue: several markdown forms the native client renders stayed raw
// text here — ATX headings (## Large Heading), nested bullets ("  + sub"
// as a second-order bullet), checklists (- [ ] / - [x] as ☐ / ☒) and
// horizontal rules (---, ___, ***). Covers each form with the issue's exact
// examples plus the precedence guards: --- under a pipe header is a table
// delimiter, ***bold*** stays inline, marker runs inside ``` fences stay
// literal code, and a fenced info string only lands as a lang-* class hook.

import { boot, test, ok, eq } from "../harness.mjs";

const ME = { id: "me1", username: "me", first_name: "Me", last_name: "" };
const CHANNELS = [
  // unread by one message → pinned in the unfolded Unread section at boot
  { id: "c1", name: "town-square", display_name: "Town Square", type: "O", team_id: "", total_msg_count: 20, member: { msg_count: 19 } },
];
const USERS = { u2: { id: "u2", username: "anna", first_name: "Anna", last_name: "Doe" } };

const post = (id, message) => ({ id, user_id: "u2", channel_id: "c1", message, create_at: 1728000000000 });

async function bootWith(...posts) {
  const w = await boot({ channels: CHANNELS, posts: { c1: posts }, users: USERS, me: ME });
  const row = w.qa(".channel-item").find((r) => r.textContent.includes("Town Square"));
  ok(row, "Town Square row rendered (unread → pinned Unread section)");
  w.fire(row, "click");
  await w.flush();
  return w;
}

const bodyOf = (w, id) => w.q(`.msg-row[data-post-id="${id}"] .msg-body`);
const tags = (els) => els.map((el) => el.tagName).join(",");

test("32: ATX headings map # → h2 … ###### → h6 (capped), one element per line", async () => {
  const w = await bootWith(
    post("p1", "# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six")
  );

  const body = bodyOf(w, "p1");
  eq(tags(body.children), "h2,h3,h4,h5,h6,h6", "marker runs become h(n+1), ###### caps at h6, no stray <br>");
  eq(body.children[0].textContent, "One", "h2 text");
  eq(body.children[2].textContent, "Three", "h4 text");
  eq(body.children[5].textContent, "Six", "capped h6 text");
});

test("32: heading content runs through inlineMd", async () => {
  const w = await bootWith(post("p1", "## **Big** deal :smile:"));

  const h = w.q("h3", bodyOf(w, "p1"));
  ok(h, "## became <h3>");
  eq(w.q("strong", h).textContent, "Big", "**bold** inside the heading is real <strong>");
  ok(h.textContent.includes("Big deal 😄"), "rest of the line stays inline (emoji resolved)");
});

test("32: '#tag' without whitespace stays plain text", async () => {
  const w = await bootWith(post("p1", "#nope\n###"));

  const body = bodyOf(w, "p1");
  eq(w.qa("h2", body).length + w.qa("h3", body).length + w.qa("h4", body).length, 0, "no heading without the marker+whitespace+content shape");
  ok(body.textContent.includes("#nope"), "hashtag kept verbatim");
  ok(body.textContent.includes("###"), "bare marker run kept verbatim");
});

test("32: the issue's nested bullet renders as a second-order sub-list", async () => {
  // Verbatim from the issue:
  //   - item one
  //   - item two
  //     + item two sub-point
  const w = await bootWith(post("p1", "- item one\n- item two\n  + item two sub-point"));

  const body = bodyOf(w, "p1");
  eq(tags(body.children), "ul", "one flat root list");
  const root = body.children[0];
  eq(root.children.length, 2, "two top-level items");
  eq(root.children[0].textContent, "item one", "first item");
  ok(!w.q("ul", root.children[0]), "first item has no sub-list");
  eq(root.children[1].childNodes[0].textContent, "item two", "second item's own text");
  const sub = w.q("ul", root.children[1]);
  ok(sub, "'+' sub-point nested as a second-order list inside its parent li");
  eq(sub.children.length, 1, "one sub-item");
  eq(sub.children[0].textContent, "item two sub-point", "sub-item text");
});

test("32: nesting mixes ul/ol three levels deep and dedents back out", async () => {
  const w = await bootWith(post("p1", "- a\n  1. b\n    - c\n- d"));

  const root = w.q("ul", bodyOf(w, "p1"));
  eq(root.children.length, 2, "root keeps its two top-level items after the excursion");
  eq(root.children[1].textContent, "d", "dedent across two frames returns to the root list");
  const ol = w.q("ol", root.children[0]);
  ok(ol, "ordered list nests inside the bullet item");
  eq(ol.children[0].childNodes[0].textContent, "b", "ordered sub-item");
  const deep = w.q("ul", ol.children[0]);
  ok(deep, "third level nests inside the ordered item");
  eq(deep.children[0].textContent, "c", "third-level item text");
});

test("32: checklists map [ ] → ☐ and [x]/[X] → ☒, display-only", async () => {
  // Verbatim from the issue: "- [ ] Item one / - [ ] Item two / - [x] Completed item"
  // plus the uppercase-X spelling.
  const w = await bootWith(post("p1", "- [ ] Item one\n- [ ] Item two\n- [x] Completed item\n- [X] Shouted done"));

  const body = bodyOf(w, "p1");
  const items = w.qa("li", body);
  eq(items.length, 4, "all four items rendered");
  const boxes = items.map((li) => w.q(".task-check", li));
  ok(boxes.every(Boolean), "every item carries a checkbox glyph span");
  for (const li of items) ok(li.classList.contains("task"), "item tagged .task so CSS can swap the bullet");
  eq(boxes[0].textContent, "\u2610", "open item gets ☐");
  eq(boxes[1].textContent, "\u2610", "second open item gets ☐");
  eq(boxes[2].textContent, "\u2612", "[x] gets ☒");
  eq(boxes[3].textContent, "\u2612", "uppercase [X] gets ☒");
  ok(items[0].textContent.includes("Item one"), "the label text survives the glyph swap");
  eq(w.qa("input", body).length, 0, "display-only — no interactive <input> cheaters");
});

test("32: checklist items nest like any bullet", async () => {
  const w = await bootWith(post("p1", "- [ ] parent\n  - [x] child"));

  const body = bodyOf(w, "p1");
  const root = w.q("ul", body);
  eq(root.children.length, 1, "one parent item");
  const sub = w.q("ul", root.children[0]);
  ok(sub, "task item nests a sub-list");
  eq(w.q(".task-check", root.children[0]).textContent, "\u2610", "parent is open");
  eq(w.q(".task-check", sub.children[0]).textContent, "\u2612", "nested child is done");
  ok(sub.children[0].textContent.includes("child"), "nested label intact");
});

test("32: the issue's three hr spellings separate the texts (no setext heading)", async () => {
  const w = await bootWith(
    post("p1", "text with a line below\n---\ntext with a line below\n___\ntext with a line below\n***\nmore text")
  );

  const body = bodyOf(w, "p1");
  const kids = body.childNodes;
  eq(kids.length, 7, "text and rule alternate with no stray <br>");
  eq(tags(kids.filter((_, idx) => idx % 2 === 1)), "hr,hr,hr", "---, ___ and *** all became <hr>");
  for (const idx of [0, 2, 4]) eq(kids[idx].textContent, "text with a line below", "the texts survive as plain text");
  eq(kids[6].textContent, "more text", "trailing text intact");
  eq(w.qa("h2", body).length, 0, "GFM setext deliberately NOT turned into a heading — the issue wants a rule");
});

test("32: spaced marker runs (- - - and friends) are horizontal rules too", async () => {
  const w = await bootWith(post("p1", "a\n- - -\nb\n* * *\nc\n_ _ _\nd"));

  const body = bodyOf(w, "p1");
  eq(w.qa("hr", body).length, 3, "all three spaced spellings became rules");
  eq(tags(body.children), "hr,hr,hr", "rules sit between the texts");
  eq(w.qa("li", body).length, 0, "'- - -' is NOT a bullet of dashes");
});

test("32: a --- row directly under a pipe header is a table delimiter, not an hr", async () => {
  const w = await bootWith(post("p1", "| a |\n---\n| 1 |"));

  const body = bodyOf(w, "p1");
  ok(w.q("table.md-table", body), "table lookahead still wins");
  eq(w.q("thead th", body).textContent, "a", "header cell");
  eq(w.q("tbody td", body).textContent, "1", "body row after the delimiter");
  eq(w.qa("hr", body).length, 0, "the delimiter row did not double as a rule");
});

test("32: ***bold*** stays inline formatting, not an hr", async () => {
  const w = await bootWith(post("p1", "***bold***"));

  const body = bodyOf(w, "p1");
  eq(w.qa("hr", body).length, 0, "a line WITH text is never a rule");
  eq(w.q("strong", body).textContent, "bold", "inline bold still renders");
});

test("32: marker lines inside a fenced block stay literal code", async () => {
  const w = await bootWith(post("p1", "```\n## not a heading\n---\n- [ ] not a task\n- not a bullet\n```"));

  const body = bodyOf(w, "p1");
  const pre = w.q("pre", body);
  ok(pre, "fenced block rendered");
  for (const line of ["## not a heading", "---", "- [ ] not a task", "- not a bullet"]) {
    ok(pre.textContent.includes(line), `"${line}" kept as code`);
  }
  eq(w.qa("h3", body).length + w.qa("hr", body).length + w.qa("li", body).length, 0, "no markdown parsed inside the fence");
});

test("32: a '+' sub-bullet doesn't break the following top-level '-' item", async () => {
  const w = await bootWith(post("p1", "- one\n  + sub\n- two"));

  const root = w.q("ul", bodyOf(w, "p1"));
  eq(root.children.length, 2, "dedent back to '-' lands in the SAME root list");
  eq(root.children[1].textContent, "two", "top-level item after the '+' sub-point");
  eq(w.q("ul li", root.children[0]).textContent, "sub", "the '+' line became the nested sub-item");
});

test("32: a blank line between list items doesn't swallow them", async () => {
  const w = await bootWith(post("p1", "- one\n\n- two"));

  const body = bodyOf(w, "p1");
  eq(tags(body.children), "ul", "the blank line merges into one loose list — no br, no drop");
  const items = w.qa("li", body);
  eq(items.length, 2, "both items rendered");
  eq(items[0].textContent, "one", "first item");
  eq(items[1].textContent, "two", "item after the blank line");
});

test("32: a fence info string lands as a lang-* class (no highlighting)", async () => {
  const w = await bootWith(post("p1", "```bash\nls -a\n```"));

  const pre = w.q("pre", bodyOf(w, "p1"));
  ok(pre, "fenced block rendered");
  ok(pre.classList.contains("lang-bash"), "info string stashed for future CSS");
  eq(pre.textContent, "ls -a", "code body untouched");
});

test("32: a tab indents like 4 spaces (nesting works with tabs)", async () => {
  const w = await bootWith(post("p1", "- a\n\t- b"));

  const body = bodyOf(w, "p1");
  const rootUl = body.children.find((el) => el.tagName === "ul");
  ok(rootUl, "root list rendered");
  const nested = w.q("ul ul", rootUl);
  ok(nested, "tab-indented item nests");
  eq(nested.textContent, "b", "nested item text");
});

test("32: switching marker kind at the same indent opens a sibling list (ul → ol)", async () => {
  const w = await bootWith(post("p1", "- a\n1. b"));

  const body = bodyOf(w, "p1");
  eq(tags(body.children), "ul,ol", "kind switch ends the ul and opens an ol");
  eq(w.q("ol", body).textContent, "b", "ordered item text");
});

test("32: two marker chars are NOT a rule (-- stays text, - - stays a bullet)", async () => {
  const w = await bootWith(post("p1", "-- still text\n- - one bullet"));

  const body = bodyOf(w, "p1");
  eq(w.qa("hr", body).length, 0, "short marker runs never become rules");
  ok(body.textContent.includes("-- still text"), "double dash kept verbatim");
  eq(w.qa("ul", body).length, 1, "spaced single dash is a list, not a rule");
});

test("32: a root list opened with leading indent stays its own list when a later item dedents past it", async () => {
  // A root item at indent N opens a root list there; dedenting BELOW that
  // indent can't merge into it, so a second root list opens (forgiving rule).
  const w = await bootWith(post("p1", "    - deep\n- top"));

  const body = bodyOf(w, "p1");
  const rootUls = body.children.filter((el) => el.tagName === "ul"); // direct children only
  eq(rootUls.length, 2, "two sibling root lists");
  eq(rootUls[0].textContent, "deep", "indented item first");
  eq(rootUls[1].textContent, "top", "dedented item gets its own root list");
});
