import assert from "node:assert/strict";
import test from "node:test";

import { fetchFeed, parseFeed } from "../src/main/feed-service.mjs";

const RSS_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Chroma &amp; Friends</title>
    <item>
      <title><![CDATA[First <b>post</b>]]></title>
      <link>https://example.com/first</link>
    </item>
    <item>
      <title>Second &#x2014; post</title>
      <link>https://example.com/second#fragment</link>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Fixture</title>
  <link rel="self" href="https://example.com/feed.xml"/>
  <entry>
    <title>Entry one</title>
    <link rel="alternate" href="https://example.com/entry-one"/>
  </entry>
  <entry>
    <title>Entry two</title>
    <link href="https://example.com/entry-two"/>
  </entry>
</feed>`;

test("parses RSS items with CDATA, entities, and markup stripped", () => {
  const feed = parseFeed(RSS_FIXTURE);
  assert.equal(feed.title, "Chroma & Friends");
  assert.deepEqual(feed.items, [
    { url: "https://example.com/first", title: "First post" },
    { url: "https://example.com/second#fragment", title: "Second — post" },
  ]);
});

test("parses Atom entries and skips rel=self feed links", () => {
  const feed = parseFeed(ATOM_FIXTURE);
  assert.equal(feed.title, "Atom Fixture");
  assert.deepEqual(feed.items, [
    { url: "https://example.com/entry-one", title: "Entry one" },
    { url: "https://example.com/entry-two", title: "Entry two" },
  ]);
});

test("drops unsafe or duplicate item links and strips credentials", () => {
  const feed = parseFeed(`<rss><channel><title>Weird</title>
    <item><title>Scripted</title><link>javascript:alert(1)</link></item>
    <item><title>Filed</title><link>file:///etc/passwd</link></item>
    <item><title>Creds</title><link>https://user:secret@example.com/page</link></item>
    <item><title>Dupe</title><link>https://example.com/page</link></item>
    <item><title>Bare</title></item>
  </channel></rss>`);
  assert.deepEqual(feed.items, [
    { url: "https://example.com/page", title: "Creds" },
  ]);
});

test("malformed documents yield an empty item list instead of throwing", () => {
  assert.deepEqual(parseFeed("this is not xml at all"), { title: "", items: [] });
  assert.deepEqual(parseFeed(null), { title: "", items: [] });
  assert.deepEqual(parseFeed("<rss><channel><item><title>Open"), {
    title: "",
    items: [],
  });
});

test("items without a title fall back to their link", () => {
  const feed = parseFeed(
    "<rss><channel><item><link>https://example.com/untitled</link></item></channel></rss>"
  );
  assert.deepEqual(feed.items, [
    { url: "https://example.com/untitled", title: "https://example.com/untitled" },
  ]);
});

test("fetchFeed parses a successful response without sending credentials", async () => {
  const calls = [];
  const feed = await fetchFeed("https://example.com/feed.xml", {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(RSS_FIXTURE, { status: 200 });
    },
  });
  assert.equal(feed.items.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.redirect, "follow");
});

test("fetchFeed rejects non-2xx responses", async () => {
  await assert.rejects(
    fetchFeed("https://example.com/feed.xml", {
      fetchImpl: async () => new Response("missing", { status: 404 }),
    }),
    /status 404/
  );
});

test("fetchFeed rejects oversized bodies before parsing", async () => {
  await assert.rejects(
    fetchFeed("https://example.com/feed.xml", {
      fetchImpl: async () => new Response("x".repeat(64), { status: 200 }),
      maxBytes: 16,
    }),
    /too large/
  );
  await assert.rejects(
    fetchFeed("https://example.com/feed.xml", {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "9999999" },
        arrayBuffer: async () => new ArrayBuffer(4),
      }),
      maxBytes: 16,
    }),
    /too large/
  );
});

test("fetchFeed aborts slow responses after the timeout", async () => {
  // The abort timer is unref'ed, so keep the event loop alive until it fires.
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    await assert.rejects(
      fetchFeed("https://example.com/feed.xml", {
        timeoutMs: 20,
        fetchImpl: (url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new Error("The operation was aborted"))
            );
          }),
      }),
      /aborted/
    );
  } finally {
    clearTimeout(keepAlive);
  }
});
