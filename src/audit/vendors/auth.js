// Token acquisition for vendor connectors. Tokens live in memory only, are
// reused until shortly before they expire, and never appear in a log, an
// event or an error message.

import crypto from "node:crypto";
import fs from "node:fs";
import { vendorFetch } from "./framework.js";

const cache = new Map(); // key -> { token, expiresAt }

function cached(key) {
  const hit = cache.get(key);
  return hit && hit.expiresAt - 60_000 > Date.now() ? hit.token : null;
}

function store(key, token, expiresInSeconds) {
  cache.set(key, { token, expiresAt: Date.now() + (Number(expiresInSeconds) || 3600) * 1000 });
  return token;
}

/**
 * Microsoft Entra client credentials.
 *
 * `resource` uses the v1 endpoint with `resource=`, which is the flow the
 * Office 365 Management Activity API documents. `scope` uses the v2 endpoint
 * with `<resource>/.default`, the standard form for Microsoft Graph.
 */
export async function microsoftToken({ tenantId, clientId, clientSecret, resource, scope, loginBase = "https://login.microsoftonline.com" }) {
  const key = `ms|${tenantId}|${clientId}|${resource || scope}`;
  const hit = cached(key);
  if (hit) return hit;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
  let url;
  if (resource) {
    body.set("resource", resource);
    url = `${loginBase}/${encodeURIComponent(tenantId)}/oauth2/token`;
  } else {
    body.set("scope", scope);
    url = `${loginBase}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  }
  const r = await vendorFetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), retries: 1 });
  if (!r.json?.access_token) throw new Error("Microsoft token endpoint returned no access_token.");
  return store(key, r.json.access_token, r.json.expires_in);
}

/**
 * Google service account with domain-wide delegation: a JWT signed with the
 * account's private key, acting as `subject` (a Workspace admin), exchanged
 * for an access token.
 */
export async function googleToken({ keyFile, subject, scope, tokenUrl = "https://oauth2.googleapis.com/token" }) {
  const key = `google|${keyFile}|${subject}|${scope}`;
  const hit = cached(key);
  if (hit) return hit;
  let sa;
  try {
    sa = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read the Google service account key file (${err.code || "invalid JSON"}).`);
  }
  if (!sa.client_email || !sa.private_key) throw new Error("The Google service account key file has no client_email or private_key.");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: sa.client_email, sub: subject, scope, aud: tokenUrl, iat: now, exp: now + 3600 })}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  const r = await vendorFetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(),
    retries: 1
  });
  if (!r.json?.access_token) throw new Error("Google token endpoint returned no access_token.");
  return store(key, r.json.access_token, r.json.expires_in);
}

/** Tests only. */
export function _resetTokens() {
  cache.clear();
}
