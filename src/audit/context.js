// Who is making the current call, carried across async boundaries.
//
// The audit hook lives in the router, because every dialect, the MCP
// completion tools, A2A and the panel's provider test all end up there. The
// router has no request object, though, and threading one through every
// signature between an Express handler and an adapter would touch half the
// codebase. AsyncLocalStorage carries it instead: the middleware below opens
// a context per request and anything awaited inside it can read it back.
//
// Calls with no context (MCP over stdio, a script importing the router) are
// still audited, attributed to `local` with the source they came from.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const store = new AsyncLocalStorage();

export function currentContext() {
  return store.getStore() || null;
}

/** True once the client of the current request has disconnected. */
export function clientGone() {
  return store.getStore()?.signal?.aborted === true;
}

export function runWithContext(ctx, fn) {
  return store.run({ ...ctx }, fn);
}

// The surface a request arrived on, from its path.
export function sourceOf(path) {
  const p = String(path || "");
  if (p.startsWith("/v1/chat/completions")) return "openai";
  if (p.startsWith("/v1/messages")) return "anthropic";
  if (p.startsWith("/v1/responses")) return "responses";
  if (p.startsWith("/api/chat")) return "ollama";
  if (p.startsWith("/audit/hooks/claude-code")) return "claude-code";
  if (p.startsWith("/audit/endpoint")) return "endpoint";
  if (p.startsWith("/mcp-proxy")) return "mcp-proxy";
  if (p.startsWith("/mcp")) return "mcp";
  if (p.startsWith("/a2a")) return "a2a";
  if (p.startsWith("/api/panel")) return "panel";
  return "http";
}

// Express middleware. Mounted after authentication, so the agent identity it
// records is the one the key check established, never a header claim.
export function auditContext(req, res, next) {
  const ctx = {
    requestId: randomUUID(),
    source: sourceOf(req.originalUrl || req.url),
    agent: req.agent
      ? { id: req.agent.id, name: req.agent.name }
      : req.sensor
        ? null
        : req.callerId && req.callerId !== "anonymous"
          ? { id: "operator", name: "operator" }
          : null,
    sensor: req.sensor ? { id: req.sensor.id, name: req.sensor.name } : undefined,
    callerId: req.callerId || "anonymous",
    ip: req.ip || req.socket?.remoteAddress || null,
    userAgent: String(req.get?.("user-agent") || "").slice(0, 120) || null,
    session: req.get?.("X-Tollpike-Session") ? String(req.get("X-Tollpike-Session")).slice(0, 64) : null
  };
  res.set("X-Tollpike-Audit-Request", ctx.requestId);
  // Aborted when the client goes away before the response is finished, so
  // the upstream call it was waiting for stops too (see providers/http.js)
  // instead of running, and billing, to the end for nobody.
  const gone = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) gone.abort();
  });
  ctx.signal = gone.signal;
  store.run(ctx, next);
}
