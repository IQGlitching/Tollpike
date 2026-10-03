// Vendor audit-log connectors: the hosted agents' own records, pulled in.
//
// Hosted agents (ChatGPT, Claude.ai, Microsoft 365 Copilot, GitHub Copilot,
// Gemini in Workspace) talk to their vendor, not to this gateway, so no other
// layer can see them. Their vendors keep audit logs, and enterprise plans
// expose them over an API. This layer pulls those logs on a schedule, runs the
// same rules over them, and writes them into the same hash-chained record.
//
// Each connector declares what it needs and turns one vendor's pages into
// normalized records:
//
//   { vendorId, ts, product, action, actor: { id, email, type }, ip,
//     target, content, details }
//
// `content` is the text of a prompt or response when the vendor provides it.
// It is scanned by the prompt rules and then dropped: the record keeps only a
// hash and a length, because an audit trail that stores every conversation is
// a second copy of everything the company typed into an AI.
//
// Credentials come from the environment (the gateway's credential file),
// never from settings: settings are writable through the panel, and a field
// there that held a vendor admin key would be one more place it could leak.
// Status reports only whether each credential is present. For the same
// reason a connector's base URL can be overridden only by environment
// variable, so nothing writable can point a vendor key at another host.

import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../../paths.js";

const STATE_PATH = path.join(dataDir, "vendor-state.json");
const SEEN_MAX = 5_000;

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function writeState(id, value) {
  const all = { ...readState(), [id]: value };
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_PATH);
}

export function envBaseUrl(id, fallback) {
  const v = process.env[`TOLLPIKE_VENDOR_${id.toUpperCase().replace(/-/g, "_")}_BASE_URL`];
  return v ? v.replace(/\/+$/, "") : fallback;
}

export function credentialsPresent(connector) {
  return Object.fromEntries(connector.credentials.map((c) => [c.env, Boolean(process.env[c.env])]));
}

export function isConfigured(connector, settings = {}) {
  const creds = connector.credentials.filter((c) => !c.optional).every((c) => process.env[c.env]);
  const opts = (connector.settings || []).filter((s) => s.required).every((s) => settings[s.key]);
  return creds && opts;
}

/**
 * fetch with a deadline and bounded handling of rate limits. Vendors answer a
 * burst with 429 and Retry-After; this waits up to 30 seconds per retry and
 * gives up after three, so a vendor in trouble delays a pull instead of
 * wedging the scheduler.
 */
//
// `redirect: "manual"` returns a 3xx as { status, location } instead of
// following it, for a download that redirects to a signed URL: the caller
// then fetches the location without the vendor's credential. fetch keeps the
// Authorization header on a same-origin redirect, so relying on it to drop
// the key would hold only as long as the signed URL lives on another host.
export async function vendorFetch(url, { method = "GET", headers = {}, body, timeoutMs = 30_000, retries = 3, redirect = "follow" } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, headers, body, redirect, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw new Error(`${new URL(url).host}: ${err.name === "TimeoutError" ? "timed out" : err.cause?.code || err.message}`);
    }
    if (redirect === "manual" && res.status >= 300 && res.status < 400) {
      await res.body?.cancel?.().catch(() => {});
      return { status: res.status, headers: res.headers, location: res.headers.get("location") ? new URL(res.headers.get("location"), url).toString() : null };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const after = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * (attempt + 1), 30_000)));
      continue;
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // some endpoints answer with an empty body
    }
    if (!res.ok) {
      // The vendor's message, never the request: the request carries the key.
      const msg = json?.error?.message || json?.error_description || json?.message || (typeof json?.error === "string" ? json.error : "") || text.slice(0, 200);
      const err = new Error(`${new URL(url).host} answered HTTP ${res.status}${msg ? `: ${String(msg).slice(0, 200)}` : ""}`);
      err.status = res.status;
      throw err;
    }
    return { status: res.status, headers: res.headers, json, text };
  }
}

/** The seen-id window: records a vendor resends at a page boundary are dropped. */
export function rememberSeen(state, ids) {
  const seen = [...(state.seen || []), ...ids];
  return seen.length > SEEN_MAX ? seen.slice(seen.length - SEEN_MAX) : seen;
}
