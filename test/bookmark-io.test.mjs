import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOKMARK_IMPORT_ENTRY_LIMIT,
  parseBookmarksHtml,
  serializeBookmarks,
} from "../src/shared/bookmark-io.mjs";

test("serializes folders and ungrouped bookmarks to a Netscape document", () => {
  const html = serializeBookmarks({
    bookmarks: [
      { id: "b1", title: "One & Two", url: "https://example.com/one", createdAt: 1_700_000_000_000 },
      { id: "b2", title: '<b>"Quoted"</b>', url: "https://example.com/two", createdAt: 2 },
      { id: "b3", title: "Loose", url: "https://example.com/loose", createdAt: 3 },
    ],
    bookmarkFolders: [
      { id: "f1", name: "Work <stuff>", bookmarkIds: ["b1", "b2"], expanded: true },
    ],
  });

  assert.ok(html.startsWith("<!DOCTYPE NETSCAPE-Bookmark-file-1>"));
  assert.ok(html.includes("<DT><H3>Work &lt;stuff&gt;</H3>"));
  assert.ok(html.includes('HREF="https://example.com/one" ADD_DATE="1700000000"'));
  assert.ok(html.includes("One &amp; Two"));
  assert.ok(html.includes("&lt;b&gt;&quot;Quoted&quot;&lt;/b&gt;"));
  assert.ok(html.includes("https://example.com/loose"));
  assert.ok(!html.includes("<b>"), "titles must be escaped, not embedded as markup");
});

test("round-trips its own export including folder membership", () => {
  const source = {
    bookmarks: [
      { id: "b1", title: "Inside", url: "https://example.com/inside", createdAt: 1 },
      { id: "b2", title: "Outside", url: "https://example.com/outside", createdAt: 2 },
    ],
    bookmarkFolders: [
      { id: "f1", name: "Folder", bookmarkIds: ["b1"], expanded: true },
    ],
  };
  const { items } = parseBookmarksHtml(serializeBookmarks(source));
  assert.deepEqual(items, [
    { title: "Inside", url: "https://example.com/inside", folderPath: ["Folder"] },
    { title: "Outside", url: "https://example.com/outside", folderPath: [] },
  ]);
});

test("parses browser-style exports preserving nested folder paths", () => {
  const { items } = parseBookmarksHtml(`<!DOCTYPE NETSCAPE-Bookmark-file-1>
    <TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>
    <DL><p>
      <DT><H3 ADD_DATE="1" LAST_MODIFIED="2">Outer</H3>
      <DL><p>
        <DT><A HREF="https://example.com/outer" ICON="data:image/png;base64,x">Outer page</A>
        <DT><H3>Inner</H3>
        <DL><p>
          <DT><A HREF="https://example.com/inner">Inner &amp; page</A>
        </DL><p>
      </DL><p>
      <DT><A HREF="https://example.com/top">Top page</A>
    </DL><p>`);

  assert.deepEqual(items, [
    { title: "Outer page", url: "https://example.com/outer", folderPath: ["Outer"] },
    { title: "Inner & page", url: "https://example.com/inner", folderPath: ["Outer", "Inner"] },
    { title: "Top page", url: "https://example.com/top", folderPath: [] },
  ]);
});

test("drops unsafe, credentialed, duplicate, and malformed entries", () => {
  const { items } = parseBookmarksHtml(`<DL><p>
    <DT><A HREF="javascript:alert(1)">Scripted</A>
    <DT><A HREF="file:///etc/passwd">File</A>
    <DT><A HREF="https://user:secret@example.com/page">Creds</A>
    <DT><A HREF="https://example.com/page">Dupe</A>
    <DT><A HREF="not a url">Broken</A>
    <DT><A>No href</A>
  </DL><p>`);
  assert.deepEqual(items, [
    { title: "Creds", url: "https://example.com/page", folderPath: [] },
  ]);
});

test("tolerates malformed input and enforces the entry cap", () => {
  assert.deepEqual(parseBookmarksHtml(null), { items: [] });
  assert.deepEqual(parseBookmarksHtml("plain text"), { items: [] });
  assert.deepEqual(
    parseBookmarksHtml("<DL><DT><H3>Open folder").items,
    []
  );

  const many = Array.from(
    { length: BOOKMARK_IMPORT_ENTRY_LIMIT + 10 },
    (_, index) => `<DT><A HREF="https://example.com/item-${index}">Item ${index}</A>`
  ).join("\n");
  assert.equal(
    parseBookmarksHtml(`<DL><p>${many}</DL><p>`).items.length,
    BOOKMARK_IMPORT_ENTRY_LIMIT
  );
});

test("untitled links fall back to their address", () => {
  const { items } = parseBookmarksHtml(
    '<DL><p><DT><A HREF="https://example.com/untitled">   </A></DL><p>'
  );
  assert.deepEqual(items, [
    {
      title: "https://example.com/untitled",
      url: "https://example.com/untitled",
      folderPath: [],
    },
  ]);
});
