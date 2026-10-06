// tests/fe/33-composer-height.test.mjs — issue #33: composer height on open.
//
// applyPanes() runs autoResize() at BOOT, while the chat panel is still
// display:none — in WebKitGTK that measures scrollHeight 0, so the composer
// kept a stale inline height (a "0px" stub here, a ~20px sliver on a real
// layout) until the first keystroke re-ran autoResize via the input listener.
// Opening a conversation must re-measure once the panel is visible.

import { boot, test, ok, eq } from "../harness.mjs";

const ME = { id: "me1", username: "me", first_name: "Me", last_name: "" };

const CHANNELS = [
  // unread, so it renders in the pinned Unread section and opens with one click
  { id: "c1", name: "town-square", display_name: "Town Square", type: "O", team_id: "", total_msg_count: 6, member: { msg_count: 5 } },
];
const POSTS = {
  c1: [{ id: "p1", user_id: "me1", channel_id: "c1", message: "old text", create_at: 1728000000000 }],
};

test("33: opening a conversation re-measures the composer height", async () => {
  const w = await boot({ channels: CHANNELS, posts: POSTS, me: ME });
  const input = w.el("composer-input");

  // Boot-time stale measurement: the panel was hidden → scrollHeight 0 →
  // the boot autoResize stamped "0px" (140px = the classic inline cap).
  eq(input.style.height, "0px", "boot measured the composer while hidden");
  eq(input.style.maxHeight, "140px", "inline cap folded in at boot");

  // Simulate a real layout: the textarea now has content height again.
  input.scrollHeight = 40;

  const row = w.qa(".channel-item").find((r) => r.textContent.includes("Town Square"));
  ok(row, "Town Square row rendered (unread → pinned Unread section)");
  w.fire(row, "click");
  await w.flush();

  eq(input.style.height, "40px", "openChannel re-measured on a real layout");
  eq(input.style.maxHeight, "140px", "inline cap re-stamped as well");
});
