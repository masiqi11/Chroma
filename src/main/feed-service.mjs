/**
 * Feed provider for live folders.
 *
 * Live folders populate themselves from an RSS 2.0 or Atom document fetched
 * over http(s). Parsing is dependency-free and deliberately tolerant: a
 * malformed document yields an empty item list rather than an error, while
 * network and size failures throw so callers can surface an error status.
 * The fetcher never sends cookies or credentials — feed requests run in the
 * main process outside every browser session, so nothing about the user's
 * browsing state leaks to the feed host.
 */

const FEED_FETCH_TIMEOUT_MS = 10_000;
const FEED_MAX_BYTES = 1_048_576;
const FEED_ITEM_PARSE_LIMIT = 100;

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
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
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => NAMED_ENTITIES.get(name));
}

function textContent(value) {
  return decodeEntities(
    value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]*>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function firstTagText(block, tag) {
  const match = block.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i")
  );
  return match ? textContent(match[1]) : "";
}

function atomLinkHref(block) {
  const links = block.matchAll(/<link\b([^>]*?)\/?>(?:[\s\S]*?<\/link>)?/gi);
  let fallback = "";
  for (const [, attributes] of links) {
    const href = attributes.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const rel = attributes.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1] || "";
    if (!rel || rel === "alternate") return decodeEntities(href.trim());
    if (!fallback) fallback = decodeEntities(href.trim());
  }
  return fallback;
}

function itemUrl(block, isAtom) {
  if (isAtom) return atomLinkHref(block);
  const link = firstTagText(block, "link");
  return link || atomLinkHref(block);
}

function safeItemUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return "";
  }
}

/**
 * Parses an RSS 2.0 or Atom document into `{ title, items }`. Items without
 * a safe http(s) link are dropped; duplicate links are kept once. Malformed
 * input yields an empty item list.
 */
export function parseFeed(xmlText) {
  if (typeof xmlText !== "string") return { title: "", items: [] };
  const rssBlocks = [...xmlText.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)];
  const atomBlocks = rssBlocks.length
    ? []
    : [...xmlText.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)];
  const isAtom = !rssBlocks.length && atomBlocks.length > 0;
  const blocks = (isAtom ? atomBlocks : rssBlocks).slice(0, FEED_ITEM_PARSE_LIMIT);

  const firstBlockIndex = blocks.length ? blocks[0].index : xmlText.length;
  const title = firstTagText(xmlText.slice(0, firstBlockIndex), "title");

  const seenUrls = new Set();
  const items = [];
  for (const [, block] of blocks) {
    const url = safeItemUrl(itemUrl(block, isAtom));
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    items.push({ url, title: firstTagText(block, "title") || url });
  }
  return { title, items };
}

/**
 * Fetches and parses one feed. Rejects non-2xx responses and bodies over
 * `maxBytes`; aborts after `timeoutMs`. `fetchImpl` is injectable for tests.
 */
export async function fetchFeed(
  url,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = FEED_FETCH_TIMEOUT_MS,
    maxBytes = FEED_MAX_BYTES,
  } = {}
) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      signal: abort.signal,
      redirect: "follow",
      credentials: "omit",
      headers: {
        accept:
          "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1",
      },
    });
    if (!response?.ok) {
      throw new Error(`Feed request failed with status ${response?.status}`);
    }
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error("Feed response is too large");
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > maxBytes) {
      throw new Error("Feed response is too large");
    }
    return parseFeed(body.toString("utf8"));
  } finally {
    clearTimeout(timer);
  }
}
