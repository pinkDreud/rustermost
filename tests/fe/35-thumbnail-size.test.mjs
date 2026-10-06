// tests/fe/35-thumbnail-size.test.mjs — issue #35 "Configurable thumbnail size".
//
// Inline image attachments were hard-capped at 260px; the thumbSize setting
// (small 180 / medium 260 / large 360) makes the cap configurable. main.js
// applies it as the --thumb-size CSS variable on <html> (styles.css falls
// back to 260px when unset); the modal seg is auto-wired through the generic
// .option-seg handler once the setting is in SETTINGS_VALUES.

import { test, ok, eq, boot, flush } from "../harness.mjs";

const thumbVar = (w) => w.document.documentElement.style["--thumb-size"];
const thumbSegBtn = (w, value) => w.qa('[data-setting="thumbSize"] .seg-btn').find((b) => b.dataset.value === value);

test("a corrupt persisted thumbSize falls back to the medium 260px", async () => {
  const w = await boot({ seeds: { "rustermost.settings": JSON.stringify({ thumbSize: "huge" }) } });
  eq(thumbVar(w), "260px", "invalid persisted value falls back to the medium default");
});

test("clicking the Large seg-btn applies 360px and persists the choice", async () => {
  const w = await boot();
  eq(thumbVar(w), "260px", "default boot applies the medium size");
  w.fire(thumbSegBtn(w, "large"), "click");
  await flush();
  eq(thumbVar(w), "360px", "Large applies --thumb-size: 360px");
  const saved = JSON.parse(globalThis.localStorage.getItem("rustermost.settings"));
  eq(saved.thumbSize, "large", "thumbSize persisted to settings");
});

test("boot seeded with thumbSize small applies 180px", async () => {
  const w = await boot({ seeds: { "rustermost.settings": JSON.stringify({ thumbSize: "small" }) } });
  eq(thumbVar(w), "180px", "persisted small applies --thumb-size: 180px at boot");
});

test("opening the settings modal marks the persisted thumbSize seg-btn active", async () => {
  const w = await boot({ seeds: { "rustermost.settings": JSON.stringify({ thumbSize: "large" }) } });
  w.fire("settings-btn", "click"); // renderSettingsControls syncs the modal UI
  ok(thumbSegBtn(w, "large").classList.contains("active"), "persisted Large is active in the modal");
  ok(!thumbSegBtn(w, "medium").classList.contains("active"), "Medium is not active");
});
