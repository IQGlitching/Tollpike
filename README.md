# tollpike

A personal AI gateway: one OpenAI-compatible endpoint (`/v1/chat/completions`)
that routes across whichever providers you've configured, with tiered
fallback, cost tracking, free-quota accounting, stacked compression,
persistent memory, and the whole gateway exposed as tools an agent can drive.

**46 providers** (6 local runtimes) · **575 tests** · **19 routing
strategies** with tier-1/2/3 combos · full tool-calling on
OpenAI/Anthropic/Gemini · streaming · 3-layer resilience · budget caps ·
free-quota tracking · hybrid memory recall · RTK + Caveman compression ·
**104 MCP tools across 31 scopes** over stdio/HTTP/SSE · **A2A** JSON-RPC
with 6 skills · response caching · security guardrails

Point any OpenAI-compatible tool at one local endpoint and reach 46
providers behind it, with hard spend limits, failure isolation, response
caching and optional guardrails. Or plug it into an MCP client, an A2A
network or a cloud coding agent, and it becomes a tool the agent operates.

It optimises for **cost control and honest reporting**, not provider reach.
Every number it shows you says where it came from: spend figures report what
share is provider-reported versus locally estimated, free-quota readings say
they are observation-only, savings state the baseline they are measured
against, and anything unverified is labelled unverified.

## Install

Node 18 or newer. Node 22.5+ additionally enables the SQLite-backed half of
memory recall; below that it falls back to an in-process index and says so.

### Option A: run it without installing anything

```bash
npx tollpike
```

### Option B: install the CLI globally

```bash
npm install -g tollpike
tollpike
```

State lives in `~/.tollpike` when you install this way, so an upgrade never
throws away your usage ledger, budget caps or provider toggles.

### Option C: Docker (recommended for anything long-running)

```bash
git clone https://github.com/IQGlitching/Tollpike.git
cd Tollpike
cp .env.example .env    # optional, add at least one provider API key
npm run docker:up       # builds the image and starts it, detached
npm run docker:logs     # follow logs
npm run docker:down     # stop
```

This uses `docker-compose.yml`: a named volume (`tollpike-data`) persists
`data/usage.jsonl` and `data/settings.json` (your provider toggles, budget
caps, gateway key) across restarts and rebuilds, a healthcheck hits
`/health` every 30s, and `restart: unless-stopped` brings it back after a
host reboot or crash. Runs as a non-root user inside the container.

### Option D: from source

```bash
git clone https://github.com/IQGlitching/Tollpike.git
cd Tollpike
npm install
npm start
```

### Option E: systemd (bare-metal, no Docker, survives reboots)

```bash
sudo useradd -r -s /usr/sbin/nologin tollpike
sudo mkdir -p /opt/tollpike && sudo cp -r . /opt/tollpike
sudo chown -R tollpike:tollpike /opt/tollpike
cd /opt/tollpike && npm ci --omit=dev
sudo cp deploy/tollpike.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tollpike
```

Edit the `User=` and `WorkingDirectory=` lines in `deploy/tollpike.service`
first if you're installing somewhere other than `/opt/tollpike`.

## First run

**1. Start it.** It binds loopback only, so nothing is exposed to your
network until you deliberately change `BIND_HOST`.

```bash
tollpike
```

```
tollpike listening on http://127.0.0.1:20128
  API base:      http://127.0.0.1:20128/v1
  control panel: http://127.0.0.1:20128/panel
```

**2. Open the control panel.** <http://127.0.0.1:20128/panel>

It boots with zero keys configured. Every provider shows as `NO KEY` and the
router has nowhere to send traffic yet, which is the expected first state.

**3. Add a provider key.** Either put it in the protected env file, which is
outside the source tree on purpose:

```bash
mkdir -p ~/.tollpike
printf 'GROQ_API_KEY=your_key_here\n' >> ~/.tollpike/.env
```

or export it for a single run:

```bash
ANTHROPIC_API_KEY=sk-ant-... tollpike
```

Multiple keys for one provider are a comma-separated list, and each becomes
an independently cooled-down connection:

```bash
GROQ_API_KEY=key_one,key_two,key_three
```

Restart after editing the file. The Providers page will show the lane turn
green, and the sidebar lane count goes up.

**4. Send your first request.**

```bash
curl http://127.0.0.1:20128/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'
```

`"model": "auto"` means "walk the fallback chain in priority order". The
response headers tell you what actually happened:

```
X-Tollpike-Provider: groq
X-Tollpike-Attempts: 1
X-Tollpike-Candidates: 41
X-Tollpike-Routing-Tier: 1
X-Tollpike-Routing-Strategy: priority
X-Tollpike-Cache: MISS
```

`Attempts` counts calls actually made upstream. `Candidates` counts the whole
fallback walk, most of which is usually lanes skipped without being contacted
at all, for want of a key or because a cap or breaker ruled them out. A
request answered by the first reachable lane reports 1 attempt across 41
candidates, not 41 attempts.

## Point your existing tools at it

Anything that speaks the OpenAI chat-completions format works by changing
the base URL. No SDK swap, no code rewrite.

**Node, official OpenAI SDK**

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:20128/v1",
  apiKey: "unused"            // or your gateway key, if you set one
});

const res = await client.chat.completions.create({
  model: "auto/cheapest",
  messages: [{ role: "user", content: "Hello!" }]
});
console.log(res.choices[0].message.content);
```

**Python, official OpenAI SDK**

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:20128/v1", api_key="unused")

res = client.chat.completions.create(
    model="combo/free-first",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(res.choices[0].message.content)
```

**Streaming.** Add `"stream": true`. The response is standard OpenAI-style
SSE (`data: {...}\n\n`, terminated by `data: [DONE]`), including for
Anthropic and Gemini lanes, whose native event shapes are translated so your
client only ever parses one format.

**Environment-variable drop-in.** Most tools read these, so exporting them
is often the whole integration:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:20128/v1
export OPENAI_API_KEY=unused
```

## Choosing a route

The `model` field is the routing instruction. Four forms:

```jsonc
{ "model": "anthropic/claude-sonnet-4-6" }  // explicit lane, no fallback
{ "model": "auto" }                         // priority order, or your default combo
{ "model": "auto/cheapest" }                // one of 19 strategies
{ "model": "combo/free-first" }             // a tiered chain
```

Preview what a route resolves to before spending anything:

```bash
curl -X POST http://127.0.0.1:20128/api/panel/routing/preview \
  -H "Content-Type: application/json" \
  -d '{"model":"auto/cheapest"}'
```

Each hop reports `wouldBeContacted`, and a `skip` reason when it would not be:
the answer runs through the same `skipReason` the router dispatches through,
so a lane with an open breaker, a locked model, every key cooling down or
spend past its cap shows up as skipped here rather than looking ready to
serve. Asking does not consume the single probe a recovering provider is
allowed per cooldown window.

Two request-level flags: `"stream": true` for SSE, and `"cache": false` to
bypass the response cache for one request.

## The control panel

<http://127.0.0.1:20128/panel>. Twenty pages over one gateway.

| Page | What it is for |
|---|---|
| Control center | Live routing topology, decision gates, traffic telemetry, spend |
| Providers | Every lane, its models, keys, health and per-provider budget cap |
| Routing | The 19 strategies, live ordering, and why a lane ranks where it does |
| Budgets | Monthly caps, enforced at routing time rather than after the fact |
| Ledger | Every request: provider, model, tokens, cost, latency |
| Resilience | Breaker state, cooling keys, locked models, manual reset |
| Combos | Build and preview tiered fallback chains |
| Free quota | Per-provider free allowances, counted with shared pools deduplicated |
| Cache | Hit rate, TTL, LRU capacity, clear |
| Compression | Preview RTK and Caveman against your own text before enabling |
| Memory | Recall mode, embedding provider, what is actually stored |
| Knowledge | Notion and Obsidian as read-only context |
| Protocols | The MCP and A2A surfaces and how to connect to them |
| Cloud agents | Codex, Cursor, Devin, Jules behind one interface |
| Services | Bifrost, 9Router, CLIProxy as supervised sidecars |
| Guards | PII redaction, prompt-injection mode, rate limit |
| Access | The gateway key, and what each control actually covers |
| Proxy | Per-provider and global egress proxy |
| Endpoints | Every route this gateway serves |
| Achievements | Streaks and savings, derived from the ledger |

The test console on the Control center sends a real request and animates the
actual `attempts` array that came back, so the chain you watch is the chain
that ran.

## Locking it down

The panel API is unauthenticated until you set a gateway key. Set one from
the Access page, or:

```bash
curl -X POST http://127.0.0.1:20128/api/panel/auth/key \
  -H "Content-Type: application/json" \
  -d '{"key":"a-long-random-string"}'
```

After that, every `/v1/*` and `/api/*` call needs `Authorization: Bearer
<key>`. To encrypt that key at rest rather than storing it as honest
plaintext, set `TOLLPIKE_SECRET` before starting:

```bash
TOLLPIKE_SECRET=$(openssl rand -hex 32) tollpike
```

## CLI reference

```bash
tollpike                 # start the gateway and control panel
tollpike start           # the same thing, explicitly
tollpike mcp             # serve the 104 MCP tools over stdio
tollpike where           # print resolved paths, ports and URLs
tollpike --version
tollpike --help
```

From a checkout, the npm scripts are the equivalent:

```bash
npm start                # start
npm run dev              # start with --watch
npm test                 # 575 tests
npm run verify           # check provider endpoints against vendor docs
npm run verify-pricing   # check price tables against published rates
npm run docker:up        # build and start the container, detached
npm run docker:logs      # follow container logs
npm run docker:down      # stop the container
```

## Configuration

Everything is optional. Tollpike boots with nothing set.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `20128` | Listen port |
| `BIND_HOST` | `127.0.0.1` | Listen address. Anything non-loopback prints a warning if no gateway key is set |
| `TOLLPIKE_ENV_FILE` | unset | Read credentials from this file and nothing else. Suppresses both defaults |
| `TOLLPIKE_DATA_DIR` | `./data`, or `~/.tollpike/data` via the CLI | Where `usage.jsonl` and `settings.json` live |
| `TOLLPIKE_SECRET` | unset | Enables AES-256-GCM encryption of the stored gateway key |
| `TOLLPIKE_ALLOWED_HOSTS` | unset | Extra hostnames the host-header guard accepts |
| `ALLOW_UNLISTED_MODELS` | `false` | Allow models not listed for a provider in `config/providers.json` |
| `UPSTREAM_TIMEOUT_MS` | see `src/providers/http.js` | Per-request deadline |
| `UPSTREAM_STALL_TIMEOUT_MS` | see `src/providers/http.js` | Per-chunk stall watchdog for streams |
| `MCP_READ_ONLY` | `false` | Hide and refuse every mutating MCP tool |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | unset | Egress proxy, overridden by per-provider settings |
| `<PROVIDER>_API_KEY` | unset | Credentials. Comma-separate for multiple keys per provider |

Credentials resolve in this order, first match per variable winning:
`TOLLPIKE_ENV_FILE` if set (and then nothing else), otherwise
`~/.tollpike/.env` and then `./.env`. A variable already present in the real
environment beats every file, which is what keeps `docker run -e` and
systemd's `EnvironmentFile` working.

## Security

The guardrails below are off by default and opt-in. See the Security
section of the control panel. The network posture is on by default.

**Always on**

- **Binds loopback.** The server listens on `127.0.0.1` unless you set
  `BIND_HOST`. The control-panel API is unauthenticated until you set a
  gateway key, so it must not reach the network by accident; if you do bind
  a non-loopback address with no key set, startup prints a warning.
- **Host-header guard.** Requests are answered only when addressed to
  `localhost` or an IP literal. This is the defence against DNS rebinding,
  where a page you visit points a hostname it controls at `127.0.0.1` and
  then drives this API from its own origin. List any legitimate hostname
  you front the gateway with in `TOLLPIKE_ALLOWED_HOSTS`.
- **Upstream deadlines.** Every provider call runs under a request timeout,
  and streams under a per-chunk stall timeout (`UPSTREAM_TIMEOUT_MS`,
  `UPSTREAM_STALL_TIMEOUT_MS`). A provider that accepts the connection and
  then goes quiet gets routed around instead of holding the request open.
- **Model allowlist.** `provider/model` is rejected unless that model is
  listed for the provider in `config/providers.json`, so the `models` array
  is an allowlist rather than documentation and spend can't be billed
  against the wrong cost table. `ALLOW_UNLISTED_MODELS=true` opts out.
- **Panel hardening.** The panel escapes everything it renders and builds
  model output with DOM nodes rather than `innerHTML`, under a CSP that
  forbids inline and remote script. It holds your gateway key in
  `localStorage`, so markup reaching the DOM would be a credential leak.

**Opt-in**

- **Encryption at rest (AES-256-GCM).** Set `TOLLPIKE_SECRET` and the
  stored gateway key is encrypted with a key derived via scrypt from a
  per-install random salt. If the secret isn't set, it's stored as honest
  plaintext rather than being fake-encrypted with a hardcoded key. The
  appearance of encryption with none of the protection is worse than
  plaintext you know about. The panel reports whether the key is *actually*
  encrypted on disk, not merely whether a secret is configured.
  **If the secret goes missing, the gateway refuses rather than opens.** A key
  that cannot be decrypted used to decode to `null`, which is exactly what "no
  key was ever configured" looks like, so a gateway set up to require a key
  served every request unauthenticated the moment `TOLLPIKE_SECRET` went
  missing from a unit file or a container. It now answers `503` and says what
  to do. The ciphertext is also preserved across unrelated settings writes:
  that `null` used to be written back over it by the next provider toggle or
  budget-cap change, destroying the key beyond recovery even for someone
  holding the correct secret.
- **Constant-time auth comparison.** The gateway key check uses
  `crypto.timingSafeEqual` over hashed inputs. (This was a real bug in an
  earlier version of this project: a plain `!==` returns as soon as it hits
  a differing character, leaking how many leading characters matched via
  response timing.)
- **Rate limiting.** Token bucket per client. It runs *after* authentication
  and buckets on `req.callerId`, which auth has already reduced to an HMAC of
  the validated key under a per-process random key, falling back to source IP
  when no gateway key is set. Both halves of that matter: the other order let
  an unauthenticated caller name someone else's bucket and drain it, and
  deriving identity from the header here instead of from the authenticated
  caller meant any token-shaped string minted a fresh bucket, so with no
  gateway key set a client could rotate the header and never be limited at
  all. Mounted on `/v1`, `/mcp`, `/a2a` and `/api/chat`, and deliberately not
  on the `/api/panel` control plane, so the request that disables it can never
  be rate-limited itself. The failure mode this actually protects against on a
  personal gateway is a runaway agent loop burning paid quota in seconds.
- **PII redaction.** Strips emails, Luhn-valid card numbers, IBANs, common
  API-key shapes, JWTs and private-key blocks before anything is sent
  upstream, in plain string content and in multimodal content parts.
- **Prompt-injection guard.** Heuristic scan of `user` **and `tool`** turns
  in `off` / `flag` / `block` modes. Tool results carry text from web pages,
  files and APIs you don't control, which makes them the primary indirect-
  injection vector. `system` and `assistant` turns are never scanned:
  those are the operator's own text.
- **Random key generation.** The panel can generate a
  `crypto.randomBytes`-backed gateway key so you're not tempted to type
  `password123`. Keys shorter than 16 characters are rejected.

**What these are not.** PII redaction is pattern matching, not a DLP
product: it will miss unusual formats, names, addresses and anything
contextual. Prompt-injection detection is a known-unsolved problem; these
patterns catch low-effort attempts and will not stop a determined
adversary. Both are defence-in-depth that reduce accidental leakage, not
guarantees. Treat them accordingly.

## 3-layer resilience

Failures are isolated to the smallest scope that explains them:

```
model  ⊂  connection  ⊂  provider
```

- **429 (rate limit)** → lock that *model* for 60s. Other models on the
  same key keep serving.
- **401/403 (bad credential)** → cool that *connection* (API key) for 60s.
  Other keys for the same provider keep serving.
- **404 (unknown model)** → lock that model for 30 min; retrying won't make
  it appear.
- **5xx / network / 408** → count toward the *provider* circuit breaker;
  opens after 3 failures for 30s, then half-open probe. Exactly one request
  is admitted per cooldown window, not one per caller: the whole point is
  that a burst arriving the moment the window opens does not all pile onto a
  provider still known to be down. If that probe never reports back, the
  next window admits another, so a dropped request cannot bench a lane
  permanently.
- **Any other 4xx (400, 413, 422)** → the *request* was wrong, not the lane.
  The candidate still fails and the walk moves on, but nothing is recorded
  against the provider. Otherwise one caller sending malformed requests
  opens the breaker on a lane that is answering everyone else.

A flat provider-only breaker treats all of these identically and disables far
more capacity than necessary. Recovery is lazy (checked on access), so
there are no background timers to leak.

Multiple keys per provider are just a comma-separated env var:
`GROQ_API_KEY=key_one,key_two,key_three`. Each becomes an independently
cooled-down connection, and the router picks the first one that isn't
cooling down.

## Control panel

A dark, terminal-styled dashboard at `/panel`, backed by `/api/panel/*`:

- **Routing chain**: every configured provider as a node, ordered by
  priority. Circuit-breaker state shown live (green dot = healthy, red =
  open). Click a node to expand its settings.
- **Per-provider toggle**: disable a provider without touching `.env` or
  restarting. Disabled providers are removed from `auto` candidate pools
  entirely (not just skipped-and-logged).
- **Per-provider budget caps**: set a monthly USD cap; once current-month
  spend (tracked from the real usage log) meets or exceeds it, the router
  treats that provider as unavailable until next month, same as a tripped
  circuit breaker.
- **Test console**: send a real request through the router and watch the
  routing chain animate live: each candidate node pulses blue while being
  tried, then turns green (answered) or red (failed → fell through to the
  next one). This is the actual `attempts` array from a real router call,
  not a simulation.
- **Recent requests table**: provider, model, tokens, cost, latency per
  request, newest first.
- **Cost chart**: a compact per-request bar chart of the last 20 calls
  (pure CSS/DOM, no charting library), plus an overall avg-latency stat
  and per-provider avg latency shown right on each routing-chain node.
- **Security controls**: toggle PII redaction, set the injection-guard
  mode, configure the rate limit, and see whether at-rest encryption is
  active.
- **Gateway access**: optionally require `Authorization: Bearer <key>` on
  every `/v1/*` and `/api/*` call. The key lives in `data/settings.json` on
  the server and in your browser's `localStorage`. Nowhere else. If you
  lose it, recovery is deleting/editing `gatewayApiKey` in
  `data/settings.json` directly (there's no key-recovery flow by design:
  it's a local personal-use lock, not a real auth system).

## How routing works

Four route forms:

- `"model": "provider/model"`: explicit, no fallback (e.g. `"anthropic/claude-sonnet-4-6"`)
- `"model": "auto"`: priority order, or your default combo if you've set one
- `"model": "auto/<strategy>"`: one of the 19 strategies below
- `"model": "combo/<name>"`: a tiered chain

### Strategies

Each orders the whole pool best-first. `GET /api/panel/strategies` lists them
live; `auto/cheap`, `auto/fastest` and `auto/roundrobin` still work as aliases.

| Strategy | Orders by |
|---|---|
| `priority` | config order |
| `cheapest` | blended cost, input + 3× output |
| `cheapest-input` | input price alone, for prompt-heavy traffic |
| `fastest` | measured average latency |
| `roundrobin` | rotating start point |
| `randomized` | unpredictable, so traffic shape can't fingerprint one backend |
| `spread-load` | fewest requests so far, per connection |
| `drain-free` | free allowances first, most headroom first |
| `drain-subscription` | lanes a plan you already pay for covers, then local, then free, then metered |
| `quota-headroom` | most free quota left, counted per shared pool |
| `budget-headroom` | most monthly budget left |
| `context-aware` | smallest window that fits the prompt; too-small lanes last |
| `least-errors` | healthiest by observed failures and breaker state |
| `balanced` | normalised cost × latency |
| `verified-pricing` | lanes whose price table was actually checked |
| `local-first` | nothing leaves the machine unless it has to |
| `frontier-first` | frontier labs, then inference hosts, then aggregators |
| `sticky` | pins to the last lane that answered |
| `cost-ceiling` | anything at or under a tier's `maxCostPer1m` first |

**Every strategy is a total order, never a filter.** `cheapest` means cheapest
*first* and most expensive *last*, not "only the cheap ones". A strategy that
dropped candidates would silently shorten the fallback chain, so a request
would fail with "all providers unavailable" while a lane that could have served
it was never tried. Filtering is a tier's job.

Unknown sorts **last** everywhere. An unmeasured provider isn't infinitely
fast, an undeclared context window isn't unlimited, and a free tier whose
limits nobody configured isn't quota you can drain.

### Combos

A combo stacks up to 4 tiers, each `{ strategy, filter }`. Tiers concatenate,
a provider is never placed twice, and unmatched lanes are appended in priority
order so a filter typo degrades the route instead of causing an outage. A combo
marked `strict` (like `private`) has no such tail. Failing is the correct
outcome when the promise is "nothing leaves this machine".

Eight built in: `free-first`, `paid-for-it`, `cost-floor`, `quality-first`,
`long-context`, `resilient`, `stealth`, `private`. Build your own from the
Combos page or `PUT /api/panel/combos/<name>`, and preview any chain before
spending anything with `POST /api/panel/routing/preview`.

Filters: `providers`, `exclude`, `categories`, `billing`, `freeOnly`,
`verifiedPricingOnly`, `maxCostPer1m`, `minContextWindow`, `withQuotaRemaining`.

Two request-level flags:
- `"stream": true`: SSE streaming (see above)
- `"cache": false`: bypass the response cache for this request

Response headers show what actually happened, rather than asking you to trust
it: `X-Tollpike-Provider`, `X-Tollpike-Attempts`, `X-Tollpike-Routing-Tier`,
`X-Tollpike-Routing-Strategy`, `X-Tollpike-Compression-Saved-Pct`,
`X-Tollpike-Compression-Detail` (per-layer split) and
`X-Tollpike-Memory-Recalled` when memory injected context.

Knowing a call landed on **tier 3** is the difference between "routing worked"
and "everything I preferred was unavailable and nothing told me".

## Free quota

Per-provider free allowances, counted honestly. Three things make a naive
free-tier counter lie, and each is handled:

**Shared pools.** Several entries can front the same upstream allowance.
Counting per gateway-entry then reports 2× the quota you have. Every free tier
declares a `quotaPool`; entries sharing one share a counter, and the snapshot
reports `dedupedAway` so the deduplication is visible rather than implied.
Pools we haven't confirmed are marked `assumed`.

**Window semantics.** Requests use a real sliding window. A counter that
resets on the wall-clock minute lets a caller spend 2× the limit either side of
the boundary. Daily limits use the vendor's own reset time where it's known.

**Failed requests still count.** A 500 consumed rate-limit budget at
essentially every vendor. Only requests that never left this process are free.

What it does *not* do is read your remaining quota from the vendor. Almost
none expose it. Every reading carries `observedOnly: true`: usage of the same
key from another client is invisible here, so real remaining quota is always
this or less, never more. 13 free tiers are declared, all with
`limitsVerified: false`. Published shapes, not numbers checked against an
account.

## Memory

Persistent conversational memory, **off by default** because it changes the
prompt the model sees.

- **Keyword half:** SQLite FTS5 with BM25 ranking via `node:sqlite`, falling
  back to an in-process inverted index with the same ranking family on Node
  &lt;22.5. Which backend is live is always reported, never inferred.
- **Vector half:** Qdrant over REST, no SDK. Embeddings come from any
  OpenAI-compatible `/embeddings` provider you name.
- **Fusion:** Reciprocal Rank Fusion, K=60. BM25 scores and cosine
  similarities aren't on the same scale, so adding them lets whichever half
  produces bigger numbers dominate, and that shifts as the store grows, making
  recall quality drift for no visible reason. RRF reads only *rank*, so a
  document found by both halves outranks one found first by only one.

There is deliberately **no fallback embedder**. A hash-based "embedding"
clusters on spelling rather than meaning, and vector search over those returns
confident nonsense. With no embedding provider configured, recall degrades to
keyword-only and *says so*: `effectiveMode` reports what recall can actually
do, not what it's set to.

Memory is caller-partitioned like the response cache. Recalled text is scanned
for injection at hydrate time and dropped if it trips: it gets injected as a
`system` message, and that's the one role the injection scanner deliberately
skips on the grounds that the system prompt is the operator's own text. Memory
breaks that assumption, so the guard moves to where it still holds.

Only `user` and `assistant` turns are stored, never system prompts (they'd
dominate every recall) and never tool output (the primary indirect-injection
vector, which must not gain persistence across conversations).

## Compression

Three stacked layers, each switchable, with per-layer attribution on every
response. A compression ratio nobody can attribute is a number nobody can act
on.

| Layer | What it does | Typical |
|---|---|---|
| base | whitespace, consecutive duplicate lines | 5–15% |
| **RTK** | tabularize uniform JSON, collapse runs keeping the count, elide blobs with a visible marker | 40–95% on tool output |
| **Caveman** | lossy prose compression: drops grammar the model re-infers | 20–50% on old assistant text |

Plus history truncation, which isn't compression so much as forgetting, and is
usually the largest single saving.

**Scope is the whole safety argument for the lossy layer.** Caveman never
touches your system prompt, and by default never touches the newest user turn
either. Those are the two places exact wording matters. Words whose removal
*inverts* meaning (`not`, `never`, `without`, `unless`, `except`) are never
dropped at any level; dropping "not" from "do not delete the table" isn't a
compression bug, it's a destroyed instruction. Fenced code, inline code, URLs,
paths, identifiers and anything containing a digit are protected byte-exact.

Preview it against your own text on the Compression page before enabling it.

## Agent protocols

The gateway exposes *itself*, so an agent can operate it.

### MCP: 104 tools across 31 scopes

Over **stdio** (`tollpike mcp`, or `node src/mcp/server.js` from a checkout),
**Streamable HTTP** (`POST /mcp`)
and **SSE** (`GET /mcp/sse`). Scopes: gateway, providers, models, routing,
combos, completions, quota, budgets, cost, cache, resilience, compression,
memory, notion, obsidian, guards, proxy, tls, auth, services, cloud_agents,
gamification, a2a, mcp, settings, usage, pricing, context, sessions,
diagnostics, dialects.

Two rules the surface is built on:

- **Mutations are marked.** Every tool carries `mutates`, surfaced in its
  description, so a model can tell reading state from spending money.
  `MCP_READ_ONLY=true` hides *and refuses* them. Hiding without refusing
  leaves them reachable by name for any client that remembers them.
- **No credential crosses the boundary.** Not in a response, not in an error.
  `settings_get` reduces the gateway key to `<set>`, `settings_patch` can't
  write it at all (an agent able to set it could lock you out; able to clear
  it, could disable auth), and `diagnostics_environment` reports presence
  only. A test plants a canary key and scans every read-only tool's output
  for it.

Wiring it into a client that spawns a subprocess:

```json
{
  "mcpServers": {
    "tollpike": {
      "command": "tollpike",
      "args": ["mcp"],
      "env": { "MCP_READ_ONLY": "true" }
    }
  }
}
```

Drop the `env` block to let the agent spend money and change settings. From a
checkout, use `"command": "node"` with `"args": ["src/mcp/server.js"]` and set
`cwd` to the checkout. On this transport stdout carries the JSON-RPC frames
themselves, so every log the server writes goes to stderr.

### A2A: 6 skills over JSON-RPC 2.0

`POST /a2a`, Agent Card at `/.well-known/agent-card.json` (unauthenticated by
design. A peer has to read *how* to authenticate before it can). Skills:
`smart-routing`, `quota-report`, `discovery`, `cost-analysis`, `health-report`,
`memory-recall`. Coarse-grained on purpose: MCP is for a model driving this
gateway step by step, A2A is for a peer agent that wants an outcome.

`message/stream` is **not** implemented and the card reports
`streaming: false` to match. Advertising a capability that returns one chunk at
the end is worse than not advertising it. A peer builds an incremental UI on
that flag. A failing skill returns a **failed Task**, not a JSON-RPC error, so a
peer can tell "your request was malformed" from "the work was attempted and
didn't succeed".

Both protocols sit behind the same gateway key *and* rate limiter as `/v1`.
Both can reach the router, so exempting them would leave a way around the one
control that stops a runaway agent loop.

## Cloud agents

Codex, Cursor, Devin and Jules behind one interface: `createTask`, `getTask`,
`listTasks`, `approvePlan`, `cancelTask`. A capability a vendor doesn't have is
reported as unsupported rather than emulated. A fake approval step that
returns success without approving anything is worse than a missing one.

**Every driver is unverified.** Endpoint paths and payload shapes follow vendor
documentation; none has been exercised against a live account, and all carry
`verified: false`. Treat a first successful call as the verification step.

## Embedded services

Supervises Bifrost, 9Router and CLIProxy as managed sidecars. Start, stop,
health, logs, plus cluster profiles. **It never installs anything:** each
binary must already be on your PATH. Downloading and executing a binary on your
behalf is a supply-chain decision, and a dashboard button is not consent.

No shell, ever: every spawn is an argv array with `shell: false`. The service
list is a closed set in code, because an arbitrary-command supervisor reachable
from the control panel is a remote shell. Children are killed on gateway exit:
an orphan holding a port is worse than no supervisor, since the next start
fails against a process you can't see.

## Knowledge sources

Notion (REST) and an Obsidian vault (filesystem) as read-only context, exposed
as MCP tools. Read-only in both cases because this text is a prime
indirect-injection vector, and a writable knowledge source is one an injected
instruction can use to edit your notes.

The Obsidian containment rule: every path is realpath-resolved and must remain
inside the vault root. Screening for `..` isn't enough. A symlink inside the
vault pointing at `~/.ssh` contains no `..` at all and resolves straight out of
the tree.

## Gamification

Streaks, achievements and live savings, derived entirely from data the gateway
already records. It stores nothing of its own, so it can't disagree with the
ledger.

Savings are a **counterfactual against a stated baseline**: the same tokens
priced at the most expensive lane *with verified pricing*. Most dashboards show
a savings figure without ever saying what they compared against, which makes
the number unfalsifiable. Verified-price only, because a baseline built on an
unchecked table has that table's error bars. Unbounded in the flattering
direction. With no verified lane, savings report as unavailable rather than
being computed against a guess.

## Architecture

```
src/
  paths.js               # single source of truth for the data dir
                          # (TOLLPIKE_DATA_DIR overrides it)
  providers/
    http.js              # shared upstream transport: ProviderError,
                          # request deadline, and the stream stall watchdog
    registry.js          # loads config/providers.json, tracks which have keys,
                          # enforces the per-provider model allowlist
    openaiCompatible.js  # ONE adapter covers OpenAI, DeepSeek, Groq, Together,
                          # Fireworks, Mistral, Cerebras, OpenRouter, xAI,
                          # they all speak the same wire format. Includes both
                          # buffered (callOpenAICompatible) and streaming
                          # (streamOpenAICompatible) variants.
    anthropic.js          # translates to/from the Messages API, buffered + streaming
    anthropicTranslate.js # pure functions: OpenAI tools/tool_calls <-> Anthropic
                           # tool_use/tool_result shape. No I/O, so it is unit-tested directly.
    geminiTranslate.js    # same idea for Gemini's functionDeclarations/
                           # functionCall/functionResponse shape
    gemini.js             # translates to/from generateContent, buffered + streaming
    normalize.js          # every buffered adapter returns this same shape
  routing/
    router.js             # candidate building (auto/cheap/roundrobin/explicit),
                           # fallback walk, budget-cap + disabled-provider
                           # filtering, plus the streaming variant
    resilience.js          # 3 layers: model lockout ⊂ connection cooldown ⊂
                            # provider breaker, with failure classification
    proxy.js               # egress proxy resolution + URL validation; refuses
                            # to send direct if a configured proxy is unusable
  compression/
    compress.js            # whitespace collapse, dedup, history truncation
  storage/
    costTracker.js          # append-only JSONL usage log, aggregation, and
                             # calendar-month spend lookup (for budget caps)
    responseCache.js         # exact-match TTL+LRU cache, hit/miss stats
    settings.js              # runtime state: disabled providers, budget caps,
                               # gateway API key, persisted to data/settings.json,
                               # editable live from the control panel
  security/
    crypto.js                 # AES-256-GCM at rest, scrypt KDF, timing-safe compare
    guardrails.js             # PII redaction + prompt-injection heuristics (pure)
  middleware/
    auth.js                   # optional Bearer-key gate, constant-time comparison
    rateLimit.js              # token-bucket limiter per client
  mcp/
    server.js                  # exposes list_providers / get_usage_stats /
                                # get_resilience_status as MCP tools (stdio transport)
  server.js                    # Express app: REST API, SSE streaming, control
                                # panel API, static panel assets
public/
  index.html, panel.js          # the control panel, vanilla HTML/CSS/JS,
                                 # no build step, served directly by Express
Dockerfile, docker-compose.yml   # multi-stage build, non-root user, healthcheck,
                                  # persistent named volume for data/
deploy/tollpike.service           # systemd unit for bare-metal, no-Docker hosting
```

**Adding a provider** that speaks the OpenAI format is a config-only change:
add an entry to `config/providers.json` with its `baseURL` and an
`apiKeyEnv` name, then set that env var. No code required. Anthropic-shaped
or Gemini-shaped providers need their own adapter file (buffered + streaming
variant), following the pattern in `anthropic.js` / `gemini.js`.

## What this honestly does and doesn't do

**Does:**
- Real multi-provider fallback with circuit breakers (tested: trips after
  3 failures, opens for 30s, half-open probes after cooldown)
- Real streaming: OpenAI-compatible providers are passed through verbatim
  (their SSE format already matches what the gateway emits); Anthropic and
  Gemini events are translated into OpenAI-shaped delta chunks so every
  client only ever needs to parse one format. Fallback works up through
  connection-open time. A bad key or 5xx before any bytes stream moves to
  the next candidate with nothing sent to the client yet. Once tokens start
  flowing, the gateway commits to that provider (switching mid-stream isn't
  something a client could sanely consume anyway).
- Real cost tracking per request, aggregated per provider and per calendar
  month, logged to `data/usage.jsonl`. Inspect via `GET /dashboard/usage`
  or the control panel
- Real per-provider budget caps enforced at routing time. A provider over
  its monthly cap is skipped exactly like a tripped circuit breaker
- Real runtime provider enable/disable, no restart needed
- A real control panel: live circuit/budget state, a test console whose
  chain animation reflects an actual `attempts` array from a real router
  call (not a canned demo), and optional gateway-wide auth
- Exact-match response caching with TTL + LRU eviction. Deliberately NOT
  semantic/fuzzy matching. Returning a "close enough" answer to a
  different question is a correctness bug, not a feature. Only
  byte-identical requests hit, and only deterministic ones
  (`temperature` unset or 0) are cached at all, since `temperature > 0`
  means the caller explicitly wants variation. The cache key excludes the
  provider, so an answer from any backend is reusable, which is exactly
  what makes caching valuable in a *multi-provider* gateway. It excludes
  the inbound dialect for the same reason: the key is built from the
  normalised internal request, so a question asked through
  `/v1/chat/completions` and the same question asked through
  `/v1/messages`, `/v1/responses` or `/api/chat` share one entry rather
  than paying four times. Streaming is never served from cache, since
  there is no complete response to store at the point it is delivered.
  Responses carry `X-Tollpike-Cache: HIT|MISS|BYPASS`.
- Retry-with-backoff on the *same* provider before falling through to the
  next one: transient failures (429/5xx/timeout) get up to 2 retries with
  exponential backoff plus jitter. A rate-limited provider is usually
  still the best choice a moment later, so burning the whole fallback
  chain on one 429 wastes both the preferred provider and, potentially,
  money on a pricier backup. Non-retryable errors (401, 400) fall through
  immediately instead of wasting time.
- Real (if modest) compression: whitespace collapse, duplicate-line dedup,
  and conversation-history truncation. Typically saves 10-30% on tool-heavy
  sessions full of repeated log/output noise. This is NOT semantic
  compression (no LLMLingua-style token pruning). That's a real
  follow-up if you want it, behind the same `compressMessages()` interface.
- MCP server for introspection (providers, usage, resilience state) via stdio

- Tool-calling translation for Anthropic: OpenAI's `tools`/`tool_choice`/
  `tool_calls` format is translated to and from Anthropic's `input_schema`/
  `tool_use`/`tool_result` shape, for both buffered and streaming calls.
  Handles the edge case where consecutive tool-result messages need
  merging to satisfy Anthropic's strict user/assistant alternation
  requirement.
- Tool-calling translation for Gemini: OpenAI's format is translated to
  and from Gemini's `functionDeclarations`/`functionCall`/`functionResponse`
  shape, buffered and streaming. Gemini supplies no tool-call IDs, so the
  adapter maps OpenAI's `tool_call_id` back to the function *name* when
  building responses, and synthesizes deterministic IDs on the way out.
  **All three adapter families now have full tool-calling parity.**
- Per-provider and overall average latency, tracked from real request
  timing (including full stream duration for streamed calls, not just
  time-to-first-byte) and surfaced in the control panel
- Sampling parameters are carried through to the provider: `top_p`,
  `stop`, `seed`, `frequency_penalty`, `presence_penalty`, `logit_bias`
  and `response_format` (JSON mode). Only the ones a caller actually sends
  are forwarded, so a request that uses none of them produces exactly the
  body it did before, which matters because strict providers reject
  unknown fields. They are part of the cache key too, so a request asking
  for JSON never receives a cached prose answer to the same question. The
  inbound dialects map their own spellings: Anthropic's `stop_sequences`
  and `top_p`, Ollama's `options.stop`, `options.top_p`, `options.seed`
  and `format: "json"`.
  **Two honest limits.** The Anthropic Messages API has no
  `response_format`, `seed`, `logit_bias` or penalty parameters, so a
  request that uses them and routes to the Anthropic adapter gets the
  two that do exist (`top_p`, `stop_sequences`) and nothing invented for
  the rest; the way to get JSON out of Claude is a tool with the schema
  you want. And `n > 1` is rejected with a 400 rather than accepted,
  because every response this gateway builds carries a single choice, so
  honouring it halfway would return one completion for a request billed
  as several.

**Doesn't yet:**
- A time-series view of cost/latency (the chart shows the last 20 raw
  requests, not cost-per-day or cost-per-hour aggregation)
- Multi-user accounts. The gateway key is a single shared lock, not
  per-user auth with separate quotas
- Real request-body validation beyond "model and messages are present":
  malformed `tools`/`tool_choice` will surface as a raw provider error,
  not a clean 400

## Testing what's here

Every module was exercised directly while building this, in three passes:

**Core (fallback, compression, MCP):**
- Circuit breaker: unit-tested state transitions (closed → open at 3
  failures → resets on success)
- Compression: unit-tested against messy multi-blank-line / duplicate-line
  input, and history truncation with a 20-message conversation
- Router: verified `auto` correctly enumerates every configured provider
  and reports *why* each was skipped, rather than swallowing the reason
- MCP server: verified it loads and registers handlers against the
  installed SDK version (the schema-registration API changed between SDK
  versions. This uses the current one, `ListToolsRequestSchema` /
  `CallToolRequestSchema` objects, not string method names)

**Control panel + routing features:**
- Panel state API, toggle, and budget-cap endpoints tested live against a
  running server
- Confirmed a disabled provider is fully removed from the `auto` candidate
  pool (not just logged-and-skipped)
- Confirmed budget-cap math against injected usage-log entries
  (`getMonthlySpend` correctly flags over-cap)
- Confirmed the full gateway-auth lifecycle: set key → unauthenticated
  request 401s → wrong key 401s → correct key 200s → panel static assets
  stay reachable unauthenticated → clearing the key requires the key
  itself (by design: see Control Panel section above for the recovery path)
- Confirmed the streaming endpoint fails cleanly with a structured JSON
  error (full per-provider attempt list) when no keys are configured,
  rather than hanging or crashing the process
- Confirmed `avgLatencyMs` aggregation math against injected usage entries,
  both per-provider and overall-weighted
- `panel.js` passes `node --check`; `index.html` div tags balance (25/25):
  not a substitute for opening it in a browser, but catches syntax breaks

**Anthropic tool-calling (this round's main addition):**
- Unit-tested the pure translation functions directly (no network): OpenAI
  `tool_calls` → Anthropic `tool_use` blocks, the `tool` role → Anthropic's
  `tool_result` content block, `tools[].function.parameters` →
  `input_schema`, all four `tool_choice` variants, and an Anthropic
  `tool_use` response converted back to OpenAI's `tool_calls` shape
- Found and fixed a real bug during testing: two consecutive tool-result
  messages (e.g. answering two parallel tool calls) produced two
  consecutive `user`-role messages, which violates Anthropic's strict
  role-alternation requirement and would have caused a 400 from the real
  API. Added a merge step and verified the fix against that exact scenario,
  confirming strictly-alternating roles afterward.
- Verified the streaming tool-call path against a fake local Anthropic SSE
  server (real HTTP, real SSE framing, no live API key involved): the
  `content_block_start` → `input_json_delta` → `content_block_stop`
  sequence correctly produces OpenAI-style incremental `tool_calls` deltas
  whose `arguments` fragments concatenate to valid JSON
- Verified the buffered tool-calling path the same way. Confirmed both
  the outbound request shape (tools converted to `input_schema`) and the
  inbound response shape (`tool_use` converted to `tool_calls`,
  `finish_reason: "tool_calls"`) against a fake server
- Caught and fixed a duplicate-import bug introduced while wiring the new
  translation module into `anthropic.js` (would have been a hard crash on
  boot). The fake-server test caught it immediately

**Gemini tool-calling, caching, retry, latency routing (this round):**
- Unit-tested all Gemini translation functions with no network: tools →
  `functionDeclarations`, all four `tool_choice` → `functionCallingConfig`
  modes, the `tool_call_id` → function-name mapping Gemini requires (it has
  no call IDs of its own), consecutive-tool-result merging for role
  alternation, and non-JSON tool output wrapping instead of throwing
- Verified the Gemini adapter end-to-end against a fake local server for
  both buffered and streaming tool calls. Confirmed the outbound
  `functionDeclarations` shape and the inbound `functionCall` →
  OpenAI `tool_calls` conversion with `finish_reason: "tool_calls"`
- Cache: unit-tested key determinism, that differing messages produce
  differing keys, the `temperature > 0` non-cacheable rule, TTL expiry
  (verified a 50ms entry is gone at 80ms), and LRU eviction at capacity
  (inserted 505 entries into a 500-cap store; confirmed the oldest was
  evicted and the newest retained)
- Retry: verified against a fake server that 429s twice then succeeds:
  confirmed 3 total upstream requests, success on attempt 2, and ~805ms
  elapsed matching the expected 250ms + 500ms exponential backoff plus
  jitter. Separately confirmed a 401 is flagged non-retryable so it falls
  through immediately rather than burning retries on a bad key.
- Confirmed all four routing modes (`auto`, `/cheap`, `/roundrobin`,
  `/fastest`) are accepted and route through the full candidate chain, and
  that cache stats/clear surface correctly in the panel API

**Security + 3-layer resilience (this round):**
- Crypto: verified AES-256-GCM round-trip, that identical plaintext yields
  different ciphertext (random IV), that tampering with the ciphertext is
  *detected* on decrypt rather than silently returning garbage, and that
  omitting `TOLLPIKE_SECRET` degrades to honest plaintext instead of
  fake-encrypting with a hardcoded key
- Constant-time compare verified for match, mismatch, and differing-length
  inputs
- PII: verified each pattern, and specifically that Luhn validation stops a
  13-digit order number being redacted as a credit card
- Injection: verified each heuristic fires, that a benign coding request
  produces zero findings (no false positive), and that the *system* prompt
  is never scanned (it's the operator's own text)
- Rate limiter: verified a capacity-3 bucket allows exactly 3 then 429s
  with a `Retry-After`, and that disabling it passes traffic through
- Resilience: verified all six behaviors: 401 cools only the connection
  (provider stays up, other keys keep serving), 429 locks only the model
  (other models keep serving), 5xx trips the provider breaker at threshold,
  404 produces a 30-min model lockout, success clears every layer on that
  path, and lockouts expire lazily
- **Multi-key failover proven end-to-end** against a fake upstream that
  401s one key and accepts another: the router cooled the bad connection,
  switched to the good one, and the provider breaker stayed CLOSED
- Full HTTP regression: all four routing modes, streaming, rate-limit
  tripping at capacity, and the auth lifecycle (401 no-key / 401 wrong-key
  / 200 correct-key) against a live server

Not yet tested: a live round-trip against a real provider, for either
buffered or streaming calls (needs a real API key, which isn't something
to put in a shared build environment). Before relying on this, run one
real request per provider you intend to use, buffered and streamed, and
confirm the response content and `usage` numbers look right. The adapters
are straightforward but unverified against live traffic.

**Deployment (Docker/systemd):** this sandbox has no Docker daemon, so the
image was never actually built or run as a container. What *was* verified:
`docker-compose.yml` parses as valid YAML, every path the `Dockerfile`
`COPY`s exists in the repo, and `npm ci --omit=dev`, the exact command the
image build runs, succeeds against the checked-in lockfile. The app's own
boot sequence and `/health` response were confirmed separately outside a
container. Run `npm run docker:up` yourself and confirm the container
reaches "healthy" before depending on it; if it doesn't, `npm run
docker:logs` is the first thing to check.

## Design principles

Four commitments that shaped every decision in here, worth stating because
they're what you'd change if you disagreed:

**1. Spend control is the primary feature.** Most gateways optimize for
reach: most providers, most free tiers. Tollpike optimizes for knowing and
capping what you spend: per-provider monthly caps enforced at routing time,
cross-provider response caching, and cost- and latency-aware routing.

**2. Fail at the smallest scope.** A rate-limited model shouldn't disable a
key. A rejected key shouldn't disable a provider. See the resilience
section. This is the difference between losing one model for 60 seconds
and losing a third of your capacity.

**3. Correctness over apparent capability.** The response cache is
exact-match only, because returning a "close enough" answer to a different
question is a bug wearing a feature's clothes. Encryption is disabled
rather than fake when no secret is set, because the appearance of
protection is worse than known plaintext. Guardrails are documented as
heuristics, not boundaries.

**4. Small enough to audit.** Roughly 3,000 lines across 25 source files.
You can read the whole routing path in one sitting and change it with
confidence. That's a deliberate ceiling, not a stage it hasn't outgrown.

## Proxy support

Route upstream traffic through an HTTP(S) or SOCKS5 proxy you control, for
networks that can't reach a provider directly.

```bash
# Standard env vars work
HTTPS_PROXY=http://proxy.internal:3128 npm start
```

Or per-provider from the panel API, which overrides the global setting:

```bash
curl -X POST localhost:20128/api/panel/proxy \
  -H 'Content-Type: application/json' \
  -d '{"providerId":"anthropic","url":"socks5://127.0.0.1:1080"}'
```

Resolution order, most specific first: per-provider → global (`"*"`) →
`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` → direct.

**If a proxy is configured but can't be used, the request fails.** It will
not quietly fall back to a direct connection. Silently bypassing a proxy
someone configured on purpose is the kind of "helpful" behavior that leaks
traffic they expected to be routed. Verified by test: a dead proxy errors
and the request never reaches the origin.

This does not alter your TLS fingerprint or impersonate another client.
See below.

## Not built, on purpose

**TLS fingerprint impersonation.** Some gateways spoof JA3/JA4 handshakes so
traffic looks like an official first-party CLI. That exists to defeat
providers' own anti-abuse detection. Making a third-party client
indistinguishable from an authorized one is circumventing an access control,
not protecting privacy, and it's what gets accounts terminated. That position
hasn't changed.

What *was* added is **TLS handshake shaping** (`src/routing/tls.js`), and the
distinction is the whole point:

- It changes what this process's own ClientHello contains. Cipher suite list
  and order, signature algorithms, curve preference, TLS version floor, ALPN
  order. That does change the JA3 fingerprint.
- It **cannot** pass as a browser, and the profiles are named `chrome-like`,
  not `chrome`, for that reason. Real Chrome mimicry needs GREASE values,
  exact TLS extension ordering and extension padding, none of which Node
  exposes, because they're OpenSSL internals. Tools that do this properly ship
  a patched TLS stack. A strict JA3 allowlist will still tell this apart.
- It is `default` unless you change it, and the caveat is on the API response
  (`tlsStatus().caveat`), not buried in a comment.

It exists because some providers and many corporate middleboxes behave
differently for a handshake that doesn't look like stock Node, and a gateway
that can't vary its handshake has no way to work around that. If you're
reaching for it to defeat a provider's abuse controls, that's the thing above
that isn't built and won't be.

**TLS interception.** Never, in either direction. `proxy.js` does not
terminate, decrypt or re-sign provider TLS, and `proxyStatus().interception`
says so permanently. A gateway that MITMs its upstreams holds every key and
every prompt in cleartext at a hop nobody audited.

**Cookie / OAuth provider auth.** Still not built. "Drain subscription" is
implemented as *operator-declared* coverage. You mark which lanes a plan you
already pay for covers, and `drain-subscription` puts them first. Nothing in a
provider's API reports "this key is included in a subscription you bought", so
it cannot be detected, and scraping session cookies out of a first-party client
to reach a plan's quota through an unofficial path generally breaks the ToS you
agreed to.

**Semantic caching.** The response cache stays exact-match. Returning a "close
enough" answer to a different question is a correctness bug wearing a feature's
clothes.

## Next steps, in priority order

1. **Verify against a live provider.** Only Groq and Ollama have been
   exercised live. Everything else is tested against fake servers that mimic
   documented wire formats. Before trusting a lane with money, send one
   buffered and one streamed request through it and confirm the content and
   the `usage` numbers.
2. **Verify the free-tier limits.** All 13 declared tiers carry
   `limitsVerified: false`. They're the vendors' published shapes, not
   figures checked against a real account. A headroom number computed from a
   wrong limit is confidently wrong. Check the ones you actually route to.
3. **Verify a cloud-agent driver.** All four carry `verified: false`. Vendor
   task APIs move faster than their docs; one successful live call per driver
   is the verification step.
4. **Exercise the vector half of memory.** Keyword recall is tested; the
   Qdrant path has no live Qdrant behind it in CI, so `upsert` and `search`
   are verified only against their documented request shapes.
5. Persistent/shared response cache (in-memory per process today: restarting
   drops it, and two containers wouldn't share it). Keys are already
   partitioned by caller, so this is safe to share once per-user auth lands.
6. Per-user auth with separate quotas, replacing the single shared gateway key
7. Real request-body validation for `tools`/`tool_choice` shape
8. Log rotation for `data/usage.jsonl`. Aggregates are incremental and
   in-memory, so the file only costs startup time, but it still grows forever
9. More free providers. The quota machinery scales to any number of lanes;
   reaching a much larger pool is config work, and every added `baseURL` must
   be checked against first-party vendor documentation first. A bulk
   provider list pasted from a third-party aggregator is a supply-chain
   decision, not a config change.

## Accuracy of spend figures

Budget caps are only as good as the numbers behind them, so the honest
position:

- Provider prices in `config/providers.json` are quoted **per million tokens** (`costPer1mTokens`), matching how vendors publish them. Only `groq` has been checked against a published rate; diff the rest against vendor docs before relying on them.
- When a provider reports `usage`, those numbers are used directly.
- When it doesn't, tokens are estimated at ~4 chars/token and the row is
  marked estimated (`~` in the panel, `usage_source: "estimated"` in the
  response). Estimates are approximate. Treat a cap as a strong guardrail,
  not an accounting guarantee.
- Streaming reads a usage frame when the provider volunteers one
  (Anthropic and Gemini always do); otherwise it estimates. Usage is
  recorded even if a stream dies partway, since those tokens were still
  generated and billed.
- In-flight requests hold a reserved estimate against the cap, so
  concurrent calls can't each see the cap as "not yet reached" and
  collectively overshoot it.
