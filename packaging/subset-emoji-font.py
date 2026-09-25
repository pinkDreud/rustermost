#!/usr/bin/env python3
"""Subset the bundled Twemoji Mozilla emoji font.

src/fonts/twemoji-mozilla.woff2 ships as a SUBSET of the full upstream font
(twemoji-colr-font@15.0.3): the full build covers every emoji in Unicode and
weighs ~465 KB while the picker catalog (src/emoji-data.js) plus the app's
own chrome glyphs need a few hundred. This script regenerates the subset:

    python3 -m venv /tmp/fontenv
    /tmp/fontenv/bin/pip install fonttools brotli   # brotli = woff2 support
    /tmp/fontenv/bin/python packaging/subset-emoji-font.py <input> <output>

<input> is the FULL upstream Twemoji.Mozilla.woff2, <output> the subset
(repo layout: overwrite src/fonts/twemoji-mozilla.woff2 with it).

Kept codepoints:
  - every emoji VALUE in the EMOJI table of src/emoji-data.js, all of their
    codepoints (so ZWJ / VS16 / keycap / regional-indicator sequences bring
    their components along — keycap ASCII bases and regional indicators are
    included only because the catalog actually contains such sequences),
  - the UI chrome glyphs below (buttons, menus, chips — audited from
    src/index.html + src/main.js; listed explicitly so the subset does not
    silently lose a UI glyph when the catalog is edited),
  - U+FE0F (variation selector) and U+200D (zero-width joiner), always.

Everything else falls back to the system emoji font — intended.

Requires fonttools (+ brotli for woff2); stdlib otherwise. Fails loudly if
the color tables (COLR/CPAL) do not survive the subset.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EMOJI_DATA = os.path.join(ROOT, "src", "emoji-data.js")

# UI chrome glyphs rendering through the emoji font, audited from
# src/index.html + src/main.js (re-audit when the chrome changes):
#   🙂  emoji-picker button            (index.html)
#   🔔  mute button / "Silence" menu   (index.html, main.js)
#   🔕  muted bell / menu              (main.js)
#   📎  attach button, file chips      (index.html, main.js)
#   🗂  "New/Move to space" menu rows  (main.js)
#   💬  empty-state logo               (index.html)
#   🖼️  image-fallback chip label      (main.js)
#   ✏️  "Edit message" menu row        (main.js)
CHROME = ["🙂", "🔔", "🔕", "📎", "🗂", "💬", "\U0001F5BC\uFE0F", "✏️"]

ALWAYS = [0xFE0F, 0x200D]  # variation selector-16, zero-width joiner


def js_unescape(s):
    """Decode a JS double-quoted string body (the catalog uses none of these,
    but stay correct if escapes ever appear)."""
    def repl(m):
        esc = m.group(1)
        if esc.startswith("u"):
            return chr(int(esc[1:], 16))
        if esc.startswith("x"):
            return chr(int(esc[1:], 16))
        return {"n": "\n", "t": "\t", "r": "\r"}.get(esc, esc)
    return re.sub(r"\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)", repl, s)


def catalog_codepoints():
    """Codepoints of every VALUE in the EMOJI table of src/emoji-data.js."""
    src = open(EMOJI_DATA, encoding="utf-8").read()
    # Values are the string literals following a colon in the object literal;
    # keys are ASCII identifiers, so every emoji value follows `: "`.
    values = [js_unescape(m) for m in re.findall(r':\s*"((?:[^"\\\n]|\\.)*)"', src)]
    cps = set()
    for v in values:
        cps.update(ord(c) for c in v)
    return cps, len(values)


def main():
    if len(sys.argv) != 3:
        sys.exit(f"usage: {sys.argv[0]} <input-woff2> <output-woff2>")
    in_path, out_path = sys.argv[1], sys.argv[2]

    from fontTools import subset
    from fontTools.ttLib import TTFont

    cps, n_values = catalog_codepoints()
    cps.update(ord(c) for g in CHROME for c in g)
    cps.update(ALWAYS)
    unicodes = ",".join(f"U+{cp:04X}" for cp in sorted(cps))
    print(f"catalog: {n_values} emoji values from {os.path.relpath(EMOJI_DATA)}")
    print(f"chrome:  {len(CHROME)} glyphs")
    print(f"total:   {len(cps)} codepoints")

    options = [
        f"--unicodes={unicodes}",
        "--flavor=woff2",
        "--no-hinting",
        "--desubroutinize",
        f"--output-file={out_path}",
        in_path,
    ]
    subset.main(options)

    # Validate: the color tables MUST survive, and the cmap must cover both
    # plain catalog glyphs and the components of sequence entries.
    font = TTFont(out_path)
    for tag in ("COLR", "CPAL"):
        if tag not in font:
            sys.exit(f"ERROR: {tag} table missing from the subset — NOT shipping this")
    cmap = font.getBestCmap()
    missing = [cp for cp in sorted(cps) if cp not in cmap]
    sample = [0x1F642, 0x1F604, 0x1F44D, 0x1F389]  # 🙂 😄 👍 🎉
    bad = [f"U+{cp:04X}" for cp in sample if cp not in cmap]
    if bad:
        sys.exit(f"ERROR: spot-check codepoints missing from cmap: {' '.join(bad)}")
    print(f"COLR v{font['COLR'].version} + CPAL present; glyphs: {font['maxp'].numGlyphs}; "
          f"cmap: {len(cmap)} entries ({len(missing)} requested codepoints not in upstream)")
    print(f"wrote {out_path}: {os.path.getsize(out_path)} bytes")


if __name__ == "__main__":
    main()
