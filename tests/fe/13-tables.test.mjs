// tests/fe/13-tables.test.mjs — issue #13: GFM pipe tables.
//
// The issue: a table like
//   | a | b | c |
//   |---|---|---|
//   | α | β | γ |
//   | 1 | 2 | 3 |
// rendered as raw pipe text instead of a table like the native client shows.
// Covers detection, unicode cells, alignment, inline markdown inside cells,
// ragged rows, header-only tables, and the "not a table" cases (no delimiter,
// fences, header/delimiter column-count mismatch).

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
const tableOf = (w, id) => w.q(`.msg-row[data-post-id="${id}"] .msg-body table.md-table`);
const texts = (els) => els.map((el) => el.textContent).join("|");

test("13: the issue's table renders as a real table with unicode intact", async () => {
  const w = await bootWith(post("p1", "| a | b | c |\n|---|---|---|\n| α | β | γ |\n| 1 | 2 | 3 |"));

  const wrap = w.q(".table-wrap", bodyOf(w, "p1"));
  ok(wrap, "table wrapped in a .table-wrap scroller");
  const table = tableOf(w, "p1");
  ok(table, "semantic <table> rendered");

  const ths = w.qa("thead th", table);
  eq(ths.length, 3, "3 header cells");
  eq(texts(ths), "a|b|c", "header texts");

  const rows = w.qa("tbody tr", table);
  eq(rows.length, 2, "2 body rows");
  eq(texts(w.qa("td", rows[0])), "α|β|γ", "unicode row intact");
  eq(texts(w.qa("td", rows[1])), "1|2|3", "second row");
});

test("13: delimiter colons map to alignment classes on th and td", async () => {
  const w = await bootWith(post("p1", "| l | c | r |\n|:---|:---:|---:|\n| x | y | z |"));

  const table = tableOf(w, "p1");
  ok(table, "table rendered");
  const ths = w.qa("thead th", table);
  const tds = w.qa("tbody tr td", table);
  eq(ths.length, 3, "3 columns");
  eq(tds.length, 3, "3 cells in the body row");
  for (const [i, cls] of [["0", "align-left"], ["1", "align-center"], ["2", "align-right"]]) {
    ok(ths[+i].classList.contains(cls), `th ${i} carries .${cls}`);
    ok(tds[+i].classList.contains(cls), `td ${i} carries .${cls}`);
  }
});

test("13: bold, code and links inside cells still render as elements", async () => {
  const w = await bootWith(post("p1", "| Mix |\n|---|\n| **bold** `co` [lnk](https://example.org) |"));

  const td = w.q("tbody td", tableOf(w, "p1"));
  ok(td, "single body cell");
  eq(w.q("strong", td).textContent, "bold", "**bold** became <strong>");
  eq(w.q("code", td).textContent, "co", "`co` became <code>");
  const a = w.q("a", td);
  ok(a, "link became <a>");
  eq(a.textContent, "lnk", "link label");
  eq(a.href, "https://example.org", "link target");
});

test("13: pipe lines without a delimiter row stay plain text", async () => {
  const w = await bootWith(post("p1", "| a | b |\n| just a lone line |"));

  const body = bodyOf(w, "p1");
  ok(!w.q("table", body), "no table without a delimiter");
  ok(body.textContent.includes("| a | b |"), "first line kept verbatim");
  ok(body.textContent.includes("| just a lone line |"), "second line kept verbatim");
});

test("13: a delimiter with no body rows renders a header-only table", async () => {
  const w = await bootWith(post("p1", "| a | b |\n|---|---|"));

  const table = tableOf(w, "p1");
  ok(table, "table rendered from header + delimiter alone");
  eq(texts(w.qa("thead th", table)), "a|b", "headers intact");
  eq(w.qa("tbody tr", table).length, 0, "tbody empty, nothing crashed");
});

test("13: ragged rows — short rows pad with empty cells, long rows keep extras", async () => {
  const w = await bootWith(post("p1", "| a | b |\n|---|---|\n| one |\n| 1 | 2 | 3 |"));

  const rows = w.qa("tbody tr", tableOf(w, "p1"));
  eq(rows.length, 2, "both ragged rows rendered");
  const short = w.qa("td", rows[0]);
  eq(short.length, 2, "short row padded to the header's width");
  eq(texts(short), "one|", "padding cell is empty");
  const long = w.qa("td", rows[1]);
  eq(long.length, 3, "extra cell appended rather than dropped");
  eq(texts(long), "1|2|3", "extra content keeps its text");
});

test("13: a table interrupts plain text without swallowing it", async () => {
  const w = await bootWith(post("p1", "hello\n| a |\n|---|\n| b |\nbye"));

  const body = bodyOf(w, "p1");
  const table = tableOf(w, "p1");
  ok(table, "table rendered mid-message");
  eq(w.q("thead th", table).textContent, "a", "header");
  eq(w.q("tbody td", table).textContent, "b", "body cell");
  const kids = body.childNodes;
  eq(kids.length, 3, "exactly: text, table, text — no stray <br>");
  eq(kids[0].textContent, "hello", "text before the table kept, no br glued on");
  ok(kids[1].classList && kids[1].classList.contains("table-wrap"), "table sits between the texts");
  eq(kids[2].textContent, "bye", "text after the table kept");
});

test("13: pipe lines inside a fenced block do NOT become a table", async () => {
  const w = await bootWith(post("p1", "```\n| a |\n|---|\n```"));

  const body = bodyOf(w, "p1");
  ok(!w.q("table", body), "fences win over table detection");
  const pre = w.q("pre", body);
  ok(pre, "fenced block still rendered");
  ok(pre.textContent.includes("| a |"), "pipe line kept as code");
  ok(pre.textContent.includes("|---|"), "delimiter kept as code");
});

test("13: header/delimiter column-count mismatch stays plain text (GFM rule)", async () => {
  const w = await bootWith(post("p1", "| a | b |\n|---|---|---|\n| 1 | 2 | 3 |"));

  const body = bodyOf(w, "p1");
  ok(!w.q("table", body), "3-cell delimiter under a 2-cell header is not a table");
  ok(body.textContent.includes("|---|---|---|"), "mismatched delimiter kept verbatim");
});

test("13: short delimiter cells (--:, 1-2 dashes) still open a table (reported case)", async () => {
  const w = await bootWith(post("p1", "| Nome | Punti |\n| --- | --: |\n| Mastronikolis | 38 |\n| Scheulen | 35 |\n| Zanzottera | 36 |"));

  const table = tableOf(w, "p1");
  ok(table, "table rendered despite the 2-dash '--:' delimiter cell");

  const ths = w.qa("thead th", table);
  eq(ths.length, 2, "2 columns");
  eq(texts(ths), "Nome|Punti", "header texts");

  const rows = w.qa("tbody tr", table);
  eq(rows.length, 3, "3 data rows");
  eq(texts(w.qa("td", rows[0])), "Mastronikolis|38", "first body row");
  eq(texts(w.qa("td", rows[1])), "Scheulen|35", "second body row");
  eq(texts(w.qa("td", rows[2])), "Zanzottera|36", "third body row");

  ok(ths[1].classList.contains("align-right"), "Punti th carries .align-right (from '--:')");
  for (const [i, row] of rows.entries()) {
    ok(w.qa("td", row)[1].classList.contains("align-right"), `Punti td ${i} carries .align-right`);
  }
});
