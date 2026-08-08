// Notion as a context source.
//
// Read-only, deliberately. Write access would make an indirect prompt injection
// able to edit the operator's notes — and the content this reads is exactly the
// kind of text an injection arrives in. Search, read, list. Nothing else.
//
// Direct REST, no SDK: three endpoints, and @notionhq/client would be a
// dependency tree for a POST and two GETs.
//
// UNVERIFIED AGAINST A REAL WORKSPACE. The request shapes follow Notion's
// documented v1 API and the response parsing handles the block types that carry
// text, but nothing here has been exercised against a live integration token.
// Treat a first run as the verification step.

import { requestJson } from "../providers/http.js";

const API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28"; // pinned: Notion breaks response shapes across versions
const TIMEOUT_MS = 15_000;

function token() {
  return process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || null;
}

export function notionConfigured() {
  return Boolean(token());
}

function headers() {
  return {
    Authorization: `Bearer ${token()}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json"
  };
}

// Every function returns { ok, ... } instead of throwing. A knowledge source
// being unreachable must degrade the context, never fail the completion.
function unconfigured() {
  return {
    ok: false,
    reason: "NOTION_API_KEY is not set. Create an internal integration in Notion and share pages with it."
  };
}

// Notion nests text inside rich_text arrays on typed blocks. Every block type
// that can hold text keeps it under a different key, so this walks the shapes
// rather than guessing one.
const TEXT_BLOCK_KEYS = [
  "paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item",
  "numbered_list_item", "to_do", "toggle", "quote", "callout", "code"
];

function blockText(block) {
  for (const key of TEXT_BLOCK_KEYS) {
    const rich = block[key]?.rich_text;
    if (Array.isArray(rich)) {
      const text = rich.map((r) => r.plain_text || "").join("");
      if (!text) return "";
      const prefix = key.startsWith("heading") ? "#".repeat(Number(key.slice(-1))) + " " : "";
      const bullet = key.endsWith("list_item") ? "- " : "";
      return `${prefix}${bullet}${text}`;
    }
  }
  return "";
}

function pageTitle(page) {
  const properties = page.properties || {};
  for (const value of Object.values(properties)) {
    if (value?.type === "title") {
      return (value.title || []).map((t) => t.plain_text || "").join("") || "(untitled)";
    }
  }
  return page.id;
}

export async function search(query, { limit = 10 } = {}) {
  if (!notionConfigured()) return unconfigured();
  try {
    const body = await requestJson(
      "notion",
      `${API}/search`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          query: String(query || ""),
          page_size: Math.min(Math.max(Number(limit) || 10, 1), 100),
          sort: { direction: "descending", timestamp: "last_edited_time" }
        })
      },
      TIMEOUT_MS
    );
    return {
      ok: true,
      results: (body.results || []).map((item) => ({
        id: item.id,
        type: item.object,
        title: item.object === "page" ? pageTitle(item) : item.title?.[0]?.plain_text || item.id,
        url: item.url || null,
        lastEdited: item.last_edited_time || null
      }))
    };
  } catch (err) {
    return { ok: false, reason: `notion search failed: ${err.message}` };
  }
}

export async function readPage(pageId, { maxBlocks = 200 } = {}) {
  if (!notionConfigured()) return unconfigured();
  // Screens obvious non-ids rather than validating the format precisely: Notion
  // accepts both dashed and undashed ids, and rejecting a valid one would be
  // worse than letting the API return its own 400. The id is interpolated into
  // a URL, so it cannot be arbitrary text.
  if (typeof pageId !== "string" || !/^[0-9a-fA-F-]{32,36}$/.test(pageId)) {
    return { ok: false, reason: "pageId must be a Notion page id (32 hex chars, dashes optional)" };
  }

  try {
    const page = await requestJson("notion", `${API}/pages/${pageId}`, { headers: headers() }, TIMEOUT_MS);
    const blocks = await requestJson(
      "notion",
      `${API}/blocks/${pageId}/children?page_size=${Math.min(maxBlocks, 100)}`,
      { headers: headers() },
      TIMEOUT_MS
    );
    const lines = (blocks.results || []).map(blockText).filter(Boolean);
    return {
      ok: true,
      id: page.id,
      title: pageTitle(page),
      url: page.url || null,
      lastEdited: page.last_edited_time || null,
      // Top-level blocks only. Following child blocks recursively is one HTTP
      // request per nested block and turns reading a page into dozens of calls;
      // `hasMore` says so rather than presenting a partial page as complete.
      text: lines.join("\n"),
      blocks: lines.length,
      hasMore: Boolean(blocks.has_more)
    };
  } catch (err) {
    return { ok: false, reason: `notion page read failed: ${err.message}` };
  }
}

export async function notionStatus() {
  if (!notionConfigured()) return { configured: false, reachable: false, ...unconfigured() };
  const probe = await search("", { limit: 1 });
  return {
    configured: true,
    reachable: probe.ok,
    reason: probe.ok ? null : probe.reason,
    apiVersion: NOTION_VERSION,
    access: "read-only",
    verified: false
  };
}
