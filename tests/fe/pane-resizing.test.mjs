// tests/fe/pane-resizing.test.mjs — user-resizable sidebar and composer.
//
// Drag sashes: one on the sidebar's right edge, one on the composer's top
// edge. The sidebar width lives in a --sidebar-width CSS variable on <html>
// (clamped 200…560px); the composer size is a FLOOR the textarea's content
// auto-grow sits on top of — dragging below the 44px snap point (or
// double-clicking either sash) returns to pure auto-grow. Both persist in
// localStorage under the single JSON key rustermost.panes.
//
// Harness notes: boxes are zero-size, so a composer drag starts from the
// COMPOSER_SNAP fallback (44px), and scrollHeight is 0 → auto-grow height
// computes to "0px". window.innerHeight is 800 (the 0.6 cap = 480px).

import { boot, test, ok, eq } from "../harness.mjs";

const savedPanes = () => JSON.parse(localStorage.getItem("rustermost.panes"));
const sidebarVar = (w) => w.document.documentElement.style["--sidebar-width"];

test("panes: dragging the sidebar sash resizes the sidebar and saves on mouseup", async () => {
  const w = await boot();
  w.fire("sidebar-resizer", "mousedown", { clientX: 320 });
  w.fire(w.document, "mousemove", { clientX: 400 });
  eq(sidebarVar(w), "400px", "sidebar width follows the drag");
  eq(localStorage.getItem("rustermost.panes"), null, "nothing persisted while the drag is in flight");
  w.fire(w.document, "mouseup");
  eq(savedPanes().sidebar, 400, "sidebar width persisted on mouseup");
});

test("panes: the sidebar drag clamps at 560px on the right and 200px on the left", async () => {
  const w = await boot();
  w.fire("sidebar-resizer", "mousedown", { clientX: 320 });
  w.fire(w.document, "mousemove", { clientX: 2000 }); // way past every cap
  eq(sidebarVar(w), "560px", "clamped at the max width");
  w.fire(w.document, "mouseup");

  w.fire("sidebar-resizer", "mousedown", { clientX: 1000 });
  w.fire(w.document, "mousemove", { clientX: 0 }); // 560 - 1000 → way under the min
  eq(sidebarVar(w), "200px", "clamped at the min width");
  w.fire(w.document, "mouseup");
});

test("panes: double-clicking the sidebar sash resets to the default 320px", async () => {
  const w = await boot();
  w.fire("sidebar-resizer", "mousedown", { clientX: 320 });
  w.fire(w.document, "mousemove", { clientX: 400 });
  w.fire(w.document, "mouseup");
  eq(sidebarVar(w), "400px", "precondition: dragged away from the default");

  w.fire("sidebar-resizer", "dblclick");
  eq(sidebarVar(w), "320px", "reset to the default width");
  eq(savedPanes().sidebar, 320, "reset persisted");
});

test("panes: dragging the composer sash up raises the composer floor", async () => {
  const w = await boot();
  const input = w.el("composer-input");
  // Zero-size boxes: the drag starts from the COMPOSER_SNAP fallback (44px),
  // so 500 → 380 is 44 + 120 = 164px.
  w.fire("composer-resizer", "mousedown", { clientY: 500 });
  w.fire(w.document, "mousemove", { clientY: 380 });
  eq(input.style.height, "164px", "the floor holds the box open at the dragged size");
  eq(input.style.maxHeight, "164px", "the inline cap grows past 140px with the floor");
  w.fire(w.document, "mouseup");
  eq(savedPanes().composer, 164, "composer floor persisted");
});

test("panes: dragging the composer below the snap point returns it to auto-grow", async () => {
  const w = await boot();
  const input = w.el("composer-input");
  w.fire("composer-resizer", "mousedown", { clientY: 500 });
  w.fire(w.document, "mousemove", { clientY: 380 });
  w.fire(w.document, "mouseup");
  eq(input.style.height, "164px", "precondition: floor set");

  // Second drag starts from the current floor (164px): 500 → 640 = 24px < 44px snap.
  w.fire("composer-resizer", "mousedown", { clientY: 500 });
  w.fire(w.document, "mousemove", { clientY: 640 });
  eq(input.style.height, "0px", "snapped back to pure content height (0 in the harness)");
  eq(input.style.maxHeight, "140px", "inline cap back to the classic 140px");
  w.fire(w.document, "mouseup");
  eq(savedPanes().composer, 0, "auto-grow persisted");
});

test("panes: double-clicking the composer sash returns it to auto-grow", async () => {
  const w = await boot();
  const input = w.el("composer-input");
  w.fire("composer-resizer", "mousedown", { clientY: 500 });
  w.fire(w.document, "mousemove", { clientY: 380 });
  w.fire(w.document, "mouseup");
  eq(input.style.maxHeight, "164px", "precondition: floor set");

  w.fire("composer-resizer", "dblclick");
  eq(input.style.maxHeight, "140px", "double-click restores auto-grow");
  eq(savedPanes().composer, 0, "auto-grow persisted");
});

test("panes: saved sizes are re-applied at boot", async () => {
  const w = await boot({ seeds: { "rustermost.panes": JSON.stringify({ sidebar: 456, composer: 250 }) } });
  eq(sidebarVar(w), "456px", "sidebar width restored (applyPanes runs at module load)");
  eq(w.el("composer-input").style.height, "250px", "composer floor restored");
  eq(w.el("composer-input").style.maxHeight, "250px", "cap raised past 140px for the tall floor");
});

test("panes: garbage in storage falls back to the defaults", async () => {
  const w1 = await boot({ seeds: { "rustermost.panes": "not json{{{" } });
  eq(sidebarVar(w1), "320px", "unparseable JSON → default sidebar width");
  eq(w1.el("composer-input").style.maxHeight, "140px", "unparseable JSON → auto composer");

  const w2 = await boot({ seeds: { "rustermost.panes": JSON.stringify({ sidebar: "wide", composer: -9 }) } });
  eq(sidebarVar(w2), "320px", "wrong types → default sidebar width");
  eq(w2.el("composer-input").style.height, "0px", "negative floor → auto composer");
});
