# Tollpike: handover

Context for an agent or developer picking this up cold.

> Rename or symlink this to `CLAUDE.md` in the repo root if you want Claude
> Code to load it automatically every session.

**This project was previously called Patchbay.** The rename is complete and
deliberately made no compatibility shims: `TOLLPIKE_SECRET`, `X-Tollpike-*`
headers, `tpk_` key prefix, `tollpike.service`, `tollpike-data` volume. If
you find any `patchbay` string, it's a leftover.

---

## 1. What this is

A self-hosted AI gateway. One OpenAI-compatible endpoint at
`127.0.0.1:20128/v1` fans out to 46 providers with tiered fallback, hard
spend caps, free-quota accounting, stacked compression, persistent memory,
response caching, and optional guardrails, and exposes the whole gateway
as tools an agent can drive over MCP and A2A.

**It optimizes for cost control and honest reporting, not provider reach.**
That's the whole thesis. Per-provider monthly budget caps enforced at routing
time, cross-provider caching, and cost/latency-aware routing. If a change
would trade spend predictability for more providers or more throughput, it's
probably the wrong change here.

The second half of that thesis is load-bearing and easy to erode: **every
number this thing reports says where it came from.** Spend says what share is
provider-reported versus estimated; free quota says it is observation-only;
savings state their baseline; recall says which halves actually ran; anything
unchecked is labelled unchecked. A change that makes an output look more
confident than its inputs justify is the wrong change here even when the
number itself is unchanged.

~12,200 lines of source, ~5,200 lines of tests, no build step, no framework
beyond Express. Two runtime dependencies beyond Express and dotenv: `undici`
(ProxyAgent/Agent) and the MCP SDK. Zero known advisories.

**Subsystem map**. Where to look for what:

| Area | Files |
|---|---|
| Routing strategies & combos | `routing/strategies.js`, `routing/router.js` |
| Egress & TLS shaping | `routing/proxy.js`, `routing/tls.js` |
| Compression | `compression/{compress,rtk,caveman}.js` |
| Free quota | `storage/quotaTracker.js` |
| Memory | `memory/{index,store,recall,vector,embeddings}.js` |
| MCP | `mcp/scopes.js` (registry), `mcp/server.js` (transports) |
| A2A | `a2a/{server,skills,card}.js` |
| Cloud agents | `agents/cloud.js` |
| Sidecars | `services/embedded.js` |
| Knowledge | `knowledge/{notion,obsidian}.js` |
| Gamification | `storage/gamification.js` |

---

## 2. Commands

```bash
npm install
cp .env.example .env      # add at least one provider key
npm start                 # http://127.0.0.1:20128 · panel at /panel

npm test                  # 505 tests, node:test, no test framework dep
npm run test:watch
npm run verify            # probes every configured provider baseURL for real
npm run verify-pricing    # diffs config prices vs upstream; exit 1 on drift
npm run verify-pricing -- --write   # apply first-party corrections, restamp
npm run verify-pricing -- --json    # machine-readable, for CI

npm run docker:up         # compose up -d
npm run docker:logs
```

Requires Node 18+ (uses native `fetch`, `node:test`, `import.meta.dirname`).

**Node 22.5+ gets a better memory backend.** `memory/store.js` prefers
`node:sqlite` with an FTS5 index and falls back to an in-process BM25 inverted
index below that. Same ranking family, so relevance is broadly comparable. The
fallback is slower, not differently behaved. Which one is live is reported on
every `storeStats()` call, because "why is recall worse on the server than on my
laptop" is otherwise unanswerable. Force the fallback with
`TOLLPIKE_MEMORY_BACKEND=memory`.

Environment flags added by this work:

```
MCP_READ_ONLY=true        # /mcp hides AND refuses every mutating tool
TOLLPIKE_MEMORY_BACKEND   # "memory" forces the pure-JS index
QDRANT_URL, QDRANT_API_KEY
OBSIDIAN_VAULT            # or set knowledge.obsidianVault from the panel
NOTION_API_KEY            # read-only integration token
PUBLIC_URL                # what the A2A Agent Card advertises
CURSOR_API_KEY, DEVIN_API_KEY, JULES_API_KEY   # cloud agent drivers
```

---

## 3. Request lifecycle

Read `src/server.js` → `src/routing/router.js` first; everything else hangs
off those two.

```
POST /v1/chat/completions
  ↓ hostGuard           middleware/hostGuard.js   rejects unknown Host headers
  ↓ requireGatewayKey   middleware/auth.js        constant-time, off by default
  ↓ rateLimit           middleware/rateLimit.js   token bucket, off by default
  ↓ memory.hydrate      memory/index.js           recall + inject, off by default
  ↓ compressMessages…   compression/compress.js   truncate → RTK → Caveman
  ↓ applyGuardrails     security/guardrails.js    PII redact + injection scan
  ↓ cache lookup        storage/responseCache.js  exact-match, deterministic only
  ↓ routeChatCompletion   routing/router.js
      buildCandidates()   auto | auto/<strategy> | combo/<name> | explicit
      for each candidate:
        skipReason()      disabled? no key? breaker open? model locked? over budget?
        pickConnection()  first API key not cooling down
        reserveSpend()    holds an estimate against the cap while in flight
        retry loop        2 retries, exponential backoff + jitter, transient only
        adapter call      providers/{openaiCompatible,anthropic,gemini}.js
                          via providers/http.js — deadline + stall watchdog
        on failure → resilience.classifyAndRecord() picks which layer to trip
  ↓ cache store + usage log (storage/costTracker.js → data/usage.jsonl)
  ↓ recordFreeUsage     storage/quotaTracker.js   counts failures too
  ↓ memory.ingest       memory/index.js           user+assistant turns only
```

**`prepare()` is async now**, because memory recall may do network I/O. All
four inbound dialects `await` it. The order inside it is deliberate and the
comments say why: memory recalls against the request as the client sent it (a
query built from caveman-compressed text searches for words that pass just
removed), and guardrails run last so the injection scanner sees exactly what
will be sent upstream.

Three ordering choices worth not undoing:

- **Free usage is recorded on FAILURE too.** A 429 or 500 consumed the vendor's
  rate-limit budget. Not counting it drifts the counter optimistic and the drain
  strategies keep picking a lane with nothing left.
- **Memory ingests after a successful answer**, never before. Ingesting a
  request that then failed fills recall with dead ends.
- **Memory stores what the CLIENT sent**, not the compressed and hydrated
  version. Otherwise each turn stores a caveman paraphrase with the previous
  recall block folded in, compounding into memories increasingly unlike the
  conversation they came from.

**Auth runs before the rate limiter.** The other order let an
unauthenticated caller reach the limiter, which derived bucket identity
from the bearer token, so a stranger could name someone else's bucket and
drain it.

The limiter is mounted on `/v1`, `/api/chat`, `/mcp` and `/a2a`. Every path
that can reach `routeChatCompletion`. It is deliberately **not** on the rest of
`/api`: putting it on the control plane means the request that turns the limiter
off can itself be rejected, locking the operator out of their own panel with no
recovery but restarting the process. MCP and A2A are on it because
`completions_chat` and the `smart-routing` skill both route real requests, so
exempting them would leave a way around the only control that stops a runaway
agent loop.

Streaming (`"stream": true`) takes `routeChatCompletionStream()`. Same
candidate logic, but fallback only works up to connection-open. Once bytes
flow, the provider is committed. Usage is recorded even if the stream dies
partway, because those tokens were still generated and billed.

---

## 4. Invariants: do not break these

`test/security-invariants.test.mjs` asserts these **structurally** (by
reading source text), because behavioral tests can't catch them. That suite
exists because mutation testing found the gap: reverting the auth check to
`token !== gatewayApiKey` passed all behavioral tests, since a
timing-unsafe compare returns the identical 401.

If you change any of these, that suite fails loudly. That's intended. Read
the reasoning before "fixing" the test. Two of them carry a `CHANGED,
deliberately` comment explaining why the *original* invariant was wrong.

| Invariant | Where | Why |
|---|---|---|
| Auth uses `safeCompare`, never `===`/`!==` on the token | `middleware/auth.js` | Plain compare short-circuits on first differing char; response timing leaks the key byte-by-byte |
| No hardcoded fallback secret; return `null` if `TOLLPIKE_SECRET` unset | `security/crypto.js` | Fake encryption with a known key is worse than honest plaintext |
| Salt file written `0o600`; settings written `0o600` atomically | `security/crypto.js`, `storage/settings.js` | Settings hold the gateway key. Non-atomic writes lost updates under concurrency |
| Resilience layer never touches `connection.key` | `routing/resilience.js` | Tracks by opaque connection id so key material never lands in state maps |
| Rate limiter identity is an HMAC, never a raw token substring | `middleware/rateLimit.js` | A prefix keeps key material out of the Map but is *derivable*: `tpk_` + 4 guessable chars let an outsider target your bucket |
| Auth is mounted before the rate limiter | `server.js` | Otherwise unauthenticated callers reach token-derived state |
| `/api/panel/state` never serializes `apiKey` or key material | `server.js` | `apiKeyEnv` (the variable *name*) is fine and the panel shows it; the value never leaves the process |
| Server binds `127.0.0.1` unless `BIND_HOST` overrides | `server.js` | `app.listen(PORT)` alone binds every interface, and the panel API is unauthenticated by default |
| Host-header guard mounted ahead of all routes | `middleware/hostGuard.js` | Same-origin policy does not stop DNS rebinding; the Host header is what an attacker can't forge away |
| Proxy endpoint validates provider id **and** URL scheme | `server.js`, `routing/proxy.js` | It configures where every upstream request is routed |
| Gateway key encrypted at rest when a secret is available | `storage/settings.js` | The panel claimed "encryption active" while writing plaintext: the exact false-confidence failure invariant #2 exists to prevent |
| Luhn `validate()` gates card redaction | `security/guardrails.js` | Without it, any 13–19 digit order number gets mangled |
| Injection scan covers `user` **and `tool`**, never `system`/`assistant` | `security/guardrails.js` | Tool results are untrusted input and the primary indirect-injection vector. The system prompt is the operator's own text |
| Panel never uses `innerHTML` for model output | `public/panel.js` | The panel holds the gateway key in `localStorage`; markup reaching the DOM is a credential leak |
| No MCP tool returns key material, in a response or an error | `mcp/scopes.js` | An agent transcript is stored, replayed and often shipped to a third party. `test/protocols.test.mjs` plants a canary key and scans every read-only tool's output |
| `settings_patch` cannot write `gatewayApiKey` | `mcp/scopes.js` | An agent able to set it locks the operator out; able to clear it, disables auth. The allowlist is the mechanism, not a filter on the value |
| MCP read-only mode REFUSES mutating tools, not just hides them | `mcp/scopes.js`, `mcp/server.js` | Hiding alone leaves them callable by name for any client that remembered them from a previous session |
| `/mcp` and `/a2a` are behind auth **and** the rate limiter | `server.js` | Both reach `routeChatCompletion`. Exempting them leaves a way around the only control that stops a runaway agent loop |
| Caveman never drops a `NEVER_DROP` word | `compression/caveman.js` | Removing `not` from "do not delete the table" inverts the instruction. Lossy compression that can invert meaning is not compression |
| Caveman never touches a system prompt | `compression/compress.js` | It is the operator's own text and the one thing in the request they wrote deliberately |
| Recalled memory is injection-scanned before injection | `memory/index.js` | It lands in a `system` message, the one role the scanner skips because that slot is meant to hold the operator's words. Memory puts someone else's words there |
| Memory recall is caller-partitioned | `memory/store.js`, `server.js` | Same reasoning as the cache: one caller recalling another's turns is a data leak |
| `freeTierOf` rejects a non-object `freeTier` | `storage/quotaTracker.js` | The legacy `freeTier: true` boolean has no limits, so headroom computed from it was 1.0: reporting plenty of free quota for a lane nobody can count |
| Every quota reading carries `observedOnly` | `storage/quotaTracker.js` | The gateway cannot see the same key used elsewhere, so real remaining quota is always this or less |
| Sidecars spawn with `shell: false`, from a closed service list | `services/embedded.js` | Arguments include operator input; one string in a shell is a command injection reachable from the panel. An arbitrary-command supervisor is a remote shell |
| Obsidian paths are realpath-resolved and contained | `knowledge/obsidian.js` | A symlink inside the vault contains no `..` and resolves straight out of the tree |
| `proxy.js` never terminates or re-signs TLS | `routing/proxy.js`, `routing/tls.js` | Shaping our own ClientHello is not interception. A gateway that MITMs upstreams holds every key in cleartext at an unaudited hop |
| Every routing strategy is a total order, never a filter | `routing/strategies.js` | A filtering strategy silently shortens the fallback chain: the request fails while a working lane was never tried |

**Also non-negotiable, enforced by design rather than test:**

- **A configured proxy that can't be used must throw, never fall back to
  direct.** `routing/proxy.js`. Silently bypassing a proxy someone set on
  purpose leaks traffic they believed was routed. This now includes a proxy
  whose stored URL is invalid.
- **The cache is exact-match only.** Never make it semantic/fuzzy.
  Returning a "close enough" answer to a different question is a
  correctness bug wearing a feature's clothes. Only deterministic requests
  (`temperature` unset or `0`) are cached at all. Keys are partitioned by
  caller so the roadmap's per-user auth doesn't turn it into a data leak.
- **A corrupt line in `usage.jsonl` costs one row of history, not the
  gateway.** It used to throw out of `JSON.parse` on the routing hot path.

---

## 5. Design decisions you might otherwise undo

**One adapter covers most providers.** `openaiCompatible.js` serves OpenAI,
DeepSeek, Groq, Together, Fireworks, Mistral, Cerebras, OpenRouter, xAI and
most of the 36. Adding one of those is a `config/providers.json` entry, not
code. Only Anthropic and Gemini need bespoke adapters.

**`providers/http.js` owns every upstream call.** Request deadline, stream
stall watchdog, and the `ProviderError` shape live there. There was
previously no timeout anywhere: a provider that accepted the connection and
went quiet held the request open forever *and* never let the fallback chain
advance. Timeouts are deliberately **not** retryable. Retrying an
unresponsive provider twice with backoff triples the wait before fallback.

**3-layer resilience: `model ⊂ connection ⊂ provider`.** Failures trip the
smallest scope that explains them: 429 locks one model for 60s, 401 cools
one API key, 5xx counts toward the provider breaker, 404 locks the model for
30 min. Recovery is lazy (checked on access), so there are no background
timers to leak. See `routing/resilience.js:classifyAndRecord`.

**`auto` builds its candidate pool from ALL configured providers**, not
just ones with keys, so `attempts[]` can report *why* each was skipped
("no API key" vs "circuit open" vs "over budget"). Filtering early made
debugging much worse. Don't re-optimize this. The client-facing copy of
`attempts[]` is sanitized by `publicAttempts()`. Upstream error bodies
stay in the log.

**Prices are per MILLION tokens: `costPer1mTokens`.** The field used to be
named `costPer1kTokens` while holding per-million values (which is how every
vendor publishes them), and `costTracker.js` divided by 1,000. Every recorded
cost was therefore **1000× too high**, and since caps are checked against
those numbers a $5/month cap behaved like $0.005 and skipped the provider
almost immediately. No test caught it. All 152 asserted internal
consistency, and the arithmetic was self-consistently wrong. The very first
live request made it obvious. The field name now matches the unit so config
values can be pasted straight from a vendor pricing page, which is the
conversion step that silently went missing. `TOKENS_PER_PRICE_UNIT` in
`costTracker.js` is the single place it's applied.

Corollary: monetary figures carry **8 decimal places** internally and the
panel formats adaptively. At real per-million rates a handful of requests
costs millionths of a dollar, and the previous 4dp rounding printed that as
`$0.0000`, which reads as *free* rather than *small*, the wrong signal
from a spend-control tool.

**Pricing is per MODEL, not per provider.** `priceFor(provider, model)` in
`registry.js` reads `modelPricing[model]` and falls back to the
provider-level rate. A single rate per provider was wrong nearly everywhere:
`gpt-4o` and `gpt-4o-mini` differ ~17x, `claude-opus-4-8` and
`claude-haiku-4-5` ~5x. Under-counting is the dangerous direction, because
the cap then silently never fires.

**Only 6 providers have verified pricing.** Checked against vendor pages on
2026-08-08 and carrying `pricingVerified: "2026-08-08"`:

| Provider | Verified rates ($/1M in · out) |
|---|---|
| anthropic | sonnet-4-6 3·15 · opus-4-8 5·25 · haiku-4-5 1·5 |
| openai | gpt-4o 2.5·10 · gpt-4o-mini 0.15·0.6 |
| gemini | 2.5-flash 0.3·2.5 · 2.5-pro 1.25·10 |
| groq | llama-3.3-70b-versatile 0.59·0.79 |
| xai | grok-4.5 2·6 |
| deepseek | v4-flash 0.14·0.28 · v4-pro 0.435·0.87 |

The audit turned up more than bad numbers:

- **Gemini was under-priced 4–8x** (config had 0.075/0.3; real flash rates
  are 0.3/2.5). Under-counting means a cap that never fires.
- **Stale model ids.** `deepseek-chat`/`deepseek-reasoner` and `grok-4` no
  longer exist at those vendors. With the model allowlist now enforced, such
  entries are broken in both directions: the listed model 404s upstream, and
  the model that *does* exist is rejected locally. Both are corrected.
- **Six providers are priced 0/0**: cerebras, openrouter, nvidia,
  githubmodels, huggingface, chutes. Cerebras is demonstrably not free. A
  zero rate means recorded spend is always $0 and **the cap can never
  trip**, so setting one there is worse than setting none. `/api/panel/
  providers/:id/budget` now returns a `warning` in exactly that case, and
  the panel surfaces it.
- **`verified: true` was meaningless.** In this config it means "the baseURL
  answered", which was never established for any provider. It came with the
  unaudited drop (§10). Reset to `false` for all non-local providers.

**`npm run verify-pricing` keeps this honest.** A one-off audit is worthless
three months later, so staleness is a machine-checkable state rather than
something you remember to re-check. `scripts/verify-pricing.mjs` +
`config/pricing-sources.json`:

- **first-party** providers (the vendor serves its own model) are diffed
  automatically against the OpenRouter catalogue, which matched all five
  hand-verified rates exactly. `--write` applies corrections and restamps.
- **third-party hosts** resell someone else's open model at their own rate,
  so the catalogue says nothing about them. These are reported with their
  vendor URL and how old the last human check is, never auto-"verified".
- **free-tier** entries priced 0/0 are reported as `NO CAP`, because a zero
  rate means recorded spend is always $0 and a budget cap can never trip.

It exits non-zero on drift, stale ids, or unenforceable pricing, so CI can
gate on it. Its first run found 4 real drifts, two of them severe
under-counts: `cohere/command-r-plus` at 0.15/0.6 against a real 2.5/10, and
`perplexity/sonar-pro` at 1/1 against a real 3/15.

21 providers still carry `pricingVerified: false`. Treat their rates as
indicative only, and don't enforce a budget against one without checking the
vendor page first.

**Cost accounting is honest about estimates.** When a provider reports
`usage`, those numbers are used. When it doesn't, tokens are estimated from
the actual prompt and the row is marked `estimated` (`usage_source` on the
response, `~` in the panel). There used to be a fallback reading
`raw.promptEcho`, a field no adapter ever set, so any unreported prompt
recorded as **1 token** regardless of size.

**Budget caps reserve in-flight spend.** `reserveSpend()` holds an estimate
for the duration of a call. Without it the cap only saw committed spend, so
N concurrent requests all read "not yet reached" and collectively overshot.

**Cost aggregates are incremental and in-memory.** `getMonthlySpend` used to
re-read and re-parse the whole log once per candidate provider. Up to 36
full file reads per `auto` request, against a file that only grows.

**Local runtimes carry `requiresKey: false`** and get priority 50+, so they
sort last and never preempt a real provider. Connection-refused isn't
classified retryable, so they fail fast without burning backoff.

**Guardrails are documented as heuristics, not boundaries.** PII redaction
is pattern matching, not DLP. Injection detection is a known-unsolved
problem. Keep the README honest about this; don't let the docs drift into
implying they're guarantees.

---

## 6. Inbound dialects

The gateway understands four request formats and translates all of them into
one internal shape before routing. **This is what determines which tools can
connect, not provider coverage.** Claude Code was unreachable not because a
provider was missing but because it only speaks `/v1/messages`.

| Endpoint | Format | Unlocks |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI chat | Cursor, Continue, Aider, every OpenAI SDK |
| `POST /v1/messages` | Anthropic messages | **Claude Code**, Cline, Anthropic SDK |
| `POST /v1/responses` | OpenAI Responses | **Codex** |
| `POST /api/chat`, `GET /api/tags` | Ollama | anything with a hardcoded local-Ollama mode |
| `/vscode/<key>/...` | path-token alias | clients that can't send auth headers |

`src/inbound/*.js` mirrors `src/providers/*Translate.js`: those convert our
requests *out* to a vendor's format, these convert a vendor's format *in*.
All are pure functions, unit-tested without network, for the same reason.

Notes that cost time:

- **Anthropic clients authenticate with `x-api-key`, not `Authorization`.**
  `middleware/auth.js` accepts both, or `/v1/messages` is unreachable.
- **Anthropic's stream is block-structured**: every piece of content is
  opened, streamed, then closed, while OpenAI's is a flat delta sequence.
  The encoder tracks which block is open and closes it before opening
  another; getting this wrong produces a stream clients silently drop.
- **Ollama streams newline-delimited JSON, not SSE.** No `data:` prefix, no
  blank-line separator, no `[DONE]`.
- **Ollama streams by default**: an absent `stream` field means true, the
  opposite of OpenAI.
- **`/api/*` sits outside `/v1`**, so it needs its own auth and rate-limit
  mounts. Easy to forget and leaves an unauthenticated hole.
- **Path tokens are off unless `ALLOW_PATH_TOKEN=true`.** Keys in URLs leak
  via proxy logs, history and Referer. It exists only for clients with no
  alternative, and a header always wins over the path.

`/v1/responses` implements text and function tools only. Built-in tools
(web_search, file_search), `previous_response_id` threading, reasoning items
and images are absent rather than faked, so a client asking for them gets
nothing back instead of something wrong.

## 7. The control panel

A multi-page SPA at `/panel`, served as static assets under a CSP that
forbids inline and remote script. `public/index.html` is the shell and all
CSS; `public/panel.js` is the router plus one renderer per page.

| Page | Backed by |
|---|---|
| Home | totals, cost chart, crossing log |
| Providers | the 36-lane grid: category groups, search, filter chips, per-card cap + toggle + `Test lane` |
| Routing | fallback chain visual, routing modes, trial run with chain animation |
| Budgets | caps vs month-to-date spend |
| Resilience | `resilience.snapshot()`: breakers, cooling keys, locked models |
| Cache / Compression | cache stats + clear; compression enable + history window |
| Guards / Access | PII, injection mode; gateway key, rate limit, encryption, bind posture |
| Proxy / Endpoints | per-provider egress proxy; connection URLs and response headers |

Adding a page: add an entry to `NAV`, `PAGE_META`, a `<div class="page"
id="page-x">` in the shell, and a `PAGES.x` renderer. The router is
hash-based.

**Everything rendered goes through `esc()`, and model output is built with
DOM nodes.** This is not stylistic. The panel is reachable without auth by
design and holds the gateway key in `localStorage`; a model emitting
`<img onerror=...>`, trivially reachable through indirect prompt injection,
would exfiltrate that key on the next 8-second refresh.

Deliberately **not** built, despite appearing in the reference design this
was modelled on: MITM proxy (contradicts `proxy.js`'s promise not to touch
TLS), OAuth/cookie provider auth (that's the provider-reach axis this
project trades away, and cookie access generally breaks provider ToS), and
remote restart/shutdown controls (a destructive control on a
default-unauthenticated surface).

---

## 8. Gotchas already paid for

Each of these cost real debugging time. Don't rediscover them.

- **MCP SDK takes schema objects, not method strings.** `setRequestHandler(ListToolsRequestSchema, ...)`. The string form throws `Schema is missing a method literal` at import time.
- **Anthropic requires strictly alternating user/assistant roles.** Two consecutive tool results map to two consecutive `user` messages → 400. `anthropicTranslate.js` merges consecutive same-role messages. Same for Gemini.
- **Gemini has no tool-call IDs.** To answer a tool result you must map OpenAI's `tool_call_id` back to the function *name*. `geminiTranslate.js` walks the history to build that map.
- **Anthropic streams tool args incrementally**, Gemini streams them **complete in one part**. The adapters emit different delta shapes for this reason; it's not an inconsistency.
- **Anthropic and Gemini report real token counts mid-stream.** The adapters capture them and yield an internal `{__usage}` frame that the router consumes and never forwards to the client.
- **Don't send `stream_options: {include_usage: true}`.** It would give exact streamed spend, but strict providers reject unknown body fields and none of the 30 OpenAI-compatible entries has been exercised live.
- **`undici` is a real dependency.** Node bundles it internally but doesn't expose it as a bare specifier, so `import("undici")` fails without the package. Needed for `ProxyAgent`.
- **`fetch` cannot set a `Host` header**: it's forbidden. The host-guard tests use `node:http` for that reason.
- **Streaming latency is full stream duration**, not time-to-first-byte. If you add a TTFB metric, add it as a separate field.

---

## 9. Testing conventions

`node --test`, no framework. Four kinds:

1. **Pure unit**: `translate`, `guardrails`, `cache`, `resilience`, `crypto`, `compression`. No I/O.
2. **Behavioural regression**: `hardening.test.mjs`. One test per fixed security finding; each fails against the pre-fix code.
3. **Fake-server integration**: `adapters.integration.test.mjs`. Spins a local `http.createServer` mimicking a provider's wire format including real SSE framing.
4. **E2E**: `gateway.e2e.test.mjs`. Spawns the real server, hits real endpoints.

**When adding a feature, prefer pure functions + a fake server over mocks.**
Every bug this project actually shipped was caught by a fake server.

**Never commit a live API key to a test.** Nothing here has been verified
against a real provider. See gap #1 below.

**The e2e suite's flakiness is fixed, and it had three causes**, none of
them timing in the way it looked:

1. A 5s health budget (`50 × 100ms`). `node --test` runs each file in its own process in parallel, and a cold start plus the 36-provider config routinely exceeds that. Every test then reported `cancelled`. Now 30s, and it fails fast if the process actually dies.
2. The rate-limit test set `capacity: 2` and its siblings inherited it, turning unrelated assertions into 429s. All suites now sit under one parent `describe` with `concurrency: 1`.
3. The suite deleted the shared `./data` while the crypto suite was concurrently deriving a key from `.salt`. It now uses its own `TOLLPIKE_DATA_DIR`.

If you see `cancelled` again, check for a stale server squatting port 20777
before assuming flakiness. The health poll will happily succeed against
someone else's process.

---

## 10. Known gaps

1. **Only Groq and Ollama have been exercised live.** Both buffered and streamed, both returning `usage_source: "provider"`: Groq sends a usage frame in its SSE and the parser picks it up. The other 34 entries remain verified only against fake servers. Before trusting one with money, run a real buffered *and* streamed request through it and confirm the content and the `usage` numbers. `npm run verify` probes reachability but does not exercise completions.
2. **Docker image never actually built**. No daemon was available. Compose YAML parses, all `COPY` paths exist, `npm ci --omit=dev` succeeds. Confirm the container reaches `healthy` before depending on it. Note the container sets `BIND_HOST=0.0.0.0` (the namespace is the boundary) while compose publishes to `127.0.0.1` on the host.
3. **Cache is in-memory per process.** Restart drops it; two containers don't share it. Keys are already caller-partitioned, so sharing it later is safe.
4. **Chart is last-20 raw requests**, not time-bucketed.
5. **Single shared gateway key**, not per-user auth with separate quotas.
6. **`tools`/`tool_choice` shape isn't validated**. Malformed input surfaces as a raw provider error, not a clean 400.
7. **`data/usage.jsonl` has no rotation.** Aggregates are incremental now so it only costs startup time, but it grows forever.
8. **Streamed spend is estimated unless the provider volunteers usage.** Anthropic and Gemini always do; Groq does too (confirmed live). The rest of the OpenAI-compatible path depends on the provider.
9. **21 of 30 remote providers have unverified pricing**, and their model ids are equally unverified. Two of the six checked had stale ones. Treat any unchecked provider as indicative only, and check the vendor page before enforcing a cap against it. Prices and model names both drift; this needs periodic re-checking, not a one-off pass.

### Gaps added by the routing/memory/agents work

Everything below was built against documented shapes and tested against pure
functions or fake servers. None of it has been exercised against the live
third-party service it talks to. The pattern to follow is the one pricing
already uses: a `*Verified: false` stamp that a human clears after a real call.

10. **All 13 free-tier declarations carry `limitsVerified: false`.** They are the
    vendors' published shapes, not figures confirmed against an account. A
    headroom figure computed from a wrong limit is confidently wrong — and it is
    wrong in the *dangerous* direction if the vendor's real limit is lower,
    because the drain strategies will keep choosing a lane that is already
    exhausted. Verify the ones you actually route to; `config/providers.json` is
    the only place to change.
11. **No two shipped entries are known to share a free-quota pool**, so
    `dedupedAway` reports 0 today. The dedup machinery is real and tested —
    `test/quota.test.mjs` declares a shared pool to exercise it — but if you add
    an entry that fronts an allowance another entry already draws on, you must
    set the same `quotaPool` on both or the counter reports twice the quota you
    have. Seven pools are marked `poolConfidence: "assumed"`.
12. **`nebius` carries `freeTier: true`**. The legacy boolean from the original
    config, with no limits. `freeTierOf` rejects non-objects and reports it under
    `undeclaredFreeTiers`, so it is treated as a paid lane rather than one with
    imaginary headroom. Filling in real limits is a config change.
13. **The vector half of memory has never run against a live Qdrant.** Collection
    creation, upsert and search follow the documented REST shapes and every
    failure path is exercised, but the success path is untested. Keyword recall
    is fully tested on both backends. Embeddings are equally untested: no
    provider's `/embeddings` endpoint has been called.
14. **All four cloud-agent drivers are `verified: false`.** Vendor task APIs move
    faster than their documentation. Expect the first live call per driver to
    need a fix, and treat the endpoint paths in `agents/cloud.js` as a starting
    point rather than a contract.
15. **No sidecar has been started for real**, none of Bifrost, 9Router or
    CLIProxy was installed here. The supervisor's failure paths are tested
    (missing binary, bad port, double start, partial cluster); the success path
    is not. `serviceHealth` assumes each exposes the `healthPath` declared in
    `SERVICE_DEFINITIONS`.
16. **Notion is untested against a real workspace.** Block-text extraction covers
    the documented text-bearing block types, and only top-level blocks —
    `hasMore` says so rather than presenting a partial page as complete.
17. **TLS profiles change the fingerprint but are not verified to *achieve*
    anything.** Nobody has checked what any provider does differently in
    response to one. Read the header of `routing/tls.js` before drawing a
    conclusion from a profile appearing to "work".
18. **A2A task history is in-process and bounded to 500.** Skills run
    synchronously, so `tasks/get` exists for after-the-fact lookup rather than to
    track live work, and a restart loses it. `tasks/cancel` on a finished task
    returns -32002 rather than pretending it did something. `tasks/list` is a
    non-standard extension and labels itself as one in its response.
19. **The MCP HTTP transport is stateless per request**. A new `Server` and
    transport per POST, `sessionIdGenerator: undefined`. The SSE transport *is*
    stateful, and its sessions do not survive a restart; a stale `sessionId`
    returns a 404 telling the client to reopen the stream.
20. **`STRATEGY_IDS.length` is 19, not 18.** Nothing hardcodes a count. The
    panel, the README table and `/api/panel/strategies` all read the registry —
    so adding or removing a strategy leaves no stale number to chase.
21. **The Obsidian symlink-escape test skips on Windows** without the privilege
    to create symlinks. The containment code is platform-independent (realpath on
    both sides, `root + sep` prefix compare), but that specific assertion only
    runs where symlinks can be made. It is the one skipped test in the suite.

Roadmap order in `README.md`.

---

## 11. Provenance note: read before publishing

During early development, a set of files appeared in the working tree that
the authoring session did not write: `test/` (9 files),
`scripts/verify-providers.mjs`, and edits to `README.md`, `Dockerfile`,
`package.json`, and `config/providers.json` (which grew from 11 to 36
providers).

They were audited then, and **the baseURL audit was independently re-run
during the security pass**: all 36 `baseURL`s resolve to first-party vendor
domains or `localhost`. No exfiltration endpoint, which was the material
risk. No `postinstall`/`preinstall`/`prepare` hooks. No `eval`, no dynamic
require; the only `child_process` use is the e2e test spawning the local
server. `npm audit` reports zero vulnerabilities.

**Still verify independently before this goes into a company repo.** Diff
`config/providers.json` against vendor docs and regenerate hashes with
`sha256sum test/*.mjs scripts/*.mjs` against your own record.

---

## 12. Most common task: adding a provider

If it speaks the OpenAI chat-completions format: **config only, no code:**

```jsonc
// config/providers.json
{
  "id": "newprovider",
  "name": "New Provider",
  "category": "inference",        // frontier | inference | aggregator | local
  "adapter": "openai-compatible",
  "baseURL": "https://api.newprovider.com/v1",
  "apiKeyEnv": "NEWPROVIDER_API_KEY",
  "priority": 12,
  "costPer1mTokens": { "input": 0.5, "output": 1.5 },
  "models": ["their-model-name"],
  "verified": false
}
```

`category` drives which group it lands in on the Providers page.

`models` is an **allowlist**, not documentation: a request for
`newprovider/something-else` is rejected with a 400 unless
`ALLOW_UNLISTED_MODELS=true`. That's what stops an expensive model being
reached and then billed against this entry's cost table.

Then `NEWPROVIDER_API_KEY=... npm run verify newprovider` and set
`"verified": true` only if it actually answered. Multiple keys are
comma-separated in the env var; each becomes an independently
cooled-down connection.

If the wire format differs, copy the `anthropic.js` / `anthropicTranslate.js`
pair as the pattern: pure translation functions in one file, HTTP in the
other, both a buffered and a streaming variant, and unit tests for the
translation before wiring it up.
