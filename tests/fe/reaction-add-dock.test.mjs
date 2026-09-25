// tests/fe/reaction-add-dock.test.mjs — empty-reactions "+" dock side.
//
// The empty reactions strip (only the hover-revealed "+") is absolutely
// positioned so it docks beside the balloon instead of stretching the gap
// under it (#16). It used to always dock in the avatar-side gutter — straight
// on top of the avatar whenever the bubble was a line or two short. Ungrouped
// rows now dock at the corner OPPOSITE the avatar; grouped rows keep the old
// gutter dock because their avatar is only visibility:hidden (overlaps
// nothing) and the grouped-only corner timestamp (.msg-stamp) already owns
// the avatar-free corner — a corner-docked "+" would collide with it.
// Source pins: the four dock rules in src/styles.css.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, ok } from "../harness.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(path.join(root, "src", "styles.css"), "utf8");

// Body of the one rule whose selector is exactly `selector` (selectors are
// unique in the file), or "" when absent.
const ruleBody = (selector) => {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}");
  const m = css.match(re);
  return m ? m[1] : "";
};

test("empty reactions strip: base rule still docks absolutely", () => {
  const body = ruleBody(".msg-row .reactions:not(.with-pills)");
  ok(body.includes("position: absolute"), "base empty-strip rule keeps position: absolute");
});

test("ungrouped rows dock the '+' at the corner OPPOSITE the avatar", () => {
  // Others' avatar sits on the LEFT, so their "+" goes RIGHT of the column.
  ok(
    ruleBody(".msg-row:not(.grouped) .msg-other .reactions:not(.with-pills)").includes("left: 100%"),
    "ungrouped msg-other: left: 100% (right of the column, away from the left avatar)",
  );
  // My avatar sits on the RIGHT, mirrored.
  ok(
    ruleBody(".msg-row:not(.grouped) .msg-me .reactions:not(.with-pills)").includes("right: 100%"),
    "ungrouped msg-me: right: 100% (left of the column, away from the right avatar)",
  );
});

test("grouped rows keep the gutter dock (corner is taken by .msg-stamp)", () => {
  ok(
    ruleBody(".msg-row.grouped .msg-other .reactions:not(.with-pills)").includes("right: 100%"),
    "grouped msg-other: right: 100% (hidden-avatar gutter, stamp owns the other corner)",
  );
  ok(
    ruleBody(".msg-row.grouped .msg-me .reactions:not(.with-pills)").includes("left: 100%"),
    "grouped msg-me: left: 100% (hidden-avatar gutter, stamp owns the other corner)",
  );
});
