/**
 * Netscape Bookmark-file interchange for the local bookmark service.
 *
 * `serializeBookmarks` emits the NETSCAPE-Bookmark-file-1 dialect that
 * Chrome, Firefox, Safari, and Zen all export, so Chroma bookmarks can move
 * in either direction. `parseBookmarksHtml` is deliberately tolerant: it
 * tokenizes anchors, folder headings, and list boundaries rather than
 * requiring a well-formed document, flattens nested folders to Chroma's
 * single folder level (innermost name wins), keeps only http(s) links, and
 * returns an empty result for malformed input instead of throwing.
 */

export const BOOKMARK_IMPORT_ENTRY_LIMIT = 2_000;
export const BOOKMARK_IMPORT_MAX_BYTES = 5 * 1_024 * 1_024;

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d{1,7});/g, (_, digits) => {
      const code = Number(digits);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name) =>
      NAMED_ENTITIES.get(name.toLowerCase())
    );
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

function cleanText(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function safeHttpUrl(value) {
  try {
    const url = new URL(decodeEntities(value).trim());
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return "";
  }
}

/**
 * Serializes bookmarks and their flat folders to a Netscape bookmark file.
 * Folder membership follows `bookmarkFolders`; every unowned bookmark is
 * written at the top level in list order.
 */
export function serializeBookmarks({ bookmarks, bookmarkFolders } = {}) {
  const allBookmarks = Array.isArray(bookmarks) ? bookmarks : [];
  const folders = Array.isArray(bookmarkFolders) ? bookmarkFolders : [];
  const bookmarksById = new Map(allBookmarks.map(item => [item.id, item]));
  const grouped = new Set();

  const anchor = (bookmark, indent) => {
    const added = Number.isFinite(bookmark.createdAt)
      ? ` ADD_DATE="${Math.round(bookmark.createdAt / 1_000)}"`
      : "";
    return `${indent}<DT><A HREF="${escapeHtml(bookmark.url)}"${added}>${escapeHtml(bookmark.title || bookmark.url)}</A>`;
  };

  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
  ];
  const childFolders = parentId =>
    folders.filter(folder => (folder.parentId || "") === parentId);
  const emitFolder = (folder, indent, seen) => {
    if (seen.has(folder.id)) return;
    seen.add(folder.id);
    const members = (Array.isArray(folder.bookmarkIds) ? folder.bookmarkIds : [])
      .map(id => bookmarksById.get(id))
      .filter(Boolean);
    for (const member of members) grouped.add(member.id);
    lines.push(`${indent}<DT><H3>${escapeHtml(folder.name)}</H3>`);
    lines.push(`${indent}<DL><p>`);
    for (const member of members) lines.push(anchor(member, `${indent}    `));
    for (const child of childFolders(folder.id)) {
      emitFolder(child, `${indent}    `, seen);
    }
    lines.push(`${indent}</DL><p>`);
  };
  const emitted = new Set();
  for (const folder of childFolders("")) emitFolder(folder, "    ", emitted);
  for (const folder of folders) emitFolder(folder, "    ", emitted);
  for (const bookmark of allBookmarks) {
    if (!grouped.has(bookmark.id)) lines.push(anchor(bookmark, "    "));
  }
  lines.push("</DL><p>");
  return `${lines.join("\n")}\n`;
}

/**
 * Parses a Netscape bookmark document into
 * `{ items: [{ title, url, folderPath }] }` where `folderPath` is the
 * ancestor folder-name chain (outermost first, `[]` for top-level
 * bookmarks). Non-http(s) and duplicate URLs are dropped; parsing stops
 * after BOOKMARK_IMPORT_ENTRY_LIMIT accepted items.
 */
export function parseBookmarksHtml(html) {
  if (typeof html !== "string") return { items: [] };
  const tokens = html.matchAll(
    /<dl[\s>]|<\/dl>|<h3(?:\s[^>]*)?>([\s\S]*?)<\/h3>|<a\s([^>]*)>([\s\S]*?)<\/a>/gi
  );

  const stack = [];
  let pendingFolder = null;
  const seenUrls = new Set();
  const items = [];

  for (const token of tokens) {
    const text = token[0].toLowerCase();
    if (text.startsWith("<dl")) {
      stack.push(pendingFolder);
      pendingFolder = null;
      continue;
    }
    if (text.startsWith("</dl")) {
      stack.pop();
      pendingFolder = null;
      continue;
    }
    if (text.startsWith("<h3")) {
      pendingFolder = cleanText(token[1] ?? "").slice(0, 80);
      continue;
    }
    const href = (token[2] ?? "").match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1];
    const url = href ? safeHttpUrl(href) : "";
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    items.push({
      title: cleanText(token[3] ?? "").slice(0, 500) || url,
      url,
      folderPath: stack.filter(Boolean),
    });
    if (items.length === BOOKMARK_IMPORT_ENTRY_LIMIT) break;
  }
  return { items };
}
