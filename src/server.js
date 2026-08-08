// MUST stay the first import. ES module imports are evaluated in source order,
// and providers/registry.js reads process.env at module scope — so anything
// that loads credentials has to run before it, exactly as `dotenv/config` did.
import { envStatus } from "./env.js";
import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  routeChatCompletion,
  routeChatCompletionStream,
  publicAttempts,
  buildCandidates
} from "./routing/router.js";
import { compressMessagesWithStats } from "./compression/compress.js";
import { providers, availableProviders, isPricingVerified, billingOf, applyCredential } from "./providers/registry.js";
import {
  setCredential, clearCredential, credentialStatus, storageLocation,
  validateCredential, validateEnvName
} from "./security/credentialStore.js";
import {
  STRATEGIES,
  STRATEGY_IDS,
  STRATEGY_ALIASES,
  FILTER_KEYS,
  MAX_TIERS,
  listCombos,
  validateCombo,
  comboName
} from "./routing/strategies.js";
import { quotaSnapshot, resetQuota, isFreeTier } from "./storage/quotaTracker.js";
import { getUsageSummary, getMonthlySpend, getUsageSeries, getLedger } from "./storage/costTracker.js";
import * as resilience from "./routing/resilience.js";
import {
  getSettings,
  toggleProvider,
  setBudgetCap,
  updateSettings,
  isKeyEncryptedAtRest,
  validateCompression
} from "./storage/settings.js";
import { requireGatewayKey, requireAuthenticatedOrLocal } from "./middleware/auth.js";
import { hostGuard } from "./middleware/hostGuard.js";
import { csrfGuard } from "./middleware/csrf.js";
import { pathToken, isPathTokenEnabled } from "./middleware/pathToken.js";
import { validateMessages } from "./inbound/validate.js";
import { fromAnthropicRequest, toAnthropicResponse, toAnthropicStream } from "./inbound/anthropicInbound.js";
import { fromOllamaRequest, toOllamaResponse, toOllamaTags, toOllamaStream } from "./inbound/ollamaInbound.js";
import { fromResponsesRequest, toResponsesResponse, toResponsesStream } from "./inbound/responsesInbound.js";
import * as cache from "./storage/responseCache.js";
import { cacheKey, isCacheable } from "./storage/responseCache.js";
import { applyGuardrails, guardCoverage } from "./security/guardrails.js";
import * as rateLimiter from "./middleware/rateLimit.js";
import { generateApiKey, isEncryptionAvailable } from "./security/crypto.js";
import { proxyStatus, proxyPlan, clearAgentCache, validateProxyUrl } from "./routing/proxy.js";
import { TLS_PROFILE_IDS, validateTlsProfile, tlsStatus } from "./routing/tls.js";
import * as memory from "./memory/index.js";
import { mountMcpHttp, mcpStatus } from "./mcp/server.js";
import { handleA2A, a2aStatus } from "./a2a/server.js";
import { agentCard } from "./a2a/card.js";
import { gamificationSnapshot } from "./storage/gamification.js";
import * as services from "./services/embedded.js";
import * as cloud from "./agents/cloud.js";
import * as notion from "./knowledge/notion.js";
import * as obsidian from "./knowledge/obsidian.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable("x-powered-by");
app.set("trust proxy", false); // req.ip must not be spoofable via X-Forwarded-For

// Express 4 does not catch a rejected promise from an `async` route handler.
// The rejection escapes as an unhandledRejection, and Node's default policy for
// an unhandled rejection is to terminate the process — so ANY throw inside any
// of the ~20 async handlers below killed the entire gateway for every caller.
//
// That was not hypothetical: `{"model":"a","messages":[null]}` reached
// totalChars(), threw a TypeError on `m.content`, and took the process down.
// Unauthenticated, one request, no provider key required.
//
// Wrapping at registration is the only version of this fix that cannot be
// forgotten. Patching the 20 call sites individually leaves the next route
// someone adds as the one that brings the crash back — and the failure mode is
// a total outage, not a bad response, so it is worth the indirection here.
for (const method of ["get", "post", "put", "delete", "patch", "all"]) {
  const register = app[method].bind(app);
  app[method] = (path, ...handlers) => {
    // `app.get("etag")` with no handler is Express's settings getter, not a
    // route registration. Passing it through untouched keeps that working.
    if (handlers.length === 0) return register(path);
    return register(
      path,
      ...handlers.map((handler) => {
        if (typeof handler !== "function" || handler.length >= 4) return handler;
        return function rejectionSafe(req, res, next) {
          try {
            return Promise.resolve(handler(req, res, next)).catch(next);
          } catch (err) {
            return next(err); // a synchronous throw, same destination
          }
        };
      })
    );
  };
}

const PORT = process.env.PORT || 20128;

// Defaults to loopback. The previous `app.listen(PORT)` bound every
// interface — including the LAN — while the banner and README both said
// "localhost", and the control plane is unauthenticated until a key is set.
// Exposing this deliberately is fine; doing it by accident is not.
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";
const isLoopbackBind = ["127.0.0.1", "::1", "localhost"].includes(BIND_HOST);

app.use(hostGuard);
// Runs before auth so a key carried in the path is in place by the time
// requireGatewayKey looks for one. Off unless ALLOW_PATH_TOKEN=true.
app.use(pathToken);
app.use(express.json({ limit: process.env.MAX_BODY_SIZE || "10mb" }));

// express.json's own parse failures otherwise surface as an HTML error page.
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Request body is not valid JSON" });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }
  return next(err);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, providersAvailable: availableProviders().length });
});

// ---- Control panel: static assets (unauthenticated — the panel itself
// holds no data, it just calls the protected API below with a key you
// enter and it stores in your own browser's localStorage) ----
app.use(
  "/panel",
  (req, res, next) => {
    // The panel renders provider names, model ids and model output. A CSP
    // that forbids inline and remote script is the backstop for anything
    // that slips past output encoding, and the panel needs no inline JS.
    res.set({
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer"
    });
    next();
  },
  express.static(path.join(__dirname, "..", "public"))
);

// ---- Everything below this line is gateway surface: protected if a
// gatewayApiKey has been set from the control panel ----
//
// The cross-site guard runs FIRST, ahead of auth, and applies to every
// state-changing call on every surface. It has to precede auth rather than
// follow it because the case it exists for is the one where auth is a no-op:
// with no gatewayApiKey set, requireGatewayKey waves everything through, and
// a form on any page the operator visits could otherwise start sidecars, wipe
// memory and run completions on their keys. hostGuard does not cover this —
// see the header comment in middleware/csrf.js for why.
app.use("/v1", csrfGuard);
app.use("/api", csrfGuard);
app.use("/mcp", csrfGuard);
app.use("/a2a", csrfGuard);

// Auth runs BEFORE the rate limiter. The other order let an unauthenticated
// caller reach the limiter, which derived its bucket identity from the
// bearer token — so a stranger could name someone else's bucket and drain
// it without ever holding a valid key.
app.use("/v1", requireGatewayKey);
app.use("/v1", rateLimiter.rateLimit);
app.use("/api", requireGatewayKey);

// The agent protocols get the same auth as /v1, and for a stronger reason: an
// unauthenticated MCP endpoint is a remote control for this gateway's spend, and
// an unauthenticated A2A endpoint lets any peer on the network run completions
// on your keys. Both are mounted here, ahead of their routes, so no handler can
// be added below without inheriting it.
//
// Rate-limited too. MCP's completions_chat and A2A's smart-routing skill both
// reach routeChatCompletion, so leaving them off the limiter would leave a way
// around the one control that exists to stop a runaway agent loop.
app.use("/mcp", requireGatewayKey, rateLimiter.rateLimit);
app.use("/a2a", requireGatewayKey, rateLimiter.rateLimit);

// The rate limiter is deliberately NOT mounted on /api. It exists to stop a
// runaway agent loop burning paid quota, which is a /v1 concern; applying it
// to the control plane means the request that turns the limiter back OFF can
// itself be rejected, locking the operator out of their own panel with no
// way to recover except restarting the process.

app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: providers.flatMap((p) =>
      p.models.map((m) => ({
        id: `${p.id}/${m}`,
        object: "model",
        owned_by: p.id,
        available: p.available
      }))
    )
  });
});

// Which memory partition this caller reads and writes.
//
// Defaults to the auth fingerprint, exactly like the response cache: memory is
// conversational history, and one caller recalling another's turns is the same
// data leak the cache's caller partitioning exists to prevent. A client can
// name a narrower partition with X-Tollpike-Session — useful for keeping
// separate conversations apart under one key — but never a broader one, so the
// header is scoped INSIDE the caller id rather than replacing it.
function sessionOf(req) {
  const caller = req.callerId || "anonymous";
  const requested = req.get("X-Tollpike-Session");
  if (!requested) return caller;
  return `${caller}:${String(requested).slice(0, 64).replace(/[^\w.-]/g, "_")}`;
}

// Write the user's turn and the model's reply to memory.
//
// Stores the messages the CLIENT sent, not the compressed and hydrated ones:
// recall should return what was actually said, not a caveman paraphrase of it
// with a previous recall block folded in — which would compound into memories
// increasingly unlike the conversation they came from.
//
// Never throws. Memory is an enhancement; a failure to persist must not turn a
// completion the caller already received into an error.
function ingestTurn(req, requestMessages, response) {
  if (!memory.memoryEnabled()) return;
  try {
    const reply = response?.choices?.[0]?.message;
    memory.ingest([...(requestMessages || []), ...(reply ? [reply] : [])], {
      sessionId: sessionOf(req)
    });
  } catch (err) {
    console.error(`[memory] ingest failed: ${err.message}`);
  }
}

// Compression and guardrails belong to the gateway, not to any one wire
// format, so every inbound dialect runs through this before routing.
// Returns either { blocked } or the payload the router expects.
async function prepare(payload, { sessionId = "default" } = {}) {
  const settings = getSettings();
  const compressionOn = payload.compress !== false && settings.compression.enabled !== false;

  // Memory first: recall runs against the request as the client sent it. A
  // query built from already-compressed text searches for words the caveman
  // pass may have removed, which quietly degrades recall to keyword noise.
  const hydrated = await memory.hydrate(payload.messages, { sessionId });

  // Compression runs before guardrails, and that order matters: the injection
  // scanner has to see what will actually be sent upstream. Scanning the
  // pre-compression text would let a payload that only becomes a directive
  // after the caveman pass strips its surrounding prose through unexamined.
  const compressed = compressionOn
    ? compressMessagesWithStats(hydrated.messages, settings.compression)
    : { messages: hydrated.messages, stats: null };

  const guard = applyGuardrails(compressed.messages, {
    redactPii: settings.redactPii === true,
    injectionMode: settings.injectionMode || "off"
  });

  return {
    blocked: guard.blocked,
    guard,
    compression: compressed.stats,
    memory: hydrated,
    payload: {
      model: payload.model,
      messages: guard.messages,
      temperature: payload.temperature,
      max_tokens: payload.max_tokens,
      tools: payload.tools,
      tool_choice: payload.tool_choice
    }
  };
}

app.post("/v1/chat/completions", async (req, res) => {
  const requestId = randomUUID();
  const body = req.body || {};

  if (!body.model || typeof body.model !== "string" || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: "model (string) and messages[] are required" });
  }

  // Element shapes, not just the container. `[null]` passed the check above.
  const shape = validateMessages(body.messages);
  if (!shape.ok) return res.status(400).json({ error: shape.error });

  const prepared = await prepare(body, { sessionId: sessionOf(req) });
  const { guard, compression } = prepared;

  if (prepared.blocked) {
    return res.status(400).json({
      error: "Request blocked by prompt-injection guardrail",
      findings: guard.findings.injection,
      hint: "Set injectionMode to 'flag' in the control panel to log instead of block."
    });
  }

  const requestPayload = prepared.payload;

  if (body.stream) {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Tollpike-Request-Id": requestId
    });

    try {
      for await (const event of routeChatCompletionStream(requestPayload)) {
        if (event.type === "provider-selected") {
          res.set("X-Tollpike-Provider", event.provider); // best-effort, headers may already be flushed
        } else if (event.type === "raw-line") {
          res.write(event.line + "\n");
        } else if (event.type === "chunk") {
          res.write(`data: ${JSON.stringify(event.chunk)}\n\n`);
        }
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err) {
      // Stream failed before any provider connected successfully —
      // safe to send a normal JSON error since nothing's been written yet.
      if (!res.headersSent) {
        res
          .status(err.status || 502)
          .json({ error: err.message, attempts: publicAttempts(err.attempts) });
      } else {
        res.end();
      }
    }
    return;
  }

  // Cache lookup happens after compression so the key reflects what
  // would actually be sent upstream, and only for deterministic requests.
  const cacheEnabled = body.cache !== false && isCacheable(requestPayload);
  const key = cacheEnabled ? cacheKey(requestPayload, req.callerId) : null;

  if (key) {
    const cached = cache.get(key);
    if (cached) {
      res.set("X-Tollpike-Request-Id", requestId);
      res.set("X-Tollpike-Provider", cached.provider);
      res.set("X-Tollpike-Cache", "HIT");
      return res.json(cached);
    }
  }

  try {
    const { response, attempts } = await routeChatCompletion(requestPayload);

    if (key) cache.set(key, response);

    res.set("X-Tollpike-Request-Id", requestId);
    res.set("X-Tollpike-Provider", response.provider);
    res.set("X-Tollpike-Attempts", String(attempts.length));
    res.set("X-Tollpike-Cache", key ? "MISS" : "BYPASS");
    if (guard.findings.pii.length) res.set("X-Tollpike-PII-Redacted", guard.findings.pii.join(","));
    if (guard.findings.injection.length) res.set("X-Tollpike-Injection-Flags", guard.findings.injection.join(","));

    // Which tier answered is the single most useful routing fact a client can
    // get back: tier 1 means the combo worked, tier 3 means everything you
    // preferred was unavailable and nothing told you.
    const winner = attempts.find((a) => a.ok);
    if (winner?.tier) res.set("X-Tollpike-Routing-Tier", String(winner.tier));
    if (winner?.strategy) res.set("X-Tollpike-Routing-Strategy", String(winner.strategy));

    // Memory injected context into this request, so the client is told. A
    // gateway that silently rewrites the prompt and reports nothing is
    // indistinguishable from a model that hallucinated the extra context.
    if (prepared.memory?.recalled) {
      res.set("X-Tollpike-Memory-Recalled", String(prepared.memory.recalled));
      if (prepared.memory.used?.length) res.set("X-Tollpike-Memory-Recall", prepared.memory.used.join("+"));
      // A memory withheld because it tripped the injection scanner is the one
      // recall event most worth surfacing: it means stored conversation tried
      // to reach the model with system authority and was stopped.
      if (prepared.memory.droppedForInjection) {
        res.set("X-Tollpike-Memory-Dropped-Injection", String(prepared.memory.droppedForInjection));
      }
      if (prepared.memory.degraded?.length) {
        res.set("X-Tollpike-Memory-Degraded", prepared.memory.degraded.map((d) => d.half).join(","));
      }
    }

    // Store the turn AFTER a successful answer. Ingesting a request that then
    // failed would fill memory with prompts that were never answered, and
    // recall would keep surfacing dead ends.
    ingestTurn(req, body.messages, response);

    if (compression) {
      res.set("X-Tollpike-Compression-Saved-Pct", String(compression.savedPct));
      // Per-layer attribution, so a ratio can be acted on rather than just
      // admired. truncation/rtk/caveman, in the order they ran.
      res.set(
        "X-Tollpike-Compression-Detail",
        `truncation=${compression.byPass.truncation.savedPct}%,` +
          `rtk=${compression.byPass.rtk.savedPct}%,` +
          `caveman=${compression.byPass.caveman.savedPct}%`
      );
    }

    res.json(response);
  } catch (err) {
    if (err.status !== 400) console.error(`[${requestId}] routing failed: ${err.message}`);
    res
      .status(err.status || 500)
      .json({ error: err.message, attempts: publicAttempts(err.attempts) });
  }
});

// ---- Other inbound dialects ----
//
// Same router, same caps, same ledger — only the wire format differs. This
// is what lets Claude Code, Codex and Ollama-only tools use the gateway;
// the limit was never provider coverage, it was that only one dialect was
// understood on the way in.

const blockedBody = (guard) => ({
  error: "Request blocked by prompt-injection guardrail",
  findings: guard.findings.injection
});

// Anthropic Messages API — Claude Code, Cline, the Anthropic SDK.
app.post("/v1/messages", async (req, res) => {
  const body = req.body || {};
  // `typeof model !== "string"` as well as presence. A numeric model is truthy,
  // so it passed a bare `!body.model` check, reached routing, matched no
  // provider and came back as a 502 — telling the caller the upstream failed
  // when in fact they sent an invalid field. /v1/chat/completions already got
  // this right; the other dialects did not.
  if (!body.model || typeof body.model !== "string" || !Array.isArray(body.messages)) {
    return res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: "model (string) and messages[] are required" } });
  }

  // Before conversion: fromAnthropicRequest walks these entries.
  const shape = validateMessages(body.messages);
  if (!shape.ok) {
    return res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: shape.error } });
  }

  const inbound = fromAnthropicRequest(body);
  const prepared = await prepare(inbound, { sessionId: sessionOf(req) });
  if (prepared.blocked) {
    return res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: blockedBody(prepared.guard).error } });
  }

  if (body.stream) {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    try {
      for await (const frame of toAnthropicStream(routeChatCompletionStream(prepared.payload), body.model)) {
        res.write(frame);
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) res.status(err.status || 502).json({ type: "error", error: { type: "api_error", message: err.message } });
      else res.end();
    }
    return;
  }

  try {
    const { response } = await routeChatCompletion(prepared.payload);
    res.set("X-Tollpike-Provider", response.provider);
    ingestTurn(req, inbound.messages, response);
    res.json(toAnthropicResponse(response, body.model));
  } catch (err) {
    res.status(err.status || 502).json({ type: "error", error: { type: "api_error", message: err.message } });
  }
});

// OpenAI Responses API — Codex.
app.post("/v1/responses", async (req, res) => {
  const body = req.body || {};
  if (!body.model || typeof body.model !== "string" || body.input === undefined) {
    return res.status(400).json({ error: { type: "invalid_request_error", message: "model (string) and input are required" } });
  }

  // `input` may be a string or an array, so this is checked on the CONVERTED
  // messages — that is the shape prepare() will actually walk.
  const inbound = fromResponsesRequest(body);
  const shape = validateMessages(inbound.messages);
  if (!shape.ok) {
    return res.status(400).json({ error: { type: "invalid_request_error", message: shape.error } });
  }

  const prepared = await prepare(inbound, { sessionId: sessionOf(req) });
  if (prepared.blocked) {
    return res.status(400).json({ error: { type: "invalid_request_error", message: blockedBody(prepared.guard).error } });
  }

  if (body.stream) {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    try {
      for await (const frame of toResponsesStream(routeChatCompletionStream(prepared.payload), body.model)) {
        res.write(frame);
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) res.status(err.status || 502).json({ error: { type: "api_error", message: err.message } });
      else res.end();
    }
    return;
  }

  try {
    const { response } = await routeChatCompletion(prepared.payload);
    res.set("X-Tollpike-Provider", response.provider);
    ingestTurn(req, inbound.messages, response);
    res.json(toResponsesResponse(response, body.model));
  } catch (err) {
    res.status(err.status || 502).json({ error: { type: "api_error", message: err.message } });
  }
});

// Ollama API — anything with a hardcoded "use my local Ollama" mode.
// Note these live outside /v1, so they get their own auth + limiter mounts.
app.use("/api/tags", requireGatewayKey);
app.use("/api/chat", requireGatewayKey, rateLimiter.rateLimit);
app.use("/api/version", requireGatewayKey);

app.get("/api/tags", (req, res) => res.json(toOllamaTags(providers)));
app.get("/api/version", (req, res) => res.json({ version: "0.1.0-tollpike" }));

app.post("/api/chat", async (req, res) => {
  const body = req.body || {};
  if (!body.model || typeof body.model !== "string" || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: "model (string) and messages[] are required" });
  }

  const shape = validateMessages(body.messages);
  if (!shape.ok) return res.status(400).json({ error: shape.error });

  const inbound = fromOllamaRequest(body);
  const prepared = await prepare(inbound, { sessionId: sessionOf(req) });
  if (prepared.blocked) return res.status(400).json({ error: blockedBody(prepared.guard).error });

  // Ollama streams by default — absent `stream` means true, unlike OpenAI.
  const wantsStream = body.stream !== false;

  if (wantsStream) {
    // Newline-delimited JSON, not SSE. Different framing entirely.
    res.set({ "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
    try {
      for await (const line of toOllamaStream(routeChatCompletionStream(prepared.payload), body.model)) {
        res.write(line);
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) res.status(err.status || 502).json({ error: err.message });
      else res.end();
    }
    return;
  }

  try {
    const { response } = await routeChatCompletion(prepared.payload);
    res.set("X-Tollpike-Provider", response.provider);
    ingestTurn(req, inbound.messages, response);
    res.json(toOllamaResponse(response, body.model));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// ---- Agent protocols: MCP and A2A ----

// The Agent Card is the A2A discovery document, and it sits OUTSIDE auth by
// design: a peer has to be able to read how to authenticate before it can
// authenticate. card.js is written so it exposes no secret — it reports whether
// a key is required, never the key, and lists capabilities that are already
// public on /v1/models.
app.get("/.well-known/agent-card.json", (req, res) => res.json(agentCard()));
app.get("/.well-known/agent.json", (req, res) => res.json(agentCard())); // pre-rename spelling

app.post("/a2a", async (req, res) => {
  const response = await handleA2A(req.body);
  // A batch of pure notifications gets no body at all, per JSON-RPC.
  if (response === null) return res.status(204).end();
  res.json(response);
});

app.get("/a2a", (req, res) => {
  res.status(405).json({
    error: "A2A is JSON-RPC 2.0 over POST. Fetch /.well-known/agent-card.json for discovery.",
    ...a2aStatus()
  });
});

// ---- Control panel API ----

app.get("/api/panel/state", (req, res) => {
  const settings = getSettings();
  const usage = getUsageSummary();
  const resilienceSnap = resilience.snapshot();
  const circuits = resilienceSnap.providers;

  const providerState = providers.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category || "inference",
    billing: billingOf(p, settings.subscriptionProviders),
    contextWindow: p.contextWindow ?? null,
    freeTier: p.freeTier ? { ...p.freeTier } : null,
    baseURL: p.baseURL,
    apiKeyEnv: p.apiKeyEnv,
    priority: p.priority,
    costPer1mTokens: p.costPer1mTokens,
    modelPricing: p.modelPricing || null,
    pricingVerified: p.pricingVerified ?? false,
    requiresKey: p.requiresKey !== false,
    verified: p.verified === true,
    models: p.models,
    hasKey: p.available,
    enabled: !settings.disabledProviders.includes(p.id),
    circuit: circuits[p.id]?.status || "CLOSED",
    connections: p.connections.length,
    connectionsCoolingDown: p.connections.filter(
      (c) => !resilience.isConnectionAvailable(p.id, c.id)
    ).length,
    budgetCapUsd: settings.budgetCapsUsd[p.id] ?? null,
    monthlySpendUsd: getMonthlySpend(p.id),
    lifetimeStats: usage.byProvider[p.id] || { requests: 0, costUsd: 0, tokens: 0, avgLatencyMs: 0 }
  }));

  const overallAvgLatency = providerState.reduce((sum, p) => sum + p.lifetimeStats.avgLatencyMs * p.lifetimeStats.requests, 0);

  res.json({
    providers: providerState,
    totals: {
      totalRequests: usage.totalRequests,
      totalCostUsd: usage.totalCostUsd,
      totalTokens: usage.totalTokens,
      avgLatencyMs: usage.totalRequests > 0 ? Math.round(overallAvgLatency / usage.totalRequests) : 0
    },
    recentRequests: usage.recent,
    corruptLogLines: usage.corruptLines,
    cache: cache.stats(),
    // Provider breaker state travels too: a failure count on its own is
    // noise, but next to the threshold it is "one more 5xx opens this lane".
    resilience: {
      providers: resilienceSnap.providers,
      connections: resilienceSnap.connections,
      models: resilienceSnap.models,
      policy: resilienceSnap.policy
    },
    security: {
      redactPii: settings.redactPii === true,
      injectionMode: settings.injectionMode || "off",
      rateLimit: rateLimiter.getConfig(),
      // Reports whether the stored key is ACTUALLY encrypted on disk, not
      // merely whether a secret is configured. The old flag said "active"
      // while the key sat in settings.json as plaintext.
      encryptionAvailable: isEncryptionAvailable(),
      keyEncryptedAtRest: isKeyEncryptedAtRest(),
      boundHost: BIND_HOST,
      exposedBeyondLoopback: !isLoopbackBind,
      // Named so the panel can state what each guard covers without keeping
      // its own copy of the pattern list.
      guardCoverage: guardCoverage()
    },
    confidence: usage.confidence,
    // How much of the price table is actually trustworthy. This is the
    // number the whole spend story rests on, so it belongs on the dashboard
    // rather than buried in a config file.
    pricingTrust: (() => {
      const remote = providers.filter((p) => p.category !== "local");
      const verified = remote.filter(isPricingVerified);
      const unenforceable = remote.filter(
        (p) => !p.costPer1mTokens?.input && !p.costPer1mTokens?.output
      );
      return {
        total: remote.length,
        verified: verified.length,
        unverified: remote.length - verified.length,
        unenforceable: unenforceable.length,
        unenforceableIds: unenforceable.map((p) => p.id),
        // Only counts lanes you could actually spend on.
        activeUnverified: remote.filter((p) => p.available && !isPricingVerified(p)).map((p) => p.id)
      };
    })(),
    compression: settings.compression,
    routing: {
      strategyCount: STRATEGY_IDS.length,
      comboCount: Object.keys(listCombos(settings.combos)).length,
      customCombos: Object.keys(settings.combos || {}),
      defaultCombo: settings.defaultCombo,
      subscriptionProviders: settings.subscriptionProviders || []
    },
    quota: quotaSnapshot(),
    endpoints: {
      base: `http://${BIND_HOST}:${PORT}`,
      chatCompletions: "/v1/chat/completions",
      models: "/v1/models",
      health: "/health",
      panelApi: "/api/panel/*",
      mcp: "node src/mcp/server.js (stdio)"
    },
    proxy: proxyStatus(),
    gatewayAuthEnabled: Boolean(settings.gatewayApiKey)
  });
});

// Exercise one specific provider rather than walking the whole fallback
// chain — the panel's per-card "Test" needs to know that *this* jack works,
// which `model: "auto"` can't tell you because it may answer from a
// different provider entirely.
app.post("/api/panel/providers/:id/test", async (req, res) => {
  const { id } = req.params;
  const provider = providers.find((p) => p.id === id);
  if (!provider) return res.status(404).json({ error: `Unknown provider "${id}"` });

  const model = typeof req.body?.model === "string" ? req.body.model : provider.models[0];
  const message = typeof req.body?.message === "string" ? req.body.message : "Reply with just: ok";
  if (!model) return res.status(400).json({ error: `Provider "${id}" lists no models` });

  const startedAt = Date.now();
  try {
    const { response, attempts } = await routeChatCompletion({
      model: `${id}/${model}`,
      messages: [{ role: "user", content: message }],
      max_tokens: 32
    });
    res.json({
      ok: true,
      provider: id,
      model,
      latencyMs: Date.now() - startedAt,
      content: response.choices?.[0]?.message?.content ?? "",
      usage: response.usage,
      usageSource: response.usage_source,
      attempts
    });
  } catch (err) {
    res.status(err.status || 502).json({
      ok: false,
      provider: id,
      model,
      latencyMs: Date.now() - startedAt,
      error: err.message,
      attempts: publicAttempts(err.attempts)
    });
  }
});

app.get("/api/panel/series", (req, res) => {
  const bucket = req.query.bucket === "day" ? "day" : "hour";
  const points = Math.min(Math.max(Number(req.query.points) || (bucket === "day" ? 14 : 24), 2), 90);
  res.json({ bucket, points, series: getUsageSeries({ bucket, points }) });
});

// Reconciliation export. The point of the whole spend pipeline is being able
// to hold this next to the vendor's invoice and have the numbers agree.
app.get("/api/panel/ledger", (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : undefined;
  const ledger = getLedger(month);
  const enriched = {
    ...ledger,
    generatedAt: new Date().toISOString(),
    rows: ledger.rows.map((r) => {
      const p = providers.find((x) => x.id === r.providerId);
      return {
        ...r,
        pricingVerified: p?.pricingVerified ?? false,
        // Flags rows whose figure rests on an unchecked price table, so a
        // mismatch against the invoice has an obvious first suspect.
        trustworthy: p ? isPricingVerified(p) : false
      };
    })
  };

  if (req.query.format === "csv") {
    const header = "month,provider,cost_usd,pricing_verified\n";
    const body = enriched.rows
      .map((r) => `${r.month},${r.providerId},${r.costUsd},${r.pricingVerified}`)
      .join("\n");
    res.set("Content-Type", "text/csv");
    res.set("Content-Disposition", `attachment; filename="tollpike-${enriched.month}.csv"`);
    return res.send(header + body + "\n");
  }
  res.json(enriched);
});

app.post("/api/panel/resilience/reset", (req, res) => {
  resilience.reset();
  res.json({ ok: true, resilience: resilience.snapshot() });
});

app.post("/api/panel/compression", (req, res) => {
  const parsed = validateCompression(req.body || {});
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  // The layer groups need merging one level deeper than the container. A
  // shallow spread let `{ rtk: { dictionary: true } }` replace the whole RTK
  // group, silently clearing every other flag in it — the caller turned one
  // thing on and four things off.
  const current = getSettings().compression;
  updateSettings({
    compression: {
      ...current,
      ...parsed.value,
      rtk: { ...current.rtk, ...(parsed.value.rtk || {}) },
      caveman: { ...current.caveman, ...(parsed.value.caveman || {}) }
    }
  });
  res.json({ ok: true, compression: getSettings().compression });
});

// Run the real pipeline against sample text and report per-layer savings.
// Compression is the one subsystem where an operator needs to see the output
// before trusting it on their traffic — a lossy pass nobody has previewed is a
// lossy pass nobody should enable.
app.post("/api/panel/compression/preview", (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages must be a non-empty array" });
  }
  if (messages.some((m) => !m || typeof m.role !== "string")) {
    return res.status(400).json({ error: "each message needs a role" });
  }
  const result = compressMessagesWithStats(messages, getSettings().compression);
  res.json({ stats: result.stats, messages: result.messages });
});

// ---- Routing: strategies and combos ----

app.get("/api/panel/strategies", (req, res) => {
  const settings = getSettings();
  res.json({
    strategies: STRATEGY_IDS.map((id) => ({
      id,
      label: STRATEGIES[id].label,
      description: STRATEGIES[id].description,
      route: `auto/${id}`
    })),
    aliases: STRATEGY_ALIASES,
    combos: Object.entries(listCombos(settings.combos)).map(([name, combo]) => ({
      name,
      label: combo.label || name,
      description: combo.description || "",
      custom: combo.custom === true,
      strict: combo.strict === true,
      tiers: combo.tiers,
      route: `combo/${name}`
    })),
    defaultCombo: settings.defaultCombo,
    filterKeys: FILTER_KEYS,
    maxTiers: MAX_TIERS
  });
});

app.put("/api/panel/combos/:name", (req, res) => {
  const name = comboName(req.params.name);
  if (!name) return res.status(400).json({ error: "combo name must contain a-z, 0-9 or -" });

  const parsed = validateCombo(req.body || {});
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const settings = getSettings();
  const combos = { ...settings.combos, [name]: parsed.value };
  updateSettings({ combos });
  res.json({ ok: true, name, combo: parsed.value, route: `combo/${name}` });
});

app.delete("/api/panel/combos/:name", (req, res) => {
  const name = comboName(req.params.name);
  const settings = getSettings();
  if (!settings.combos[name]) {
    return res.status(404).json({ error: `No saved combo named "${name}"` });
  }
  const combos = { ...settings.combos };
  delete combos[name];
  // A deleted combo that is still the default would make every bare "auto"
  // request fail with "unknown combo" — clear the pointer with the target.
  const patch = { combos };
  if (settings.defaultCombo === name) patch.defaultCombo = null;
  updateSettings(patch);
  res.json({ ok: true, deleted: name, defaultCombo: patch.defaultCombo ?? settings.defaultCombo });
});

app.post("/api/panel/default-combo", (req, res) => {
  const { name } = req.body || {};
  const settings = getSettings();
  if (name === null || name === undefined || name === "") {
    updateSettings({ defaultCombo: null });
    return res.json({ ok: true, defaultCombo: null });
  }
  const resolved = comboName(name);
  if (!listCombos(settings.combos)[resolved]) {
    return res.status(404).json({ error: `No combo named "${resolved}"` });
  }
  updateSettings({ defaultCombo: resolved });
  res.json({ ok: true, defaultCombo: resolved });
});

// Preview the chain a route string would produce, without sending anything.
// A routing decision nobody can inspect before it costs money is a routing
// decision nobody will turn on.
app.post("/api/panel/routing/preview", (req, res) => {
  const { model = "auto", messages } = req.body || {};
  if (typeof model !== "string") return res.status(400).json({ error: "model must be a string" });

  const request = {
    model,
    messages: Array.isArray(messages) ? messages : [{ role: "user", content: "preview" }]
  };
  try {
    const chain = buildCandidates(model, request);
    const settings = getSettings();
    res.json({
      model,
      chainLength: chain.length,
      chain: chain.map((c) => ({
        provider: c.provider.id,
        name: c.provider.name,
        model: c.model,
        tier: c.tier ?? 1,
        strategy: c.strategy ?? "explicit",
        billing: billingOf(c.provider, settings.subscriptionProviders),
        hasKey: c.provider.available,
        enabled: !settings.disabledProviders.includes(c.provider.id),
        freeTier: isFreeTier(c.provider)
      }))
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Which lanes a subscription you already pay for covers. Operator-declared:
// nothing in a provider's API reports "this key is included in a plan you
// bought", so inferring it would be guessing about someone's money.
app.post("/api/panel/subscription-providers", (req, res) => {
  const { providerIds } = req.body || {};
  if (!Array.isArray(providerIds)) {
    return res.status(400).json({ error: "providerIds must be an array of provider ids" });
  }
  const unknown = providerIds.filter((id) => !providers.find((p) => p.id === id));
  if (unknown.length) {
    return res.status(400).json({ error: `Unknown provider ids: ${unknown.join(", ")}` });
  }
  updateSettings({ subscriptionProviders: providerIds });
  res.json({ ok: true, subscriptionProviders: providerIds });
});

// ---- Memory ----

app.get("/api/panel/memory", async (req, res) => {
  res.json(await memory.memoryStatus());
});

app.post("/api/panel/memory", async (req, res) => {
  const { enabled, recall, topK, crossSession, qdrantUrl, collection, embeddingProvider, embeddingModel } =
    req.body || {};
  const patch = {};

  if (enabled !== undefined) patch.enabled = Boolean(enabled);
  if (crossSession !== undefined) patch.crossSession = Boolean(crossSession);
  if (recall !== undefined) {
    if (!memory.RECALL_MODES.includes(recall)) {
      return res.status(400).json({ error: `recall must be one of ${memory.RECALL_MODES.join(", ")}` });
    }
    patch.recall = recall;
  }
  if (topK !== undefined) {
    const n = Number(topK);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      return res.status(400).json({ error: "topK must be an integer between 1 and 50" });
    }
    patch.topK = n;
  }
  if (qdrantUrl !== undefined) {
    if (qdrantUrl === null || qdrantUrl === "") patch.qdrantUrl = null;
    else {
      // Same reasoning as the egress proxy: this URL is one this process will
      // send conversation content to, so it is validated rather than stored
      // verbatim.
      let parsed;
      try {
        parsed = new URL(qdrantUrl);
      } catch {
        return res.status(400).json({ error: `"${qdrantUrl}" is not a valid URL` });
      }
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return res.status(400).json({ error: "qdrantUrl must be http or https" });
      }
      patch.qdrantUrl = qdrantUrl;
    }
  }
  if (collection !== undefined) {
    if (typeof collection !== "string" || !/^[\w.-]{1,64}$/.test(collection)) {
      return res.status(400).json({ error: "collection must be 1-64 chars of [A-Za-z0-9_.-]" });
    }
    patch.collection = collection;
  }
  if (embeddingProvider !== undefined) {
    if (embeddingProvider === null || embeddingProvider === "") patch.embeddingProvider = null;
    else if (!providers.find((p) => p.id === embeddingProvider)) {
      return res.status(400).json({ error: `Unknown provider "${embeddingProvider}"` });
    } else patch.embeddingProvider = embeddingProvider;
  }
  if (embeddingModel !== undefined) {
    if (embeddingModel === null || embeddingModel === "") patch.embeddingModel = null;
    else if (typeof embeddingModel !== "string") {
      return res.status(400).json({ error: "embeddingModel must be a string" });
    } else patch.embeddingModel = embeddingModel;
  }

  updateSettings({ memory: { ...getSettings().memory, ...patch } });
  res.json({ ok: true, memory: await memory.memoryStatus() });
});

app.post("/api/panel/memory/search", async (req, res) => {
  const { query, mode, limit, crossSession } = req.body || {};
  if (typeof query !== "string" || !query.trim()) {
    return res.status(400).json({ error: "query must be a non-empty string" });
  }
  try {
    const found = await memory.recall(query, {
      sessionId: sessionOf(req),
      mode: mode || getSettings().memory.recall,
      limit: Math.min(Math.max(Number(limit) || 6, 1), 50),
      crossSession: crossSession === true
    });
    res.json(found);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/panel/memory/remember", (req, res) => {
  const { text, role = "user", tags = [] } = req.body || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "text must be a non-empty string" });
  }
  const stored = memory.remember({ sessionId: sessionOf(req), role, text, tags });
  res.json({ ok: true, ...stored });
});

app.post("/api/panel/memory/sync-vectors", async (req, res) => {
  const result = await memory.syncVectors({ batchSize: Math.min(Number(req.body?.batchSize) || 64, 512) });
  res.status(result.ok ? 200 : 400).json(result);
});

// Destructive, so it will not wipe everything unless explicitly told to:
// `scope: "all"` is required to clear other sessions. Defaulting to a global
// wipe on an endpoint whose common use is "forget this conversation" is how a
// caller deletes someone else's history by omitting a field.
app.post("/api/panel/memory/forget", (req, res) => {
  const { scope = "session", id = null } = req.body || {};
  if (id !== null) {
    return res.json({ ok: true, deleted: memory.forget({ id: Number(id) }) });
  }
  if (scope === "all") {
    return res.json({ ok: true, deleted: memory.forget({}), scope: "all" });
  }
  if (scope !== "session") {
    return res.status(400).json({ error: 'scope must be "session" or "all"' });
  }
  res.json({ ok: true, deleted: memory.forget({ sessionId: sessionOf(req) }), scope: "session" });
});

// ---- Free quota ----

app.get("/api/panel/quota", (req, res) => {
  res.json(quotaSnapshot());
});

app.post("/api/panel/quota/reset", (req, res) => {
  resetQuota();
  res.json({ ok: true, quota: quotaSnapshot() });
});

app.post("/api/panel/providers/:id/toggle", (req, res) => {
  const { id } = req.params;
  const { enabled } = req.body || {};
  if (!providers.find((p) => p.id === id)) {
    return res.status(404).json({ error: `Unknown provider "${id}"` });
  }
  const settings = toggleProvider(id, Boolean(enabled));
  res.json({ ok: true, disabledProviders: settings.disabledProviders });
});

app.post("/api/panel/providers/:id/budget", (req, res) => {
  const { id } = req.params;
  const { capUsd } = req.body || {}; // null clears the cap
  if (!providers.find((p) => p.id === id)) {
    return res.status(404).json({ error: `Unknown provider "${id}"` });
  }
  const provider = providers.find((p) => p.id === id);
  try {
    const settings = setBudgetCap(id, capUsd);
    const response = { ok: true, budgetCapsUsd: settings.budgetCapsUsd };

    // A cap is only as good as the price table behind it. Say so at the
    // moment it's set, rather than letting someone believe a $5 ceiling is
    // being enforced against numbers nobody has checked.
    if (settings.budgetCapsUsd[id] !== undefined && !isPricingVerified(provider)) {
      const zeroPriced = !provider.costPer1mTokens?.input && !provider.costPer1mTokens?.output;
      response.warning = zeroPriced
        ? `Pricing for "${id}" is 0/0 and unverified, so recorded spend is always $0 and this cap can never be reached. Set real rates in config/providers.json first.`
        : `Pricing for "${id}" has not been verified against vendor documentation, so this cap may fire early or not at all.`;
    }
    res.json(response);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Set or clear one provider's credential, from the panel.
//
// The variable NAME is taken from the registry, never from the request — the
// caller chooses a provider, not an environment variable. The value is written
// to the protected env file (`~/.tollpike/.env`), applied to this process so
// the lane opens without a restart, and never echoed back: the response
// carries presence and connection count, and a masked hint at most.
app.post("/api/panel/providers/:id/key", requireAuthenticatedOrLocal, (req, res) => {
  const provider = providers.find((p) => p.id === req.params.id);
  if (!provider) return res.status(404).json({ error: `Unknown provider "${req.params.id}"` });
  if (provider.requiresKey === false) {
    return res.status(400).json({ error: `${provider.name} is a local runtime and needs no credential` });
  }
  if (!validateEnvName(provider.apiKeyEnv)) {
    return res.status(500).json({ error: `Provider "${provider.id}" has an unusable apiKeyEnv` });
  }

  const { key } = req.body || {};
  const clearing = key === null || key === undefined || key === "";

  try {
    if (clearing) {
      clearCredential(provider.apiKeyEnv);
      delete process.env[provider.apiKeyEnv];
    } else {
      const problem = validateCredential(key);
      // The message describes the shape, never the value.
      if (problem) return res.status(400).json({ error: problem });
      setCredential(provider.apiKeyEnv, key);
      process.env[provider.apiKeyEnv] = key.trim();
    }
  } catch (err) {
    return res.status(500).json({ error: `Could not write the credential: ${err.message}` });
  }

  applyCredential(provider.id, process.env[provider.apiKeyEnv] || "");
  // A new credential must not inherit the rejected one's cooldown.
  resilience.clearProvider(provider.id);

  const status = credentialStatus(provider.apiKeyEnv);
  res.json({
    ok: true,
    id: provider.id,
    envVar: provider.apiKeyEnv,
    hasKey: provider.available,
    connections: status.connections,
    hint: status.hint,
    storedIn: storageLocation()
  });
});

// Where a credential typed into the panel would be written, and whether that
// location is the hardened one. The panel states this before asking for a key
// rather than after — an operator is entitled to know where their secret lands.
app.get("/api/panel/credential-location", (req, res) => {
  res.json(storageLocation());
});

app.post("/api/panel/gateway-key", requireAuthenticatedOrLocal, (req, res) => {
  const { apiKey } = req.body || {}; // null/empty disables gateway auth
  if (apiKey !== null && apiKey !== undefined && apiKey !== "") {
    if (typeof apiKey !== "string") {
      return res.status(400).json({ error: "apiKey must be a string, or null to disable auth" });
    }
    // Short keys make the constant-time compare pointless.
    if (apiKey.length < 16) {
      return res.status(400).json({ error: "apiKey must be at least 16 characters" });
    }
  }
  const settings = updateSettings({ gatewayApiKey: apiKey || null });
  res.json({
    ok: true,
    gatewayAuthEnabled: Boolean(settings.gatewayApiKey),
    encryptedAtRest: isKeyEncryptedAtRest()
  });
});

app.post("/api/panel/security", (req, res) => {
  const { redactPii, injectionMode, rateLimit: rl } = req.body || {};
  const patch = {};
  if (redactPii !== undefined) patch.redactPii = Boolean(redactPii);
  if (injectionMode !== undefined) {
    if (!["off", "flag", "block"].includes(injectionMode)) {
      return res.status(400).json({ error: "injectionMode must be off, flag, or block" });
    }
    patch.injectionMode = injectionMode;
  }
  try {
    if (rl) rateLimiter.configure(rl);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const settings = updateSettings(patch);
  res.json({
    ok: true,
    security: {
      redactPii: settings.redactPii === true,
      injectionMode: settings.injectionMode || "off",
      rateLimit: rateLimiter.getConfig()
    }
  });
});

app.post("/api/panel/proxy", (req, res) => {
  const { providerId = "*", url } = req.body || {};

  // Both fields were previously stored verbatim. providerId is a key in a
  // persisted settings object, and url ends up constructing a ProxyAgent
  // that every upstream request is routed through — neither should accept
  // arbitrary input.
  if (typeof providerId !== "string" || (providerId !== "*" && !providers.find((p) => p.id === providerId))) {
    return res.status(400).json({ error: `Unknown provider "${providerId}" (use "*" for a global proxy)` });
  }
  const parsed = validateProxyUrl(url);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const settings = getSettings();
  const proxies = { ...(settings.proxies || {}) };
  if (parsed.value === null) delete proxies[providerId];
  else proxies[providerId] = parsed.value;
  updateSettings({ proxies });
  clearAgentCache(); // stale agents would keep using the old proxy
  res.json({ ok: true, proxy: proxyStatus() });
});

app.post("/api/panel/proxy/category", (req, res) => {
  const { category, url } = req.body || {};
  const known = ["frontier", "inference", "aggregator", "local"];
  if (!known.includes(category)) {
    return res.status(400).json({ error: `category must be one of ${known.join(", ")}` });
  }
  const parsed = validateProxyUrl(url);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const categories = { ...(getSettings().proxyCategories || {}) };
  if (parsed.value === null) delete categories[category];
  else categories[category] = parsed.value;
  updateSettings({ proxyCategories: categories });
  clearAgentCache();
  res.json({ ok: true, proxy: proxyStatus() });
});

app.get("/api/panel/proxy/plan", (req, res) => {
  res.json({ plan: proxyPlan(providers), levels: ["provider", "category", "global", "env"] });
});

// ---- TLS shaping ----

app.get("/api/panel/tls", (req, res) => {
  res.json(tlsStatus(getSettings().tlsProfile));
});

app.post("/api/panel/tls", (req, res) => {
  const parsed = validateTlsProfile(req.body?.profile);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  updateSettings({ tlsProfile: parsed.value });
  clearAgentCache(); // dispatchers are cached per (proxy, profile) pair
  res.json({ ok: true, ...tlsStatus(parsed.value) });
});

// ---- Embedded services ----

app.get("/api/panel/services", (req, res) => {
  res.json(services.servicesStatus(getSettings()));
});

app.post("/api/panel/services/:id/start", (req, res) => {
  const result = services.startService(req.params.id, {
    port: req.body?.port,
    binary: getSettings().serviceBinaries?.[req.params.id]
  });
  res.status(result.ok ? 200 : 400).json(result);
});

app.post("/api/panel/services/:id/stop", (req, res) => {
  const result = services.stopService(req.params.id, { signal: req.body?.signal || "SIGTERM" });
  res.status(result.ok ? 200 : 400).json(result);
});

app.get("/api/panel/services/:id/logs", (req, res) => {
  const result = services.serviceLogs(req.params.id, { lines: req.query.lines });
  res.status(result.ok ? 200 : 404).json(result);
});

app.get("/api/panel/services/:id/health", async (req, res) => {
  res.json(await services.serviceHealth(req.params.id));
});

app.post("/api/panel/services/profile/:name", (req, res) => {
  const result = services.startProfile(req.params.name, { ports: req.body?.ports || {} });
  res.status(result.ok || result.started?.length ? 200 : 400).json(result);
});

// ---- Cloud coding agents ----

app.get("/api/panel/agents", (req, res) => {
  res.json(cloud.cloudAgentStatus());
});

app.post("/api/panel/agents/:driver/tasks", async (req, res) => {
  const { prompt, repo, model } = req.body || {};
  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "prompt must be a non-empty string" });
  }
  const result = await cloud.createTask(req.params.driver, { prompt, repo, model });
  res.status(result.ok ? 200 : result.status || 502).json(result);
});

app.get("/api/panel/agents/:driver/tasks", async (req, res) => {
  const result = await cloud.listTasks(req.params.driver);
  res.status(result.ok ? 200 : result.status || 502).json(result);
});

app.get("/api/panel/agents/:driver/tasks/:id", async (req, res) => {
  const result = await cloud.getTask(req.params.driver, req.params.id);
  res.status(result.ok ? 200 : result.status || 502).json(result);
});

app.post("/api/panel/agents/:driver/tasks/:id/approve", async (req, res) => {
  const result = await cloud.approvePlan(req.params.driver, req.params.id, req.body?.message);
  res.status(result.ok ? 200 : result.status || 502).json(result);
});

app.post("/api/panel/agents/:driver/tasks/:id/cancel", async (req, res) => {
  const result = await cloud.cancelTask(req.params.driver, req.params.id);
  res.status(result.ok ? 200 : result.status || 502).json(result);
});

// ---- Knowledge sources ----

app.get("/api/panel/knowledge", async (req, res) => {
  res.json({
    notion: await notion.notionStatus(),
    obsidian: obsidian.obsidianStatus(),
    access: "read-only for both — a writable knowledge source is one an injected instruction can edit"
  });
});

app.post("/api/panel/knowledge", (req, res) => {
  const { obsidianVault, notion: notionEnabled } = req.body || {};
  const patch = { ...getSettings().knowledge };
  if (notionEnabled !== undefined) patch.notion = Boolean(notionEnabled);
  if (obsidianVault !== undefined) {
    if (obsidianVault === null || obsidianVault === "") patch.obsidianVault = null;
    else if (typeof obsidianVault !== "string") {
      return res.status(400).json({ error: "obsidianVault must be a string path, or null" });
    } else patch.obsidianVault = obsidianVault;
  }
  updateSettings({ knowledge: patch });
  res.json({ ok: true, knowledge: getSettings().knowledge, obsidian: obsidian.obsidianStatus() });
});

app.post("/api/panel/knowledge/search", async (req, res) => {
  const { query, source = "all", limit = 10 } = req.body || {};
  if (typeof query !== "string" || !query.trim()) {
    return res.status(400).json({ error: "query must be a non-empty string" });
  }
  const capped = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const results = {};
  if (source === "all" || source === "notion") results.notion = await notion.search(query, { limit: capped });
  if (source === "all" || source === "obsidian") results.obsidian = obsidian.searchNotes(query, { limit: capped });
  res.json(results);
});

// ---- Gamification ----

app.get("/api/panel/achievements", async (req, res) => {
  res.json(
    gamificationSnapshot({
      settings: getSettings(),
      memoryTotal: (await memory.memoryStatus()).store.total
    })
  );
});

// ---- Agent protocol status (for the panel, not for agents) ----

app.get("/api/panel/protocols", (req, res) => {
  res.json({ mcp: mcpStatus(), a2a: a2aStatus() });
});

app.post("/api/panel/generate-key", (req, res) => {
  res.json({ apiKey: generateApiKey() });
});

app.post("/api/panel/cache/clear", (req, res) => {
  cache.clear();
  res.json({ ok: true, cache: cache.stats() });
});

app.post("/api/panel/test", async (req, res) => {
  const { model = "auto", message = "Say hello in one short sentence." } = req.body || {};
  if (typeof model !== "string" || typeof message !== "string") {
    return res.status(400).json({ error: "model and message must be strings" });
  }
  try {
    const { response, attempts } = await routeChatCompletion({
      model,
      messages: [{ role: "user", content: message }]
    });
    res.json({ ok: true, response, attempts });
  } catch (err) {
    res
      .status(err.status || 502)
      .json({ ok: false, error: err.message, attempts: publicAttempts(err.attempts) });
  }
});

// MCP over HTTP and SSE. Mounted last among routes but behind the auth applied
// to /mcp above. Awaited at module scope so the transports exist before listen()
// — mounting them from inside the listen callback would leave a window where the
// port is open and /mcp 404s.
// Whether the HTTP MCP transport refuses mutating tools, resolved per request
// so setting a gateway key from the panel takes effect without a restart.
//
// The default is tied to auth rather than being a flat "off". Unauthenticated
// MCP over HTTP is a remote control for 100+ tools — settings_patch, proxy_set,
// services_start, completions_chat — available to anything that can reach the
// port. Defaulting that to fully writable meant the safe configuration was the
// one an operator had to know to ask for. Now it inverts: no key means
// read-only, and MCP_READ_ONLY=false is how you say you meant it.
//
// The stdio transport is deliberately unaffected. It is spawned as a subprocess
// by a client the operator already trusts with their shell, so there is no
// network exposure to mitigate and read-only would only break local use.
function mcpReadOnly() {
  if (process.env.MCP_READ_ONLY === "true") return true;
  if (process.env.MCP_READ_ONLY === "false") return false;
  return !getSettings().gatewayApiKey;
}

const mcpHttp = await mountMcpHttp(app, { path: "/mcp", readOnly: mcpReadOnly });

// Unmatched route. Without this Express serves its built-in HTML error page,
// which meant a JSON API answered a typo'd path with a document — every client
// here parses JSON, and the error handler below already exists to prevent
// exactly that for thrown errors. The path is deliberately not echoed back:
// Express escapes it safely, but reflecting caller-controlled text into a
// response is a habit worth not having.
app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path.slice(0, 100)}` });
});

// Catch-all so an unexpected throw returns JSON rather than an HTML stack.
app.use((err, req, res, next) => {
  console.error(`[server] unhandled error: ${err?.message}`);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal error" });
});

// Sidecars are child processes of this one. Without this an orphan keeps holding
// its port after the gateway exits, and the next start fails against a process
// the operator cannot see in the dashboard that started it.
services.installShutdownHooks();

app.listen(PORT, BIND_HOST, () => {
  console.log(`tollpike listening on http://${BIND_HOST}:${PORT}`);
  console.log(`  providers configured: ${providers.length}, available (key set): ${availableProviders().length}`);
  console.log(`  API base:      http://${BIND_HOST}:${PORT}/v1`);
  console.log(`  control panel: http://${BIND_HOST}:${PORT}/panel`);
  console.log("  inbound formats: OpenAI chat · OpenAI responses · Anthropic messages · Ollama");
  console.log(
    `  MCP: ${mcpHttp.tools} tools / ${mcpHttp.scopes} scopes over stdio · POST /mcp · GET /mcp/sse` +
      (mcpHttp.readOnly ? " (READ-ONLY)" : "")
  );
  console.log(`  A2A: ${a2aStatus().skills.length} skills over JSON-RPC at /a2a · card at /.well-known/agent-card.json`);
  console.log(`  routing: ${STRATEGY_IDS.length} strategies, ${Object.keys(listCombos(getSettings().combos)).length} combos`);
  if (isPathTokenEnabled()) {
    console.log("  path-token aliases ENABLED (/vscode/<key>/...) — keys will appear in URLs");
  }

  const settings = getSettings();

  // Where credentials came from. Worth a line because the failure it prevents
  // is silent: an env file that was not found looks exactly like a set of
  // providers nobody configured, and the banner would otherwise just report
  // "available (key set): 0" with no hint as to why.
  const env = envStatus();
  console.log(
    `  credentials: ${
      env.loadedFrom.length
        ? env.loadedFrom.map((l) => l.source).join(" + ")
        : "none found (no env file loaded)"
    }${env.secretConfigured ? " · at-rest encryption available" : " · TOLLPIKE_SECRET unset, keys stored in cleartext"}`
  );

  if (!isLoopbackBind && !settings.gatewayApiKey) {
    console.warn(
      "\n  WARNING: bound to a non-loopback address with no gateway API key set.\n" +
        "  The control panel API (provider toggles, budget caps, egress proxy,\n" +
        "  test completions) is reachable by anyone who can reach this port.\n" +
        "  Set a key from the panel, or bind to 127.0.0.1.\n"
    );
  }

  // Said at startup, not only on a panel nobody has open. A key stored in
  // cleartext is not an emergency — it is exactly as safe as the file it sits
  // in — but it is a fact the operator should learn when they set the key
  // rather than after the file has been copied into a backup or a bug report.
  if (settings.gatewayApiKey && !isKeyEncryptedAtRest()) {
    console.warn(
      "\n  NOTE: the gateway API key is stored in cleartext in data/settings.json.\n" +
        "  Set TOLLPIKE_SECRET and re-save the key from the panel to encrypt it at rest.\n"
    );
  }
});
