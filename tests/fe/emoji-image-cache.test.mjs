// tests/fe/emoji-image-cache.test.mjs — custom-emoji image caching in IndexedDB.
//
// Custom emoji images used to be fetched lazily on first render and kept only
// in memory, so every launch re-fetched each one over the network and pickers
// showed blank images in the meantime. Now each fetched image is also put()
// into an IndexedDB "emoji" store (db "rustermost", records { id, data } keyed
// by emoji id); at startup the cache is folded into memory, pruned against the
// server list (images are immutable per id — no versioning needed), and the
// missing ones are prefetched by a worker pool in the background.
//
// Covers: first-launch lazily filled + persisted, cached launch with zero
// get_emoji_image calls, startup prune of stale ids, background prefetch
// without any rendering, the no-IndexedDB degradation, and the picker
// benefitting from the warm cache.

import { boot, test, ok, eq } from "../harness.mjs";

const ME = { id: "me1", username: "me", first_name: "Me", last_name: "" };
const CHANNELS = [
  // unread by one message → pinned in the unfolded Unread section at boot
  { id: "c1", name: "town-square", display_name: "Town Square", type: "O", team_id: "", total_msg_count: 20, member: { msg_count: 19 } },
];
const USERS = { u2: { id: "u2", username: "anna", first_name: "Anna", last_name: "Doe" } };

const post = (id, message) => ({ id, user_id: "u2", channel_id: "c1", message, create_at: 1728000000000 });

async function openTownSquare(w) {
  const row = w.qa(".channel-item").find((r) => r.textContent.includes("Town Square"));
  ok(row, "Town Square row rendered (unread → pinned Unread section)");
  w.fire(row, "click");
  await w.flush();
}

const emojiImg = (w, postId) => w.q(`.msg-row[data-post-id="${postId}"] .msg-body img.emoji`);

test("emoji-cache: first launch renders :blob: via get_emoji_image and persists it to IndexedDB", async () => {
  const w = await boot({
    channels: CHANNELS,
    posts: { c1: [post("p1", "hello :blob: world")] },
    users: USERS,
    me: ME,
    customEmoji: [{ id: "e1", name: "blob" }],
  });
  await w.flush();

  await openTownSquare(w);
  const img = emojiImg(w, "p1");
  ok(img, "the :blob: shortcode rendered as an <img>");
  eq(img.dataset.emojiId, "e1", "img carries the emoji id");
  eq(img.src, "data:image/png;base64,AAE-e1", "img.src filled from the get_emoji_image stub");

  await w.flush();
  ok(w.emojiStore.has("e1"), "the fetched image was persisted to IndexedDB");
  eq(w.emojiStore.get("e1").data, "data:image/png;base64,AAE-e1", "stored record carries the data URL");
});

test("emoji-cache: a cached launch paints from IndexedDB with zero get_emoji_image calls", async () => {
  const w = await boot({
    channels: CHANNELS,
    posts: { c1: [post("p1", "hello :blob:")] },
    users: USERS,
    me: ME,
    customEmoji: [{ id: "e1", name: "blob" }],
    emojiCache: { e1: "data:image/png;base64,CACHED-e1" },
  });
  await w.flush(); // lets the startup warm (open → getAll → state fill) finish

  await openTownSquare(w);
  const img = emojiImg(w, "p1");
  ok(img, "the :blob: shortcode rendered as an <img>");
  eq(img.src, "data:image/png;base64,CACHED-e1", "painted straight from the persisted cache");
  eq(w.invoked("get_emoji_image").length, 0, "no network fetch — the cache satisfied everything");
});

test("emoji-cache: entries whose id left the server list are pruned at startup", async () => {
  const w = await boot({
    customEmoji: [{ id: "e1", name: "blob" }],
    emojiCache: { e1: "data:image/png;base64,CACHED-e1", zz: "data:image/png;base64,STALE" },
  });
  await w.flush();

  ok(w.emojiStore.has("e1"), "the entry still on the server was kept");
  ok(!w.emojiStore.has("zz"), "the stale entry was pruned from IndexedDB");
});

test("emoji-cache: with an empty cache every custom emoji warms in the background, no rendering needed", async () => {
  const w = await boot({
    customEmoji: [
      { id: "e1", name: "alpha" },
      { id: "e2", name: "bravo" },
      { id: "e3", name: "charlie" },
    ],
  });
  await w.flush(); // channel never opened — only the startup warm ran

  const fetched = w.invoked("get_emoji_image").map((c) => c.args.emojiId).sort();
  eq(fetched.join(","), "e1,e2,e3", "all three images fetched without anything being rendered");
  for (const id of ["e1", "e2", "e3"]) {
    ok(w.emojiStore.has(id), `${id} persisted to IndexedDB`);
    eq(w.emojiStore.get(id).data, "data:image/png;base64,AAE-" + id, `${id} stored with its stub data URL`);
  }
});

test("emoji-cache: without IndexedDB the app still renders via invoke and nothing crashes", async () => {
  const w = await boot({
    channels: CHANNELS,
    posts: { c1: [post("p1", "hello :blob: world")] },
    users: USERS,
    me: ME,
    customEmoji: [{ id: "e1", name: "blob" }],
    noIdb: true,
  });
  await w.flush();

  await openTownSquare(w);
  const img = emojiImg(w, "p1");
  ok(img, "the :blob: shortcode rendered as an <img>");
  eq(img.src, "data:image/png;base64,AAE-e1", "img.src filled from the get_emoji_image stub");
  ok(!w.emojiStore.has("e1"), "nothing persisted — the fake store was never installed");
});

test("emoji-cache: the picker grid paints custom emoji from the warm cache without a new fetch", async () => {
  const w = await boot({
    channels: CHANNELS,
    posts: { c1: [post("p1", "hi")] },
    users: USERS,
    me: ME,
    customEmoji: [{ id: "e1", name: "blob" }],
    emojiCache: { e1: "data:image/png;base64,CACHED-e1" },
  });
  await w.flush(); // startup warm done

  w.fire("emoji-btn", "click");
  await w.flush();
  const img = w.q(".emoji-grid .emoji-cell img.emoji");
  ok(img, "the custom emoji cell rendered an <img>");
  eq(img.dataset.emojiId, "e1", "picker cell carries the emoji id");
  eq(img.src, "data:image/png;base64,CACHED-e1", "picker painted from the warm cache");
  eq(w.invoked("get_emoji_image").length, 0, "opening the picker triggered no fetch");
});
