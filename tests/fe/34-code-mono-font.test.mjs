// tests/fe/34-code-mono-font.test.mjs — issue #34: code blocks not monospaced.
//
// The issue (reported on Ubuntu/KDE/Wayland, i.e. WebKitGTK): fenced code
// blocks render misaligned — columned monospace text (an ipmitool sensor
// table) falls out of columns. On Linux none of ui-monospace / SF Mono /
// Menlo / Consolas resolve, and the runtime-registered "Rustermost Emoji"
// subset keeps cmap entries for the keycap ASCII bases (0-9, #, *), so
// per-glyph fallback drew digits from the emoji font — at emoji proportions,
// not monospace advance widths — before ever reaching generic monospace.
// Letters stayed monospace, digits didn't. The fix moves generic monospace
// before the emoji family in the .msg-body code stack (inline code inherits
// the same stack); genuine emoji still fall through. Static guard on the CSS
// so the order can't be "helpfully" flipped back.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, ok } from "../harness.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("34: code font stack puts monospace before the emoji subset font", () => {
  const css = readFileSync(path.join(root, "src", "styles.css"), "utf8");

  // Isolate the .msg-body code rule — .msg-body pre code only resets
  // background/padding, so fenced blocks inherit this same font-family.
  const rule = css.match(/\.msg-body\s+code\s*\{([^}]*)\}/);
  ok(rule, "found the .msg-body code rule");
  const family = rule && rule[1].match(/font-family\s*:\s*([^;]*);/);
  ok(family, "the .msg-body code rule declares a font-family");

  // Exact comma-separated entries — a bare indexOf("monospace") would match
  // inside "ui-monospace" and pass even with the buggy order.
  const entries = family[1].split(",").map((e) => e.trim().replace(/^["']+|["']+$/g, ""));
  const monoIdx = entries.indexOf("monospace");
  const emojiIdx = entries.indexOf("Rustermost Emoji");
  ok(monoIdx !== -1, "the stack contains the generic monospace entry");
  ok(emojiIdx !== -1, 'the stack contains the "Rustermost Emoji" family');
  ok(
    monoIdx !== -1 && emojiIdx !== -1 && monoIdx < emojiIdx,
    `generic monospace (entry ${monoIdx}) precedes "Rustermost Emoji" (entry ${emojiIdx})`,
  );
});
