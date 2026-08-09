const AUTH_STORAGE_KEY = "tollpike_panel_key";

// Everything rendered here is untrusted to some degree: provider ids and
// model names travel from the request through the usage log, and the test
// consoles render model output. All of it goes through esc(), and model
// output is built with DOM nodes rather than markup. The panel holds the
// gateway key in localStorage, so markup reaching the DOM is a credential
// leak, not a cosmetic bug.
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

function authHeaders() {
  const key = localStorage.getItem(AUTH_STORAGE_KEY);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// One unlock at a time.
//
// The home view fires state, series and the routing preview concurrently, so a
// locked gateway used to raise three separate `prompt()` dialogs stacked on top
// of each other — and a native prompt blocks the event loop, so the panel froze
// behind them. Every 401 now awaits the SAME unlock promise: the first one puts
// the lock screen up, the rest queue behind it and retry once a key is entered.
let unlockPromise = null;

function askForKey() {
  if (unlockPromise) return unlockPromise;
  unlockPromise = new Promise((resolve, reject) => {
    const wrap = document.getElementById("lockWrap");
    const input = document.getElementById("lockInput");
    const btn = document.getElementById("lockBtn");
    const err = document.getElementById("lockErr");
    if (!wrap || !input || !btn) { reject(new Error("Unauthorized")); return; }

    err.textContent = localStorage.getItem(AUTH_STORAGE_KEY) ? "The stored key was rejected." : "";
    wrap.hidden = false;
    input.value = "";
    input.focus();

    // The key is checked HERE rather than by letting the caller retry and
    // fail. Resolving on whatever was typed meant one typo dismissed the lock
    // screen, the retry 401'd, and the panel sat empty with no way back short
    // of a reload — the overlay is the only place that can ask again, so it is
    // the place that has to know whether the answer was right.
    const submit = async () => {
      const key = input.value.trim();
      if (!key) { err.textContent = "Enter the key."; return; }
      btn.disabled = true;
      const wasLabel = btn.textContent;
      btn.textContent = "Checking…";
      err.textContent = "";
      try {
        const probe = await fetch("/api/panel/state", { headers: { Authorization: `Bearer ${key}` } });
        if (probe.status === 401) {
          err.textContent = "That key was rejected.";
          input.value = "";
          input.focus();
          return;
        }
        if (!probe.ok) { err.textContent = `Gateway returned ${probe.status}.`; return; }
        localStorage.setItem(AUTH_STORAGE_KEY, key);
        cleanup();
        resolve(key);
      } catch (e) {
        err.textContent = "Could not reach the gateway.";
      } finally {
        btn.disabled = false;
        btn.textContent = wasLabel;
      }
    };
    const onKey = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
    function cleanup() {
      btn.removeEventListener("click", submit);
      input.removeEventListener("keydown", onKey);
      wrap.hidden = true;
      input.value = "";
      unlockPromise = null;
    }
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", onKey);
  });
  return unlockPromise;
}

async function api(path, options = {}, retried = false) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(options.headers || {}) }
  });
  if (res.status === 401) {
    // One retry per call. Without the guard a key that is valid for /api but
    // rejected by something else would loop forever re-prompting.
    if (retried) throw new Error("Unauthorized");
    await askForKey();
    return api(path, options, true);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status}`);
  return body;
}

// Adaptive precision. A flat 4dp printed every sub-cent figure as $0.0000,
// which reads as free rather than small — the wrong signal from a tool whose
// entire job is making spend legible. Real per-million pricing means a
// handful of short requests genuinely costs millionths of a dollar.
const fmtUsd = (n) => {
  const v = Number(n) || 0;
  if (v === 0) return "$0.0000";
  const abs = Math.abs(v);
  if (abs < 0.000001) return "<$0.000001";
  if (abs < 0.01) return "$" + v.toFixed(6);
  return "$" + v.toFixed(4);
};
const fmtTokens = (n) => {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
};
const fmtTime = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "–" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

// --- Navigation ----------------------------------------------------------

const ICON = {
  home: '<path d="M3 9.5 8 3l5 6.5V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5Z"/>',
  grid: '<path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z"/>',
  route: '<path d="M3 3h4v4H3zM9 9h4v4H9zM5 7v3a2 2 0 0 0 2 2h2"/>',
  coin: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v6M6.5 6.5h3M6.5 9.5h3"/>',
  shield: '<path d="M8 2 3 4v4c0 3 2.2 5.3 5 6 2.8-.7 5-3 5-6V4L8 2Z"/>',
  box: '<path d="M2 5.5 8 3l6 2.5v5L8 13l-6-2.5v-5ZM2 5.5 8 8m0 0 6-2.5M8 8v5"/>',
  zip: '<path d="M13 4H8L6.5 2H3v12h10V4Z"/><path d="M9 6v5M7 8.5h4"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  key: '<circle cx="5.5" cy="8" r="2.5"/><path d="M8 8h6M12 8v2.5"/>',
  link: '<path d="M6.5 9.5 9.5 6.5M6 4.5 7.5 3a2.8 2.8 0 0 1 4 4l-1.5 1.5M10 11.5 8.5 13a2.8 2.8 0 0 1-4-4L6 7.5"/>',
  pulse: '<path d="M2 8h3l2-5 2 10 2-5h3"/>'
};

const NAV = [
  { group: null, items: [{ id: "home", label: "Control center", sub: "Live routing overview", icon: "home" }] },
  {
    group: "Toll plaza",
    items: [
      { id: "providers", label: "Providers", sub: "Manage your lanes", icon: "grid", badge: (s) => `${s.providers.filter((p) => p.hasKey).length}/${s.providers.length}` },
      { id: "routing", label: "Routing", sub: "Fallback chain & test", icon: "route" },
      { id: "budgets", label: "Budgets", sub: "Monthly spend caps", icon: "coin" },
      { id: "ledger", label: "Ledger", sub: "Reconcile vs invoice", icon: "coin" },
      { id: "resilience", label: "Resilience", sub: "Breakers & lockouts", icon: "pulse", badge: (s) => { const n = openCircuits(s); return n ? String(n) : null; } }
    ]
  },
  {
    group: "Traffic",
    items: [
      { id: "combos", label: "Combos", sub: "Tiered routing chains", icon: "route", badge: (s) => String(s.routing?.strategyCount ?? "") },
      { id: "quota", label: "Free quota", sub: "Pool-deduped counting", icon: "coin", badge: (s) => { const n = s.quota?.totals?.exhaustedPools; return n ? String(n) : null; } },
      { id: "cache", label: "Cache", sub: "Exact-match responses", icon: "box" },
      { id: "compression", label: "Compression", sub: "RTK + Caveman", icon: "zip" }
    ]
  },
  {
    group: "Context",
    items: [
      { id: "memory", label: "Memory", sub: "Hybrid recall", icon: "box" },
      { id: "knowledge", label: "Knowledge", sub: "Notion & Obsidian", icon: "box" }
    ]
  },
  {
    group: "Agents",
    items: [
      { id: "protocols", label: "Protocols", sub: "MCP & A2A surface", icon: "link" },
      { id: "agents", label: "Cloud agents", sub: "Codex, Cursor, Devin, Jules", icon: "pulse" },
      { id: "services", label: "Services", sub: "Managed sidecars", icon: "grid" }
    ]
  },
  {
    group: "Security",
    items: [
      { id: "guards", label: "Guards", sub: "PII & injection", icon: "shield" },
      { id: "access", label: "Access", sub: "Gateway key & limits", icon: "lock" }
    ]
  },
  {
    group: "Network",
    items: [
      { id: "proxy", label: "Proxy", sub: "Egress & TLS shaping", icon: "link" },
      { id: "endpoints", label: "Endpoints", sub: "Your connection URLs", icon: "key" }
    ]
  },
  {
    group: null,
    items: [{ id: "achievements", label: "Achievements", sub: "Streaks & savings", icon: "pulse" }]
  }
];

const PAGE_META = {
  home: ["Tollpike", "Routing control center"],
  providers: ["Providers", "Manage your AI provider lanes"],
  routing: ["Routing", "How a request walks the fallback chain"],
  budgets: ["Budgets", "Monthly spend caps, enforced at routing time"],
  ledger: ["Ledger", "What we billed you, ready to check against the invoice"],
  resilience: ["Resilience", "Circuit breakers, cooling keys, locked models"],
  cache: ["Cache", "Exact-match response cache"],
  compression: ["Compression", "Lossless prompt slimming before dispatch"],
  guards: ["Guards", "PII redaction and prompt-injection heuristics"],
  access: ["Access", "Gateway key, rate limiting, encryption at rest"],
  proxy: ["Proxy", "Egress proxy across three levels, plus TLS shaping"],
  endpoints: ["Endpoints", "Where to point your OpenAI-compatible client"],
  combos: ["Combos", "Routing strategies and tiered fallback chains"],
  quota: ["Free quota", "Pool-deduped counting of what you have drawn down"],
  memory: ["Memory", "Persistent conversational memory with hybrid recall"],
  knowledge: ["Knowledge", "Notion and Obsidian as read-only context"],
  protocols: ["Protocols", "The MCP and A2A surface this gateway exposes"],
  agents: ["Cloud agents", "Codex, Cursor, Devin and Jules through one interface"],
  services: ["Services", "Managed sidecars · supervised, never installed"],
  achievements: ["Achievements", "Streaks, savings and milestones"]
};

const CATEGORIES = [
  { id: "frontier", label: "Frontier", hint: "The big three, bespoke adapters for Anthropic and Gemini." },
  { id: "inference", label: "Inference providers", hint: "OpenAI-compatible wire format. One adapter serves all of them." },
  { id: "aggregator", label: "Aggregators", hint: "Route to many upstream models behind a single key." },
  { id: "local", label: "Local runtimes", hint: "No credential needed. Priority 50+, so they never preempt a paid lane." }
];

function openCircuits(s) {
  return s.providers.filter((p) => p.circuit === "OPEN").length;
}

let state = null;
let current = location.hash.slice(1) || "home";
let providerFilter = "all";
let providerSearch = "";
const openCards = new Set();

// --- Sidebar -------------------------------------------------------------

function renderNav() {
  const nav = document.getElementById("nav");
  const hot = new Set(["resilience"]);
  nav.innerHTML = NAV.map((g) => {
    const items = g.items.map((it) => {
      const badge = state && it.badge ? it.badge(state) : null;
      // The subtitle moves to the tooltip. A console sidebar is a list of
      // subsystems you already know the names of — two lines per row spends
      // vertical space on a sentence nobody re-reads after the first week.
      return `<div class="nav-item${it.id === current ? " active" : ""}" data-page="${esc(it.id)}" title="${esc(it.sub)}">
        <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"
             stroke-linecap="round" stroke-linejoin="round">${ICON[it.icon]}</svg>
        <span class="lbl">${esc(it.label)}</span>
        ${badge ? `<span class="nav-badge${hot.has(it.id) ? " hot" : ""}">${esc(badge)}</span>` : ""}
      </div>`;
    }).join("");
    return (g.group ? `<div class="sb-group"><div class="sb-group-label">${esc(g.group)}</div>${items}</div>`
                    : `<div class="sb-group">${items}</div>`);
  }).join("");

  nav.querySelectorAll(".nav-item").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.page));
  });
}

function navigate(page) {
  if (!PAGE_META[page]) page = "home";
  current = page;
  location.hash = page;
  const [title, sub] = PAGE_META[page];
  document.getElementById("pageTitle").textContent = title;
  document.getElementById("pageSub").textContent = sub;
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.getElementById("page-" + page).classList.add("active");
  renderNav();
  // The rail reports the subsystem you are on, so it has to turn over with
  // the page rather than waiting for the next poll.
  if (state) { paintCommandRail(state); renderPage(page); }
}

// --- Page rendering ------------------------------------------------------

const PAGES = {};

function renderPage(page) {
  const el = document.getElementById("page-" + page);
  if (PAGES[page]) PAGES[page](el, state);
}

// --- Command view state --------------------------------------------------

// Colours are the product's own resilience scopes, not a palette: purple is
// provider-scope, amber connection-scope, cyan model-scope. Anyone who has
// read the Resilience page can already read this dashboard.
const SCOPE = {
  provider: "#a78bfa", providerDeep: "#8b5cf6",
  conn: "#fdcb6e", model: "#00cec9",
  ok: "#7ee787", bad: "#f87171",
  dim: "#868d99", faint: "#737b8a",
  rule: "rgba(255,255,255,.09)"
};

const TEL_RANGES = [
  { id: "6H", bucket: "hour", points: 6 },
  { id: "24H", bucket: "hour", points: 24 },
  { id: "7D", bucket: "day", points: 7 },
  { id: "30D", bucket: "day", points: 30 }
];
let telRange = "24H";
let telSeries = null;
let telBucket = "hour";

// The topology animates with SMIL. Rebuilding it on every 8s poll would
// restart every particle mid-flight, so it only rebuilds when the shape of
// the infrastructure actually changed.
let topoSig = "";
let topoTips = {};
let routingChain = null;
let seenEvents = new Set();
let firstStreamPaint = true;

const trunc = (v, n) => { const t = String(v ?? ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const fmtMs = (n) => {
  const v = Number(n) || 0;
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 1 : 2) + "s";
  return Math.round(v) + "ms";
};
// Nearest-rank. With a 20-entry recent window, interpolating between order
// statistics would invent precision the sample cannot support.
const percentile = (sorted, q) => {
  if (!sorted.length) return 0;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
};

function laneState(p) {
  if (!p.hasKey) return "nokey";
  if (!p.enabled) return "off";
  if (p.circuit === "OPEN") return "open";
  if (p.circuit === "HALF_OPEN") return "half";
  if (p.connectionsCoolingDown > 0) return "cold";
  return p.lifetimeStats.requests > 0 ? "live" : "idle";
}
const LANE_INK = { live: SCOPE.ok, idle: SCOPE.dim, cold: SCOPE.conn, half: SCOPE.conn, open: SCOPE.bad, off: SCOPE.faint, nokey: SCOPE.faint };
const LANE_LABEL = { live: "SERVING", idle: "IDLE", cold: "COOLING", half: "HALF-OPEN", open: "BREAKER OPEN", off: "DISABLED", nokey: "NO KEY" };

// Everything the recent-crossing window can tell us, folded once per paint.
function foldRecent(s) {
  const byProvider = new Map();
  const latencies = [];
  for (const r of s.recentRequests) {
    const tokens = Number(r.promptTokens || 0) + Number(r.completionTokens || 0);
    const cost = Number(r.costUsd) || 0;
    const lat = Number(r.latencyMs) || 0;
    latencies.push(lat);
    let b = byProvider.get(r.providerId);
    if (!b) { b = { req: 0, cost: 0, tokens: 0, lat: [], models: new Map() }; byProvider.set(r.providerId, b); }
    b.req += 1; b.cost += cost; b.tokens += tokens; b.lat.push(lat);
    let m = b.models.get(r.model);
    if (!m) { m = { req: 0, cost: 0, tokens: 0 }; b.models.set(r.model, m); }
    m.req += 1; m.cost += cost; m.tokens += tokens;
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    byProvider, latencies, sorted,
    p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99)
  };
}

function alerts(s) {
  const out = [];
  if (s.security.exposedBeyondLoopback && !s.gatewayAuthEnabled) {
    out.push({ level: "bad", title: "Exposed with no gateway key", body: `Bound to ${s.security.boundHost}. Anyone who can reach this port can change caps, toggle lanes and spend your keys.`, action: "access" });
  }
  const t = s.pricingTrust || {};
  if (t.activeUnverified?.length) {
    out.push({ level: "bad", title: `${t.activeUnverified.length} active lane(s) priced from an unchecked table`, body: `${t.activeUnverified.join(", ")}. Spend figures and any cap on them may be wrong in either direction. Run npm run verify-pricing.`, action: "budgets" });
  }
  if (s.corruptLogLines > 0) {
    out.push({ level: "warn", title: `${s.corruptLogLines} unreadable line(s) in the usage log`, body: "Skipped. Spend totals exclude them.", action: null });
  }
  const openBreakers = s.providers.filter((p) => p.circuit === "OPEN");
  if (openBreakers.length) {
    out.push({ level: "warn", title: `${openBreakers.length} circuit breaker(s) open`, body: openBreakers.map((p) => p.name).join(", "), action: "resilience" });
  }
  const capped = s.providers.filter((p) => p.budgetCapUsd !== null && p.monthlySpendUsd >= p.budgetCapUsd);
  if (capped.length) {
    out.push({ level: "warn", title: `${capped.length} lane(s) at their monthly cap`, body: `${capped.map((p) => p.name).join(", ")}, skipped by the router until next month.`, action: "budgets" });
  }
  return out;
}

// =========================================================================
// COMMAND VIEW — the home page is not a page of cards, it is one instrument.
// It is built once and then repainted in place: the topology animates with
// SMIL and the event stream animates on insert, both of which a wholesale
// innerHTML rewrite every eight seconds would destroy.
// =========================================================================

PAGES.home = (el, s) => {
  if (el.dataset.built !== "1") { buildHomeShell(el); el.dataset.built = "1"; }
  loadChain(s);
  paintAlerts(s);
  paintTopology(s);
  paintEngine(s);
  paintInstruments(s);
  paintTelemetry();
  paintFlow(s);
  paintLatency(s);
  paintHealth(s);
  paintMatrix(s);
  paintStream(s);
  paintPulse(s);
  // Most panels rebuild their markup on the poll, which throws away the .lit
  // marks. Without this, a repaint under the cursor leaves the page dimmed
  // with nothing lit — the trace has to survive its own refresh.
  restoreFocus();
};

// The composition is five zones with deliberately different proportions, not
// a stack of equal full-width strips. The core zone — engine beside topology —
// is the tallest thing on the page because it is the thing the product does;
// everything below it explains what that decision cost, how fast it was and
// which lane took it.
function buildHomeShell(el) {
  el.innerHTML = `
    <div class="alerts-band" id="alertBand" style="display:none"></div>

    <section class="zone core">
      <aside class="pane engine" id="enginePane">
        <div class="p-head">
          <span class="p-t">Routing engine</span>
          <span class="p-s" id="engMeta"></span>
        </div>
        <div id="engStrategy"></div>
        <div id="engGates"></div>
        <div class="eng-order">
          <div class="eng-oh">FALLBACK ORDER<span class="rule"></span><span id="engHops"></span></div>
          <div class="cr-list" id="crList"></div>
        </div>
      </aside>
      <div class="pane topo-wrap gridpaper" id="topoWrap">
        <div class="p-head">
          <span class="p-t">Live routing topology</span>
          <span class="p-s" id="topoMeta"></span>
        </div>
        <div id="topoHost"></div>
        <div class="topo-legend">
          <span><i style="background:#a78bfa"></i>PROVIDER</span>
          <span><i style="background:#00cec9"></i>MODEL</span>
          <span><i style="background:#7ee787"></i>SERVING</span>
          <span><i style="background:#fdcb6e"></i>COOLING</span>
          <span><i style="background:#f87171"></i>BREAKER OPEN</span>
          <span class="hint-hover">HOVER A LANE TO TRACE IT ACROSS EVERY PANEL</span>
        </div>
        <div class="topo-tip" id="topoTip"></div>
      </div>
    </section>

    <section class="zone flow">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">Traffic telemetry</span>
          <span class="p-s" id="telMeta"></span>
          <div class="seg" id="telSeg">${TEL_RANGES.map((r) =>
            `<b data-range="${esc(r.id)}"${r.id === telRange ? ' class="on"' : ""}>${esc(r.id)}</b>`).join("")}</div>
        </div>
        <div class="tel-wrap" id="telWrap">
          <div id="telHost"></div>
          <div class="tel-cross" id="telCross"></div>
          <div class="tel-tip" id="telTip"></div>
        </div>
        <div class="tel-legend">
          <span><i style="background:#a78bfa"></i>COST PER BUCKET</span>
          <span><i style="background:#00cec9"></i>REQUEST VOLUME</span>
          <span><i style="background:#2a3140"></i>NO TRAFFIC</span>
        </div>
      </div>
      <div class="pane instr-pane">
        <div class="p-head"><span class="p-t">Instruments</span><span class="p-s">GAUGED, NOT LISTED</span></div>
        <div class="instr" id="instr"></div>
      </div>
    </section>

    <section class="zone analysis">
      <div class="pane">
        <div class="p-head"><span class="p-t">Provider health</span><span class="p-s" id="phMeta"></span></div>
        <div class="ph" id="phHost"></div>
      </div>
      <div class="pane">
        <div class="p-head"><span class="p-t">Traffic matrix</span><span class="p-s" id="mxMeta"></span></div>
        <div class="mx" id="mxHost"></div>
      </div>
    </section>

    <section class="zone detail">
      <div class="pane">
        <div class="p-head"><span class="p-t">Cost flow</span><span class="p-s" id="flowMeta"></span></div>
        <div id="flowHost"></div>
      </div>
      <div class="pane">
        <div class="p-head"><span class="p-t">Latency distribution</span><span class="p-s" id="latMeta"></span></div>
        <div id="latStats"></div>
        <div id="latHost"></div>
      </div>
      <aside class="pane">
        <div class="p-head"><span class="p-t">System pulse</span></div>
        <div id="plHost"></div>
      </aside>
    </section>

    <section class="zone stream">
      <div class="pane">
        <div class="p-head"><span class="p-t">Live request stream</span><span class="p-s" id="evMeta"></span></div>
        <div class="ev-head">
          <span>Time</span><span>Provider</span><span>Model</span>
          <span class="r">Tokens</span><span class="r">Cost</span>
          <span class="hide-sm">Latency</span><span class="r">ms</span>
        </div>
        <div id="evHost"></div>
      </div>
    </section>`;

  el.querySelectorAll("#telSeg b").forEach((b) => b.addEventListener("click", () => {
    telRange = b.dataset.range;
    el.querySelectorAll("#telSeg b").forEach((x) => x.classList.toggle("on", x.dataset.range === telRange));
    paintTelemetry();
  }));

  wireTopoTip();
  wireTelemetryHover();
  wireFocusLink(el);

  // The charts are laid out in real pixels, so they have to follow their own
  // container — not the window. A pane can be dragged narrower, the sidebar
  // can collapse and a scrollbar can appear without a single resize event.
  const observe = (id, fn) => {
    const host = document.getElementById(id);
    if (!host || typeof ResizeObserver === "undefined") return;
    let last = 0, t = null;
    new ResizeObserver(() => {
      const w = Math.round(host.clientWidth);
      if (!w || Math.abs(w - last) < 3) return;
      last = w;
      clearTimeout(t);
      t = setTimeout(() => { if (current === "home" && state) fn(); }, 120);
    }).observe(host);
  };
  observe("topoHost", () => { topoSig = ""; paintTopology(state); });
  observe("telHost", () => drawTelemetry());
  observe("flowHost", () => paintFlow(state));
  observe("latHost", () => paintLatency(state));
}

// --- Alerts --------------------------------------------------------------

function paintAlerts(s) {
  const host = document.getElementById("alertBand");
  if (!host) return;
  const a = alerts(s);
  if (!a.length) { host.style.display = "none"; host.innerHTML = ""; return; }
  host.style.display = "grid";
  host.innerHTML = a.map((x) => `
    <div class="alert ${esc(x.level)}"${x.action ? ` data-goto="${esc(x.action)}"` : ""}>
      <div class="ai">${x.level === "bad" ? "!" : "&#8226;"}</div>
      <div><div class="at">${esc(x.title)}</div><div class="ab">${esc(x.body)}</div></div>
      ${x.action ? '<div class="ax">&#8594;</div>' : ""}
    </div>`).join("");
  host.querySelectorAll("[data-goto]").forEach((n) =>
    n.addEventListener("click", () => navigate(n.dataset.goto)));
}

// --- The real routing chain ----------------------------------------------

// The order the router will actually walk for a bare `auto`, straight from
// the routing engine. A synthetic "route score" would look more impressive
// and mean nothing — this is the decision, not a picture of one.
let chainSig = "";
async function loadChain(s) {
  const sig = s.providers.map((p) => `${p.id}:${p.hasKey ? 1 : 0}${p.enabled ? 1 : 0}`).join("|")
    + "|" + (s.routing?.defaultCombo || "");
  if (sig === chainSig) return;
  chainSig = sig;
  try {
    const r = await api("/api/panel/routing/preview", { method: "POST", body: JSON.stringify({ model: "auto" }) });
    routingChain = r.chain || [];
  } catch {
    routingChain = null;
  }
  if (!state) return;
  if (current === "home") { topoSig = ""; paintTopology(state); paintEngine(state); }
  if (current === "routing") { paintWalk(state); paintFunnel(state); }
}

// The five gates the router actually consults, as readable rows rather than
// 8px labels buried inside the topology SVG. Each states the reading AND what
// that reading does to the order below it — the panel is the reasoning, the
// list under it is the conclusion.
function engineGates(s) {
  const capPct = topoCapPct(s);
  const openN = s.providers.filter((p) => p.circuit === "OPEN").length;
  const cool = s.providers.reduce((a, p) => a + (p.connectionsCoolingDown || 0), 0);
  const pools = s.quota?.totals?.distinctPools || 0;
  const exhausted = s.quota?.totals?.exhaustedPools || 0;
  const capped = s.providers.filter((p) => p.budgetCapUsd !== null && p.monthlySpendUsd >= p.budgetCapUsd).length;
  return [
    { k: "POLICY", v: s.routing?.defaultCombo ? "combo" : "priority", ink: SCOPE.provider,
      n: s.routing?.defaultCombo ? "tiered order from the combo" : "ascending provider priority" },
    { k: "QUOTA", v: pools ? `${exhausted} / ${pools}` : "off", ink: exhausted ? SCOPE.conn : pools ? SCOPE.ok : SCOPE.faint,
      n: pools ? (exhausted ? "exhausted pools drop to the back" : "every declared pool still has room") : "no free pool declared" },
    { k: "HEALTH", v: openN ? `${openN} open` : "closed", ink: openN ? SCOPE.bad : SCOPE.ok,
      n: openN ? "open breakers are skipped outright" : cool ? `${cool} key cooling, lane still eligible` : "no lane isolated" },
    { k: "LATENCY", v: s.totals.avgLatencyMs ? fmtMs(s.totals.avgLatencyMs) : "—", ink: SCOPE.model,
      n: s.totals.avgLatencyMs ? "plaza average across every lane" : "no crossing measured yet" },
    { k: "COST", v: capPct === null ? "no cap" : Math.max(0, Math.round(100 - capPct)) + "% left", ink: capPct === null ? SCOPE.faint : capPct >= 100 ? SCOPE.bad : capPct >= 80 ? SCOPE.conn : SCOPE.ok,
      n: capPct === null ? "nothing is capping spend" : capped ? `${capped} lane(s) already at their cap` : "every capped lane still has headroom" }
  ];
}

function paintEngine(s) {
  const list = document.getElementById("crList");
  if (!list) return;
  const combo = s.routing?.defaultCombo;

  const strat = document.getElementById("engStrategy");
  if (strat) {
    strat.innerHTML = `<div class="eng-strat">
      <div class="eng-k">ACTIVE STRATEGY</div>
      <div class="eng-v">${combo ? `combo<em>/</em>${esc(combo)}` : "priority order"}</div>
      <div class="eng-sub">${esc(s.routing?.strategyCount ?? 0)} STRATEGIES &#183; ${esc(s.routing?.comboCount ?? 0)} COMBOS<br>
        RESOLVED LIVE FOR <em>auto</em></div>
    </div>`;
  }

  const gatesHost = document.getElementById("engGates");
  if (gatesHost) {
    gatesHost.innerHTML = `<div class="eng-gh">DECISION GATES</div>` + engineGates(s).map((g) =>
      `<div class="gate"><i style="background:${g.ink}"></i>
        <span class="gk">${esc(g.k)}</span>
        <span class="gv" style="color:${g.ink}">${esc(g.v)}</span>
        <span class="gn">${esc(g.n)}</span>
      </div>`).join("");
  }

  const hops = document.getElementById("engHops");
  const meta = document.getElementById("engMeta");

  if (routingChain === null) {
    list.innerHTML = '<div class="cr-empty">Chain preview unavailable. The engine could not be asked for its order. The gates above are still live.</div>';
    if (hops) hops.textContent = "";
    if (meta) meta.textContent = "";
    return;
  }
  if (!routingChain.length) {
    list.innerHTML = `<div class="cr-empty">No lane can serve <em>auto</em>.<br>
      Every candidate is missing a credential or switched off, so the engine has nothing to walk.
      The order appears here the moment one lane becomes eligible.</div>`;
    if (hops) hops.textContent = "0 HOPS";
    if (meta) meta.textContent = "IDLE";
    return;
  }

  const byId = new Map(s.providers.map((p) => [p.id, p]));
  const skipOf = (c) => {
    const p = byId.get(c.provider);
    if (!c.hasKey) return "NO KEY";
    if (!c.enabled) return "OFF";
    if (p?.circuit === "OPEN") return "OPEN";
    if (p && p.budgetCapUsd !== null && p.monthlySpendUsd >= p.budgetCapUsd) return "CAPPED";
    if (p?.connectionsCoolingDown > 0) return "COOLING";
    return null;
  };

  // Computed over the WHOLE chain, not the visible window. With 46 providers
  // the first servable hop is routinely past the fold — a local runtime sits
  // at priority 50+ — and deciding "servable" from the first fourteen rows
  // reported NO SERVABLE HOP while the gateway was perfectly able to answer.
  const firstServable = routingChain.findIndex((c) => !skipOf(c));

  const row = (c, i) => {
    const skip = skipOf(c);
    const serves = i === firstServable;
    const tag = skip ? `<span class="cr-tag skip">${esc(skip)}</span>`
      : c.freeTier ? '<span class="cr-tag free">FREE</span>'
      : c.billing === "subscription" ? '<span class="cr-tag sub">SUB</span>'
      : `<span class="cr-tag">T${esc(c.tier)}</span>`;
    // A hop skipped for want of a key is one click from the field that fixes
    // it — the chain is where you notice the gap, so it is where the way out
    // of it belongs.
    return `<div class="cr-item${skip ? " skipped" : ""}${serves ? " first" : ""}${skip === "NO KEY" ? " fixable" : ""}"
        data-prov="${esc(c.provider)}"
        ${skip === "NO KEY" ? `data-addkey="${esc(c.provider)}" title="No credential · click to add one"` : ""}>
      <div class="cr-n">${String(i + 1).padStart(2, "0")}</div>
      <div style="min-width:0">
        <div class="cr-nm">${esc(c.provider)}</div>
        <div class="cr-md">${esc(trunc(c.model, 30))}</div>
      </div>
      ${serves ? '<span class="cr-serves">SERVES</span>' : ""}
      ${tag}
    </div>`;
  };

  const VISIBLE = 14;
  let rows = routingChain.slice(0, VISIBLE).map((c, i) => row(c, i)).join("");
  if (routingChain.length > VISIBLE) {
    // The hop that actually serves is the answer this panel exists to give,
    // so it is pulled above the fold rather than left below it.
    if (firstServable >= VISIBLE) {
      rows += `<div class="cr-empty">&#8230; ${firstServable - VISIBLE} more skipped</div>`
        + row(routingChain[firstServable], firstServable);
      const after = routingChain.length - firstServable - 1;
      if (after > 0) rows += `<div class="cr-empty">+ ${after} further hop(s) after it</div>`;
    } else {
      rows += `<div class="cr-empty">+ ${routingChain.length - VISIBLE} further hop(s) below the fold</div>`;
    }
  }
  list.innerHTML = rows;
  if (hops) hops.textContent = `${routingChain.length} HOP${routingChain.length === 1 ? "" : "S"}`;
  if (meta) {
    meta.textContent = firstServable < 0
      ? "NO SERVABLE HOP"
      : `HOP ${String(firstServable + 1).padStart(2, "0")} SERVES`;
  }

  list.querySelectorAll("[data-addkey]").forEach((n) => n.addEventListener("click", () => {
    openCards.add(n.dataset.addkey);
    providerFilter = "all";
    providerSearch = n.dataset.addkey;
    navigate("providers");
    // The page renders synchronously, so the field exists by now.
    document.querySelector(`.pcard[data-id="${CSS.escape(n.dataset.addkey)}"] [data-action="keyinput"]`)?.focus();
  }));
}

// --- Hero: live routing topology -----------------------------------------

const MONO = "ui-monospace,SFMono-Regular,Consolas,monospace";

const TOPO_MAX = 6;
function topoLanes(s, fold) {
  const serving = s.providers.filter((p) => p.hasKey && p.enabled);
  const order = new Map();
  if (routingChain?.length) routingChain.forEach((c, i) => { if (!order.has(c.provider)) order.set(c.provider, i); });
  const chainRank = (p) => (order.has(p.id) ? order.get(p.id) : 900 + p.priority);

  // The canvas has room for six lanes, and which six matters. A lane that is
  // carrying traffic, or one that has broken, outranks a standing-by local
  // runtime that happens to sit early in the chain — otherwise the busiest
  // provider on the plaza can fall off the picture of the plaza.
  const carrying = serving.filter((p) => p.lifetimeStats.requests > 0)
    .sort((a, b) => b.lifetimeStats.requests - a.lifetimeStats.requests);
  const degraded = serving.filter((p) => !carrying.includes(p) && (p.circuit === "OPEN" || p.circuit === "HALF_OPEN" || p.connectionsCoolingDown > 0));
  const standby = serving.filter((p) => !carrying.includes(p) && !degraded.includes(p))
    .sort((a, b) => chainRank(a) - chainRank(b));
  const shown = [...carrying, ...degraded, ...standby].slice(0, TOPO_MAX);
  const totalReq = shown.reduce((n, p) => n + p.lifetimeStats.requests, 0) || 1;
  return shown.map((p) => {
    const seen = fold.byProvider.get(p.id);
    const models = seen && seen.models.size
      ? [...seen.models.entries()].sort((a, b) => b[1].req - a[1].req).slice(0, 2)
          .map(([model, v]) => ({ model, req: v.req, cost: v.cost, tokens: v.tokens, live: true }))
      : [{ model: p.models?.[0] || "—", req: 0, cost: 0, tokens: 0, live: false }];
    return { p, state: laneState(p), models, share: p.lifetimeStats.requests / totalReq };
  });
}

function particles(path, color, count, dur) {
  let out = "";
  for (let i = 0; i < count; i++) {
    const begin = ((dur * i) / count).toFixed(2);
    out += `<circle r="2.1" fill="${color}" opacity="0">`
      + `<animateMotion path="${path}" begin="${begin}s" dur="${dur}s" repeatCount="indefinite"/>`
      + `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.86;1" begin="${begin}s" dur="${dur}s" repeatCount="indefinite"/>`
      + `</circle>`;
  }
  return out;
}

function paintTopology(s) {
  const host = document.getElementById("topoHost");
  const meta = document.getElementById("topoMeta");
  if (!host) return;
  const fold = foldRecent(s);
  const lanes = topoLanes(s, fold);

  // Laid out in real pixels, not a scaled viewBox: a 2560px display should
  // get a wider plaza, not a magnified one.
  const W = Math.max(620, Math.round(host.clientWidth || 960));
  const sig = lanes.map((l) => `${l.p.id}:${l.state}:${l.p.lifetimeStats.requests}:${l.models.map((m) => m.model + "#" + m.req).join(",")}`).join("|")
    + `|${s.totals.totalRequests}|${s.routing?.defaultCombo || ""}|${routingChain?.length || 0}|${W}`;
  if (meta) {
    // Only lanes that can serve NOW are drawn. When history was made by lanes
    // that have since lost their credential, "8 lanes · 132 crossings" reads
    // as a contradiction — every box on screen says idle. Say where it went.
    const drawnReq = lanes.reduce((n, l) => n + l.p.lifetimeStats.requests, 0);
    const elsewhere = s.totals.totalRequests - drawnReq;
    meta.textContent = lanes.length
      ? `${lanes.length} LANE${lanes.length === 1 ? "" : "S"} DRAWN · `
        + (elsewhere > 0 && drawnReq === 0
            ? `${s.totals.totalRequests} LIFETIME CROSSINGS CAME FROM LANES NOW WITHOUT A KEY`
            : elsewhere > 0
              ? `${drawnReq} OF ${s.totals.totalRequests} CROSSINGS · ${elsewhere} FROM LANES NOW WITHOUT A KEY`
              : `${drawnReq} CROSSINGS LIFETIME`)
      : "NOTHING TO DRAW";
  }
  if (sig === topoSig && host.firstChild) return;
  topoSig = sig;
  topoTips = {};

  // An empty plaza should say what would be here and what closes the gap —
  // not sit as a blank rectangle with a chart frame around it.
  if (!lanes.length) {
    host.innerHTML = `<div class="topo-empty">
      <div class="te-h">NO SERVING LANE</div>
      <div class="te-b">Every provider is missing a credential or switched off, so the engine has no edge to draw.
        This canvas fills left to right the moment one lane becomes eligible: ingress, engine, lane, model, response.</div>
      <div class="te-a" data-goto-page="providers">CONNECT A PROVIDER &#8594;</div>
    </div>`;
    host.querySelector("[data-goto-page]")?.addEventListener("click", () => navigate("providers"));
    return;
  }

  const rowH = 56, topPad = 86, botPad = 34;
  let rows = 0;
  lanes.forEach((l) => { rows += l.models.length; });
  const H = Math.max(414, topPad + rows * rowH + botPad);
  let cur = topPad;
  lanes.forEach((l) => {
    l.models.forEach((m) => { m.y = cur + rowH / 2; cur += rowH; });
    l.y = (l.models[0].y + l.models[l.models.length - 1].y) / 2;
  });
  const midY = (topPad + (H - botPad)) / 2;

  // The gates moved into the engine panel, where they can be read. That buys
  // the map back ~120px, so the lanes and models — the part that is actually
  // a map — get the width.
  // Column widths are proportional up to a ceiling, then shrink together if
  // the canvas is too narrow to hold them. Clamping each one independently is
  // what used to let the model column slide under the response box.
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const hubR = 33;
  const xHub = W < 720 ? 104 : 128;
  const egressW = clamp(W * 0.115, 116, 168);
  const xEgress = W - egressW - 14;
  const spanStart = xHub + hubR + (W < 720 ? 28 : 40);
  const avail = Math.max(180, xEgress - spanStart - 26);
  let provW = clamp(W * 0.165, 130, 214);
  let modelW = clamp(W * 0.235, 156, 330);
  if (provW + modelW > avail) {
    const k = avail / (provW + modelW);
    provW = Math.max(92, provW * k);
    modelW = Math.max(108, modelW * k);
  }
  const slack = Math.max(22, xEgress - spanStart - provW - modelW);
  const X = {
    hub: xHub, hubR,
    prov: spanStart + slack * 0.26, provW,
    model: spanStart + slack * 0.70 + provW, modelW,
    egress: xEgress, egressW
  };

  const cap = (x, label, anchor) => `<text x="${x.toFixed(0)}" y="40" ${anchor ? `text-anchor="${anchor}"` : ""} font-family=${MONO} font-size="9.5" letter-spacing="2.2" fill="#868d99">${label}</text>`;
  let svg = `<svg id="topo" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
      aria-label="Live routing topology: ingress, the routing engine, ${lanes.length} provider lanes, their models and the response.">
    <defs>
      <linearGradient id="ingressG" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${SCOPE.provider}" stop-opacity="0"/>
        <stop offset="50%" stop-color="${SCOPE.provider}" stop-opacity=".75"/>
        <stop offset="100%" stop-color="${SCOPE.provider}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${cap(22, "INGRESS")}${cap(X.hub, "ENGINE", "middle")}${cap(X.prov, "PROVIDER LANES")}${cap(X.model, "MODELS")}${cap(W - 14, "RESPONSE", "end")}
    <line x1="22" y1="52" x2="${W - 14}" y2="52" stroke="${SCOPE.rule}"/>`;

  // ingress bus + feed
  const feed = `M 34,${midY} L ${X.hub - hubR - 4},${midY}`;
  svg += `<g class="t-ingress">
    <rect x="30" y="${midY - 38}" width="3" height="76" fill="url(#ingressG)"/>
    <path d="${feed}" stroke="${SCOPE.provider}" stroke-opacity=".45" stroke-width="1.4" fill="none"/>
    <text x="24" y="${midY - 60}" font-family=${MONO} font-size="9" letter-spacing="1.1" fill="#737b8a">LIFETIME</text>
    <text x="24" y="${midY - 46}" font-family=${MONO} font-size="12" fill="#c9d1d9">${esc(s.totals.totalRequests)} req</text>
  </g>`;
  if (s.totals.totalRequests > 0) svg += particles(feed, SCOPE.provider, 3, 4.4);

  // The engine hub. Every lane edge on this canvas leaves from here, so the
  // decision is not a caption on the map — it is the origin of the map.
  const strategy = s.routing?.defaultCombo ? `combo/${s.routing.defaultCombo}` : "priority";
  svg += `<g class="t-engine">
    <circle cx="${X.hub}" cy="${midY}" r="${hubR}" fill="#141a24" stroke="${SCOPE.provider}" stroke-opacity=".6" stroke-width="1.5"/>
    <circle cx="${X.hub}" cy="${midY}" r="${hubR - 8}" fill="none" stroke="${SCOPE.provider}" stroke-opacity=".2"/>
    <circle cx="${X.hub}" cy="${midY}" r="6" fill="${SCOPE.provider}">
      <animate attributeName="opacity" values="1;.35;1" dur="3.2s" repeatCount="indefinite"/></circle>
    <circle cx="${X.hub}" cy="${midY}" r="${hubR}" fill="none" stroke="${SCOPE.provider}" stroke-opacity=".22">
      <animate attributeName="r" values="${hubR};${hubR + 13}" dur="3.2s" repeatCount="indefinite"/>
      <animate attributeName="stroke-opacity" values=".3;0" dur="3.2s" repeatCount="indefinite"/></circle>
    <text x="${X.hub}" y="${midY + hubR + 20}" text-anchor="middle" font-family=${MONO} font-size="11.5" fill="${SCOPE.provider}">${esc(trunc(strategy, 20))}</text>
    <text x="${X.hub}" y="${midY + hubR + 34}" text-anchor="middle" font-family=${MONO} font-size="9.5" letter-spacing="1.1" fill="#737b8a">${esc(routingChain?.length ?? 0)} HOP ORDER</text>
  </g>`;

  // lanes
  lanes.forEach((l, li) => {
    const ink = LANE_INK[l.state];
    const serving = l.state === "live";
    const dead = l.state === "open";
    const edge = `M ${X.hub + hubR},${midY} C ${X.prov - 46},${midY} ${X.prov - 46},${l.y} ${X.prov},${l.y}`;
    const w = 1 + Math.min(3, l.share * 4.4);
    // The edge belongs to the lane, so it dims and lights with it — a lane
    // you are tracing has to include the line that carries it.
    let laneEdge = `<path d="${edge}" fill="none" stroke="${dead ? SCOPE.bad : serving ? SCOPE.provider : SCOPE.dim}"
      stroke-opacity="${dead ? ".5" : serving ? ".5" : ".28"}" stroke-width="${serving ? w.toFixed(2) : 1}"
      ${serving || dead ? "" : 'stroke-dasharray="3 4"'}/>`;
    if (serving) laneEdge += particles(edge, SCOPE.provider, Math.max(1, Math.round(l.share * 3) + 1), 5.4 - Math.min(2.4, l.share * 3));
    if (dead) {
      laneEdge += `<g stroke="${SCOPE.bad}" stroke-width="2" stroke-linecap="round">
        <line x1="${X.prov - 26}" y1="${l.y - 5}" x2="${X.prov - 16}" y2="${l.y + 5}"/>
        <line x1="${X.prov - 16}" y1="${l.y - 5}" x2="${X.prov - 26}" y2="${l.y + 5}"/></g>`;
    }
    svg += `<g data-prov="${esc(l.p.id)}">${laneEdge}</g>`;

    const bh = 44, by = l.y - bh / 2;
    const tipId = `p${li}`;
    topoTips[tipId] = {
      h: l.p.name,
      rows: [
        ["state", LANE_LABEL[l.state]],
        ["requests", String(l.p.lifetimeStats.requests)],
        ["avg latency", l.p.lifetimeStats.avgLatencyMs ? fmtMs(l.p.lifetimeStats.avgLatencyMs) : "—"],
        ["month spend", fmtUsd(l.p.monthlySpendUsd)],
        ["cap", l.p.budgetCapUsd === null ? "none" : fmtUsd(l.p.budgetCapUsd)],
        ["connections", `${l.p.connections}${l.p.connectionsCoolingDown ? ` · ${l.p.connectionsCoolingDown} cooling` : ""}`]
      ]
    };
    svg += `<g class="tnode t-prov" data-tip="${tipId}" data-goto="providers" data-prov="${esc(l.p.id)}">
      <rect class="tbox" x="${X.prov}" y="${by}" width="${X.provW}" height="${bh}" rx="8" fill="#141a24" stroke="${ink}" stroke-opacity="${serving ? ".45" : ".22"}"/>
      <circle cx="${X.prov + 14}" cy="${by + 15}" r="3.4" fill="${ink}">${serving ? '<animate attributeName="opacity" values="1;.3;1" dur="2.4s" repeatCount="indefinite"/>' : ""}</circle>
      <text x="${X.prov + 25}" y="${by + 19}" font-family=${MONO} font-size="13" fill="#c9d1d9">${esc(trunc(l.p.name, Math.max(8, Math.floor((X.provW - 36) / 7.4))))}</text>
      <text x="${X.prov + 25}" y="${by + 34}" font-family=${MONO} font-size="9.5" letter-spacing=".6" fill="${ink}" opacity=".92">${esc(LANE_LABEL[l.state])}</text>
      <text x="${X.prov + X.provW - 11}" y="${by + 34}" text-anchor="end" font-family=${MONO} font-size="10.5" fill="#9aa3b0">${esc(l.p.lifetimeStats.requests)}</text>
      <rect class="thit" x="${X.prov}" y="${by}" width="${X.provW}" height="${bh}"/>
    </g>`;

    l.models.forEach((m, mi) => {
      const mEdge = `M ${X.prov + X.provW},${l.y} C ${X.model - 40},${l.y} ${X.model - 40},${m.y} ${X.model},${m.y}`;
      let mEdgeSvg = `<path d="${mEdge}" fill="none" stroke="${m.live ? SCOPE.model : SCOPE.dim}" stroke-opacity="${m.live ? ".42" : ".22"}"
        stroke-width="1" ${m.live ? "" : 'stroke-dasharray="3 4"'}/>`;
      if (m.live && serving) mEdgeSvg += particles(mEdge, SCOPE.model, 1, 4.8);
      svg += `<g data-prov="${esc(l.p.id)}">${mEdgeSvg}</g>`;

      const mh = 36, my = m.y - mh / 2;
      const mtip = `m${li}_${mi}`;
      topoTips[mtip] = {
        h: m.model,
        rows: m.live
          ? [["provider", l.p.id], ["recent req", String(m.req)], ["tokens", fmtTokens(m.tokens)], ["cost", fmtUsd(m.cost)]]
          : [["provider", l.p.id], ["status", "no traffic in the recent window"]]
      };
      svg += `<g class="tnode t-model" data-tip="${mtip}" data-prov="${esc(l.p.id)}" data-model="${esc(m.model)}">
        <rect class="tbox" x="${X.model}" y="${my}" width="${X.modelW}" height="${mh}" rx="7" fill="#12171f" stroke="${m.live ? SCOPE.model : SCOPE.dim}" stroke-opacity="${m.live ? ".35" : ".16"}"/>
        <text x="${X.model + 12}" y="${my + 16}" font-family=${MONO} font-size="11.5" fill="${m.live ? "#c9d1d9" : "#868d99"}">${esc(trunc(m.model, Math.max(10, Math.floor((X.modelW - 56) / 6.6))))}</text>
        <text x="${X.model + 12}" y="${my + 28}" font-family=${MONO} font-size="9" letter-spacing=".8" fill="#737b8a">${m.live ? esc(fmtTokens(m.tokens)) + " TOK &#183; " + esc(fmtUsd(m.cost)) : "NO RECENT TRAFFIC"}</text>
        <text x="${X.model + X.modelW - 11}" y="${my + 22}" text-anchor="end" font-family=${MONO} font-size="12.5" fill="${m.live ? SCOPE.model : "#737b8a"}">${m.live ? esc(m.req) : "—"}</text>
        <rect class="thit" x="${X.model}" y="${my}" width="${X.modelW}" height="${mh}"/>
      </g>`;

      const out = `M ${X.model + X.modelW},${m.y} C ${X.egress - 34},${m.y} ${X.egress - 34},${midY} ${X.egress},${midY}`;
      let outSvg = `<path d="${out}" fill="none" stroke="${m.live ? SCOPE.ok : SCOPE.dim}" stroke-opacity="${m.live ? ".32" : ".16"}" stroke-width="1" ${m.live ? "" : 'stroke-dasharray="3 4"'}/>`;
      if (m.live && serving) outSvg += particles(out, SCOPE.ok, 1, 5.2);
      svg += `<g data-prov="${esc(l.p.id)}">${outSvg}</g>`;
    });
  });

  // Never let the canvas imply it is showing everything.
  const hidden = s.providers.filter((p) => p.hasKey && p.enabled).length - lanes.length;
  if (hidden > 0) {
    svg += `<text x="${X.prov}" y="${H - 13}" font-family=${MONO} font-size="9.5" letter-spacing="1.2" fill="#737b8a">+ ${hidden} LANE(S) STANDING BY &#183; SEE PROVIDERS</text>`;
  }

  // egress
  const eh = 76, ey = midY - eh / 2;
  svg += `<g class="t-egress">
    <rect x="${X.egress}" y="${ey}" width="${X.egressW}" height="${eh}" rx="9" fill="#12171f" stroke="${SCOPE.ok}" stroke-opacity=".3"/>
    <circle cx="${X.egress + 15}" cy="${ey + 18}" r="3.4" fill="${SCOPE.ok}"/>
    <text x="${X.egress + 26}" y="${ey + 22}" font-family=${MONO} font-size="10.5" letter-spacing="1.2" fill="#7ee787">RESPONSE</text>
    <text x="${X.egress + 15}" y="${ey + 45}" font-family=${MONO} font-size="13" fill="#c9d1d9">${esc(fmtTokens(s.totals.totalTokens))} tok</text>
    <text x="${X.egress + 15}" y="${ey + 62}" font-family=${MONO} font-size="10.5" fill="#9aa3b0">${esc(fmtUsd(s.totals.totalCostUsd))}</text>
  </g></svg>`;

  host.innerHTML = svg;
}

function topoCapPct(s) {
  const spend = s.providers.reduce((a, p) => a + p.monthlySpendUsd, 0);
  const cap = s.providers.reduce((a, p) => a + (p.budgetCapUsd || 0), 0);
  return cap ? Math.min(999, (spend / cap) * 100) : null;
}

function wireTopoTip() {
  const wrap = document.getElementById("topoWrap");
  const tip = document.getElementById("topoTip");
  if (!wrap || !tip) return;
  wrap.addEventListener("mousemove", (e) => {
    const g = e.target.closest?.(".tnode");
    if (!g) { tip.classList.remove("on"); return; }
    const d = topoTips[g.dataset.tip];
    if (!d) { tip.classList.remove("on"); return; }
    tip.innerHTML = `<div class="tt-h">${esc(d.h)}</div>`
      + d.rows.map((r) => `<div class="tt-r"><span>${esc(r[0])}</span><span>${esc(r[1])}</span></div>`).join("");
    const box = wrap.getBoundingClientRect();
    const x = Math.min(box.width - 190, Math.max(8, e.clientX - box.left + 14));
    const y = Math.min(box.height - 110, Math.max(8, e.clientY - box.top + 12));
    tip.style.left = x + "px";
    tip.style.top = y + "px";
    tip.classList.add("on");
  });
  wrap.addEventListener("mouseleave", () => tip.classList.remove("on"));
  wrap.addEventListener("click", (e) => {
    const g = e.target.closest?.(".tnode");
    if (g?.dataset.goto) navigate(g.dataset.goto);
  });
}

// --- Cross-panel identity ------------------------------------------------

// One provider is one thing, wherever it appears. Every panel that names a
// lane carries data-prov, so pointing at it anywhere — the chain, a topology
// node, a health row, a matrix cell, a stream row — dims everything that is
// not that lane. This is the only way the six views read as one system rather
// than six charts that happen to share a page.
let focusProv = null;
function focusProvider(id) {
  if (id === focusProv) return;
  focusProv = id || null;
  document.querySelectorAll(".page[data-focus]").forEach((n) => n.removeAttribute("data-focus"));
  const pg = document.querySelector(".page.active");
  if (!pg) return;
  if (focusProv) pg.setAttribute("data-focus", focusProv);
  pg.querySelectorAll("[data-prov]").forEach((n) =>
    n.classList.toggle("lit", n.getAttribute("data-prov") === focusProv));
}

// Wired to the page element rather than its contents, so it survives every
// repaint that replaces the innerHTML underneath it.
function wireFocusLink(el) {
  if (el.dataset.focusWired === "1") return;
  el.dataset.focusWired = "1";
  el.addEventListener("mouseover", (e) => {
    const n = e.target.closest?.("[data-prov]");
    focusProvider(n ? n.getAttribute("data-prov") : null);
  });
  el.addEventListener("mouseleave", () => focusProvider(null));
}

// Re-apply after a repaint threw the marks away (see PAGES.home).
function restoreFocus() {
  if (!focusProv) return;
  const id = focusProv;
  focusProv = null;
  focusProvider(id);
}

// --- One request, walked through the whole console -----------------------

// When a crossing lands, it is drawn once and then followed: ingress, engine,
// the lane that took it, the model, the response, that lane's health row, its
// matrix cell. Every step is a brief lift on an element that is already on
// screen — nothing new appears, nothing glows permanently.
let propTimers = [];
function propagate(providerId, model) {
  propTimers.forEach(clearTimeout);
  propTimers = [];
  const home = document.getElementById("page-home");
  if (!home || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const step = (sel, delay) => {
    propTimers.push(setTimeout(() => {
      home.querySelectorAll(sel).forEach((n) => {
        n.classList.remove("hot-step");
        void n.getBoundingClientRect();
        n.classList.add("hot-step");
        setTimeout(() => n.classList.remove("hot-step"), 900);
      });
    }, delay));
  };
  if (!providerId) return;
  const p = CSS.escape(providerId);
  const m = model ? CSS.escape(model) : null;
  step("#topoHost .t-ingress", 0);
  step("#topoHost .t-engine", 150);
  step(`.cr-item[data-prov="${p}"]`, 220);
  step(`#topoHost .t-prov[data-prov="${p}"]`, 320);
  if (m) step(`#topoHost .t-model[data-prov="${p}"][data-model="${m}"]`, 470);
  step("#topoHost .t-egress", 620);
  step(`.ph-row[data-prov="${p}"]`, 760);
  if (m) step(`.mxc[data-prov="${p}"][data-model="${m}"]`, 880);
}

// --- Instrument strip ----------------------------------------------------

function arcGauge(value, ink) {
  const w = 118, h = 50, r = 44, cx = w / 2, cy = h - 3;
  const a = Math.PI * Math.min(1, Math.max(0, value / 100));
  const x = cx + r * Math.cos(Math.PI - a), y = cy - r * Math.sin(Math.PI - a);
  return `<svg class="arc" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <path d="M ${cx - r},${cy} A ${r},${r} 0 0 1 ${cx + r},${cy}" fill="none" stroke="#1b2130" stroke-width="5" stroke-linecap="round"/>
    ${a > 0.001 ? `<path d="M ${cx - r},${cy} A ${r},${r} 0 0 1 ${x.toFixed(2)},${y.toFixed(2)}" fill="none" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>` : ""}
    <circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3" fill="${ink}"/>
  </svg>`;
}

function ringGauge(value, ink) {
  const s = 54, r = 21, c = 2 * Math.PI * r;
  const on = (Math.min(100, Math.max(0, value)) / 100) * c;
  return `<svg class="ring" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" aria-hidden="true">
    <circle cx="${s / 2}" cy="${s / 2}" r="${r}" fill="none" stroke="#1b2130" stroke-width="4"/>
    <circle cx="${s / 2}" cy="${s / 2}" r="${r}" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round"
      stroke-dasharray="${on.toFixed(1)} ${(c - on).toFixed(1)}" transform="rotate(-90 ${s / 2} ${s / 2})"/>
  </svg>`;
}

function paintInstruments(s) {
  const host = document.getElementById("instr");
  if (!host) return;

  const spend = s.providers.reduce((a, p) => a + p.monthlySpendUsd, 0);
  const cap = s.providers.reduce((a, p) => a + (p.budgetCapUsd || 0), 0);
  const capPct = cap ? Math.min(999, (spend / cap) * 100) : null;
  const spendInk = capPct === null ? SCOPE.dim : capPct >= 100 ? SCOPE.bad : capPct >= 80 ? SCOPE.conn : SCOPE.ok;

  const conf = s.confidence || { reportedPct: null, estimatedRequests: 0 };
  const trust = s.pricingTrust || { verified: 0, total: 0, unenforceable: 0 };

  const active = s.providers.filter((p) => p.hasKey && p.enabled);
  const openN = s.providers.filter((p) => p.circuit === "OPEN").length;
  const coolConn = Object.keys(s.resilience?.connections || {}).length;
  const lockedModels = Object.keys(s.resilience?.models || {}).length;

  const cache = s.cache || { hits: 0, misses: 0, entries: 0, hitRatePct: 0 };
  // A hit rate needs a denominator. With nothing looked up, "0%" reads as a
  // cache that is failing rather than one that has not been asked anything.
  // The Cache page already showed a no-reading glyph here; this matches it.
  const cacheLookups = (cache.hits || 0) + (cache.misses || 0);
  const quota = s.quota || {};
  const qt = quota.totals || {};

  const laneTicks = s.providers.map((p) => {
    const st = laneState(p);
    const cls = st === "open" ? "open" : st === "cold" || st === "half" ? "cold" : st === "live" || st === "idle" ? "on" : "";
    return `<i class="${cls}"></i>`;
  }).join("");

  const priceNodes = Array.from({ length: trust.total }, (_, i) =>
    `<i class="${i < trust.verified ? "v" : i < trust.verified + (trust.unenforceable || 0) ? "z" : ""}"></i>`).join("");

  const segs = Array.from({ length: 20 }, (_, i) => {
    const on = i < Math.round((conf.reportedPct / 100) * 20);
    return `<i class="${on ? (conf.reportedPct >= 95 ? "f" : conf.reportedPct >= 60 ? "m" : "b") : ""}"></i>`;
  }).join("");

  const pools = (quota.pools || []).slice(0, 3);
  const poolBars = pools.length ? pools.map((p) => {
    const lim = p.remaining?.requestsToday != null && p.used?.requestsToday != null
      ? p.used.requestsToday + p.remaining.requestsToday : null;
    const used = p.used?.requestsToday || 0;
    const w = lim ? Math.min(100, (used / lim) * 100) : 0;
    const tip = `${p.pool} · ${used}${lim ? ` / ${lim}` : ""} requests today${p.confidence === "assumed" ? " (limit assumed)" : ""}`;
    return `<div class="pb" title="${esc(tip)}"><div class="pbt"><i class="${p.exhausted ? "full" : ""}" style="width:${w.toFixed(1)}%"></i></div>
      <div class="pbl">${esc(trunc(p.pool, 9))}</div></div>`;
  }).join("") : '<div class="pbl" style="text-align:left">no declared free pool</div>';

  host.innerHTML = `
    <div class="icell">
      <div class="ik">SPEND &#183; MONTH TO DATE</div>
      <div class="iv">${esc(fmtUsd(spend))}</div>
      ${arcGauge(capPct === null ? 0 : Math.min(100, capPct), spendInk)}
      <div class="is">${capPct === null
        ? "NO CAP SET · <em>nothing is capping spend</em>"
        : `<em>${esc(capPct.toFixed(capPct < 10 ? 1 : 0))}%</em> OF ${esc(fmtUsd(cap))} &#183; ${esc(fmtUsd(Math.max(0, cap - spend)))} HEADROOM`}</div>
    </div>

    <div class="icell">
      <div class="ik">FIGURES BACKED BY PROVIDER</div>
      <div class="iv ${conf.reportedPct === null ? "" : conf.reportedPct >= 95 ? "ok" : conf.reportedPct >= 60 ? "warn" : "bad"}">${
        conf.reportedPct === null ? "&mdash;" : `${esc(conf.reportedPct)}<span class="u">%</span>`
      }</div>
      <div class="segbar">${segs}</div>
      <div class="is">${conf.reportedPct === null
        ? "NOTHING MEASURED YET"
        : `<em>${esc(conf.estimatedRequests || 0)}</em> REQUEST(S) ESTIMATED LOCALLY${conf.estimatedRequests ? " &#183; SHOWN WITH ~" : ""}`}</div>
    </div>

    <div class="icell">
      <div class="ik">PRICE TABLE VERIFIED</div>
      <div class="iv">${esc(trust.verified)}<span class="u"> / ${esc(trust.total)}</span></div>
      <div class="nodegrid">${priceNodes}</div>
      <div class="is">${trust.unenforceable
        ? `<em>${esc(trust.unenforceable)}</em> PRICED 0/0 &#183; CAP CAN NEVER TRIP`
        : "ALL PRICED LANES CAN ENFORCE A CAP"}</div>
    </div>

    <div class="icell">
      <div class="ik">ACTIVE LANES</div>
      <div class="iv ${openN ? "bad" : ""}">${esc(active.length)}<span class="u"> / ${esc(s.providers.length)}</span></div>
      <div class="lanestrip">${laneTicks}</div>
      <div class="is">${openN ? `<em style="color:#f87171">${esc(openN)} BREAKER OPEN</em> &#183; ` : ""}${esc(coolConn)} KEY COOLING &#183; ${esc(lockedModels)} MODEL LOCKED</div>
    </div>

    <div class="icell">
      <div class="ik">RESPONSE CACHE</div>
      <div class="iv">${cacheLookups ? esc(cache.hitRatePct) + "<span class=\"u\">%</span>" : "&mdash;"}</div>
      ${ringGauge(cacheLookups ? cache.hitRatePct : 0, cache.hitRatePct >= 40 ? SCOPE.ok : cache.hitRatePct > 0 ? SCOPE.model : SCOPE.dim)}
      <div class="is">${cacheLookups
        ? `<em>${esc(cache.entries)}</em> ENTRIES &#183; ${esc(cache.hits)} HIT / ${esc(cache.misses)} MISS`
        : "NOTHING LOOKED UP YET"}</div>
    </div>

    <div class="icell">
      <div class="ik">FREE QUOTA POOLS</div>
      <div class="iv ${qt.exhaustedPools ? "warn" : ""}">${esc(qt.distinctPools ?? 0)}<span class="u"> pool${qt.distinctPools === 1 ? "" : "s"}</span></div>
      <div class="poolbars">${poolBars}</div>
      <div class="is">${esc(qt.declaredFreeProviders ?? 0)} DECLARED &#183; <em>${esc(qt.dedupedAway ?? 0)}</em> DEDUPED AWAY${qt.exhaustedPools ? ` &#183; <em style="color:#fdcb6e">${esc(qt.exhaustedPools)} EXHAUSTED</em>` : ""}</div>
    </div>`;
}

// --- Traffic telemetry ---------------------------------------------------

async function paintTelemetry() {
  const host = document.getElementById("telHost");
  if (!host) return;
  const range = TEL_RANGES.find((r) => r.id === telRange) || TEL_RANGES[1];
  try {
    const { series, bucket } = await api(`/api/panel/series?bucket=${range.bucket}&points=${range.points}`);
    telSeries = series;
    telBucket = bucket;
  } catch {
    host.innerHTML = '<div class="empty-note"><b>Could not load the series.</b>The gateway did not answer for this window. The panels below still read from the live state.</div>';
    return;
  }
  drawTelemetry();
}

function drawTelemetry() {
  const host = document.getElementById("telHost");
  const meta = document.getElementById("telMeta");
  if (!host || !telSeries) return;
  // A window with nothing in it does not need 300px of grid to say so. The
  // axis stays — it is the shape of the window you are asking about — and the
  // space that would have held bars states what will fill it.
  const totalReqAll = telSeries.reduce((a, p) => a + p.requests, 0);
  const W = Math.max(360, host.clientWidth || 900), H = totalReqAll ? 296 : 156;
  const pad = { l: 60, r: 54, t: 16, b: 28 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const n = telSeries.length;
  const maxCost = Math.max(...telSeries.map((p) => p.costUsd), 0);
  const maxReq = Math.max(...telSeries.map((p) => p.requests), 0);
  const totalReq = telSeries.reduce((a, p) => a + p.requests, 0);
  const totalCost = telSeries.reduce((a, p) => a + p.costUsd, 0);

  const quiet = telSeries.filter((p) => !p.requests).length;
  if (meta) {
    meta.textContent = totalReq
      ? `${totalReq} REQ · ${fmtUsd(totalCost)} · PEAK ${fmtUsd(maxCost)} PER ${telBucket.toUpperCase()}`
      : `NO TRAFFIC IN ANY OF THE LAST ${n} ${telBucket.toUpperCase()}S`;
  }

  const xAt = (i) => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yCost = (v) => pad.t + ih - (maxCost > 0 ? (v / maxCost) * ih * 0.92 : 0);
  const yReq = (v) => pad.t + ih - (maxReq > 0 ? (v / maxReq) * ih * 0.72 : 0);
  const bw = Math.max(2, Math.min(22, (iw / Math.max(1, n)) * 0.5));

  let g = "";
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + (ih / 3) * i;
    g += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.05)"/>`;
  }
  g += `<text x="${pad.l - 10}" y="${pad.t + 5}" text-anchor="end" font-family=${MONO} font-size="10.5" fill="#9aa3b0">${esc(maxCost > 0 ? fmtUsd(maxCost) : "$0")}</text>
    <text x="${pad.l - 10}" y="${pad.t + ih}" text-anchor="end" font-family=${MONO} font-size="10.5" fill="#737b8a">0</text>
    <text x="${W - pad.r + 10}" y="${pad.t + 5}" font-family=${MONO} font-size="10.5" fill="#00cec9" opacity=".8">${esc(maxReq)}</text>
    <text x="${W - pad.r + 10}" y="${pad.t + 18}" font-family=${MONO} font-size="8.5" letter-spacing="1" fill="#737b8a">REQ</text>`;
  // An hour with nothing in it is a reading, not a gap. Quiet buckets get a
  // hairline floor so the silence is legible rather than merely absent.
  if (quiet && quiet < n) {
    g += `<text x="${pad.l}" y="${pad.t + ih + 20}" font-family=${MONO} font-size="9" letter-spacing="1" fill="#737b8a">${quiet} QUIET ${telBucket.toUpperCase()}${quiet === 1 ? "" : "S"}</text>`;
  }

  // cost bars — the bucket is a discrete thing, so it reads as a bucket
  telSeries.forEach((p, i) => {
    const x = xAt(i) - bw / 2;
    const y = yCost(p.costUsd);
    const h = Math.max(1.5, pad.t + ih - y);
    g += p.requests
      ? `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="url(#telG)"/>`
      : `<rect x="${x.toFixed(1)}" y="${(pad.t + ih - 2).toFixed(1)}" width="${bw.toFixed(1)}" height="2" rx="1" fill="#2a3140"/>`;
  });

  // request volume — a separate layer with its own scale, drawn as a step
  let step = "";
  telSeries.forEach((p, i) => {
    const x = xAt(i), y = yReq(p.requests);
    step += `${i ? "L" : "M"} ${x.toFixed(1)},${y.toFixed(1)} `;
  });
  g += `<path d="${step}" fill="none" stroke="${SCOPE.model}" stroke-opacity=".85" stroke-width="1.4" stroke-linejoin="round"/>`;
  telSeries.forEach((p, i) => {
    if (!p.requests) return;
    g += `<circle cx="${xAt(i).toFixed(1)}" cy="${yReq(p.requests).toFixed(1)}" r="2" fill="${SCOPE.model}"/>`;
  });

  const every = Math.max(1, Math.ceil(n / 8));
  telSeries.forEach((p, i) => {
    if (i % every) return;
    const label = telBucket === "day" ? p.key.slice(5) : p.key.slice(11) + "h";
    g += `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-family=${MONO} font-size="9.5" fill="#868d99">${esc(label)}</text>`;
  });

  host.innerHTML = `<svg id="telemetry" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
    aria-label="Cost and request volume per ${telBucket} over the last ${n} ${telBucket}s.">
    <defs><linearGradient id="telG" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${SCOPE.provider}" stop-opacity=".95"/>
      <stop offset="100%" stop-color="${SCOPE.providerDeep}" stop-opacity=".18"/>
    </linearGradient></defs>${g}</svg>`
    + (totalReqAll ? "" : `<div class="empty-note wide" style="margin-top:14px">
        <b>${esc(n)} ${esc(telBucket)}s, no crossings.</b>
        Each bucket becomes one cost bar and one point on the request line, drawn against
        separate scales so a cheap busy hour and an expensive quiet one both stay readable.
        Quiet buckets keep their floor mark, so a gap in traffic reads as a gap rather than
        as missing data.</div>`);
  host.dataset.pl = pad.l; host.dataset.pr = pad.r; host.dataset.w = W;
}

function wireTelemetryHover() {
  const wrap = document.getElementById("telWrap");
  const cross = document.getElementById("telCross");
  const tip = document.getElementById("telTip");
  if (!wrap) return;
  wrap.addEventListener("mousemove", (e) => {
    const host = document.getElementById("telHost");
    if (!telSeries?.length || !host) return;
    const box = wrap.getBoundingClientRect();
    const W = Number(host.dataset.w) || box.width;
    const pl = Number(host.dataset.pl) || 52, pr = Number(host.dataset.pr) || 46;
    const x = e.clientX - box.left;
    const t = (x - pl) / Math.max(1, W - pl - pr);
    const i = Math.round(Math.min(1, Math.max(0, t)) * (telSeries.length - 1));
    const p = telSeries[i];
    const px = pl + (telSeries.length === 1 ? (W - pl - pr) / 2 : (i / (telSeries.length - 1)) * (W - pl - pr));
    cross.style.left = px + "px";
    cross.style.opacity = "1";
    tip.innerHTML = `<div class="tt-h">${esc(telBucket === "day" ? p.key : p.key.replace("T", " ") + ":00")}</div>
      <div class="tt-r"><span>requests</span><span>${esc(p.requests)}</span></div>
      <div class="tt-r"><span>tokens</span><span>${esc(fmtTokens(p.tokens))}</span></div>
      <div class="tt-r"><span>cost</span><span>${esc(fmtUsd(p.costUsd))}</span></div>`;
    tip.style.left = Math.min(box.width - 170, Math.max(4, px + 12)) + "px";
    tip.style.opacity = "1";
  });
  wrap.addEventListener("mouseleave", () => {
    if (cross) cross.style.opacity = "0";
    if (tip) tip.style.opacity = "0";
  });
}

// --- Cost flow -----------------------------------------------------------

function paintFlow(s) {
  const host = document.getElementById("flowHost");
  const meta = document.getElementById("flowMeta");
  if (!host) return;
  const fold = foldRecent(s);
  const entries = [...fold.byProvider.entries()];
  if (!entries.length) {
    host.innerHTML = `<div class="empty-note">
      <b>Nothing has flowed through the plaza yet.</b>
      This is a flow, not a bar chart: the stream splits into the lanes that carried it, and each
      lane splits again into the models it reached. Ribbon width is the share of spend.</div>`;
    if (meta) meta.textContent = "";
    return;
  }

  const totalCost = entries.reduce((a, [, v]) => a + v.cost, 0);
  const byCost = totalCost > 0;
  const weightOf = (v) => (byCost ? v.cost : v.req);
  const totalW = entries.reduce((a, [, v]) => a + weightOf(v), 0) || 1;
  if (meta) meta.textContent = byCost
    ? `${s.recentRequests.length} recent crossings · ${fmtUsd(totalCost)}`
    : `${s.recentRequests.length} recent crossings · weighted by requests (no cost recorded)`;

  const nodes = [];
  entries.sort((a, b) => weightOf(b[1]) - weightOf(a[1])).forEach(([pid, v]) => {
    const models = [...v.models.entries()].sort((a, b) => weightOf(b[1]) - weightOf(a[1])).slice(0, 3);
    nodes.push({ pid, v, models });
  });
  let rowCount = 0;
  nodes.forEach((n) => { rowCount += n.models.length; });

  const W = Math.max(320, host.clientWidth || 520);
  const rowH = 52, top = 32, bot = 18;
  const H = top + rowCount * rowH + bot;
  const xStream = 14, xProvL = 92, provW = 112, xModelL = 268;
  const modelW = Math.max(90, W - xModelL - 104);

  let y = top;
  nodes.forEach((n) => {
    n.models.forEach((m) => { m[2] = y + rowH / 2; y += rowH; });
    n.y = (n.models[0][2] + n.models[n.models.length - 1][2]) / 2;
  });
  const midY = (top + (H - bot)) / 2;

  let g = `<rect x="${xStream}" y="${top - 8}" width="4" height="${H - top - bot + 16}" rx="2" fill="${SCOPE.provider}" opacity=".5"/>
    <text x="${xStream}" y="${top - 15}" font-family=${MONO} font-size="9" letter-spacing="1.6" fill="#868d99">STREAM</text>
    <text x="${xProvL}" y="${top - 15}" font-family=${MONO} font-size="9" letter-spacing="1.6" fill="#868d99">PROVIDER</text>
    <text x="${xModelL}" y="${top - 15}" font-family=${MONO} font-size="9" letter-spacing="1.6" fill="#868d99">MODEL</text>
    <text x="${W - 6}" y="${top - 15}" text-anchor="end" font-family=${MONO} font-size="9" letter-spacing="1.6" fill="#868d99">${byCost ? "COST" : "REQ"}</text>`;

  nodes.forEach((n) => {
    const share = weightOf(n.v) / totalW;
    const sw = 1.5 + share * 12;
    const ph = Math.max(28, n.models.length * rowH - 8);
    const py = n.y - ph / 2;
    const ribbon = `M ${xStream + 5},${midY} C ${xProvL - 34},${midY} ${xProvL - 34},${n.y} ${xProvL},${n.y}`;
    g += `<g data-prov="${esc(n.pid)}">
      <path d="${ribbon}" fill="none" stroke="${SCOPE.provider}" stroke-opacity=".26" stroke-width="${sw.toFixed(1)}" stroke-linecap="round"/>
      ${particles(ribbon, SCOPE.provider, Math.max(1, Math.round(share * 3)), 4.6)}
      <rect x="${xProvL}" y="${py}" width="${provW}" height="${ph}" rx="6" fill="#141a24" stroke="${SCOPE.provider}" stroke-opacity=".35"/>
      <text x="${xProvL + 10}" y="${n.y - 1}" font-family=${MONO} font-size="12" fill="${SCOPE.provider}">${esc(trunc(n.pid, 11))}</text>
      <text x="${xProvL + 10}" y="${n.y + 13}" font-family=${MONO} font-size="9.5" fill="#868d99">${esc(n.v.req)} req &#183; ${esc(Math.round(share * 100))}%</text>
    </g>`;

    n.models.forEach((m) => {
      const [name, mv, my] = m;
      const msh = weightOf(mv) / totalW;
      const msw = 1.2 + msh * 10;
      const mrib = `M ${xProvL + provW},${n.y} C ${xModelL - 30},${n.y} ${xModelL - 30},${my} ${xModelL},${my}`;
      g += `<g data-prov="${esc(n.pid)}" data-model="${esc(name)}">
        <path d="${mrib}" fill="none" stroke="${SCOPE.model}" stroke-opacity=".26" stroke-width="${msw.toFixed(1)}" stroke-linecap="round"/>
        ${particles(mrib, SCOPE.model, 1, 4.2)}
        <rect x="${xModelL}" y="${my - 13}" width="${modelW}" height="26" rx="5" fill="#12171f" stroke="${SCOPE.model}" stroke-opacity=".22"/>
        <text x="${xModelL + 9}" y="${my + 4.5}" font-family=${MONO} font-size="11" fill="#c9d1d9">${esc(trunc(name, Math.max(8, Math.floor(modelW / 6.8))))}</text>
        <text x="${W - 6}" y="${my + 4.5}" text-anchor="end" font-family=${MONO} font-size="11" fill="${byCost ? "#c9d1d9" : "#00cec9"}">${esc(byCost ? fmtUsd(mv.cost) : mv.req + " req")}</text>
      </g>`;
    });
  });

  host.innerHTML = `<svg id="costflow" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
    aria-label="Cost flow from the request stream through each provider to each model.">${g}</svg>`;
}

// --- Latency distribution ------------------------------------------------

function paintLatency(s) {
  const host = document.getElementById("latHost");
  const stats = document.getElementById("latStats");
  const meta = document.getElementById("latMeta");
  if (!host) return;
  const fold = foldRecent(s);
  const n = fold.sorted.length;
  if (meta) meta.textContent = n ? `LAST ${n} CROSSINGS · LOG SCALE` : "";

  if (!n) {
    if (stats) stats.innerHTML = "";
    host.innerHTML = `<div class="empty-note">
      <b>No latency samples yet.</b>
      Every crossing lands here as one dot on a log axis, so a slow tail stays visible instead of
      being averaged away. P50, P95 and P99 are drawn as markers; a dot past P95 is clickable and
      scrolls to its row in the stream.</div>`;
    return;
  }

  const ink = (v) => (v >= 1000 ? SCOPE.bad : v >= 300 ? SCOPE.conn : SCOPE.ok);
  const cls = (v) => (v >= 1000 ? "bad" : v >= 300 ? "warn" : "");
  if (stats) {
    stats.innerHTML = `
      <div class="lat-stats">
        <div class="lat-stat"><div class="k">P50</div><div class="v ${cls(fold.p50)}">${esc(fmtMs(fold.p50))}</div></div>
        <div class="lat-stat"><div class="k">P95</div><div class="v ${cls(fold.p95)}">${esc(fmtMs(fold.p95))}</div></div>
        <div class="lat-stat"><div class="k">P99</div><div class="v ${cls(fold.p99)}">${esc(fmtMs(fold.p99))}</div></div>
        <div class="lat-stat"><div class="k">MAX</div><div class="v ${cls(fold.sorted[n - 1])}">${esc(fmtMs(fold.sorted[n - 1]))}</div></div>
      </div>`;
  }

  const W = Math.max(300, host.clientWidth || 460), H = 206;
  const pad = { l: 12, r: 14, t: 40, b: 32 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const lo = Math.max(20, Math.min(...fold.sorted) * 0.7);
  const hi = Math.max(fold.sorted[n - 1] * 1.25, lo * 4);
  const lx = (v) => pad.l + ((Math.log10(Math.max(lo, v)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * iw;

  let g = `<line x1="${pad.l}" y1="${pad.t + ih}" x2="${W - pad.r}" y2="${pad.t + ih}" stroke="rgba(255,255,255,.09)"/>`;
  [50, 100, 250, 500, 1000, 2500, 5000, 10000].forEach((t) => {
    if (t < lo || t > hi) return;
    const x = lx(t);
    g += `<line x1="${x.toFixed(1)}" y1="${pad.t - 4}" x2="${x.toFixed(1)}" y2="${pad.t + ih}" stroke="rgba(255,255,255,.045)"/>
      <text x="${x.toFixed(1)}" y="${H - 10}" text-anchor="middle" font-family=${MONO} font-size="9.5" fill="#868d99">${t >= 1000 ? t / 1000 + "s" : t}</text>`;
  });

  [["p50", fold.p50, SCOPE.model], ["p95", fold.p95, SCOPE.conn], ["p99", fold.p99, SCOPE.bad]].forEach(([k, v, c], i) => {
    const x = lx(v);
    g += `<line x1="${x.toFixed(1)}" y1="${pad.t - 6}" x2="${x.toFixed(1)}" y2="${pad.t + ih}" stroke="${c}" stroke-opacity=".5" stroke-dasharray="3 3"/>
      <text x="${x.toFixed(1)}" y="${pad.t - 12 + (i % 2 ? -13 : 0)}" text-anchor="middle" font-family=${MONO} font-size="10" fill="${c}">${k} ${esc(fmtMs(v))}</text>`;
  });

  // Every sample is a dot; the shape of the cloud is the distribution, and
  // the tail is not averaged away into a percentile you cannot click.
  const rows = [...s.recentRequests].map((r, i) => ({ r, i }));
  rows.forEach(({ r, i }) => {
    const v = Number(r.latencyMs) || 0;
    const x = lx(v);
    const y = pad.t + 10 + ((i * 37) % Math.max(1, ih - 20));
    const out = v >= fold.p95 && n > 3;
    const key = eventKey(r);
    g += `<g class="outlier" data-key="${esc(key)}" data-lat="${esc(v)}" data-prov="${esc(r.providerId)}" data-m="${esc(r.model)}">
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${out ? 4.5 : 3.4}" fill="${ink(v)}" fill-opacity="${out ? ".95" : ".55"}"
        ${out ? `stroke="${ink(v)}" stroke-opacity=".35" stroke-width="4"` : ""}/>
      <title>${esc(r.providerId)} · ${esc(r.model)} · ${esc(fmtMs(v))}</title>
    </g>`;
  });

  host.innerHTML = `<svg id="latdist" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
    aria-label="Latency of the last ${n} crossings on a log scale, with p50, p95 and p99 markers.">${g}</svg>`;

  host.querySelectorAll(".outlier").forEach((o) => o.addEventListener("click", () => {
    const row = document.querySelector(`.ev-row[data-key="${CSS.escape(o.dataset.key)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.remove("fresh");
    void row.offsetWidth;
    row.classList.add("fresh");
  }));
}

// --- Provider health -----------------------------------------------------

function paintHealth(s) {
  const host = document.getElementById("phHost");
  const meta = document.getElementById("phMeta");
  if (!host) return;
  const fold = foldRecent(s);
  const rows = s.providers.filter((p) => p.hasKey)
    .sort((a, b) => b.lifetimeStats.requests - a.lifetimeStats.requests)
    .slice(0, 9);
  if (meta) meta.textContent = `${rows.length} CREDENTIALLED OF ${s.providers.length}`;

  if (!rows.length) {
    host.innerHTML = `<div class="empty-note">
      <b>No provider has a credential yet.</b>
      Each lane you connect gets a row here: its state, lifetime requests, average latency,
      month-to-date spend and a heartbeat drawn from its own crossings in the recent window.</div>`;
    return;
  }

  const busiest = Math.max(...rows.map((p) => p.lifetimeStats.requests), 1);
  host.innerHTML = `<div class="ph-row head">
      <span></span><span>Lane</span><span class="ph-v">Req</span><span class="ph-v">Avg</span><span class="ph-v">Spend</span><span>Recent latency</span>
    </div>` + rows.map((p) => {
    const st = laneState(p);
    const ink = LANE_INK[st];
    const seen = fold.byProvider.get(p.id);
    const lat = seen ? [...seen.lat].reverse() : [];
    const spark = sparkline(lat, ink);
    const stCls = st === "open" ? "open" : st === "cold" || st === "half" ? "cold" : st === "live" ? "ok" : "idle";
    // The share rail behind the row is the lane's slice of lifetime traffic —
    // the ranking is already the sort order, this makes the gap between first
    // and fifth legible without a second chart.
    const share = (p.lifetimeStats.requests / busiest) * 100;
    return `<div class="ph-row${st === "idle" || st === "off" ? " quiet" : ""}" data-prov="${esc(p.id)}"
        title="${esc(p.name)} · ${esc(LANE_LABEL[st])}" style="--share:${share.toFixed(1)}%">
      <span class="dot" style="background:${ink};box-shadow:0 0 6px ${ink}"></span>
      <div class="ph-nm">${esc(trunc(p.name, 18))}<span class="sc ph-state ${stCls}">${esc(LANE_LABEL[st])}${p.connectionsCoolingDown ? ` · ${esc(p.connectionsCoolingDown)}/${esc(p.connections)} KEY` : ""}</span></div>
      <div class="ph-v ${p.lifetimeStats.requests ? "" : "zero"}">${esc(p.lifetimeStats.requests)}</div>
      <div class="ph-v ${p.lifetimeStats.avgLatencyMs ? "" : "zero"}">${esc(p.lifetimeStats.avgLatencyMs ? fmtMs(p.lifetimeStats.avgLatencyMs) : "—")}</div>
      <div class="ph-v ${p.monthlySpendUsd ? "" : "zero"}">${esc(fmtUsd(p.monthlySpendUsd))}</div>
      <div class="ph-beat">${spark}</div>
    </div>`;
  }).join("");
}

// A heartbeat drawn from the provider's own entries in the recent window.
// Flat and dim when it has not served anything — a quiet lane should look
// quiet, not like a lane with a broken chart.
function sparkline(values, ink) {
  const W = 76, H = 20;
  if (!values.length) {
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="#252c39" stroke-dasharray="2 3"/></svg>`;
  }
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => {
    const x = values.length === 1 ? W / 2 : (i / (values.length - 1)) * W;
    const y = H - 2 - (v / max) * (H - 5);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = values[values.length - 1];
  const lx = values.length === 1 ? W / 2 : W;
  const ly = H - 2 - (last / max) * (H - 5);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polyline points="${pts.join(" ")}" fill="none" stroke="${ink}" stroke-opacity=".8" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="1.6" fill="${ink}"/>
  </svg>`;
}

// --- Traffic matrix ------------------------------------------------------

let mxPrev = new Map();
function paintMatrix(s) {
  const host = document.getElementById("mxHost");
  const meta = document.getElementById("mxMeta");
  if (!host) return;
  const fold = foldRecent(s);
  const provs = [...fold.byProvider.keys()];
  if (!provs.length) {
    host.innerHTML = `<div class="empty-note">
      <b>No crossings in the recent window.</b>
      This grid crosses every lane that served against every model it served, so you can see
      at a glance whether one model is pinned to one provider or spread across several.</div>`;
    if (meta) meta.textContent = "";
    return;
  }
  const modelTotals = new Map();
  fold.byProvider.forEach((v) => v.models.forEach((mv, m) => modelTotals.set(m, (modelTotals.get(m) || 0) + mv.req)));
  const models = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([m]) => m);
  const max = Math.max(...[...fold.byProvider.values()].flatMap((v) => [...v.models.values()].map((x) => x.req)), 1);
  if (meta) meta.textContent = `${provs.length}×${models.length} · last ${s.recentRequests.length}`;

  const next = new Map();
  host.innerHTML = `<table><thead><tr><th class="rowh"></th>${models.map((m) =>
      `<th title="${esc(m)}">${esc(trunc(m, 12))}</th>`).join("")}</tr></thead><tbody>`
    + provs.map((pid) => {
      const v = fold.byProvider.get(pid);
      return `<tr><td class="rowh" data-prov="${esc(pid)}" title="${esc(pid)}">${esc(trunc(pid, 14))}</td>` + models.map((m) => {
        const cell = v.models.get(m);
        const req = cell?.req || 0;
        next.set(pid + "|" + m, req);
        const grew = req > (mxPrev.get(pid + "|" + m) || 0) && mxPrev.size > 0;
        if (!req) return `<td><div class="mxc none" data-prov="${esc(pid)}" data-model="${esc(m)}">&#183;</div></td>`;
        const t = req / max;
        const bg = `rgba(0,206,201,${(0.14 + t * 0.72).toFixed(3)})`;
        return `<td><div class="mxc ${t > 0.55 ? "hot" : ""}${grew ? " pulse" : ""}" data-prov="${esc(pid)}" data-model="${esc(m)}"
          style="background:${bg};border-color:rgba(0,206,201,${(0.2 + t * 0.4).toFixed(2)})"
          title="${esc(pid)} · ${esc(m)} · ${esc(req)} req · ${esc(fmtUsd(cell.cost))}">${esc(req)}</div></td>`;
      }).join("") + "</tr>";
    }).join("") + "</tbody></table>";

  // The grid answers one question — is any model reachable through more than
  // one lane — so the answer is stated rather than left to be counted.
  const shared = models.filter((m) =>
    provs.filter((pid) => fold.byProvider.get(pid).models.has(m)).length > 1).length;
  host.innerHTML += `<div class="mx-read">
    <b>${esc(shared)} of ${esc(models.length)}</b> model${models.length === 1 ? " is" : "s are"} reachable through more than one lane.
    ${shared ? "Those are the ones a breaker can trip without you noticing." : "Every model here is pinned to a single provider. If that lane opens, the request has nowhere else to go."}
  </div>`;
  mxPrev = next;
}

// --- Live request stream -------------------------------------------------

const eventKey = (r) => `${r.ts}|${r.providerId}|${r.model}|${r.latencyMs}`;

function paintStream(s) {
  const host = document.getElementById("evHost");
  const meta = document.getElementById("evMeta");
  if (!host) return;
  if (!s.recentRequests.length) {
    host.innerHTML = `<div class="empty-note wide">
      <b>No crossings yet.</b>
      Point an OpenAI-compatible client at <em>${esc(s.endpoints?.base || "this gateway")}${esc(s.endpoints?.chatCompletions || "/v1/chat/completions")}</em>
      and every request lands here in order: which lane took it, which model answered,
      what it cost and how long it took. The panels above fill from the same rows.</div>`;
    if (meta) meta.textContent = "AWAITING FIRST CROSSING";
    firstStreamPaint = false;
    return;
  }
  const fold = foldRecent(s);
  const worst = Math.max(...fold.latencies, 1);
  if (meta) meta.textContent = `LAST ${s.recentRequests.length} · P95 ${fmtMs(fold.p95)}`;

  const nextSeen = new Set();
  let newest = null;
  host.innerHTML = s.recentRequests.map((r) => {
    const key = eventKey(r);
    nextSeen.add(key);
    const fresh = !firstStreamPaint && !seenEvents.has(key);
    if (fresh && !newest) newest = r;
    const lat = Number(r.latencyMs) || 0;
    const tokens = Number(r.promptTokens || 0) + Number(r.completionTokens || 0);
    const cost = Number(r.costUsd) || 0;
    const sev = lat >= 1000 ? "vslow" : lat >= 300 ? "slow" : "";
    const flagged = fold.latencies.length > 3 && lat >= fold.p95;
    return `<div class="ev-row${fresh ? " fresh" : ""}${flagged ? " flagged" : ""}" data-key="${esc(key)}" data-prov="${esc(r.providerId)}">
      <div class="ev-t">${esc(fmtTime(r.ts))}</div>
      <div class="ev-p">${esc(trunc(r.providerId, 12))}</div>
      <div class="ev-m" title="${esc(r.model)}">${esc(r.model)}</div>
      <div class="r">${esc(tokens)}${r.estimated ? ' <span class="est" title="estimated locally · the provider did not report usage">~</span>' : ""}</div>
      <div class="r ev-c${cost ? "" : " free"}">${esc(fmtUsd(cost))}</div>
      <div class="ev-lat hide-sm"><div class="ev-track"><i class="${sev}" style="width:${Math.max(3, (lat / worst) * 100).toFixed(1)}%"></i></div></div>
      <div class="r ev-ms ${sev}">${esc(fmtMs(lat))}</div>
    </div>`;
  }).join("");
  seenEvents = nextSeen;
  firstStreamPaint = false;
  // The newest crossing is walked back through the console it just arrived
  // in — ingress, engine, lane, model, response, health, matrix.
  if (newest) propagate(newest.providerId, newest.model);
}

// --- System pulse --------------------------------------------------------

function paintPulse(s) {
  const host = document.getElementById("plHost");
  if (!host) return;
  const active = s.providers.filter((p) => p.hasKey && p.enabled).length;
  const openN = s.providers.filter((p) => p.circuit === "OPEN").length;
  const coolConn = Object.keys(s.resilience?.connections || {}).length;
  const lockedModels = Object.keys(s.resilience?.models || {}).length;
  const cache = s.cache || {};
  const comp = s.compression || {};
  const sec = s.security || {};
  const proxy = s.proxy || {};
  const proxyLevels = Object.keys(proxy.configured || {}).length + Object.keys(proxy.categories || {}).length;

  const items = [
    { nm: "Router", st: "ok", txt: s.routing?.defaultCombo ? `combo/${s.routing.defaultCombo}` : "priority order", v: `${s.routing?.strategyCount ?? 0} strat`, vc: "" },
    { nm: "Lanes", st: active ? "ok" : "warn", txt: active ? "serving traffic" : "nothing can serve", v: `${active}/${s.providers.length}`, vc: active ? "ok" : "warn" },
    { nm: "Resilience", st: openN ? "bad" : coolConn || lockedModels ? "warn" : "ok", txt: openN ? `${openN} breaker open` : coolConn || lockedModels ? `${coolConn} key cooling · ${lockedModels} model locked` : "no lane isolated", v: openN ? `${openN} open` : "nominal", vc: openN ? "bad" : coolConn || lockedModels ? "warn" : "ok" },
    { nm: "Cache", st: cache.entries ? "ok" : "", txt: `${cache.entries || 0} entries`, v: `${cache.hitRatePct || 0}%`, vc: "" },
    { nm: "Compression", st: comp.enabled ? "ok" : "", txt: comp.enabled ? `rtk ${comp.rtk?.enabled ? "on" : "off"} · caveman ${comp.caveman?.enabled ? comp.caveman.level : "off"}` : "off", v: comp.enabled ? "on" : "off", vc: comp.enabled ? "ok" : "" },
    { nm: "Guards", st: sec.redactPii || (sec.injectionMode && sec.injectionMode !== "off") ? "ok" : "warn", txt: `pii ${sec.redactPii ? "redacted" : "off"} · injection ${sec.injectionMode || "off"}`, v: sec.redactPii ? "armed" : "open", vc: sec.redactPii ? "ok" : "warn" },
    { nm: "Egress", st: "ok", txt: proxyLevels ? `${proxyLevels} proxy rule(s) · tls ${proxy.tls?.profile || "default"}` : "direct · tls not shaped", v: proxyLevels ? "proxied" : "direct", vc: "" },
    { nm: "Access", st: sec.exposedBeyondLoopback && !s.gatewayAuthEnabled ? "bad" : s.gatewayAuthEnabled ? "ok" : "warn", txt: `${sec.boundHost || "?"} · key ${s.gatewayAuthEnabled ? (sec.keyEncryptedAtRest ? "encrypted" : "plaintext") : "unset"}`, v: s.gatewayAuthEnabled ? "locked" : "open", vc: s.gatewayAuthEnabled ? "ok" : sec.exposedBeyondLoopback ? "bad" : "warn" }
  ];

  host.innerHTML = items.map((it) => `<div class="pl-item">
      <span class="pl-dot ${esc(it.st)}"></span>
      <div class="pl-nm">${esc(it.nm)}<span class="st">${esc(it.txt)}</span></div>
      <div class="pl-v ${esc(it.vc)}">${esc(it.v)}</div>
    </div>`).join("");
}

// =========================================================================
// PROVIDERS — the lane console
// Same zone grammar as the command view: one analytical band that answers
// "which lane should carry this?", then the working grid that lets you act
// on the answer. The band is not a second copy of the grid — it plots the
// two things a card cannot show side by side, price against speed.
// =========================================================================

PAGES.providers = (el, s) => {
  const counts = {
    all: s.providers.length,
    configured: s.providers.filter((p) => p.hasKey).length,
    enabled: s.providers.filter((p) => p.enabled).length,
    capped: s.providers.filter((p) => p.budgetCapUsd !== null).length,
    degraded: s.providers.filter((p) => p.circuit === "OPEN" || p.connectionsCoolingDown > 0).length,
    local: s.providers.filter((p) => !p.requiresKey).length
  };
  const chip = (id, label) =>
    `<span class="chip${providerFilter === id ? " on" : ""}" data-filter="${esc(id)}">${esc(label)} <span class="n">${esc(counts[id])}</span></span>`;

  el.innerHTML = `
    <section class="zone plot">
      <div class="pane" id="posPane">
        <div class="p-head">
          <span class="p-t">Lane positioning</span>
          <span class="p-s" id="posMeta"></span>
        </div>
        <div id="posHost"></div>
        <div class="pos-legend" id="posLegend"></div>
      </div>
      <div class="pane instr-pane">
        <div class="p-head"><span class="p-t">Lane census</span><span class="p-s">FLEET AT A GLANCE</span></div>
        <div class="instr" id="pCensus"></div>
      </div>
    </section>

    <section class="zone lanes">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">Lanes</span>
          <span class="p-s">CLICK A LANE TO INSPECT, CAP OR CREDENTIAL IT</span>
        </div>
        <div class="credbar" id="credBar">
          <span class="k">KEYS ARE WRITTEN TO</span>
          <span class="path">…</span>
        </div>
        <div class="searchbar" style="margin-top:14px">
          <input id="pSearch" type="search" placeholder="search provider, model or base URL…" value="${esc(providerSearch)}" />
          <button class="sm nowrap" id="testAllBtn">Test configured</button>
        </div>
        <div class="filters" style="margin-top:12px">
          ${chip("all", "TOTAL")}${chip("configured", "CONFIGURED")}${chip("enabled", "ENABLED")}
          ${chip("capped", "CAPPED")}${chip("degraded", "DEGRADED")}${chip("local", "LOCAL")}
        </div>
        <div id="pgroups"></div>
      </div>
    </section>`;

  const search = el.querySelector("#pSearch");
  search.addEventListener("input", () => { providerSearch = search.value; renderProviderGroups(s); });
  el.querySelectorAll("[data-filter]").forEach((c) =>
    c.addEventListener("click", () => { providerFilter = c.dataset.filter; PAGES.providers(el, s); }));
  el.querySelector("#testAllBtn").addEventListener("click", () => testAll(s));

  loadCredLocation().then((loc) => {
    const bar = el.querySelector("#credBar");
    if (!bar) return;
    if (!loc) { bar.style.display = "none"; return; }
    bar.className = `credbar${loc.protected ? "" : " warn"}`;
    bar.innerHTML = `<span class="k">KEYS ARE WRITTEN TO</span><span class="path">${esc(loc.file)}</span>`
      + `<span class="tag badge ${loc.protected ? "on" : "warn"}">${loc.protected ? "protected file" : loc.insideProject ? "inside the project tree" : "custom location"}</span>`;
    // Cards render before this resolves; fill in their footnote too.
    el.querySelectorAll("[data-key-where]").forEach((n) => {
      n.innerHTML = `WRITTEN TO <b>${esc(loc.file)}</b>`
        + (loc.protected ? "" : ' &#183; <span style="color:#fdcb6e">NOT THE PROTECTED FILE</span>');
    });
  });

  paintCensus(s, counts);
  paintPositioning(s);
  renderProviderGroups(s);
  wireFocusLink(el);
  restoreFocus();

  if (!el.dataset.obsWired) {
    el.dataset.obsWired = "1";
    const host = document.getElementById("posHost");
    if (host && typeof ResizeObserver !== "undefined") {
      let last = 0, t = null;
      new ResizeObserver(() => {
        const w = Math.round(host.clientWidth);
        if (!w || Math.abs(w - last) < 4) return;
        last = w;
        clearTimeout(t);
        t = setTimeout(() => { if (current === "providers" && state) paintPositioning(state); }, 120);
      }).observe(host);
    }
  }
};

function paintCensus(s, counts) {
  const host = document.getElementById("pCensus");
  if (!host) return;
  const serving = s.providers.filter((p) => p.hasKey && p.enabled);
  const carrying = s.providers.filter((p) => p.lifetimeStats.requests > 0)
    .sort((a, b) => b.lifetimeStats.requests - a.lifetimeStats.requests);
  const spend = s.providers.reduce((a, p) => a + p.monthlySpendUsd, 0);
  const cap = s.providers.reduce((a, p) => a + (p.budgetCapUsd || 0), 0);
  const capPct = cap ? Math.min(100, (spend / cap) * 100) : null;
  const degradedNames = s.providers.filter((p) => p.circuit === "OPEN" || p.connectionsCoolingDown > 0).map((p) => p.id);

  const ticks = s.providers.map((p) => {
    const st = laneState(p);
    const cls = st === "open" ? "open" : st === "cold" || st === "half" ? "cold" : st === "live" || st === "idle" ? "on" : "";
    return `<i class="${cls}" title="${esc(p.name)} · ${esc(LANE_LABEL[st])}"></i>`;
  }).join("");

  const keyNodes = s.providers.map((p) =>
    `<i class="${p.hasKey ? "v" : p.requiresKey === false ? "z" : ""}" title="${esc(p.name)}"></i>`).join("");

  const busiest = carrying[0]?.lifetimeStats.requests || 1;
  const topBars = carrying.length ? carrying.slice(0, 3).map((p) =>
    `<div class="pb" data-prov="${esc(p.id)}" title="${esc(p.name)} · ${esc(p.lifetimeStats.requests)} requests">
      <div class="pbt"><i style="width:${((p.lifetimeStats.requests / busiest) * 100).toFixed(1)}%"></i></div>
      <div class="pbl">${esc(trunc(p.id, 9))}</div></div>`).join("")
    : '<div class="pbl" style="text-align:left">nothing has served yet</div>';

  host.innerHTML = `
    <div class="icell">
      <div class="ik">OPEN LANES</div>
      <div class="iv ${counts.degraded ? "warn" : ""}">${esc(serving.length)}<span class="u"> / ${esc(counts.all)}</span></div>
      <div class="lanestrip">${ticks}</div>
      <div class="is">CREDENTIALLED <em>AND</em> SWITCHED ON</div>
    </div>

    <div class="icell">
      <div class="ik">CREDENTIALLED</div>
      <div class="iv">${esc(counts.configured)}<span class="u"> / ${esc(counts.all)}</span></div>
      <div class="nodegrid">${keyNodes}</div>
      <div class="is"><em>${esc(counts.all - counts.configured)}</em> WITHOUT A KEY &#183; ${esc(counts.local)} NEED NONE</div>
    </div>

    <div class="icell">
      <div class="ik">CARRYING TRAFFIC</div>
      <div class="iv ${carrying.length ? "ok" : ""}">${esc(carrying.length)}</div>
      <div class="poolbars">${topBars}</div>
      <div class="is">${carrying.length ? `<em>${esc(carrying[0].id)}</em> HAS TAKEN ${esc(Math.round((carrying[0].lifetimeStats.requests / s.totals.totalRequests) * 100) || 0)}% OF EVERYTHING` : "NO LANE HAS SERVED YET"}</div>
    </div>

    <div class="icell">
      <div class="ik">DEGRADED</div>
      <div class="iv ${counts.degraded ? "bad" : ""}">${esc(counts.degraded)}</div>
      <div class="segbar">${Array.from({ length: counts.all }, (_, i) =>
        `<i class="${i < counts.degraded ? "b" : "f"}"></i>`).join("")}</div>
      <div class="is">${degradedNames.length ? `<em style="color:#f87171">${esc(degradedNames.join(" · "))}</em>` : "NO BREAKER OPEN, NO KEY COOLING"}</div>
    </div>

    <div class="icell">
      <div class="ik">UNDER A CAP</div>
      <div class="iv">${esc(counts.capped)}<span class="u"> / ${esc(counts.all)}</span></div>
      ${arcGauge(capPct === null ? 0 : capPct, capPct === null ? SCOPE.dim : capPct >= 80 ? SCOPE.conn : SCOPE.ok)}
      <div class="is">${capPct === null
        ? "NO CAP SET · <em>nothing limits a runaway lane</em>"
        : `<em>${esc(fmtUsd(spend))}</em> OF ${esc(fmtUsd(cap))} THIS MONTH`}</div>
    </div>

    <div class="icell">
      <div class="ik">LOCAL RUNTIMES</div>
      <div class="iv">${esc(counts.local)}</div>
      <div class="lanestrip">${s.providers.filter((p) => !p.requiresKey).map((p) =>
        `<i class="${p.enabled ? "on" : ""}" title="${esc(p.name)}"></i>`).join("") || '<i></i>'}</div>
      <div class="is">NO KEY, NO EGRESS, NO BILL &#183; PRIORITY <em>50+</em> SO THEY NEVER PREEMPT A PAID LANE</div>
    </div>`;
}

// Price against speed, which is the question a lane console exists to answer
// and the one thing a grid of cards structurally cannot show. Bubble area is
// lifetime traffic, colour is lane state. Lanes with no latency sample are
// NOT given an invented position — they sit in a labelled band of their own.
function paintPositioning(s) {
  const host = document.getElementById("posHost");
  const meta = document.getElementById("posMeta");
  const legend = document.getElementById("posLegend");
  if (!host) return;

  const priceOf = (p) => Number(p.costPer1mTokens?.input) || 0;
  const priced = s.providers.filter((p) => p.requiresKey !== false && priceOf(p) > 0 && p.lifetimeStats.avgLatencyMs > 0);
  const unplaced = s.providers.filter((p) => !priced.includes(p));

  if (legend) {
    legend.innerHTML = `<span><i style="background:${SCOPE.ok}"></i>SERVING</span>
      <span><i style="background:${SCOPE.conn}"></i>COOLING</span>
      <span><i style="background:${SCOPE.bad}"></i>BREAKER OPEN</span>
      <span><i style="background:${SCOPE.dim}"></i>IDLE / OFF</span>
      <span class="pos-hint">BUBBLE AREA IS LIFETIME TRAFFIC &#183; HOVER TO TRACE THE LANE INTO THE GRID BELOW</span>`;
  }

  if (priced.length < 2) {
    host.innerHTML = `<div class="empty-note">
      <b>Not enough measured lanes to plot yet.</b>
      This chart puts input price against measured latency, so the cheap-and-fast corner is
      bottom-left and an expensive slow lane has nowhere to hide. A lane appears once it has a
      published price and has answered at least once.</div>`
      + unplacedStrip(unplaced);
    if (meta) meta.textContent = `${priced.length} OF ${s.providers.length} PLOTTABLE`;
    return;
  }

  const W = Math.max(360, host.clientWidth || 700), H = 322;
  const pad = { l: 62, r: 26, t: 22, b: 44 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

  const prices = priced.map(priceOf), lats = priced.map((p) => p.lifetimeStats.avgLatencyMs);
  const pLo = Math.min(...prices) * 0.7, pHi = Math.max(...prices) * 1.35;
  const lLo = Math.min(...lats) * 0.7, lHi = Math.max(...lats) * 1.35;
  const lx = (v) => pad.l + ((Math.log10(Math.max(pLo, v)) - Math.log10(pLo)) / Math.max(0.0001, Math.log10(pHi) - Math.log10(pLo))) * iw;
  const ly = (v) => pad.t + ih - ((Math.log10(Math.max(lLo, v)) - Math.log10(lLo)) / Math.max(0.0001, Math.log10(lHi) - Math.log10(lLo))) * ih;

  const med = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  const mp = med(prices), ml = med(lats);
  const maxReq = Math.max(...priced.map((p) => p.lifetimeStats.requests), 1);

  let g = `<rect x="${pad.l}" y="${ly(ml).toFixed(1)}" width="${lx(mp) - pad.l}" height="${(pad.t + ih - ly(ml)).toFixed(1)}"
      fill="${SCOPE.ok}" fill-opacity=".045"/>
    <line x1="${pad.l}" y1="${pad.t + ih}" x2="${W - pad.r}" y2="${pad.t + ih}" stroke="rgba(255,255,255,.09)"/>
    <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + ih}" stroke="rgba(255,255,255,.09)"/>
    <line x1="${lx(mp).toFixed(1)}" y1="${pad.t}" x2="${lx(mp).toFixed(1)}" y2="${pad.t + ih}" stroke="rgba(255,255,255,.07)" stroke-dasharray="3 4"/>
    <line x1="${pad.l}" y1="${ly(ml).toFixed(1)}" x2="${W - pad.r}" y2="${ly(ml).toFixed(1)}" stroke="rgba(255,255,255,.07)" stroke-dasharray="3 4"/>
    <text x="${pad.l + 7}" y="${pad.t + ih - 8}" font-family=${MONO} font-size="9" letter-spacing="1.2" fill="#7ee787" opacity=".8">CHEAP &amp; FAST</text>
    <text x="${(W - pad.r - 6).toFixed(0)}" y="${pad.t + 12}" text-anchor="end" font-family=${MONO} font-size="9" letter-spacing="1.2" fill="#737b8a">DEAR &amp; SLOW</text>
    <text x="${pad.l - 10}" y="${pad.t + 10}" text-anchor="end" font-family=${MONO} font-size="10" fill="#868d99">${esc(fmtMs(lHi))}</text>
    <text x="${pad.l - 10}" y="${pad.t + ih}" text-anchor="end" font-family=${MONO} font-size="10" fill="#868d99">${esc(fmtMs(lLo))}</text>
    <text x="${pad.l - 10}" y="${(pad.t + ih / 2).toFixed(0)}" text-anchor="end" font-family=${MONO} font-size="9" letter-spacing="1.1" fill="#737b8a">LATENCY</text>
    <text x="${pad.l}" y="${H - 22}" font-family=${MONO} font-size="10" fill="#868d99">$${esc(pLo.toFixed(2))}</text>
    <text x="${W - pad.r}" y="${H - 22}" text-anchor="end" font-family=${MONO} font-size="10" fill="#868d99">$${esc(pHi.toFixed(2))}</text>
    <text x="${(pad.l + iw / 2).toFixed(0)}" y="${H - 8}" text-anchor="middle" font-family=${MONO} font-size="9" letter-spacing="1.6" fill="#737b8a">INPUT PRICE PER 1M TOKENS &#183; LOG SCALE</text>`;

  // Lanes cluster: several providers charge the same headline price, so their
  // bubbles land on one vertical. Labels are pushed to whichever side has
  // room and then de-collided down the column, with a leader line back to the
  // bubble when a label has been moved off its own centre.
  const placed = [];
  const dots = priced.map((p) => {
    const x = lx(priceOf(p)), y = ly(p.lifetimeStats.avgLatencyMs);
    const r = 5 + Math.sqrt(p.lifetimeStats.requests / maxReq) * 15;
    return { p, x, y, r, right: x < pad.l + iw * 0.62 };
  }).sort((a, b) => a.y - b.y);

  dots.forEach((d) => {
    const side = d.right ? "r" : "l";
    const prev = placed.filter((q) => q.side === side).pop();
    d.ly = prev && d.y - prev.ly < 15 ? prev.ly + 15 : d.y;
    d.lx = d.right ? d.x + d.r + 8 : d.x - d.r - 8;
    placed.push({ side, ly: d.ly });
  });

  dots.sort((a, b) => b.p.lifetimeStats.requests - a.p.lifetimeStats.requests).forEach((d) => {
    const st = laneState(d.p);
    const ink = LANE_INK[st];
    const moved = Math.abs(d.ly - d.y) > 2;
    g += `<g class="posdot" data-prov="${esc(d.p.id)}" data-goto-card="${esc(d.p.id)}">
      ${moved ? `<path d="M ${(d.right ? d.x + d.r : d.x - d.r).toFixed(1)},${d.y.toFixed(1)} L ${(d.lx - (d.right ? 3 : -3)).toFixed(1)},${d.ly.toFixed(1)}"
        stroke="${ink}" stroke-opacity=".3" fill="none"/>` : ""}
      <circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${d.r.toFixed(1)}" fill="${ink}" fill-opacity=".16" stroke="${ink}" stroke-opacity=".55"/>
      <circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="2.4" fill="${ink}"/>
      <text x="${d.lx.toFixed(1)}" y="${(d.ly + 4).toFixed(1)}" ${d.right ? "" : 'text-anchor="end"'}
        font-family=${MONO} font-size="11.5" fill="#c9d1d9">${esc(trunc(d.p.id, 12))}</text>
      <title>${esc(d.p.name)} · $${esc(priceOf(d.p))}/1M in · ${esc(fmtMs(d.p.lifetimeStats.avgLatencyMs))} avg · ${esc(d.p.lifetimeStats.requests)} req</title>
    </g>`;
  });

  host.innerHTML = `<svg id="lanepos" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
    aria-label="Input price against measured latency for ${priced.length} lanes; bubble area is lifetime traffic.">${g}</svg>`
    + unplacedStrip(unplaced);
  if (meta) meta.textContent = `${priced.length} PLOTTED · ${unplaced.length} NOT YET MEASURABLE`;

  host.querySelectorAll("[data-goto-card]").forEach((n) => n.addEventListener("click", () => {
    const id = n.getAttribute("data-goto-card");
    openCards.add(id);
    renderProviderGroups(state);
    document.querySelector(`.pcard[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }));
}

// The lanes the chart cannot honestly place, named rather than dropped.
function unplacedStrip(unplaced) {
  if (!unplaced.length) return "";
  const groups = [
    ["NO LATENCY SAMPLE", unplaced.filter((p) => p.requiresKey !== false && p.lifetimeStats.avgLatencyMs === 0)],
    ["NO PUBLISHED PRICE", unplaced.filter((p) => p.requiresKey !== false && p.lifetimeStats.avgLatencyMs > 0 && !(Number(p.costPer1mTokens?.input) > 0))],
    ["LOCAL &#183; FREE", unplaced.filter((p) => p.requiresKey === false)]
  ].filter(([, list]) => list.length);
  return `<div class="pos-unplaced">${groups.map(([label, list]) =>
    `<div class="pu-row"><span class="pu-k">${label}</span><span class="pu-v">${list.map((p) =>
      `<b data-prov="${esc(p.id)}">${esc(p.id)}</b>`).join("")}</span></div>`).join("")}</div>`;
}

function matchesFilter(p) {
  switch (providerFilter) {
    case "configured": return p.hasKey;
    case "enabled": return p.enabled;
    case "capped": return p.budgetCapUsd !== null;
    case "degraded": return p.circuit === "OPEN" || p.connectionsCoolingDown > 0;
    case "local": return !p.requiresKey;
    default: return true;
  }
}

function matchesSearch(p) {
  const q = providerSearch.trim().toLowerCase();
  if (!q) return true;
  return (
    p.id.toLowerCase().includes(q) ||
    p.name.toLowerCase().includes(q) ||
    String(p.baseURL || "").toLowerCase().includes(q) ||
    p.models.some((m) => m.toLowerCase().includes(q))
  );
}

function renderProviderGroups(s) {
  const host = document.getElementById("pgroups");
  if (!host) return;
  const visible = s.providers.filter((p) => matchesFilter(p) && matchesSearch(p));

  if (!visible.length) {
    host.innerHTML = `<div class="empty-note" style="margin-top:24px">
      <b>No lane matches that filter.</b>
      ${esc(s.providers.length)} lanes are configured in total.
      Clear the search box or pick <em>TOTAL</em> above to see all of them.</div>`;
    return;
  }

  // Busiest first inside each category. A grid that lists a lane carrying
  // 1,842 requests below one that has never served is a grid with no opinion.
  const busiest = Math.max(...s.providers.map((p) => p.lifetimeStats.requests), 1);
  host.innerHTML = CATEGORIES.map((cat) => {
    const inCat = visible.filter((p) => (p.category || "inference") === cat.id)
      .sort((a, b) => b.lifetimeStats.requests - a.lifetimeStats.requests
        || Number(b.hasKey) - Number(a.hasKey) || a.priority - b.priority);
    if (!inCat.length) return "";
    const live = inCat.filter((p) => p.hasKey && p.enabled).length;
    const req = inCat.reduce((n, p) => n + p.lifetimeStats.requests, 0);
    return `<div class="cat-block">
        <div class="cat-head">
          <span class="t">${esc(cat.label)}</span>
          <span class="c">${esc(live)} / ${esc(inCat.length)} OPEN &#183; ${esc(req)} REQ</span>
          <span class="spacer"></span>
        </div>
        <div class="cat-hint">${esc(cat.hint)}</div>
        <div class="pgrid">${inCat.map((p) => providerCard(p, busiest)).join("")}</div>
      </div>`;
  }).join("");

  wireProviderCards(s);
  restoreFocus();
}

function providerCard(p, busiest = 1) {
  const st = laneState(p);
  const pct = p.budgetCapUsd ? Math.min(100, (p.monthlySpendUsd / p.budgetCapUsd) * 100) : 0;
  const conn = !p.requiresKey
    ? "LOCAL RUNTIME"
    : p.connections === 0
      ? "NO CONNECTION"
      : `${p.connections} KEY${p.connections === 1 ? "" : "S"}${p.connectionsCoolingDown ? ` · ${p.connectionsCoolingDown} COOLING` : ""}`;
  const stCls = st === "open" ? "open" : st === "cold" || st === "half" ? "cold" : st === "live" ? "live" : st === "idle" ? "idle" : "off";
  const needsKey = p.requiresKey !== false && !p.hasKey;

  const share = (p.lifetimeStats.requests / Math.max(1, busiest)) * 100;

  return `<div class="pcard st-${esc(st)}${openCards.has(p.id) ? " open" : ""}${p.enabled ? "" : " off"}${p.hasKey ? "" : " nokey"}${p.circuit === "OPEN" ? " breaker" : ""}"
      data-id="${esc(p.id)}" data-prov="${esc(p.id)}" style="--share:${share.toFixed(1)}%">
    <div class="top">
      <div class="pavatar">${esc(p.name.slice(0, 2).toUpperCase())}</div>
      <div style="min-width:0;flex:1">
        <div class="pname"><span class="nmt">${esc(p.name)}</span></div>
        <div class="pmeta">${esc(p.id)} &#183; PRIO ${esc(p.priority)} &#183; ${esc(p.models.length)} MODEL${p.models.length === 1 ? "" : "S"}</div>
        <div class="pstate ${esc(stCls)}${needsKey ? " addkey" : ""}"><span class="dot" style="background:${LANE_INK[st]};box-shadow:0 0 6px ${LANE_INK[st]}"></span>${esc(LANE_LABEL[st])} &#183; ${esc(conn)}${
          needsKey ? '<span class="addcta">+ ADD KEY</span>' : ""}</div>
      </div>
      <div class="switch ${p.enabled ? "on" : ""}" data-action="toggle" data-id="${esc(p.id)}"></div>
    </div>
    <div class="pstats">
      <div><div class="k">REQUESTS</div><div class="v ${p.lifetimeStats.requests ? "" : "zero"}">${esc(p.lifetimeStats.requests)}</div></div>
      <div><div class="k">AVG</div><div class="v ${p.lifetimeStats.avgLatencyMs ? "" : "zero"}">${esc(p.lifetimeStats.avgLatencyMs ? fmtMs(p.lifetimeStats.avgLatencyMs) : "—")}</div></div>
      <div><div class="k">MONTH</div><div class="v ${p.monthlySpendUsd ? "" : "zero"}">${esc(fmtUsd(p.monthlySpendUsd))}</div></div>
    </div>
    ${p.budgetCapUsd ? `<div class="bar" title="${esc(pct.toFixed(0))}% of ${esc(fmtUsd(p.budgetCapUsd))} cap"><i class="${pct >= 100 ? "over" : ""}" style="width:${Number(pct) || 0}%"></i></div>` : ""}
    <div class="pdetail">
      <div class="kv"><span class="k">Base URL</span><span>${esc(p.baseURL)}</span></div>
      <div class="kv"><span class="k">Key env</span><span>${esc(p.apiKeyEnv || "—")}</span></div>
      <div class="kv"><span class="k">Cost /1M in&#183;out</span><span>${esc(p.costPer1mTokens?.input)} &#183; ${esc(p.costPer1mTokens?.output)}</span></div>
      <div class="kv"><span class="k">Pricing</span><span class="${p.pricingVerified ? "" : "warnrow"}">${
        p.pricingVerified === "n/a" ? "free (local)"
        : p.pricingVerified ? "verified " + esc(p.pricingVerified)
        : "UNVERIFIED"
      }</span></div>
      ${p.modelPricing ? Object.entries(p.modelPricing).map(([m, c]) =>
        `<div class="kv mdl"><span class="k">${esc(m)}</span><span>${esc(c.input)} &#183; ${esc(c.output)}</span></div>`).join("") : ""}
      <div class="kv"><span class="k">Cap</span><span>${p.budgetCapUsd === null ? "none" : esc(fmtUsd(p.budgetCapUsd)) + " · " + esc(pct.toFixed(0)) + "% used"}</span></div>
      <div class="kv"><span class="k">Lifetime</span><span>${esc(p.lifetimeStats.requests)} req &#183; ${esc(fmtUsd(p.lifetimeStats.costUsd))} &#183; ${esc(fmtTokens(p.lifetimeStats.tokens))} tok</span></div>
      <div class="kv"><span class="k">Circuit</span><span class="${p.circuit === "CLOSED" ? "" : "warnrow"}">${esc(p.circuit)}</span></div>
      ${p.requiresKey === false ? "" : `
      <div class="pkey">
        <div class="pkey-head">CREDENTIAL <span class="env">${esc(p.apiKeyEnv)}</span></div>
        <div class="pkey-row">
          <input type="password" autocomplete="off" spellcheck="false"
                 placeholder="${p.hasKey ? "paste a new key to replace" : "paste your API key"}"
                 data-action="keyinput" data-id="${esc(p.id)}" />
          <button class="sm primary nowrap" data-action="keysave" data-id="${esc(p.id)}">Save</button>
          ${p.hasKey ? `<button class="sm danger nowrap" data-action="keyclear" data-id="${esc(p.id)}">Clear</button>` : ""}
        </div>
        <div class="pkey-state${p.hasKey ? " ok" : ""}" data-key-state="${esc(p.id)}">${
          p.hasKey
            ? `INSTALLED &#183; ${esc(p.connections)} CONNECTION${p.connections === 1 ? "" : "S"} &#183; TAKES EFFECT IMMEDIATELY`
            : "NOT SET &#183; THIS LANE IS SKIPPED BY THE ROUTER"
        }</div>
        <div class="pkey-where" data-key-where="${esc(p.id)}"></div>
      </div>`}
      <div style="margin-top:12px">
        <label>Monthly cap (USD, blank clears)</label>
        <input type="number" step="0.01" min="0" placeholder="none" value="${esc(p.budgetCapUsd ?? "")}" data-action="budget" data-id="${esc(p.id)}" />
      </div>
      <div class="row" style="margin-top:10px">
        <button class="sm" data-action="test" data-id="${esc(p.id)}" ${p.hasKey ? "" : "disabled"}>Test lane</button>
        <span class="dim mono" style="font-size:9px;letter-spacing:.1em" title="Whether this baseURL has been probed by npm run verify. Separate from the pricing check above.">${p.verified ? "ENDPOINT PROBED" : "ENDPOINT NOT PROBED"}</span>
      </div>
      <div class="ptest" data-test-out="${esc(p.id)}"></div>
    </div>
  </div>`;
}

function wireProviderCards(s) {
  document.querySelectorAll(".pcard").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-action]")) return;
      const id = card.dataset.id;
      if (openCards.has(id)) openCards.delete(id); else openCards.add(id);
      card.classList.toggle("open");
      // Opening a lane that cannot serve for want of a credential puts the
      // cursor where the fix is, rather than making you find the field.
      if (card.classList.contains("open") && card.classList.contains("nokey")) {
        card.querySelector('[data-action="keyinput"]')?.focus();
      }
    });
  });

  document.querySelectorAll('[data-action="toggle"]').forEach((el) =>
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/api/panel/providers/${encodeURIComponent(el.dataset.id)}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled: !el.classList.contains("on") })
      });
      refresh();
    }));

  document.querySelectorAll('[data-action="budget"]').forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("change", async () => {
      try {
        const r = await api(`/api/panel/providers/${encodeURIComponent(el.dataset.id)}/budget`, {
          method: "POST",
          body: JSON.stringify({ capUsd: el.value === "" ? null : Number(el.value) })
        });
        if (r.warning) alert(r.warning);
        refresh();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll('[data-action="test"]').forEach((el) =>
    el.addEventListener("click", (e) => { e.stopPropagation(); testProvider(el.dataset.id); }));

  // A click inside the credential field must not fold the card away, and
  // Enter should save — a password box you have to reach for the mouse to
  // submit is the kind of friction that keeps a lane switched off.
  document.querySelectorAll('[data-action="keyinput"]').forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); saveCredential(el.dataset.id); }
    });
  });
  document.querySelectorAll('[data-action="keysave"]').forEach((el) =>
    el.addEventListener("click", (e) => { e.stopPropagation(); saveCredential(el.dataset.id); }));
  document.querySelectorAll('[data-action="keyclear"]').forEach((el) =>
    el.addEventListener("click", (e) => { e.stopPropagation(); clearProviderCredential(el.dataset.id); }));

  document.querySelectorAll("[data-key-where]").forEach((el) => {
    if (!credLocation) return;
    el.innerHTML = `WRITTEN TO <b>${esc(credLocation.file)}</b>`
      + (credLocation.protected ? "" : ' &#183; <span style="color:#fdcb6e">NOT THE PROTECTED FILE</span>');
  });
}

// Where a credential typed into the panel lands. Fetched once and stated on
// screen: an operator is entitled to know where their secret goes before they
// paste it, not after.
let credLocation = null;
async function loadCredLocation() {
  if (credLocation) return credLocation;
  try { credLocation = await api("/api/panel/credential-location"); } catch { credLocation = null; }
  return credLocation;
}

function keyState(id, text, cls = "") {
  const el = document.querySelector(`[data-key-state="${CSS.escape(id)}"]`);
  if (el) { el.className = `pkey-state ${cls}`; el.textContent = text; }
}

async function saveCredential(id) {
  const input = document.querySelector(`[data-action="keyinput"][data-id="${CSS.escape(id)}"]`);
  if (!input) return;
  const key = input.value;
  if (!key.trim()) { keyState(id, "Paste a key first.", "err"); return; }
  keyState(id, "SAVING…", "busy");
  try {
    const r = await api(`/api/panel/providers/${encodeURIComponent(id)}/key`, {
      method: "POST", body: JSON.stringify({ key })
    });
    // Clear the field the moment it is no longer needed — the value stays in
    // the DOM otherwise, and this panel is a credential boundary.
    input.value = "";
    openCards.add(id);
    keyState(id, `SAVED · ${r.connections} CONNECTION(S) · LANE IS LIVE`, "ok");
    await refresh();
  } catch (err) {
    input.value = "";
    keyState(id, err.message, "err");
  }
}

async function clearProviderCredential(id) {
  if (!confirm(`Remove the stored credential for "${id}"? The lane stops serving immediately.`)) return;
  keyState(id, "CLEARING…", "busy");
  try {
    await api(`/api/panel/providers/${encodeURIComponent(id)}/key`, {
      method: "POST", body: JSON.stringify({ key: null })
    });
    openCards.add(id);
    await refresh();
  } catch (err) {
    keyState(id, err.message, "err");
  }
}

async function testProvider(id) {
  const out = document.querySelector(`[data-test-out="${CSS.escape(id)}"]`);
  if (out) { out.textContent = "testing…"; out.className = "ptest muted"; }
  try {
    const r = await api(`/api/panel/providers/${encodeURIComponent(id)}/test`, {
      method: "POST", body: JSON.stringify({})
    });
    if (out) {
      out.className = "ptest";
      out.textContent = "";
      const head = document.createElement("span");
      head.style.color = "var(--live)";
      head.textContent = `ok · ${r.latencyMs}ms · ${r.usage?.total_tokens ?? "?"} tok${r.usageSource === "estimated" ? " (est)" : ""}\n`;
      const body = document.createElement("span");
      body.className = "muted";
      body.textContent = r.content;
      out.append(head, body);
    }
  } catch (err) {
    if (out) { out.className = "ptest"; out.style.color = "var(--warn)"; out.textContent = err.message; }
  }
}

async function testAll(s) {
  const targets = s.providers.filter((p) => p.hasKey && p.enabled);
  for (const p of targets) {
    if (!openCards.has(p.id)) { openCards.add(p.id); }
  }
  renderProviderGroups(s);
  for (const p of targets) await testProvider(p.id);
}

// =========================================================================
// ROUTING — the walk, why it is that walk, and what a different policy
// would have done instead. Every order on this page comes from the engine's
// own preview endpoint, not from a comparator reimplemented in the browser:
// a routing page that disagrees with the router is worse than no page.
// =========================================================================

// Why a hop is passed over, in the order the router checks. Shared by the
// walk and the funnel so the two can never disagree about a lane.
const WALK_GATES = [
  { id: "nokey", label: "no credential", test: (c, p) => !c.hasKey },
  { id: "off", label: "switched off", test: (c, p) => !c.enabled },
  { id: "open", label: "breaker open", test: (c, p) => p?.circuit === "OPEN" },
  { id: "cap", label: "at monthly cap", test: (c, p) => p && p.budgetCapUsd !== null && p.monthlySpendUsd >= p.budgetCapUsd },
  { id: "cool", label: "every key cooling", test: (c, p) => p?.connectionsCoolingDown > 0 && p.connectionsCoolingDown >= p.connections }
];
const GATE_INK = { nokey: SCOPE.faint, off: SCOPE.dim, open: SCOPE.bad, cap: SCOPE.conn, cool: SCOPE.conn };

function walkRows(s) {
  const byId = new Map(s.providers.map((p) => [p.id, p]));
  const chain = routingChain || [];
  let first = -1;
  const rows = chain.map((c, i) => {
    const p = byId.get(c.provider);
    const gate = WALK_GATES.find((g) => g.test(c, p)) || null;
    if (!gate && first < 0) first = i;
    return { c, p, gate, i };
  });
  return { rows, first };
}

PAGES.routing = (el, s) => {
  el.innerHTML = `
    <section class="zone route">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">The walk</span>
          <span class="p-s" id="walkMeta"></span>
        </div>
        <div class="walk-intro" id="walkIntro"></div>
        <div class="walk" id="walkHost"></div>
      </div>
      <aside class="pane funnel-pane">
        <div class="p-head"><span class="p-t">Why this walk</span><span class="p-s" id="funMeta"></span></div>
        <div id="funHost"></div>
      </aside>
    </section>

    <section class="zone compare">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">Strategy comparison</span>
          <span class="p-s" id="cmpMeta"></span>
        </div>
        <div id="cmpHost"><div class="empty-note">Asking the engine what each strategy would do&hellip;</div></div>
      </div>
      <div class="pane">
        <div class="p-head"><span class="p-t">Trial run</span><span class="p-s" id="trialMeta"></span></div>
        <div class="trial-pre" id="trialPre"></div>
        <div class="two" style="margin:14px 0 12px">
          <div><label>Model</label><input id="testModel" value="${esc(trialInputs.model)}" /></div>
          <div><label>Message</label><input id="testMessage" value="${esc(trialInputs.message)}" /></div>
        </div>
        <button class="primary" id="testBtn">Send one real request</button>
        <div class="out" id="testOutput" style="margin-top:13px"></div>
      </div>
    </section>`;

  el.querySelector("#testBtn").addEventListener("click", runTrial);
  el.querySelector("#testModel").addEventListener("input", (e) => { trialInputs.model = e.target.value; });
  el.querySelector("#testMessage").addEventListener("input", (e) => { trialInputs.message = e.target.value; });
  paintTrial();
  loadChain(s);
  loadStrategyOrders(s);
  paintWalk(s);
  paintFunnel(s);
  paintStrategies(s);
  wireFocusLink(el);
  restoreFocus();
};

function paintWalk(s) {
  const host = document.getElementById("walkHost");
  const meta = document.getElementById("walkMeta");
  const intro = document.getElementById("walkIntro");
  const pre = document.getElementById("trialPre");
  if (!host) return;

  const combo = s.routing?.defaultCombo;
  if (intro) {
    intro.innerHTML = `The order the engine resolves for <em>auto</em> right now, under
      <b>${combo ? "combo/" + esc(combo) : "priority order"}</b>. A request walks it top to bottom and stops at the
      first lane that answers, so everything below the serving hop is reached only when something above it fails.`;
  }

  if (routingChain === null) {
    host.innerHTML = '<div class="empty-note"><b>The engine could not be asked for its order.</b>The preview endpoint did not answer. Lane states on the Providers page are still live.</div>';
    if (meta) meta.textContent = "";
    return;
  }
  const { rows, first } = walkRows(s);
  if (!rows.length) {
    host.innerHTML = `<div class="empty-note"><b>No candidate at all.</b>
      Nothing is credentialled and switched on, so the engine produces an empty order.
      Connect one lane and the walk appears here, gate by gate.</div>`;
    if (meta) meta.textContent = "0 HOPS";
    return;
  }
  if (meta) {
    meta.textContent = first < 0
      ? `${rows.length} HOPS · NONE CAN SERVE`
      : `${rows.length} HOPS · HOP ${String(first + 1).padStart(2, "0")} SERVES`;
  }

  // The trial panel says what pressing the button will actually do, before
  // you press it: this sends a real request and bills a real lane.
  if (pre) {
    const t = first >= 0 ? rows[first] : null;
    pre.innerHTML = t
      ? `<span class="tp-k">AS THINGS STAND</span> <em>auto</em> resolves to
         <b data-prov="${esc(t.c.provider)}">${esc(t.c.provider)}</b> &#183; <span class="tp-m">${esc(trunc(t.c.model, 28))}</span>.
         Sending costs real money on that lane.`
      : `<span class="tp-k">AS THINGS STAND</span> <em>auto</em> resolves to nothing. A trial would fail at every hop.`;
  }

  host.innerHTML = rows.map(({ c, p, gate, i }) => {
    const serves = i === first;
    const after = first >= 0 && i > first;
    const tag = c.freeTier ? '<span class="cr-tag free">FREE</span>'
      : c.billing === "subscription" ? '<span class="cr-tag sub">SUB</span>'
      : `<span class="cr-tag">T${esc(c.tier)}</span>`;
    return `<div class="walk-row${gate ? " skipped" : ""}${serves ? " serves" : ""}${after ? " after" : ""}${gate?.id === "nokey" ? " fixable" : ""}"
        data-provider-id="${esc(c.provider)}" data-prov="${esc(c.provider)}"
        ${gate?.id === "nokey" ? 'title="No credential · click to add one"' : ""}>
      <div class="wk-n">${String(i + 1).padStart(2, "0")}</div>
      <div class="wk-id">
        <div class="wk-nm">${esc(c.provider)}</div>
        <div class="wk-md">${esc(trunc(c.model, 34))}</div>
      </div>
      <div class="wk-num">${esc(p ? p.lifetimeStats.requests : 0)}<span>REQ</span></div>
      <div class="wk-num">${esc(p && p.lifetimeStats.avgLatencyMs ? fmtMs(p.lifetimeStats.avgLatencyMs) : "—")}<span>AVG</span></div>
      ${tag}
      <div class="wk-verdict${gate ? " out" : serves ? " serves" : " standby"}"
           ${gate ? `style="color:${GATE_INK[gate.id]}"` : ""}>${
        gate ? esc(gate.label.toUpperCase())
        : serves ? "SERVES THIS REQUEST"
        : `IF ${String(first + 1).padStart(2, "0")}&ndash;${String(i).padStart(2, "0")} FAIL`
      }</div>
    </div>`;
  }).join("");

  host.querySelectorAll(".walk-row.fixable").forEach((n) => n.addEventListener("click", () => {
    const id = n.dataset.providerId;
    openCards.add(id);
    providerFilter = "all";
    providerSearch = id;
    navigate("providers");
    document.querySelector(`.pcard[data-id="${CSS.escape(id)}"] [data-action="keyinput"]`)?.focus();
  }));
}

// A funnel, not a pie: the candidate pool entering each gate and what that
// gate removed. It is the only shape that shows both the survivors and the
// cost of each rule in a single reading.
function paintFunnel(s) {
  const host = document.getElementById("funHost");
  const meta = document.getElementById("funMeta");
  if (!host) return;
  if (routingChain === null || !routingChain.length) { host.innerHTML = ""; if (meta) meta.textContent = ""; return; }

  const byId = new Map(s.providers.map((p) => [p.id, p]));
  const total = routingChain.length;
  let alive = routingChain.map((c) => ({ c, p: byId.get(c.provider) }));
  const steps = [{ label: "CANDIDATES", n: total, cut: 0, ink: SCOPE.provider }];
  for (const g of WALK_GATES) {
    const before = alive.length;
    alive = alive.filter(({ c, p }) => !g.test(c, p));
    steps.push({ label: g.label.toUpperCase(), n: alive.length, cut: before - alive.length, ink: GATE_INK[g.id] });
  }
  const eligible = alive.length;
  if (meta) meta.textContent = `${eligible} OF ${total} ELIGIBLE`;

  const { rows, first } = walkRows(s);
  const target = first >= 0 ? rows[first] : null;

  host.innerHTML = `
    <div class="fun-target">
      <div class="eng-k">RESOLVES TO</div>
      ${target
        ? `<div class="fun-v" data-prov="${esc(target.c.provider)}">${esc(target.c.provider)}</div>
           <div class="fun-sub">${esc(trunc(target.c.model, 30))}</div>`
        : `<div class="fun-v bad">nothing</div>
           <div class="fun-sub">every hop is rejected by a gate below</div>`}
    </div>
    <div class="fun-bars">${steps.map((st, i) => `
      <div class="fun-row${st.cut || !i ? "" : " nil"}">
        <div class="fun-k">${i ? "&minus; " : ""}${esc(st.label)}</div>
        <div class="fun-t"><i style="width:${((st.n / total) * 100).toFixed(1)}%;background:${st.ink}"></i></div>
        <div class="fun-c">${i ? (st.cut ? `&minus;${esc(st.cut)}` : "&#183;") : esc(st.n)}</div>
      </div>`).join("")}
    </div>
    <div class="fun-foot"><b>${esc(eligible)}</b> lane${eligible === 1 ? "" : "s"} will actually be tried, in the order on the left.
      ${total - eligible ? `The other ${esc(total - eligible)} sit in the chain but cannot serve as things stand.` : "Nothing is being filtered out."}</div>`;
}

// Every strategy's real order, asked of the engine one route at a time.
let stratSig = "";
let stratOrders = null;
let stratLoading = false;
async function loadStrategyOrders(s) {
  const sig = s.providers.map((p) => `${p.id}:${p.hasKey ? 1 : 0}${p.enabled ? 1 : 0}:${p.circuit}`).join("|");
  if (sig === stratSig && stratOrders) return;
  if (stratLoading) return;
  stratLoading = true;
  stratSig = sig;
  try {
    const meta = await api("/api/panel/strategies");
    const list = meta.strategies || [];
    stratOrders = await Promise.all(list.map(async (st) => {
      try {
        const r = await api("/api/panel/routing/preview", { method: "POST", body: JSON.stringify({ model: st.route }) });
        return { ...st, order: (r.chain || []).map((c) => c.provider) };
      } catch {
        return { ...st, order: null };
      }
    }));
  } catch {
    stratOrders = null;
  } finally {
    stratLoading = false;
  }
  if (current === "routing" && state) paintStrategies(state);
}

// Strategies that re-order themselves per call. Their row is one sample, and
// says so — presenting a rotation as a fixed answer would be a lie.
const VOLATILE_STRATEGIES = new Set(["roundrobin", "randomized", "sticky"]);
const CMP_RANKS = 5;

function paintStrategies(s) {
  const host = document.getElementById("cmpHost");
  const meta = document.getElementById("cmpMeta");
  if (!host) return;
  if (stratOrders === null) {
    host.innerHTML = '<div class="empty-note"><b>Strategy list unavailable.</b>The engine did not answer, so this comparison is blank rather than filled with a guess.</div>';
    if (meta) meta.textContent = "";
    return;
  }
  const usable = stratOrders.filter((st) => st.order && st.order.length);
  if (!usable.length) {
    host.innerHTML = `<div class="empty-note"><b>No strategy can produce an order.</b>
      Every candidate is missing a credential or switched off, so all ${esc(stratOrders.length)} strategies resolve to
      the same empty chain. Connect one lane and the differences between them appear here.</div>`;
    if (meta) meta.textContent = "";
    return;
  }

  // The point of the grid is the disagreement, so the disagreement is counted.
  const firsts = [...new Set(usable.map((st) => st.order[0]))];
  const active = s.routing?.defaultCombo ? null : "priority";
  if (meta) meta.textContent = `${usable.length} STRATEGIES · ${firsts.length} DIFFERENT FIRST PICKS`;

  host.innerHTML = `<div class="cmp">
    <div class="cmp-row head">
      <span class="cmp-k">STRATEGY</span>
      ${Array.from({ length: CMP_RANKS }, (_, i) => `<span class="cmp-c">${i + 1}</span>`).join("")}
    </div>
    ${usable.map((st) => {
      const vol = VOLATILE_STRATEGIES.has(st.id);
      return `<div class="cmp-row${st.id === active ? " on" : ""}" title="${esc(st.description || "")}">
        <span class="cmp-k">${esc(st.label)}${vol ? '<em title="re-orders itself on every call · this row is one sample">~</em>'
          : ""}<b>${esc(st.route)}</b></span>
        ${Array.from({ length: CMP_RANKS }, (_, i) => {
          const id = st.order[i];
          if (!id) return '<span class="cmp-c none">&#183;</span>';
          return `<span class="cmp-c${i === 0 ? " first" : ""}" data-prov="${esc(id)}">${esc(trunc(id, 11))}</span>`;
        }).join("")}
      </div>`;
    }).join("")}
  </div>
  <div class="cmp-read">${esc(usable.length)} strategies produce <b>${esc(firsts.length)}</b> different first pick${firsts.length === 1 ? "" : "s"}
    ${firsts.length === 1
      ? `: every policy reaches for <em>${esc(firsts[0])}</em> first, so with this fleet the choice makes no difference to hop one.`
      : `: ${firsts.map((f) => `<em>${esc(f)}</em>`).join(", ")}. Which policy you run decides which lane pays for your traffic.`}</div>`;
}

// A trial ends with refresh(), which repaints the page and would otherwise
// throw away the answer you just paid for. The result and the two inputs are
// held here and re-applied on every paint.
const trialInputs = { model: "auto", message: "Say hello in one short sentence." };
let lastTrial = null;

function paintTrial() {
  const out = document.getElementById("testOutput");
  const meta = document.getElementById("trialMeta");
  if (!out) return;
  if (!lastTrial) {
    out.textContent = "Idle. Nothing has been sent from this panel.";
    if (meta) meta.textContent = "";
    return;
  }
  if (meta) meta.textContent = lastTrial.meta || "";
  out.textContent = "";
  if (lastTrial.error) {
    out.style.color = "var(--warn)";
    out.textContent = `Failed: ${lastTrial.error}`;
    return;
  }
  // Model output is built as text nodes, never markup.
  out.style.color = "";
  const tag = document.createElement("span");
  tag.className = "provider-tag";
  tag.textContent = lastTrial.provider;
  const ans = document.createElement("span");
  ans.className = "answer";
  ans.textContent = lastTrial.answer;
  out.append(tag, document.createTextNode(" passed through:\n"), ans);
}

async function runTrial() {
  const btn = document.getElementById("testBtn");
  const out = document.getElementById("testOutput");
  const meta = document.getElementById("trialMeta");
  trialInputs.model = document.getElementById("testModel").value;
  trialInputs.message = document.getElementById("testMessage").value;
  btn.disabled = true;
  out.style.color = "";
  out.textContent = "Routing…";
  if (meta) meta.textContent = "IN FLIGHT";
  document.querySelectorAll(".walk-row").forEach((n) => n.classList.remove("trying", "okhit", "failed"));

  try {
    const result = await api("/api/panel/test", {
      method: "POST",
      body: JSON.stringify({
        model: document.getElementById("testModel").value,
        message: document.getElementById("testMessage").value
      })
    });
    // The trial walks the same rows the page has been describing, one hop at
    // a time — the animation IS the fallback chain, not a progress bar.
    const attempts = result.attempts || [];
    // A skipped lane was never contacted: no key, capped, breaker open. It did
    // not try and it did not fail, so it neither animates as an attempt nor
    // counts as one. Painting those red said the gateway had burned through 40
    // providers to answer a request it served on the first reachable one.
    const contacted = attempts.filter((a) => !a.skipped);
    for (const attempt of contacted) {
      const node = [...document.querySelectorAll(".walk-row")].find((n) => n.dataset.providerId === attempt.provider);
      if (!node) continue;
      node.scrollIntoView({ block: "nearest" });
      node.classList.add("trying");
      await new Promise((r) => setTimeout(r, 220));
      node.classList.remove("trying");
      node.classList.add(attempt.ok ? "okhit" : "failed");
    }
    const failed = contacted.filter((a) => !a.ok).length;
    const passedOver = attempts.length - contacted.length;
    lastTrial = {
      provider: result.response.provider,
      answer: result.response.choices?.[0]?.message?.content ?? "",
      meta: failed
        ? `${contacted.length} LANE(S) CALLED · ${failed} FELL THROUGH`
        : `ANSWERED ON THE FIRST LANE CALLED${passedOver ? ` · ${passedOver} SKIPPED BEFORE IT` : ""}`
    };
    paintTrial();
  } catch (err) {
    lastTrial = { error: err.message, meta: "FAILED" };
    paintTrial();
  } finally {
    btn.disabled = false;
    refresh();
  }
}

// =========================================================================
// BUDGETS — a cap is a promise about the future, so the page is about the
// future: where the month is heading, and which lane gets there first. The
// burn-down carries the shape, the meters carry the per-lane verdict.
// =========================================================================

const monthKeyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const shiftMonth = (key, n) => {
  const [y, m] = key.split("-").map(Number);
  return monthKeyOf(new Date(y, m - 1 + n, 1));
};
const monthLabel = (key) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString([], { month: "long", year: "numeric" });
};

// Straight-line from the month so far. Crude on purpose — it is a heads-up,
// not a forecast, and every surface that shows it says so.
function monthClock() {
  const now = new Date();
  return {
    day: now.getDate(),
    days: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(),
    key: monthKeyOf(now)
  };
}
const paceTo = (spend, clock) => (clock.day > 0 ? (spend / clock.day) * clock.days : 0);

PAGES.budgets = (el, s) => {
  el.innerHTML = `
    ${s.pricingTrust?.activeUnverified?.length ? `<div class="alerts-band"><div class="alert warn" data-goto="ledger">
      <div class="ai">&#8226;</div>
      <div><div class="at">Caps resting on an unchecked price table</div>
        <div class="ab">${esc(s.pricingTrust.activeUnverified.join(", "))} ${s.pricingTrust.activeUnverified.length === 1 ? "is" : "are"}
          priced from a table nobody has verified, so a cap set there may fire early or never fire at all.
          Run <span class="mono">npm run verify-pricing</span>.</div></div>
      <div class="ax">&#8594;</div></div></div>` : ""}

    <section class="zone burn">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">Month burn-down</span>
          <span class="p-s" id="burnMeta"></span>
        </div>
        <div id="burnHost"></div>
        <div class="burn-legend" id="burnLegend"></div>
      </div>
      <div class="pane instr-pane">
        <div class="p-head"><span class="p-t">Month to date</span><span class="p-s" id="budMeta"></span></div>
        <div class="instr" id="budInstr"></div>
      </div>
    </section>

    <section class="zone caps">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">Caps &amp; usage</span>
          <span class="p-s" id="capMeta"></span>
        </div>
        <div id="capHost"></div>
      </div>
    </section>`;

  el.querySelectorAll("[data-goto]").forEach((n) => n.addEventListener("click", () => navigate(n.dataset.goto)));

  paintBudgetInstruments(s);
  paintBurn(s);
  paintCapMeters(s);
  loadBurn(s);
  wireFocusLink(el);
  restoreFocus();

  if (!el.dataset.obsWired) {
    el.dataset.obsWired = "1";
    const host = document.getElementById("burnHost");
    if (host && typeof ResizeObserver !== "undefined") {
      let last = 0, t = null;
      new ResizeObserver(() => {
        const w = Math.round(host.clientWidth);
        if (!w || Math.abs(w - last) < 4) return;
        last = w;
        clearTimeout(t);
        t = setTimeout(() => { if (current === "budgets" && state) paintBurn(state); }, 120);
      }).observe(host);
    }
  }
};

function paintBudgetInstruments(s) {
  const host = document.getElementById("budInstr");
  const meta = document.getElementById("budMeta");
  if (!host) return;
  const clock = monthClock();
  const capped = s.providers.filter((p) => p.budgetCapUsd !== null);
  const spending = s.providers.filter((p) => p.monthlySpendUsd > 0);
  const monthSpend = s.providers.reduce((a, p) => a + p.monthlySpendUsd, 0);
  const totalCap = capped.reduce((a, p) => a + p.budgetCapUsd, 0);
  const projected = paceTo(monthSpend, clock);
  const capPct = totalCap ? (monthSpend / totalCap) * 100 : null;
  const projPct = totalCap ? (projected / totalCap) * 100 : null;
  // Money that no cap is watching is the number this page exists to surface.
  const uncappedSpend = s.providers.filter((p) => p.budgetCapUsd === null).reduce((a, p) => a + p.monthlySpendUsd, 0);
  const breaching = capped.filter((p) => paceTo(p.monthlySpendUsd, clock) > p.budgetCapUsd);
  if (meta) meta.textContent = `DAY ${clock.day} OF ${clock.days}`;

  const dayTicks = Array.from({ length: clock.days }, (_, i) =>
    `<i class="${i < clock.day ? "on" : ""}"></i>`).join("");

  host.innerHTML = `
    <div class="icell">
      <div class="ik">SPENT THIS MONTH</div>
      <div class="iv">${esc(fmtUsd(monthSpend))}</div>
      ${arcGauge(capPct === null ? 0 : Math.min(100, capPct), capPct === null ? SCOPE.dim : capPct >= 100 ? SCOPE.bad : capPct >= 80 ? SCOPE.conn : SCOPE.ok)}
      <div class="is">${capPct === null
        ? "NO CAP SET · <em>nothing is watching this</em>"
        : `<em>${esc(capPct.toFixed(capPct < 10 ? 1 : 0))}%</em> OF ${esc(fmtUsd(totalCap))} CAPPED TOTAL`}</div>
    </div>

    <div class="icell">
      <div class="ik">ON PACE FOR</div>
      <div class="iv ${projPct === null ? "" : projPct >= 100 ? "bad" : projPct >= 85 ? "warn" : "ok"}">${esc(fmtUsd(projected))}</div>
      <div class="segbar">${Array.from({ length: 20 }, (_, i) => {
        const t = (i + 1) / 20;
        const on = projPct !== null && t <= Math.min(1, projPct / 100);
        return `<i class="${on ? (projPct >= 100 ? "b" : projPct >= 85 ? "m" : "f") : ""}"></i>`;
      }).join("")}</div>
      <div class="is">${projPct === null
        ? "STRAIGHT LINE FROM TODAY'S RATE"
        : projPct >= 100
          ? `<em style="color:#f87171">${esc((projPct - 100).toFixed(0))}% OVER</em> THE CAPPED TOTAL BY MONTH END`
          : `<em>${esc((100 - projPct).toFixed(0))}%</em> UNDER AT THIS RATE`}</div>
    </div>

    <div class="icell">
      <div class="ik">MONTH ELAPSED</div>
      <div class="iv">${esc(clock.day)}<span class="u"> / ${esc(clock.days)}</span></div>
      <div class="daystrip">${dayTicks}</div>
      <div class="is"><em>${esc(clock.days - clock.day)}</em> DAY${clock.days - clock.day === 1 ? "" : "S"} LEFT TO SPEND</div>
    </div>

    <div class="icell">
      <div class="ik">HEADROOM</div>
      <div class="iv ${totalCap ? (monthSpend >= totalCap ? "bad" : "ok") : ""}">${totalCap ? esc(fmtUsd(Math.max(0, totalCap - monthSpend))) : "&mdash;"}</div>
      <div class="bar big"><i class="${monthSpend >= totalCap && totalCap ? "over" : ""}" style="width:${totalCap ? Math.min(100, (monthSpend / totalCap) * 100).toFixed(1) : 0}%"></i></div>
      <div class="is">${totalCap ? "BEFORE THE ROUTER STARTS SKIPPING THEM" : "NOTHING IS CAPPING SPEND"}</div>
    </div>

    <div class="icell">
      <div class="ik">LANES UNDER A CAP</div>
      <div class="iv ${breaching.length ? "warn" : ""}">${esc(capped.length)}<span class="u"> / ${esc(s.providers.length)}</span></div>
      <div class="lanestrip">${s.providers.map((p) => {
        const proj = paceTo(p.monthlySpendUsd, clock);
        const cls = p.budgetCapUsd === null ? "" : p.monthlySpendUsd >= p.budgetCapUsd ? "open" : proj > p.budgetCapUsd ? "cold" : "on";
        return `<i class="${cls}" title="${esc(p.name)}"></i>`;
      }).join("")}</div>
      <div class="is">${breaching.length
        ? `<em style="color:#fdcb6e">${esc(breaching.map((p) => p.id).join(" · "))}</em> ON PACE TO BREACH`
        : capped.length ? "NONE ON PACE TO BREACH" : "NO LANE HAS A CAP"}</div>
    </div>

    <div class="icell">
      <div class="ik">SPENT OUTSIDE ANY CAP</div>
      <div class="iv ${uncappedSpend ? "warn" : ""}">${esc(fmtUsd(uncappedSpend))}</div>
      <div class="poolbars">${(() => {
        const un = s.providers.filter((p) => p.budgetCapUsd === null && p.monthlySpendUsd > 0)
          .sort((a, b) => b.monthlySpendUsd - a.monthlySpendUsd).slice(0, 3);
        if (!un.length) return '<div class="pbl" style="text-align:left">every spending lane is capped</div>';
        const top = un[0].monthlySpendUsd || 1;
        return un.map((p) => `<div class="pb" data-prov="${esc(p.id)}" title="${esc(p.name)} · ${esc(fmtUsd(p.monthlySpendUsd))} uncapped">
          <div class="pbt"><i class="full" style="width:${((p.monthlySpendUsd / top) * 100).toFixed(1)}%"></i></div>
          <div class="pbl">${esc(trunc(p.id, 9))}</div></div>`).join("");
      })()}</div>
      <div class="is">${uncappedSpend
        ? `<em>${esc(monthSpend ? ((uncappedSpend / monthSpend) * 100).toFixed(0) : 0)}%</em> OF THE MONTH HAS NO CEILING`
        : "NOTHING IS SPENDING UNWATCHED"}</div>
    </div>`;
}

// The month's cumulative spend against the pace that would exactly consume
// the capped total, with the projection carried dashed to month end. A cap
// is a claim about where the line ends up, so the line is the subject.
let burnSeries = null;
async function loadBurn(s) {
  try {
    const { series } = await api("/api/panel/series?bucket=day&points=31");
    burnSeries = series;
  } catch {
    burnSeries = null;
  }
  if (current === "budgets" && state) paintBurn(state);
}

function paintBurn(s) {
  const host = document.getElementById("burnHost");
  const meta = document.getElementById("burnMeta");
  const legend = document.getElementById("burnLegend");
  if (!host) return;

  const clock = monthClock();
  const capped = s.providers.filter((p) => p.budgetCapUsd !== null);
  const totalCap = capped.reduce((a, p) => a + p.budgetCapUsd, 0);
  const monthSpend = s.providers.reduce((a, p) => a + p.monthlySpendUsd, 0);
  const projected = paceTo(monthSpend, clock);

  if (legend) {
    legend.innerHTML = `<span><i style="background:${SCOPE.provider}"></i>SPENT, CUMULATIVE</span>
      <span><i class="dash" style="background:${SCOPE.conn}"></i>PROJECTED AT TODAY'S RATE</span>
      ${totalCap ? `<span><i style="background:${SCOPE.bad}"></i>CAPPED TOTAL</span>
      <span><i class="dash" style="background:${SCOPE.dim}"></i>EVEN PACE TO THE CAP</span>` : ""}
      <span class="burn-hint">A STRAIGHT-LINE PROJECTION, NOT A FORECAST</span>`;
  }

  // Days of THIS calendar month only. The series window is the last 31 days,
  // which straddles the month boundary — carrying June into July's burn-down
  // would overstate the month by however far into it we are.
  const days = (burnSeries || []).filter((p) => p.key.startsWith(clock.key));

  // monthSpend is the figure caps are actually enforced against, so it is the
  // one that decides whether there is anything to draw. With no spend AND no
  // cap there is neither a line nor a ceiling for it to run into.
  if (monthSpend <= 0 && !totalCap) {
    host.innerHTML = `<div class="empty-note">
      <b>Nothing spent this month, and no cap to spend against.</b>
      This chart draws the month's cumulative spend against the pace that would exactly consume your
      capped total by the last day, then carries today's rate forward as a dashed projection. When
      the projection crosses the cap line before month end, the router starts skipping lanes.
      Set a cap on the <em>Providers</em> page and the ceiling appears here.</div>`;
    if (meta) meta.textContent = `DAY ${clock.day} OF ${clock.days} · NO SPEND, NO CAP`;
    return;
  }

  const W = Math.max(360, host.clientWidth || 700), H = 300;
  const pad = { l: 66, r: 22, t: 20, b: 40 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

  // Cumulative to date. If the series is unavailable we still draw the two
  // endpoints we know for certain: nothing on day 0, this much today.
  let cum = [];
  if (days.length && monthSpend > 0) {
    let run = 0;
    cum = days.map((d) => {
      run += Number(d.costUsd) || 0;
      return { day: Number(d.key.slice(8, 10)), v: run };
    });
    // The daily log and the monthly aggregate are counted separately, so the
    // series can trail the authoritative total. Scale rather than contradict.
    const last = cum[cum.length - 1]?.v || 0;
    if (last > 0 && monthSpend > 0) {
      const k = monthSpend / last;
      cum = cum.map((c) => ({ ...c, v: c.v * k }));
    }
  } else {
    cum = [{ day: 1, v: 0 }, { day: clock.day, v: monthSpend }];
  }

  const ceiling = Math.max(totalCap, projected, monthSpend, 0.01) * 1.12;
  const dx = (d) => pad.l + ((d - 1) / Math.max(1, clock.days - 1)) * iw;
  const dy = (v) => pad.t + ih - (v / ceiling) * ih;

  let g = "";
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ih / 4) * i;
    g += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.045)"/>`;
  }
  g += `<text x="${pad.l - 10}" y="${pad.t + 5}" text-anchor="end" font-family=${MONO} font-size="10.5" fill="#9aa3b0">${esc(fmtUsd(ceiling))}</text>
    <text x="${pad.l - 10}" y="${pad.t + ih}" text-anchor="end" font-family=${MONO} font-size="10.5" fill="#737b8a">$0</text>`;

  // today
  g += `<line x1="${dx(clock.day).toFixed(1)}" y1="${pad.t - 4}" x2="${dx(clock.day).toFixed(1)}" y2="${pad.t + ih}"
      stroke="rgba(255,255,255,.14)"/>
    <text x="${dx(clock.day).toFixed(1)}" y="${pad.t - 8}" text-anchor="middle" font-family=${MONO} font-size="9" letter-spacing="1.2" fill="#868d99">TODAY</text>`;

  if (totalCap) {
    // even pace + the ceiling it runs into
    g += `<path d="M ${dx(1).toFixed(1)},${dy(0).toFixed(1)} L ${dx(clock.days).toFixed(1)},${dy(totalCap).toFixed(1)}"
        fill="none" stroke="${SCOPE.dim}" stroke-opacity=".5" stroke-width="1" stroke-dasharray="4 5"/>
      <line x1="${pad.l}" y1="${dy(totalCap).toFixed(1)}" x2="${W - pad.r}" y2="${dy(totalCap).toFixed(1)}"
        stroke="${SCOPE.bad}" stroke-opacity=".55" stroke-width="1"/>
      <text x="${W - pad.r}" y="${(dy(totalCap) - 7).toFixed(1)}" text-anchor="end" font-family=${MONO} font-size="10" fill="${SCOPE.bad}">CAP ${esc(fmtUsd(totalCap))}</text>`;
  }

  // projection from today to month end
  const projPath = `M ${dx(clock.day).toFixed(1)},${dy(monthSpend).toFixed(1)} L ${dx(clock.days).toFixed(1)},${dy(projected).toFixed(1)}`;
  const willBreach = totalCap > 0 && projected > totalCap;
  g += `<path d="${projPath}" fill="none" stroke="${willBreach ? SCOPE.bad : SCOPE.conn}" stroke-opacity=".8"
      stroke-width="1.6" stroke-dasharray="5 4"/>
    <circle cx="${dx(clock.days).toFixed(1)}" cy="${dy(projected).toFixed(1)}" r="3.4" fill="${willBreach ? SCOPE.bad : SCOPE.conn}"/>
    <text x="${(dx(clock.days) - 6).toFixed(1)}" y="${(dy(projected) - 10).toFixed(1)}" text-anchor="end"
      font-family=${MONO} font-size="11" fill="${willBreach ? SCOPE.bad : SCOPE.conn}">${esc(fmtUsd(projected))}</text>`;

  // actual, cumulative
  const line = cum.map((c, i) => `${i ? "L" : "M"} ${dx(c.day).toFixed(1)},${dy(c.v).toFixed(1)}`).join(" ");
  const area = `${line} L ${dx(cum[cum.length - 1].day).toFixed(1)},${dy(0).toFixed(1)} L ${dx(cum[0].day).toFixed(1)},${dy(0).toFixed(1)} Z`;
  g += `<path d="${area}" fill="${SCOPE.provider}" fill-opacity=".07"/>
    <path d="${line}" fill="none" stroke="${SCOPE.provider}" stroke-width="1.9" stroke-linejoin="round"/>
    <circle cx="${dx(clock.day).toFixed(1)}" cy="${dy(monthSpend).toFixed(1)}" r="3.6" fill="${SCOPE.provider}"/>
    <text x="${(dx(clock.day) + 8).toFixed(1)}" y="${(dy(monthSpend) - 9).toFixed(1)}"
      font-family=${MONO} font-size="11.5" fill="#c9d1d9">${esc(fmtUsd(monthSpend))}</text>`;

  const every = clock.days > 20 ? 5 : 3;
  for (let d = 1; d <= clock.days; d += every) {
    g += `<text x="${dx(d).toFixed(1)}" y="${H - 20}" text-anchor="middle" font-family=${MONO} font-size="9.5" fill="#868d99">${d}</text>`;
  }
  g += `<text x="${(pad.l + iw / 2).toFixed(0)}" y="${H - 6}" text-anchor="middle" font-family=${MONO} font-size="9" letter-spacing="1.6" fill="#737b8a">DAY OF ${esc(monthLabel(clock.key).toUpperCase())}</text>`;

  host.innerHTML = `<svg id="burndown" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
    aria-label="Cumulative spend for the month against the capped total, with a straight-line projection to month end.">${g}</svg>`;

  if (meta) {
    meta.textContent = !totalCap
      ? `DAY ${clock.day} OF ${clock.days} · NO CAP TO RUN INTO`
      : willBreach
        ? `ON PACE TO PASS THE CAP AROUND DAY ${Math.max(1, Math.ceil((totalCap / Math.max(0.000001, projected)) * clock.days))}`
        : `DAY ${clock.day} OF ${clock.days} · PROJECTED ${(100 - (projected / totalCap) * 100).toFixed(0)}% UNDER`;
  }
}

// One bullet meter per lane: spend as the bar, the cap as the boundary, the
// projected month end as a caret on the same track. Three numbers that only
// mean something next to each other, on one rail.
function paintCapMeters(s) {
  const host = document.getElementById("capHost");
  const meta = document.getElementById("capMeta");
  if (!host) return;
  const clock = monthClock();
  const capped = s.providers.filter((p) => p.budgetCapUsd !== null);
  const uncapped = s.providers.filter((p) => p.budgetCapUsd === null && p.monthlySpendUsd > 0);

  if (!capped.length && !uncapped.length) {
    host.innerHTML = `<div class="empty-note">
      <b>No cap set and nothing spent yet.</b>
      Each capped lane gets a meter here: spend as the bar, the cap as the boundary, and a caret at
      where today's rate lands it by month end. A lane at or over its cap is skipped by the router
      exactly like a tripped breaker. Set caps on the <em>Providers</em> page.</div>`;
    if (meta) meta.textContent = "";
    return;
  }

  const rank = (p) => {
    const proj = paceTo(p.monthlySpendUsd, clock);
    if (p.monthlySpendUsd >= p.budgetCapUsd) return 0;
    if (proj > p.budgetCapUsd) return 1;
    return 2;
  };
  const rows = [...capped].sort((a, b) => rank(a) - rank(b)
    || (b.monthlySpendUsd / b.budgetCapUsd) - (a.monthlySpendUsd / a.budgetCapUsd));
  const breached = capped.filter((p) => p.monthlySpendUsd >= p.budgetCapUsd).length;
  const willBreach = capped.filter((p) => rank(p) === 1).length;
  if (meta) {
    meta.textContent = breached || willBreach
      ? `${breached} AT CAP · ${willBreach} ON PACE TO BREACH`
      : `${capped.length} CAPPED · ALL WITHIN PACE`;
  }

  const meter = (p) => {
    const proj = paceTo(p.monthlySpendUsd, clock);
    const cap = p.budgetCapUsd;
    // The track runs to whichever is larger, so an overshoot is visible as an
    // overshoot rather than a bar that silently stops at 100%.
    const top = Math.max(cap, proj, p.monthlySpendUsd) * 1.06 || 1;
    const state = p.monthlySpendUsd >= cap ? "over" : proj > cap ? "risk" : "ok";
    const label = state === "over" ? "AT CAP · SKIPPED" : state === "risk" ? "ON PACE TO BREACH" : "WITHIN PACE";
    return `<div class="cap-row ${state}" data-prov="${esc(p.id)}">
      <div class="cap-nm">${esc(p.name)}<span>${esc(p.id)}</span></div>
      <div class="cap-track" title="${esc(fmtUsd(p.monthlySpendUsd))} of ${esc(fmtUsd(cap))} · projected ${esc(fmtUsd(proj))}">
        <s class="overzone" style="left:${((cap / top) * 100).toFixed(1)}%"></s>
        <i class="fill" style="width:${((p.monthlySpendUsd / top) * 100).toFixed(1)}%"></i>
        <b class="capline" style="left:${((cap / top) * 100).toFixed(1)}%"><em>CAP</em></b>
        <u class="proj" style="left:${((Math.min(top, proj) / top) * 100).toFixed(1)}%"></u>
      </div>
      <div class="cap-v">${esc(fmtUsd(p.monthlySpendUsd))}<span>OF ${esc(fmtUsd(cap))}</span></div>
      <div class="cap-v">${esc(fmtUsd(proj))}<span>PROJECTED</span></div>
      <div class="cap-st">${label}</div>
    </div>`;
  };

  host.innerHTML = `
    <div class="cap-head">
      <span></span><span>SPEND &#183; CAP &#183; PROJECTION</span>
      <span class="r">MONTH TO DATE</span><span class="r">MONTH END</span><span class="r">VERDICT</span>
    </div>
    ${rows.map(meter).join("")}
    ${uncapped.length ? `<div class="cap-uncapped">
      <div class="cu-h">NO CAP &#183; ${esc(uncapped.length)} LANE${uncapped.length === 1 ? "" : "S"} SPENDING WITH NO CEILING</div>
      ${uncapped.sort((a, b) => b.monthlySpendUsd - a.monthlySpendUsd).map((p) => {
        const top = uncapped[0].monthlySpendUsd || 1;
        return `<div class="cu-row" data-prov="${esc(p.id)}">
          <div class="cap-nm">${esc(p.name)}<span>${esc(p.id)}</span></div>
          <div class="cap-track open"><i class="fill" style="width:${((p.monthlySpendUsd / top) * 100).toFixed(1)}%"></i></div>
          <div class="cap-v">${esc(fmtUsd(p.monthlySpendUsd))}<span>UNCAPPED</span></div>
          <div class="cap-v">${esc(fmtUsd(paceTo(p.monthlySpendUsd, clock)))}<span>PROJECTED</span></div>
          <div class="cap-st">NOTHING STOPS THIS</div>
        </div>`;
      }).join("")}
    </div>` : ""}`;
}

// =========================================================================
// LEDGER — the reconciliation artefact. It is held next to an invoice, so
// it reads as a statement: the total first, the rows under it, and beside
// them how much of that money rests on a price table somebody checked.
// =========================================================================

let ledgerMonth = null;

PAGES.ledger = (el, s) => {
  if (!ledgerMonth) ledgerMonth = monthClock().key;
  el.innerHTML = `
    <section class="zone statement">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">Statement</span>
          <span class="p-s" id="stMeta"></span>
        </div>
        <div class="st-nav">
          <button class="sm" id="monthPrev" title="Previous month">&#8592;</button>
          <div class="st-month" id="stMonth"></div>
          <button class="sm" id="monthNext" title="Next month">&#8594;</button>
          <div class="st-total" id="stTotal"></div>
        </div>
        <div id="ledgerBody"><div class="empty-note">Loading the month&hellip;</div></div>
      </div>
      <aside class="pane trust-pane">
        <div class="p-head"><span class="p-t">Provenance</span><span class="p-s" id="trMeta"></span></div>
        <div id="trustHost"></div>
      </aside>
    </section>

    <section class="zone recon">
      <div class="pane">
        <div class="p-head"><span class="p-t">Reconciliation</span><span class="p-s">TAKE IT TO THE INVOICE</span></div>
        <div class="recon-body">
          <div class="setrow">
            <div><div class="nm">Download this month as CSV</div>
              <div class="hh">One row per lane: month, provider, cost, and whether its price table was verified.
                The same figures you see here, in the shape a finance team will ask for.</div></div>
            <button class="sm" id="csvBtn">Download</button>
          </div>
          <div class="setrow">
            <div><div class="nm">Re-check every price</div>
              <div class="hh">Runs offline: <span class="mono">npm run verify-pricing</span>. Diffs every first-party rate
                against the upstream catalogue, flags stale model ids, and exits non-zero on drift so CI can gate on it.</div></div>
            <span class="badge">CLI</span>
          </div>
        </div>
      </div>
    </section>`;

  el.querySelector("#csvBtn").addEventListener("click", () => {
    window.location.href = `/api/panel/ledger?format=csv&month=${encodeURIComponent(ledgerMonth)}`;
  });
  el.querySelector("#monthPrev").addEventListener("click", () => {
    ledgerMonth = shiftMonth(ledgerMonth, -1);
    loadLedger();
  });
  el.querySelector("#monthNext").addEventListener("click", () => {
    if (ledgerMonth >= monthClock().key) return;
    ledgerMonth = shiftMonth(ledgerMonth, 1);
    loadLedger();
  });
  wireFocusLink(el);
  loadLedger();
};

async function loadLedger() {
  const host = document.getElementById("ledgerBody");
  if (!host) return;
  const label = document.getElementById("stMonth");
  const next = document.getElementById("monthNext");
  const thisMonth = monthClock().key;
  if (label) label.innerHTML = `${esc(monthLabel(ledgerMonth))}<span>${esc(ledgerMonth)}${ledgerMonth === thisMonth ? " &#183; IN PROGRESS" : " &#183; CLOSED"}</span>`;
  if (next) next.disabled = ledgerMonth >= thisMonth;

  try {
    const l = await api(`/api/panel/ledger?month=${encodeURIComponent(ledgerMonth)}`);
    paintStatement(l);
    paintTrust(l);
    restoreFocus();
  } catch (err) {
    host.innerHTML = `<div class="empty-note"><b>Could not load the ledger.</b>${esc(err.message)}</div>`;
  }
}

function paintStatement(l) {
  const host = document.getElementById("ledgerBody");
  const total = document.getElementById("stTotal");
  const meta = document.getElementById("stMeta");
  if (!host) return;
  if (total) total.innerHTML = `<span>TOTAL</span>${esc(fmtUsd(l.totalUsd))}`;

  if (!l.rows.length) {
    host.innerHTML = `<div class="empty-note">
      <b>No spend recorded for ${esc(monthLabel(l.month))}.</b>
      A row appears here for every lane that billed anything, ranked by cost, with the provenance of
      each figure beside it. Use the arrows above to reach a month that has traffic.</div>`;
    if (meta) meta.textContent = "0 LANES";
    return;
  }
  if (meta) meta.textContent = `${l.rows.length} LANE${l.rows.length === 1 ? "" : "S"} BILLED`;

  const top = l.rows[0]?.costUsd || 1;
  host.innerHTML = `<div class="st-rows">${l.rows.map((r, i) => {
    const share = l.totalUsd ? (r.costUsd / l.totalUsd) * 100 : 0;
    const free = r.pricingVerified === "n/a";
    return `<div class="st-row${r.trustworthy ? "" : " untrusted"}" data-prov="${esc(r.providerId)}">
      <div class="st-n">${String(i + 1).padStart(2, "0")}</div>
      <div class="st-nm">${esc(r.providerId)}</div>
      <div class="st-bar"><i style="width:${((r.costUsd / top) * 100).toFixed(1)}%"></i></div>
      <div class="st-pc">${esc(share.toFixed(1))}%</div>
      <div class="st-c">${esc(fmtUsd(r.costUsd))}</div>
      <div class="st-p">${free
        ? '<span class="badge on">free · local</span>'
        : r.trustworthy
          ? `<span class="badge on">verified ${esc(r.pricingVerified)}</span>`
          : '<span class="badge warn">unverified</span>'}</div>
    </div>`;
  }).join("")}</div>`;
}

// How much of the month's money rests on a table somebody actually checked.
// A composition bar, because the question is what share — not how many lanes.
function paintTrust(l) {
  const host = document.getElementById("trustHost");
  const meta = document.getElementById("trMeta");
  if (!host) return;

  const free = l.rows.filter((r) => r.pricingVerified === "n/a");
  const good = l.rows.filter((r) => r.trustworthy && r.pricingVerified !== "n/a");
  const bad = l.rows.filter((r) => !r.trustworthy);
  const sum = (rows) => rows.reduce((a, r) => a + r.costUsd, 0);
  const goodUsd = sum(good), badUsd = sum(bad), freeUsd = sum(free);
  const total = l.totalUsd || 0;
  const pct = total ? (goodUsd / total) * 100 : 100;
  if (meta) meta.textContent = total ? `${pct.toFixed(pct >= 99.5 || pct < 1 ? 0 : 1)}% BACKED` : "";

  if (!l.rows.length) {
    host.innerHTML = `<div class="empty-note">
      <b>Nothing to vouch for yet.</b>
      When money has moved, this panel splits it by how much rests on a price table that has been
      checked against the vendor's published rates, the figure that decides whether the statement
      beside it can be argued from.</div>`;
    return;
  }

  const seg = (usd, cls, label) => usd <= 0 ? "" :
    `<i class="${cls}" style="width:${((usd / Math.max(total, 0.000001)) * 100).toFixed(2)}%" title="${label} · ${esc(fmtUsd(usd))}"></i>`;

  host.innerHTML = `
    <div class="tr-lede">
      <div class="eng-k">BACKED BY A CHECKED TABLE</div>
      <div class="tr-v ${badUsd ? "warn" : "ok"}">${esc(total ? pct.toFixed(pct >= 99.5 || pct < 1 ? 0 : 1) : "100")}<span>%</span></div>
      <div class="tr-sub">${esc(fmtUsd(goodUsd))} OF ${esc(fmtUsd(total))}</div>
    </div>
    <div class="tr-bar">${seg(goodUsd, "ok", "verified")}${seg(badUsd, "bad", "unverified")}${seg(freeUsd, "free", "free / local")}</div>
    <div class="tr-key">
      <div class="tk" data-n="${esc(good.length)}"><i class="ok"></i>VERIFIED<b>${esc(fmtUsd(goodUsd))}</b></div>
      ${badUsd || bad.length ? `<div class="tk"><i class="bad"></i>UNVERIFIED<b>${esc(fmtUsd(badUsd))}</b></div>` : ""}
      ${freeUsd || free.length ? `<div class="tk"><i class="free"></i>FREE / LOCAL<b>${esc(fmtUsd(freeUsd))}</b></div>` : ""}
    </div>
    ${bad.length ? `<div class="tr-flag">
      <div class="tf-h">${esc(bad.length)} LANE${bad.length === 1 ? "" : "S"} PRICED FROM AN UNCHECKED TABLE</div>
      ${bad.sort((a, b) => b.costUsd - a.costUsd).map((r) => `<div class="tf-row" data-prov="${esc(r.providerId)}">
        <span>${esc(r.providerId)}</span><b>${esc(fmtUsd(r.costUsd))}</b></div>`).join("")}
      <div class="tf-note">Expect these rows to be the ones that disagree with the invoice.
        <span class="mono">npm run verify-pricing</span> diffs them against the published rates.</div>
    </div>` : `<div class="tr-flag ok">
      <div class="tf-h">EVERY BILLED LANE IS PRICED FROM A CHECKED TABLE</div>
      <div class="tf-note">A disagreement with the invoice is a real discrepancy here, not a stale rate in this tool.</div>
    </div>`}`;
}

// =========================================================================
// RESILIENCE — the product's own claim is "never kill more than what broke".
// That is a claim about containment, so the page draws containment: each
// affected lane as a nested figure, provider ⊃ connection ⊃ model, with what
// is still serving inside it.
// =========================================================================

const RES_POLICY = { providerFailureThreshold: 3, providerCooldownSec: 30, connectionCooldownSec: 60, modelLockoutSec: 60, modelNotFoundLockoutSec: 1800 };
const resPolicy = (s) => ({ ...RES_POLICY, ...(s.resilience?.policy || {}) });

// Both maps are keyed "provider::rest". Splitting on the first separator
// keeps model ids containing colons intact.
const splitScopeKey = (k) => {
  const i = k.indexOf("::");
  return i < 0 ? [k, ""] : [k.slice(0, i), k.slice(i + 2)];
};

function resilienceFold(s) {
  const conns = Object.entries(s.resilience?.connections || {});
  const models = Object.entries(s.resilience?.models || {});
  const provs = s.resilience?.providers || {};
  const byProvider = new Map();
  const touch = (id) => {
    if (!byProvider.has(id)) byProvider.set(id, { id, conns: [], models: [], breaker: null });
    return byProvider.get(id);
  };
  conns.forEach(([k, v]) => { const [id, key] = splitScopeKey(k); touch(id).conns.push({ key, ...v }); });
  models.forEach(([k, v]) => { const [id, model] = splitScopeKey(k); touch(id).models.push({ model, ...v }); });
  Object.entries(provs).forEach(([id, v]) => {
    if (v.status !== "CLOSED" || v.failures > 0) touch(id).breaker = v;
  });
  s.providers.forEach((p) => { if (p.circuit !== "CLOSED") touch(p.id).breaker ||= { status: p.circuit, failures: 0, probeInSecRemaining: null }; });
  return { conns, models, byProvider };
}

PAGES.resilience = (el, s) => {
  el.innerHTML = `
    <section class="zone isolation">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">Isolation map</span>
          <span class="p-s" id="isoMeta"></span>
        </div>
        <div class="iso-intro">Failures trip the smallest scope that explains them:
          <b>model &#8834; connection &#8834; provider</b>. Each figure below is one lane, drawn as what it
          contains, so you can see the part that is isolated and the part still carrying traffic
          inside the same outline. Recovery is lazy: checked on access, never on a background timer.</div>
        <div id="isoHost"></div>
      </div>
      <aside class="pane budget-pane">
        <div class="p-head"><span class="p-t">Breaker pressure</span><span class="p-s" id="presMeta"></span></div>
        <div id="presHost"></div>
      </aside>
    </section>

    <section class="zone scopes">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">Cooling connections</span>
          <span class="scope-tag c">LAYER 2 &#183; ONE KEY</span>
          <span class="p-s" id="connMeta"></span>
        </div>
        <div id="connHost"></div>
      </div>
      <div class="pane">
        <div class="p-head">
          <span class="p-t">Locked models</span>
          <span class="scope-tag m">LAYER 3 &#183; ONE MODEL</span>
          <span class="p-s" id="mdlMeta"></span>
        </div>
        <div id="mdlHost"></div>
      </div>
    </section>

    <section class="zone recovery">
      <div class="pane">
        <div class="p-head"><span class="p-t">Recovery</span><span class="p-s" id="recMeta"></span></div>
        <div class="recon-body">
          <div class="setrow">
            <div><div class="nm">Clear all failure state</div>
              <div class="hh">Closes every breaker, releases cooling keys and unlocks models immediately.
                Recovery is normally lazy and automatic. Use this after fixing the underlying cause,
                not to skip a cooldown that is doing its job.</div></div>
            <button class="sm danger" id="resetResilience">Reset</button>
          </div>
        </div>
      </div>
    </section>`;

  el.querySelector("#resetResilience").addEventListener("click", async () => {
    await api("/api/panel/resilience/reset", { method: "POST" });
    refresh();
  });

  paintIsolation(s);
  paintPressure(s);
  paintScopeLists(s);
  wireFocusLink(el);
  restoreFocus();
};

// One lane, drawn as what it contains. The outer band is the provider, the
// slots inside it are its credentials, and the chips inside those are its
// models — so an isolated model reads as a chip inside a lane that is still
// otherwise serving, which is exactly the product's argument.
function paintIsolation(s) {
  const host = document.getElementById("isoHost");
  const meta = document.getElementById("isoMeta");
  if (!host) return;
  const { conns, models, byProvider } = resilienceFold(s);
  const byId = new Map(s.providers.map((p) => [p.id, p]));
  const serving = s.providers.filter((p) => p.hasKey && p.enabled && p.circuit !== "OPEN").length;
  const affected = [...byProvider.values()].filter((v) => v.breaker?.status !== "CLOSED" || v.conns.length || v.models.length || (v.breaker?.failures || 0) > 0);

  if (meta) {
    meta.textContent = affected.length
      ? `${affected.length} LANE${affected.length === 1 ? "" : "S"} CARRYING FAILURE STATE · ${serving} STILL SERVING`
      : `NOTHING ISOLATED · ${serving} LANES SERVING`;
  }

  if (!affected.length) {
    host.innerHTML = `<div class="iso-clear">
      <div class="ic-h"><span class="dot live beat"></span>ALL THREE SCOPES CLEAR</div>
      <div class="ic-b">No breaker is open, no credential is cooling and no model is locked out.
        When something does break, the lane it belongs to appears here as an outline with the failed part
        shaded and the rest of it still drawn in. A locked model does not take its siblings with it,
        and a bad key does not take the provider's other keys with it.</div>
      <div class="ic-rules">
        <div><b>401 / 403</b><span>cools that one credential for ${esc(resPolicy(s).connectionCooldownSec)}s</span></div>
        <div><b>429</b><span>locks that one model for 60s</span></div>
        <div><b>404</b><span>locks that one model for 30 min</span></div>
        <div><b>5xx &#215; ${esc(resPolicy(s).providerFailureThreshold)}</b><span>opens the whole provider for ${esc(resPolicy(s).providerCooldownSec)}s</span></div>
      </div>
    </div>`;
    return;
  }

  host.innerHTML = affected.sort((a, b) => {
    const w = (v) => v.breaker?.status === "OPEN" ? 0
      : v.breaker?.status === "HALF_OPEN" ? 1
      : v.conns.length ? 2 : v.models.length ? 3 : 4;
    return w(a) - w(b) || (b.breaker?.failures || 0) - (a.breaker?.failures || 0);
  }).map((v) => {
    const p = byId.get(v.id);
    const total = p?.connections || 1;
    const cooling = v.conns.length;
    const open = v.breaker?.status === "OPEN";
    const half = v.breaker?.status === "HALF_OPEN";
    const scope = open ? "p" : cooling ? "c" : v.models.length ? "m" : "p";
    const verdict = open ? "WHOLE LANE ISOLATED"
      : half ? "PROBING · ONE CALL DECIDES"
      : cooling >= total ? "EVERY KEY COOLING"
      : cooling ? `${cooling} OF ${total} KEYS COOLING`
      : v.models.length ? `${v.models.length} MODEL${v.models.length === 1 ? "" : "S"} LOCKED, LANE SERVING`
      : `${v.breaker?.failures || 0} FAILURE(S), STILL CLOSED`;

    // Containment cuts both ways: an open provider scope contains its own
    // credentials and models, so nothing inside it is reachable regardless of
    // its own state. Drawing "KEY 1 OK" inside a dead lane would contradict
    // the very argument the figure is making.
    const slots = Array.from({ length: Math.max(total, cooling) }, (_, i) => {
      const cool = i < cooling;
      if (open) {
        return `<div class="iso-slot dead" title="the whole lane is isolated · this credential is not reachable">
          <span>${esc(cool ? v.conns[i].key : "KEY " + (i + 1))}</span><b>&mdash;</b></div>`;
      }
      return `<div class="iso-slot ${cool ? "cool" : "live"}" title="${cool ? esc(v.conns[i].key) + " · cooling" : "credential " + (i + 1) + " · serving"}">
        <span>${cool ? esc(v.conns[i].key) : "KEY " + (i + 1)}</span>
        ${cool ? `<b>${esc(v.conns[i].cooldownSecRemaining)}s</b>` : "<b>OK</b>"}
      </div>`;
    }).join("");

    const chips = open
      ? '<span class="iso-chip dead">no model reachable while the lane is open</span>'
      : v.models.length
        ? v.models.map((m) => `<span class="iso-chip" title="${esc(m.reason)} · ${esc(m.lockedSecRemaining)}s left">
            ${esc(trunc(m.model, 22))}<i>${esc(m.lockedSecRemaining)}s</i></span>`).join("")
        : `<span class="iso-chip ok">every model reachable</span>`;

    return `<div class="iso-lane sc-${scope}${open ? " dead" : ""}" data-prov="${esc(v.id)}">
      <div class="iso-head">
        <span class="iso-nm">${esc(p?.name || v.id)}</span>
        <span class="scope-tag ${scope}">${open ? "LAYER 1" : cooling ? "LAYER 2" : "LAYER 3"}</span>
        <span class="iso-verdict">${esc(verdict)}</span>
        ${open && v.breaker?.probeInSecRemaining != null
          ? `<span class="iso-probe">PROBE IN ${esc(v.breaker.probeInSecRemaining)}s</span>` : ""}
      </div>
      <div class="iso-body">
        <div class="iso-conns">${slots}</div>
        <div class="iso-models">${chips}</div>
      </div>
    </div>`;
  }).join("");
}

// How close each lane is to losing its whole self. A raw failure count says
// nothing; the same count against the threshold says "one more opens it".
function paintPressure(s) {
  const host = document.getElementById("presHost");
  const meta = document.getElementById("presMeta");
  if (!host) return;
  const pol = resPolicy(s);
  const provs = s.resilience?.providers || {};
  const rows = s.providers
    .filter((p) => p.hasKey)
    .map((p) => ({ p, r: provs[p.id] || { status: p.circuit, failures: 0, probeInSecRemaining: null } }))
    .filter((x) => x.r.failures > 0 || x.r.status !== "CLOSED")
    .sort((a, b) => (a.r.status === "OPEN" ? -1 : 0) - (b.r.status === "OPEN" ? -1 : 0) || b.r.failures - a.r.failures);

  const armed = s.providers.filter((p) => p.hasKey && p.enabled && p.circuit !== "OPEN").length;
  if (meta) meta.textContent = `${armed} LANE${armed === 1 ? "" : "S"} ARMED`;

  host.innerHTML = `
    <div class="pres-lede">
      <div class="eng-k">TRIPS AT</div>
      <div class="pres-v">${esc(pol.providerFailureThreshold)}<span> consecutive 5xx</span></div>
      <div class="pres-sub">THEN THE LANE SITS OUT ${esc(pol.providerCooldownSec)}s BEFORE ONE CALL IS LET THROUGH TO PROBE IT</div>
    </div>
    ${rows.length ? rows.map(({ p, r }) => {
      const open = r.status === "OPEN";
      const pct = Math.min(100, (r.failures / pol.providerFailureThreshold) * 100);
      return `<div class="pres-row ${open ? "open" : r.status === "HALF_OPEN" ? "half" : ""}" data-prov="${esc(p.id)}">
        <div class="pres-nm">${esc(p.name)}<span>${esc(r.status)}</span></div>
        <div class="pres-track">${Array.from({ length: pol.providerFailureThreshold }, (_, i) =>
          `<i class="${i < r.failures ? (open ? "bad" : "warn") : ""}"></i>`).join("")}</div>
        <div class="pres-v2">${esc(r.failures)}<span>/ ${esc(pol.providerFailureThreshold)}</span></div>
        <div class="pres-note">${open
          ? (r.probeInSecRemaining != null ? `PROBE IN ${esc(r.probeInSecRemaining)}s` : "AWAITING PROBE")
          : r.failures >= pol.providerFailureThreshold - 1 ? "ONE MORE OPENS IT" : "WITHIN TOLERANCE"}</div>
      </div>`;
    }).join("") : `<div class="empty-note">
      <b>No lane has recorded a failure.</b>
      A meter appears here the moment one does, filling toward the threshold, so you can see a lane
      degrading before it trips rather than after.</div>`}`;
}

function paintScopeLists(s) {
  const pol = resPolicy(s);
  const conns = Object.entries(s.resilience?.connections || {});
  const models = Object.entries(s.resilience?.models || {});
  const ch = document.getElementById("connHost");
  const mh = document.getElementById("mdlHost");
  const cm = document.getElementById("connMeta");
  const mm = document.getElementById("mdlMeta");
  const rm = document.getElementById("recMeta");
  if (rm) rm.textContent = `${conns.length + models.length + s.providers.filter((p) => p.circuit !== "CLOSED").length} ITEM(S) OF FAILURE STATE`;

  if (ch) {
    if (cm) cm.textContent = conns.length ? `${conns.length} COOLING` : "NONE";
    ch.innerHTML = conns.length
      ? conns.map(([k, v]) => {
          const total = v.cooldownSecTotal || pol.connectionCooldownSec;
          const left = Math.max(0, Math.min(100, (v.cooldownSecRemaining / Math.max(1, total)) * 100));
          const [pid] = splitScopeKey(k);
          return `<div class="cd-row" data-prov="${esc(pid)}">
            <div class="cd-nm">${esc(k)}<span>${esc(v.failures)} FAILURE${v.failures === 1 ? "" : "S"} &#183; THE PROVIDER'S OTHER KEYS KEEP SERVING</span></div>
            <div class="cd-track"><i style="width:${left.toFixed(1)}%"></i></div>
            <div class="cd-v">${esc(v.cooldownSecRemaining)}s<span>OF ${esc(total)}s</span></div>
          </div>`;
        }).join("")
      : `<div class="empty-note">
          <b>No credential is cooling down.</b>
          A 401 or 403 puts the one key that was rejected on a ${esc(pol.connectionCooldownSec)}-second bench and leaves the
          provider's other keys serving. The bench and how much of it is left appear here.</div>`;
  }

  if (mh) {
    if (mm) mm.textContent = models.length ? `${models.length} LOCKED` : "NONE";
    mh.innerHTML = models.length
      ? models.map(([k, v]) => {
          const total = v.lockedSecTotal || pol.modelLockoutSec;
          const left = Math.max(0, Math.min(100, (v.lockedSecRemaining / Math.max(1, total)) * 100));
          const [pid, model] = splitScopeKey(k);
          return `<div class="cd-row model" data-prov="${esc(pid)}">
            <div class="cd-nm">${esc(model || k)}<span>${esc(pid)} &#183; ${esc(String(v.reason || "locked").toUpperCase())} &#183; SIBLING MODELS SERVE INSTANTLY</span></div>
            <div class="cd-track"><i style="width:${left.toFixed(1)}%"></i></div>
            <div class="cd-v">${esc(v.lockedSecRemaining)}s<span>OF ${esc(total)}s</span></div>
          </div>`;
        }).join("")
      : `<div class="empty-note">
          <b>No model is locked out.</b>
          A 429 benches one model for 60 seconds and a 404 for 30 minutes, because a model that does not
          exist will not appear on a retry. Neither touches the credential or the lane.</div>`;
  }
}

// =========================================================================
// CACHE — a hit is a crossing that never happened, so the page is about
// what did not get spent. The policy that decides cacheability is stated as
// rules with live readings rather than buried in a paragraph.
// =========================================================================

PAGES.cache = (el, s) => {
  el.innerHTML = `
    <section class="zone hitsplit">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">Lookup outcome</span>
          <span class="p-s" id="hitMeta"></span>
        </div>
        <div id="hitHost"></div>
      </div>
      <div class="pane instr-pane">
        <div class="p-head"><span class="p-t">Store</span><span class="p-s">IN MEMORY, PER PROCESS</span></div>
        <div class="instr" id="cacheInstr"></div>
      </div>
    </section>

    <section class="zone cachepolicy">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">What gets cached</span>
          <span class="p-s">EXACT MATCH ONLY &#183; NEVER SEMANTIC</span>
        </div>
        <div id="polHost"></div>
      </div>
      <div class="pane">
        <div class="p-head"><span class="p-t">Maintenance</span></div>
        <div class="recon-body">
          <div class="setrow">
            <div><div class="nm">Clear the cache</div>
              <div class="hh">Drops every stored response and resets the hit and miss counters.
                The next identical request pays for a real crossing again.</div></div>
            <button class="danger" id="clearCacheBtn">Clear</button>
          </div>
        </div>
      </div>
    </section>`;

  el.querySelector("#clearCacheBtn").addEventListener("click", async () => {
    await api("/api/panel/cache/clear", { method: "POST" });
    refresh();
  });

  paintCacheSplit(s);
  paintCacheInstruments(s);
  paintCachePolicy(s);

  if (!el.dataset.obsWired) {
    el.dataset.obsWired = "1";
    const host = document.getElementById("hitHost");
    if (host && typeof ResizeObserver !== "undefined") {
      let last = 0, t = null;
      new ResizeObserver(() => {
        const w = Math.round(host.clientWidth);
        if (!w || Math.abs(w - last) < 4) return;
        last = w;
        clearTimeout(t);
        t = setTimeout(() => { if (current === "cache" && state) paintCacheSplit(state); }, 120);
      }).observe(host);
    }
  }
};

// Every lookup goes one of two ways, and only one of them costs money. The
// split is drawn as a fork so the served-without-a-crossing branch is a
// branch, not a number in a tile.
function paintCacheSplit(s) {
  const host = document.getElementById("hitHost");
  const meta = document.getElementById("hitMeta");
  if (!host) return;
  const c = s.cache || {};
  const hits = Number(c.hits) || 0, misses = Number(c.misses) || 0;
  const total = hits + misses;

  if (!total) {
    host.innerHTML = `<div class="empty-note">
      <b>Nothing has been looked up yet.</b>
      Every request that is eligible arrives here first. It forks two ways: a hit is answered from
      memory and never becomes a crossing, a miss goes on to a provider and is stored on the way back.
      The fork below fills in as soon as traffic starts, and carries an estimate of what the hits saved.</div>`;
    if (meta) meta.textContent = "NO LOOKUPS";
    return;
  }

  // Both savings figures are derived from the plaza average, so they are
  // estimates and are labelled as such — the cache does not record the cost
  // of the crossing each hit stood in for.
  const avgCost = s.totals.totalRequests ? s.totals.totalCostUsd / s.totals.totalRequests : 0;
  const avgLat = s.totals.avgLatencyMs || 0;
  const savedUsd = hits * avgCost;
  const savedMs = hits * avgLat;
  const hitPct = (hits / total) * 100;
  if (meta) meta.textContent = `${total} LOOKUP${total === 1 ? "" : "S"} · ${hits} HIT / ${misses} MISS`;

  const W = Math.max(360, host.clientWidth || 640), H = 218;
  const xIn = 20, xFork = Math.max(150, W * 0.3), xOut = W - 190;
  const midY = 92;
  const yHit = 50, yMiss = 142;
  const hw = Math.max(2, (hits / total) * 30);
  const mw = Math.max(2, (misses / total) * 30);

  const hitPath = `M ${xFork},${midY} C ${xFork + 46},${midY} ${xOut - 60},${yHit} ${xOut},${yHit}`;
  const missPath = `M ${xFork},${midY} C ${xFork + 46},${midY} ${xOut - 60},${yMiss} ${xOut},${yMiss}`;

  const g = `
    <text x="${xIn}" y="26" font-family=${MONO} font-size="9.5" letter-spacing="2.2" fill="#868d99">LOOKUP</text>
    <text x="${xOut}" y="26" font-family=${MONO} font-size="9.5" letter-spacing="2.2" fill="#868d99">OUTCOME</text>
    <line x1="${xIn}" y1="38" x2="${W - 14}" y2="38" stroke="${SCOPE.rule}"/>
    <rect x="${xIn}" y="${midY - 30}" width="3" height="60" fill="${SCOPE.model}" opacity=".55"/>
    <path d="M ${xIn + 6},${midY} L ${xFork},${midY}" stroke="${SCOPE.model}" stroke-opacity=".45" stroke-width="1.6" fill="none"/>
    ${particles(`M ${xIn + 6},${midY} L ${xFork},${midY}`, SCOPE.model, 3, 3.6)}
    <text x="${xIn}" y="${midY + 52}" font-family=${MONO} font-size="14" fill="#c9d1d9">${esc(total)}</text>
    <text x="${xIn}" y="${midY + 66}" font-family=${MONO} font-size="9" letter-spacing="1.1" fill="#737b8a">LOOKUPS</text>

    <path d="${hitPath}" fill="none" stroke="${SCOPE.ok}" stroke-opacity=".3" stroke-width="${hw.toFixed(1)}" stroke-linecap="round"/>
    <path d="${missPath}" fill="none" stroke="${SCOPE.dim}" stroke-opacity=".28" stroke-width="${mw.toFixed(1)}" stroke-linecap="round"/>
    ${hits ? particles(hitPath, SCOPE.ok, 2, 4.2) : ""}
    ${misses ? particles(missPath, SCOPE.dim, 1, 4.6) : ""}

    <rect x="${xOut}" y="${yHit - 24}" width="176" height="48" rx="8" fill="#12171f" stroke="${SCOPE.ok}" stroke-opacity=".38"/>
    <circle cx="${xOut + 15}" cy="${yHit - 6}" r="3.4" fill="${SCOPE.ok}"/>
    <text x="${xOut + 26}" y="${yHit - 2}" font-family=${MONO} font-size="11" letter-spacing="1.2" fill="#7ee787">HIT</text>
    <text x="${xOut + 166}" y="${yHit - 2}" text-anchor="end" font-family=${MONO} font-size="16" fill="#c9d1d9">${esc(hits)}</text>
    <text x="${xOut + 15}" y="${yHit + 15}" font-family=${MONO} font-size="9.5" fill="#868d99">SERVED WITHOUT A CROSSING</text>

    <rect x="${xOut}" y="${yMiss - 24}" width="176" height="48" rx="8" fill="#12171f" stroke="${SCOPE.dim}" stroke-opacity=".28"/>
    <circle cx="${xOut + 15}" cy="${yMiss - 6}" r="3.4" fill="${SCOPE.dim}"/>
    <text x="${xOut + 26}" y="${yMiss - 2}" font-family=${MONO} font-size="11" letter-spacing="1.2" fill="#9aa3b0">MISS</text>
    <text x="${xOut + 166}" y="${yMiss - 2}" text-anchor="end" font-family=${MONO} font-size="16" fill="#c9d1d9">${esc(misses)}</text>
    <text x="${xOut + 15}" y="${yMiss + 15}" font-family=${MONO} font-size="9.5" fill="#868d99">WENT TO A PROVIDER, THEN STORED</text>

    <text x="${xFork}" y="${midY - 16}" text-anchor="middle" font-family=${MONO} font-size="16" fill="${SCOPE.ok}">${esc(hitPct.toFixed(hitPct < 10 ? 1 : 0))}%</text>`;

  host.innerHTML = `<svg id="cachesplit" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
      aria-label="Cache lookups splitting into ${hits} hits and ${misses} misses.">${g}</svg>
    <div class="saved">
      <div class="sv">
        <div class="sv-k">CROSSINGS AVOIDED</div>
        <div class="sv-v">${esc(hits)}</div>
        <div class="sv-s">REQUESTS THAT NEVER REACHED A PROVIDER</div>
      </div>
      <div class="sv">
        <div class="sv-k">EST. SPEND AVOIDED</div>
        <div class="sv-v ok">${esc(fmtUsd(savedUsd))}<em>~</em></div>
        <div class="sv-s">${esc(hits)} &#215; ${esc(fmtUsd(avgCost))} PLAZA AVERAGE</div>
      </div>
      <div class="sv">
        <div class="sv-k">EST. LATENCY AVOIDED</div>
        <div class="sv-v ok">${esc(fmtMs(savedMs))}<em>~</em></div>
        <div class="sv-s">${esc(hits)} &#215; ${esc(fmtMs(avgLat))} PLAZA AVERAGE</div>
      </div>
    </div>
    <div class="saved-note">Both estimates price a hit at the average crossing, because the cache does not
      record what the request it stood in for would have cost. Treat them as an order of magnitude, not an invoice.</div>`;
}

function paintCacheInstruments(s) {
  const host = document.getElementById("cacheInstr");
  if (!host) return;
  const c = s.cache || {};
  const hits = Number(c.hits) || 0, misses = Number(c.misses) || 0;
  const total = hits + misses;
  const max = Number(c.maxEntries) || 0;
  const entries = Number(c.entries) || 0;
  const occ = max ? (entries / max) * 100 : 0;
  const ttl = Number(c.ttlSeconds) || 0;

  host.innerHTML = `
    <div class="icell">
      <div class="ik">HIT RATE</div>
      <div class="iv ${c.hitRatePct >= 40 ? "ok" : ""}">${total ? esc(c.hitRatePct) + "<span class=\"u\">%</span>" : "&mdash;"}</div>
      ${ringGauge(total ? c.hitRatePct : 0, c.hitRatePct >= 40 ? SCOPE.ok : c.hitRatePct > 0 ? SCOPE.model : SCOPE.dim)}
      <div class="is">${total ? `OF <em>${esc(total)}</em> LOOKUPS` : "NOTHING LOOKED UP YET"}</div>
    </div>

    <div class="icell">
      <div class="ik">OCCUPANCY</div>
      <div class="iv ${occ >= 90 ? "warn" : ""}">${esc(entries)}${max ? `<span class="u"> / ${esc(max)}</span>` : ""}</div>
      <div class="bar big"><i class="${occ >= 90 ? "over" : ""}" style="width:${occ.toFixed(1)}%"></i></div>
      <div class="is">${max
        ? (occ >= 90
            ? "<em>FULL</em> · EACH NEW ENTRY EVICTS THE LEAST RECENTLY USED"
            : `<em>${esc(max - entries)}</em> SLOTS BEFORE LRU EVICTION STARTS`)
        : "STORED ENTRIES"}</div>
    </div>

    <div class="icell">
      <div class="ik">ENTRY LIFETIME</div>
      <div class="iv">${ttl ? esc(Math.round(ttl / 60)) + '<span class="u"> min</span>' : "&mdash;"}</div>
      <div class="is tall">Every entry expires <em>${esc(ttl)}s</em> after it is written, and expiry is
        checked on read. A stale entry costs nothing until somebody asks for it.
        Nothing here survives a restart.</div>
    </div>

    <div class="icell">
      <div class="ik">SPLIT</div>
      <div class="iv">${esc(hits)}<span class="u"> / ${esc(misses)}</span></div>
      <div class="segbar">${Array.from({ length: 20 }, (_, i) =>
        `<i class="${total && i < Math.round((hits / total) * 20) ? "f" : ""}"></i>`).join("")}</div>
      <div class="is">HIT / MISS SINCE THE PROCESS STARTED</div>
    </div>`;
}

// The rules that decide cacheability, in the order the code applies them.
// This is the page's most-asked question — "why was this not cached?" — so
// it is a structure rather than a sentence in a paragraph.
function paintCachePolicy(s) {
  const host = document.getElementById("polHost");
  if (!host) return;
  const c = s.cache || {};
  const rules = [
    { k: "TEMPERATURE", v: "unset or 0", ink: SCOPE.ok,
      n: "A caller asking for temperature above zero is asking for variation, so a repeat would be the wrong answer. Those requests are never stored and never served from here." },
    { k: "KEY", v: "caller + model + messages + tools + max_tokens", ink: SCOPE.model,
      n: "Byte-identical or nothing. This is deliberately not semantic matching: a close-enough answer to a different question is a correctness bug wearing a feature's clothes." },
    { k: "CALLER", v: "part of the key", ink: SCOPE.conn,
      n: "Two callers with the same prompt get their own entries, so per-user auth can land later without one person's answer being served to another." },
    { k: "PROVIDER", v: "NOT part of the key", ink: SCOPE.provider,
      n: "An answer is reusable whichever backend produced it, which is exactly what makes a cache worth having in front of many providers." },
    { k: "LIFETIME", v: c.ttlSeconds ? `${c.ttlSeconds}s, then expired` : "time-limited", ink: SCOPE.model,
      n: "Expiry is checked on read, so a stale entry costs nothing until someone asks for it." },
    { k: "CAPACITY", v: c.maxEntries ? `${c.maxEntries} entries, LRU` : "bounded, LRU", ink: SCOPE.conn,
      n: "At the ceiling the least recently used entry is dropped. A hit refreshes recency, so the things you actually re-ask for survive." },
    { k: "DURABILITY", v: "in memory, per process", ink: SCOPE.faint,
      n: "A restart drops everything. Nothing here is written to disk, so nothing here needs securing at rest." }
  ];
  host.innerHTML = `<div class="pol">${rules.map((r) => `<div class="pol-row">
    <i style="background:${r.ink}"></i>
    <span class="pol-k">${esc(r.k)}</span>
    <span class="pol-v" style="color:${r.ink}">${esc(r.v)}</span>
    <span class="pol-n">${esc(r.n)}</span>
  </div>`).join("")}</div>`;
}

// =========================================================================
// COMPRESSION — three layers a message passes through in order, each taking
// a bite out of it. That is a waterfall, so the page leads with one: the
// preview's per-layer split drawn as the reduction it actually is.
// =========================================================================

// The poll rebuilds this page every eight seconds, which would otherwise
// throw away a preview the moment after you ran it. Both the stats and the
// compressed text are held here and re-applied on paint.
let compLast = null;
let compLastOut = null;
let compInput = null;

PAGES.compression = (el, s) => {
  const c = s.compression || {};
  const rtk = c.rtk || {};
  const caveman = c.caveman || {};
  const sw = (id, on) => `<div class="switch ${on ? "on" : ""}" id="${id}"></div>`;

  el.innerHTML = `
    <div class="alerts-band">
      <div class="alert warn">
        <div class="ai">&#8226;</div>
        <div><div class="at">Caveman is lossy, and scope is the safety argument</div>
          <div class="ab">It never touches your system prompt, and by default never touches the newest user
            message either. Those are the two places exact wording matters most. Words whose removal inverts meaning
            (<span class="mono">not</span>, <span class="mono">never</span>, <span class="mono">without</span>,
            <span class="mono">unless</span>) are never dropped at any level, and fenced code, paths, URLs and
            identifiers are protected byte-exact.</div></div>
      </div>
    </div>

    <section class="zone pipeline">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">The pipeline</span>
          <span class="p-s" id="cmpMeta2"></span>
        </div>
        <div class="pipe-intro">Every request walks these three layers in order, and each one only sees what the
          one above it left. <b>Base</b> collapses whitespace and duplicate lines, free and effectively
          lossless. <b>RTK</b> attacks the shape of machine output. <b>Caveman</b> rewrites prose and is the only
          lossy step. Callers opt out per request with <span class="mono">"compress": false</span>, and every
          response carries <span class="mono">X-Tollpike-Compression-Detail</span> with this same split.</div>
        <div id="pipeHost"></div>
      </div>
      <aside class="pane try-pane">
        <div class="p-head"><span class="p-t">Try it</span><span class="p-s" id="tryMeta"></span></div>
        <div class="try-note">Runs the real pipeline with your current settings and reports what each layer saved.</div>
        <textarea id="compTest" rows="5" style="width:100%;margin-top:12px" placeholder="Paste tool output or a long message…">[{"id":1,"name":"alpha","status":"active"},{"id":2,"name":"beta","status":"active"},{"id":3,"name":"gamma","status":"active"}]</textarea>
        <div class="row" style="margin-top:10px"><button class="primary sm" id="compRun">Compress</button></div>
        <div id="compOut" class="out" style="margin-top:12px">Nothing run yet.</div>
      </aside>
    </section>

    <section class="zone settings3">
      <div class="pane">
        <div class="p-head"><span class="p-t">General</span><span class="p-s">${c.enabled ? "ON" : "OFF"}</span></div>
        <div class="setrow">
          <div><div class="nm">Compression</div><div class="hh">Master switch. Applies to every request unless the caller opts out.</div></div>
          ${sw("toggleCompression", c.enabled)}
        </div>
        <div class="setrow">
          <div><div class="nm">History window</div><div class="hh">Most recent non-system messages kept. The system prompt is always preserved regardless. This is forgetting, not compression, usually the single largest saving.</div></div>
          <input type="number" min="1" max="500" id="historyWindow" value="${esc(c.historyWindow ?? 12)}" style="width:96px" />
        </div>
      </div>

      <div class="pane">
        <div class="p-head"><span class="p-t">RTK</span><span class="scope-tag m">STRUCTURAL &#183; CONTENT-LOSSLESS</span><span class="p-s">${rtk.enabled ? "ON" : "OFF"}</span></div>
        <div class="setrow">
          <div><div class="nm">RTK</div><div class="hh">Where the 40&ndash;95% figures on tool output come from.</div></div>
          ${sw("rtkEnabled", rtk.enabled)}
        </div>
        <div class="setrow">
          <div><div class="nm">Tabularize JSON</div><div class="hh">Uniform arrays of objects become TSV. Ragged arrays are left alone: an empty cell cannot distinguish "key absent" from "empty string".</div></div>
          ${sw("rtkTabularize", rtk.tabularize)}
        </div>
        <div class="setrow">
          <div><div class="nm">Collapse runs</div><div class="hh">Repeated identical lines become <span class="mono">line &#10216;&#215;N&#10217;</span>, keeping the count the old dedupe discarded.</div></div>
          ${sw("rtkRuns", rtk.runs)}
        </div>
        <div class="setrow">
          <div><div class="nm">Elide blobs</div><div class="hh">Base64, data URIs and hexdumps become a size marker. Lossy, and always visible. A compressor that silently drops data teaches the model to trust text that is not there.</div></div>
          ${sw("rtkBlobs", rtk.blobs)}
        </div>
        <div class="setrow">
          <div><div class="nm">Symbol dictionary</div><div class="hh">Repeated phrases become <span class="mono">&#167;n</span> with a legend. Off by default: it requires the model to dereference a symbol table, which smaller models do unreliably.</div></div>
          ${sw("rtkDictionary", rtk.dictionary)}
        </div>
      </div>

      <div class="pane">
        <div class="p-head"><span class="p-t">Caveman</span><span class="scope-tag c">LOSSY PROSE</span><span class="p-s">${caveman.enabled ? esc(caveman.level || "on").toUpperCase() : "OFF"}</span></div>
        <div class="setrow">
          <div><div class="nm">Caveman</div><div class="hh">Drops grammar the model re-infers from word order.</div></div>
          ${sw("cavemanEnabled", caveman.enabled)}
        </div>
        <div class="setrow">
          <div><div class="nm">Level</div><div class="hh"><span class="mono">light</span> rewrites verbose constructions only and is meaning-preserving. <span class="mono">aggressive</span> also drops articles, copulas and inferable prepositions.</div></div>
          <select id="cavemanLevel" style="width:120px">${["off", "light", "aggressive"].map((l) =>
            `<option value="${l}" ${caveman.level === l ? "selected" : ""}>${l}</option>`).join("")}</select>
        </div>
        <div class="setrow">
          <div><div class="nm">Scope</div><div class="hh"><span class="mono">tools</span> is tool output only. <span class="mono">tools+history</span> adds older turns. <span class="mono">all</span> includes the newest user message, the one setting here that can change what the model is asked to do.</div></div>
          <select id="cavemanScope" style="width:140px">${["tools", "tools+history", "all"].map((sc) =>
            `<option value="${sc}" ${caveman.scope === sc ? "selected" : ""}>${sc}</option>`).join("")}</select>
        </div>
      </div>
    </section>`;

  el.querySelector("#toggleCompression").addEventListener("click", (e) =>
    saveCompression({ enabled: !e.currentTarget.classList.contains("on") }));
  el.querySelector("#historyWindow").addEventListener("change", (e) =>
    saveCompression({ historyWindow: Number(e.target.value) }));
  for (const [id, flag] of [
    ["rtkEnabled", "enabled"], ["rtkTabularize", "tabularize"], ["rtkRuns", "runs"],
    ["rtkBlobs", "blobs"], ["rtkDictionary", "dictionary"]
  ]) {
    el.querySelector(`#${id}`).addEventListener("click", (e) =>
      saveCompression({ rtk: { [flag]: !e.currentTarget.classList.contains("on") } }));
  }
  el.querySelector("#cavemanEnabled").addEventListener("click", (e) =>
    saveCompression({ caveman: { enabled: !e.currentTarget.classList.contains("on") } }));
  el.querySelector("#cavemanLevel").addEventListener("change", (e) =>
    saveCompression({ caveman: { level: e.target.value } }));
  el.querySelector("#cavemanScope").addEventListener("change", (e) =>
    saveCompression({ caveman: { scope: e.target.value } }));

  const input = el.querySelector("#compTest");
  if (compInput !== null) input.value = compInput;
  input.addEventListener("input", () => { compInput = input.value; });

  el.querySelector("#compRun").addEventListener("click", async () => {
    const out = el.querySelector("#compOut");
    compInput = input.value;
    out.textContent = "Compressing…";
    try {
      const result = await api("/api/panel/compression/preview", {
        method: "POST", body: JSON.stringify({ messages: [{ role: "tool", content: compInput }] })
      });
      compLast = result.stats;
      compLastOut = { text: result.messages.map((m) => m.content).join("\n") };
    } catch (err) {
      compLast = null;
      compLastOut = { error: err.message };
    }
    paintCompOut();
    paintPipeline(s);
  });

  paintCompOut();
  paintPipeline(s);
};

function paintCompOut() {
  const out = document.getElementById("compOut");
  if (!out) return;
  if (!compLastOut) { out.textContent = "Nothing run yet."; return; }
  out.textContent = "";
  if (compLastOut.error) { out.textContent = compLastOut.error; return; }
  // Compressed output derives from caller-supplied text, so it goes in as a
  // text node and never as markup.
  const pre = document.createElement("pre");
  pre.className = "mono";
  pre.style.margin = "0";
  pre.textContent = compLastOut.text;
  out.appendChild(pre);
}

// A waterfall: what arrived, what each layer removed, what left. The three
// layers are stacked in the order they run, each showing its own bite and
// its live configuration — the setting and its effect on one screen.
function paintPipeline(s) {
  const host = document.getElementById("pipeHost");
  const meta = document.getElementById("cmpMeta2");
  const tryMeta = document.getElementById("tryMeta");
  if (!host) return;
  const c = s.compression || {};
  const rtk = c.rtk || {};
  const caveman = c.caveman || {};

  const layers = [
    { k: "BASE", id: "truncation", ink: SCOPE.ok, on: c.enabled,
      state: c.enabled ? `history window ${c.historyWindow ?? 12}` : "off",
      n: "Whitespace, duplicate lines and anything past the history window." },
    { k: "RTK", id: "rtk", ink: SCOPE.model, on: c.enabled && rtk.enabled,
      state: rtk.enabled
        ? [rtk.tabularize && "tabularize", rtk.runs && "runs", rtk.blobs && "blobs", rtk.dictionary && "dictionary"].filter(Boolean).join(" · ") || "no sub-pass on"
        : "off",
      n: "Reshapes machine output. Content-lossless: nothing is dropped that cannot be reconstructed." },
    { k: "CAVEMAN", id: "caveman", ink: SCOPE.conn, on: c.enabled && caveman.enabled,
      state: caveman.enabled ? `${caveman.level || "light"} · ${caveman.scope || "tools"}` : "off",
      n: "Rewrites prose. The only lossy step, and the only one whose scope you should think about." }
  ];

  if (meta) {
    const live = layers.filter((l) => l.on).length;
    meta.textContent = c.enabled ? `${live} OF 3 LAYERS ACTIVE` : "COMPRESSION OFF";
  }
  if (tryMeta) tryMeta.textContent = compLast ? `${compLast.savedPct}% SMALLER` : "";

  const st = compLast;
  const before = st ? st.beforeChars : 0;

  const waterfall = st ? (() => {
    const cuts = layers.map((l) => ({
      ...l,
      pct: Number(st.byPass?.[l.id]?.savedPct) || 0,
      chars: Number(st.byPass?.[l.id]?.savedChars ?? 0)
    }));
    // Each layer's percentage is of what reached IT, so the bar widths are
    // taken as a share of the original to keep the stack honest end to end.
    let running = 100;
    const seg = cuts.map((cu) => {
      const share = running * (cu.pct / 100);
      running -= share;
      return { ...cu, share };
    });
    return `<div class="wf">
      <div class="wf-head"><span>${esc(before)} CHARS IN</span><span class="r">${esc(st.afterChars)} OUT</span></div>
      <div class="wf-bar">
        ${seg.map((x) => x.share > 0
          ? `<i style="width:${x.share.toFixed(2)}%;background:${x.ink}" title="${esc(x.k)} removed ${esc(x.pct)}% of what reached it"></i>`
          : "").join("")}
        <i class="kept" style="width:${Math.max(0, running).toFixed(2)}%"></i>
      </div>
      <div class="wf-key">
        ${seg.map((x) => `<span><i style="background:${x.ink}"></i>${esc(x.k)} &minus;${esc(x.pct)}%</span>`).join("")}
        <span><i class="kept"></i>KEPT ${esc(Math.max(0, Math.round(running)))}%</span>
      </div>
      <div class="wf-total"><b>${esc(st.savedPct)}%</b> smaller overall: ${esc(before)} characters in, ${esc(st.afterChars)} out.</div>
    </div>`;
  })() : `<div class="empty-note">
    <b>Nothing measured yet.</b>
    Run something through <em>Try it</em> and this becomes a waterfall: what arrived, the bite each layer took
    out of what reached it, and what actually left. Each layer only sees what the one above it produced, so the
    percentages compound rather than add.</div>`;

  host.innerHTML = waterfall + `<div class="pipe-layers">${layers.map((l, i) => `
    <div class="pl-row${l.on ? "" : " off"}">
      <div class="plr-n">${i + 1}</div>
      <div class="plr-b">
        <div class="plr-k" style="color:${l.on ? l.ink : "var(--txt-4)"}">${esc(l.k)}</div>
        <div class="plr-n2">${esc(l.n)}</div>
      </div>
      <div class="plr-s">${esc(l.state)}</div>
    </div>`).join("")}</div>`;
}

async function saveCompression(patch) {
  try {
    await api("/api/panel/compression", { method: "POST", body: JSON.stringify(patch) });
    refresh();
  } catch (err) { alert(err.message); }
}

// =========================================================================
// GUARDS — two heuristics, and the honest thing to show is what each one
// actually looks for. The pattern names come from the server so the coverage
// list on screen cannot drift from the patterns that are really running.
// =========================================================================

const PII_LABEL = {
  email: ["Email addresses", "Local-part and domain, in plain text and in multimodal content parts."],
  credit_card: ["Card numbers", "Luhn-validated, so a 16-digit order id is not mistaken for a PAN."],
  iban: ["IBANs", "Bank account numbers in the international format."],
  api_key: ["API-key shapes", "Long high-entropy tokens with a recognisable vendor prefix."],
  private_key_block: ["Private-key blocks", "PEM armour and everything between it."],
  jwt: ["JWTs", "Three base64url segments, usually carrying a whole session."]
};
const INJ_LABEL = {
  instruction_override: ["Instruction override", "“ignore all previous instructions” and its close relatives."],
  role_hijack: ["Role hijack", "“you are now… unrestricted / jailbroken / developer mode”."],
  system_prompt_exfil: ["System-prompt exfiltration", "Asking the model to reveal or repeat its own instructions."],
  fake_system_turn: ["Forged system turn", "Chat-template markers smuggled into a user or tool message."],
  delimiter_escape: ["Delimiter escape", "Closing tags meant to break out of the surrounding message."]
};

PAGES.guards = (el, s) => {
  const sec = s.security || {};
  const cov = sec.guardCoverage || { pii: [], injection: [] };
  const mode = sec.injectionMode || "off";

  el.innerHTML = `
    <div class="alerts-band">
      <div class="alert">
        <div class="ai" style="background:var(--conn-dim);color:var(--conn)">&#8226;</div>
        <div><div class="at">These are heuristics, not boundaries</div>
          <div class="ab">PII redaction is pattern matching, not DLP. It will miss unusual formats, names and
            anything contextual. Injection detection is a known-unsolved problem: it catches low-effort attempts and
            will not stop a determined adversary. Both are defence in depth, and neither is a reason to send
            something you would not otherwise send.</div></div>
      </div>
    </div>

    <section class="zone guardzone">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">PII redaction</span>
          <span class="scope-tag c">OUTBOUND</span>
          <span class="p-s">${sec.redactPii ? esc(cov.pii.length) + " PATTERN(S) ARMED" : "DISARMED"}</span>
        </div>
        <div class="setrow">
          <div><div class="nm">Strip recognised secrets before dispatch</div>
            <div class="hh">Runs on every outbound message, in plain text and in multimodal content parts.
              A match is replaced in place, so the model still sees the shape of the sentence.</div></div>
          <div class="switch ${sec.redactPii ? "on" : ""}" id="toggleRedact"></div>
        </div>
        <div class="cov-head">WHAT IT CATCHES</div>
        <div class="cov ${sec.redactPii ? "" : "off"}">${cov.pii.length
          ? cov.pii.map((n) => {
              const [t, d] = PII_LABEL[n] || [n, ""];
              return `<div class="cov-row"><i></i><div><b>${esc(t)}</b><span>${esc(d)}</span></div>
                <code>${esc(n)}</code></div>`;
            }).join("")
          : '<div class="empty-note">The gateway did not report its pattern list.</div>'}</div>
        <div class="cov-foot">Anything not in this list passes through untouched: names, addresses, free-text
          secrets and anything that only reads as sensitive in context.</div>
      </div>

      <div class="pane">
        <div class="p-head">
          <span class="p-t">Prompt-injection scan</span>
          <span class="scope-tag p">INBOUND</span>
          <span class="p-s">${esc(mode.toUpperCase())}</span>
        </div>
        <div class="setrow">
          <div><div class="nm">Scan user and tool turns</div>
            <div class="hh">Tool results carry text you do not control, which makes them the primary
              indirect-injection vector. Your own system prompt is never scanned.</div></div>
          <select id="injectionMode" style="width:120px">
            <option value="off">off</option><option value="flag">flag</option><option value="block">block</option>
          </select>
        </div>
        <div class="mode-rail">
          ${["off", "flag", "block"].map((m) => `<div class="mode ${m === mode ? "on" : ""}">
            <b>${esc(m)}</b><span>${esc({
              off: "Nothing is scanned. Fastest, and blind.",
              flag: "Matches are logged and the request still goes through.",
              block: "A match is rejected before it reaches a provider."
            }[m])}</span></div>`).join("")}
        </div>
        <div class="cov-head">WHAT IT LOOKS FOR</div>
        <div class="cov ${mode === "off" ? "off" : ""}">${cov.injection.length
          ? cov.injection.map((n) => {
              const [t, d] = INJ_LABEL[n] || [n, ""];
              return `<div class="cov-row"><i class="p"></i><div><b>${esc(t)}</b><span>${esc(d)}</span></div>
                <code>${esc(n)}</code></div>`;
            }).join("")
          : '<div class="empty-note">The gateway did not report its pattern list.</div>'}</div>
        <div class="cov-foot">Five shapes of low-effort attack. Novel phrasings, encoded payloads and anything
          that reads as a legitimate instruction will not match.</div>
      </div>
    </section>`;

  el.querySelector("#injectionMode").value = mode;
  el.querySelector("#toggleRedact").addEventListener("click", (e) =>
    saveSecurity({ redactPii: !e.currentTarget.classList.contains("on") }));
  el.querySelector("#injectionMode").addEventListener("change", (e) =>
    saveSecurity({ injectionMode: e.target.value }));
};

async function saveSecurity(patch) {
  try {
    await api("/api/panel/security", { method: "POST", body: JSON.stringify(patch) });
    refresh();
  } catch (err) { alert(err.message); }
}

// =========================================================================
// ACCESS — one key guards several surfaces and deliberately does not guard
// others, and the rate limiter covers a different set again. That is a
// matrix, and stating it is the whole job of this page.
// =========================================================================

// Taken from the middleware mounts in server.js. Each row says what the
// surface is FOR, because "does /api need the key" is only half the question.
const SURFACES = [
  { path: "/v1/*", key: true, limit: true, csrf: true,
    n: "OpenAI-compatible completions. The surface that spends money." },
  { path: "/mcp", key: true, limit: true, csrf: true,
    n: "MCP over HTTP. An unauthenticated one is a remote control for this gateway's spend." },
  { path: "/a2a", key: true, limit: true, csrf: true,
    n: "Agent-to-agent. An unauthenticated one lets any peer run completions on your keys." },
  { path: "/api/panel/*", key: true, limit: false, csrf: true,
    n: "The control plane. Deliberately NOT rate limited. The request that turns the limiter off must never be the one it rejects." },
  { path: "/panel", key: false, limit: false, csrf: false,
    n: "Panel assets. Reachable without the key on purpose: the page holds no data of its own and has to be able to ask you for one." },
  { path: "/health", key: false, limit: false, csrf: false,
    n: "Liveness only. Returns no configuration and no traffic figures." }
];

PAGES.access = (el, s) => {
  const sec = s.security || {};
  const rl = sec.rateLimit || {};
  const exposed = sec.exposedBeyondLoopback;
  const locked = s.gatewayAuthEnabled;

  el.innerHTML = `
    ${exposed && !locked ? `<div class="alerts-band"><div class="alert bad">
      <div class="ai">!</div>
      <div><div class="at">Bound beyond loopback with no key set</div>
        <div class="ab">Anyone who can reach ${esc(sec.boundHost)} on this port can change caps, toggle lanes,
          run completions on your credentials and read every figure in this panel. Set a key now.</div></div>
    </div></div>` : ""}

    <section class="zone lockzone">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">Barrier lock</span>
          <span class="p-s">${locked ? "LOCKED" : "OPEN"}</span>
        </div>
        <div class="lock-state ${locked ? "on" : "off"}">
          <div class="ls-v">${locked ? "LOCKED" : "OPEN"}</div>
          <div class="ls-n">${locked
            ? "Every <em>/v1</em>, <em>/mcp</em>, <em>/a2a</em> and <em>/api</em> request needs <em>Authorization: Bearer &lt;key&gt;</em>. Comparison is constant-time."
            : "No key is set, so every surface below that says <em>key</em> is currently answering anyone who can reach this port."}</div>
        </div>
        <div class="row" style="margin-top:16px">
          <input type="password" id="gatewayKeyInput" placeholder="${locked ? "locked · enter a new key to replace" : "unlocked · set a key to lock"}" />
          <button class="sm nowrap" id="gatewayKeyGen">Generate</button>
          <button class="sm primary nowrap" id="gatewayKeySave">Save</button>
          <button class="sm danger nowrap" id="gatewayKeyClear">Clear</button>
        </div>
        <div class="lock-hint">Minimum 16 characters. Saving one here also stores it in this browser, so the panel
          keeps working without a reload.</div>

        <div class="cov-head">SURFACE COVERAGE</div>
        <div class="surf">
          <div class="surf-row head"><span>PATH</span><span class="c">KEY</span><span class="c">RATE LIMIT</span><span>WHAT IT IS</span></div>
          ${SURFACES.map((x) => `<div class="surf-row">
            <span class="sf-p">${esc(x.path)}</span>
            <span class="c ${x.key ? (locked ? "yes" : "moot") : "no"}">${x.key ? (locked ? "&#10003;" : "&#10003;*") : "&mdash;"}</span>
            <span class="c ${x.limit ? (rl.enabled ? "yes" : "moot") : "no"}">${x.limit ? (rl.enabled ? "&#10003;" : "&#10003;*") : "&mdash;"}</span>
            <span class="sf-n">${esc(x.n)}</span>
          </div>`).join("")}
        </div>
        <div class="cov-foot">${locked && rl.enabled
          ? "Every tick is live. The cross-site guard runs ahead of authentication on all four state-changing surfaces, because the case it exists for is the one where auth is a no-op."
          : `<em>&#10003;*</em> marks a control that would apply but is currently switched off:
             ${!locked ? "no gateway key is set" : ""}${!locked && !rl.enabled ? ", and " : ""}${!rl.enabled ? "the rate limiter is disabled" : ""}.`}</div>
      </div>

      <aside class="pane posture-pane">
        <div class="p-head"><span class="p-t">Network posture</span><span class="p-s">${exposed ? "EXPOSED" : "LOOPBACK"}</span></div>
        <div class="post-row ${exposed ? "warn" : "ok"}">
          <div class="pr-k">BOUND HOST</div>
          <div class="pr-v">${esc(sec.boundHost || "?")}</div>
          <div class="pr-n">${exposed
            ? "Reachable from the network. Loopback is the default precisely because the panel API is unauthenticated until a key is set."
            : "Loopback only. Nothing off this machine can reach the gateway. Set <em>BIND_HOST</em> to change."}</div>
        </div>
        <div class="post-row ok">
          <div class="pr-k">HOST-HEADER GUARD</div>
          <div class="pr-v">active</div>
          <div class="pr-n">Only requests addressed to localhost or an IP literal are answered, which is what stops
            DNS rebinding. Add legitimate hostnames to <em>TOLLPIKE_ALLOWED_HOSTS</em>.</div>
        </div>
        <div class="post-row ${sec.keyEncryptedAtRest ? "ok" : sec.encryptionAvailable ? "" : "warn"}">
          <div class="pr-k">KEY AT REST</div>
          <div class="pr-v">${esc(sec.keyEncryptedAtRest ? "encrypted" : sec.encryptionAvailable ? "ready" : "plaintext")}</div>
          <div class="pr-n">${sec.keyEncryptedAtRest
            ? "AES-256-GCM, key derived via scrypt from a per-install random salt."
            : sec.encryptionAvailable
              ? "<em>TOLLPIKE_SECRET</em> is set, so the next key saved from here is written as ciphertext."
              : "Set <em>TOLLPIKE_SECRET</em> to encrypt the stored key. Without it the key is written as honest plaintext rather than fake-encrypted with a hardcoded one."}</div>
        </div>
      </aside>
    </section>

    <section class="zone ratezone">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">Rate limit</span>
          <span class="p-s">${rl.enabled ? esc(rl.refillPerMinute ?? 60) + "/MIN" : "OFF"}</span>
        </div>
        <div class="rate-body">
          <div class="setrow">
            <div><div class="nm">Token bucket on the spending surfaces</div>
              <div class="hh">Keyed by an HMAC of the gateway key, or by source IP when no key is set, and evaluated
                <b>after</b> authentication. The other order let a stranger name someone else's bucket and drain
                it without ever holding a valid key.</div></div>
            <div class="switch ${rl.enabled ? "on" : ""}" id="toggleRateLimit"></div>
          </div>
          <div class="setrow">
            <div><div class="nm">Requests per minute</div>
              <div class="hh">Also the burst capacity: the bucket starts full, so a burst this size is allowed
                immediately and then refills at this rate.</div></div>
            <input type="number" min="1" id="rateLimitRpm" value="${esc(rl.refillPerMinute ?? 60)}" style="width:100px" />
          </div>
          <div id="bucketHost"></div>
        </div>
      </div>
      <aside class="pane">
        <div class="p-head"><span class="p-t">What it is for</span></div>
        <div class="why-note">
          <p>A runaway agent loop can burn a month of paid quota in seconds. That is the one failure this limiter
            exists to stop, and it is a <b>/v1</b> concern, which is why the control plane is exempt.</p>
          <p>It is not a defence against an attacker who has your key. Someone holding a valid key can wait out
            a bucket; the limiter only bounds the rate, never the total. The thing that bounds the total is a
            <em>monthly cap</em> on the Budgets page.</p>
        </div>
      </aside>
    </section>`;

  paintBucket(rl);

  el.querySelector("#gatewayKeyGen").addEventListener("click", async () => {
    const { apiKey } = await api("/api/panel/generate-key", { method: "POST" });
    const input = el.querySelector("#gatewayKeyInput");
    input.type = "text";
    input.value = apiKey;
  });
  el.querySelector("#gatewayKeySave").addEventListener("click", async () => {
    const value = el.querySelector("#gatewayKeyInput").value;
    try {
      await api("/api/panel/gateway-key", { method: "POST", body: JSON.stringify({ apiKey: value || null }) });
      if (value) localStorage.setItem(AUTH_STORAGE_KEY, value);
      refresh();
    } catch (err) { alert(err.message); }
  });
  el.querySelector("#gatewayKeyClear").addEventListener("click", async () => {
    await api("/api/panel/gateway-key", { method: "POST", body: JSON.stringify({ apiKey: null }) });
    localStorage.removeItem(AUTH_STORAGE_KEY);
    refresh();
  });
  el.querySelector("#toggleRateLimit").addEventListener("click", (e) => {
    const rpm = Number(el.querySelector("#rateLimitRpm").value) || 60;
    saveSecurity({ rateLimit: { enabled: !e.currentTarget.classList.contains("on"), capacity: rpm, refillPerMinute: rpm } });
  });
  el.querySelector("#rateLimitRpm").addEventListener("change", (e) => {
    const rpm = Number(e.target.value) || 60;
    saveSecurity({ rateLimit: { enabled: rl.enabled === true, capacity: rpm, refillPerMinute: rpm } });
  });
};

// Capacity and refill are the same number here, so the bucket is drawn as
// what it is: a burst you can spend at once, then a steady trickle back.
function paintBucket(rl) {
  const host = document.getElementById("bucketHost");
  if (!host) return;
  const rpm = Number(rl.refillPerMinute) || 60;
  if (!rl.enabled) {
    host.innerHTML = `<div class="empty-note" style="margin-top:16px">
      <b>No limit is being applied.</b>
      With the bucket off, a client holding a valid key can issue requests as fast as it can open sockets.
      That is fine for a human at a keyboard and expensive for an agent in a retry loop.</div>`;
    return;
  }
  const per = 60 / rpm;
  host.innerHTML = `<div class="bucket">
    <div class="bk-row"><span class="bk-k">BURST</span>
      <div class="bk-t">${Array.from({ length: 20 }, () => '<i class="f"></i>').join("")}</div>
      <span class="bk-v">${esc(rpm)}</span></div>
    <div class="bk-n">The bucket starts full, so the first <b>${esc(rpm)}</b> requests in a quiet minute go through
      back to back. After that one token returns every <b>${esc(per < 1 ? per.toFixed(2) : per.toFixed(1))}s</b>,
      and a caller that outruns the refill gets <em>429</em> until it slows down.</div>
  </div>`;
}

// =========================================================================
// PROXY — three levels resolve to one answer per lane, and the answer is
// what matters. The plan comes from the engine's own resolver rather than
// being re-derived here, so the page cannot disagree with the egress.
// =========================================================================

const PROXY_CATEGORIES = ["frontier", "inference", "aggregator", "local"];
let proxyPlan = null;
let tlsInfo = null;

PAGES.proxy = (el, s) => {
  const p = s.proxy || {};
  const configured = Object.entries(p.configured || {});
  const categories = Object.entries(p.categories || {});

  el.innerHTML = `
    <section class="zone egress">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">Egress plan</span>
          <span class="p-s" id="planMeta"></span>
        </div>
        <div class="egress-intro">What every lane will actually do, and which level decided it. Resolution runs
          <b>provider &#8594; category &#8594; global &#8594; environment</b>, first match wins. If a configured proxy
          cannot be honoured the request <b>fails</b> rather than quietly going direct, because silently bypassing a
          proxy leaks traffic you believed was routed.</div>
        <div id="planHost"><div class="empty-note">Resolving the plan&hellip;</div></div>
      </div>
      <aside class="pane posture-pane">
        <div class="p-head"><span class="p-t">Posture</span><span class="p-s">${p.available ? "AGENT READY" : "AGENT MISSING"}</span></div>
        <div class="post-row ${p.available ? "ok" : "warn"}">
          <div class="pr-k">PROXY AGENT</div>
          <div class="pr-v">${p.available ? "available" : "unavailable"}</div>
          <div class="pr-n">${esc(p.loadError || "undici ProxyAgent loaded. HTTP(S) and SOCKS5 URLs are both accepted.")}</div>
        </div>
        <div class="post-row ${p.envFallback ? "" : "ok"}">
          <div class="pr-k">ENVIRONMENT FALLBACK</div>
          <div class="pr-v">${esc(p.envFallback || "none")}</div>
          <div class="pr-n">HTTPS_PROXY / HTTP_PROXY / ALL_PROXY. Used only for lanes with no rule above them.</div>
        </div>
        <div class="post-row ok">
          <div class="pr-k">TLS INTERCEPTION</div>
          <div class="pr-v">none</div>
          <div class="pr-n">${esc(p.interception || "Provider TLS is never terminated, decrypted or re-signed.")}
            A proxy sees the connection, not its contents.</div>
        </div>
      </aside>
    </section>

    <section class="zone rules">
      <div class="pane">
        <div class="p-head"><span class="p-t">Rules</span><span class="p-s">${esc(configured.length + categories.length)} DEFINED ACROSS 3 LEVELS</span></div>
        <div id="ruleHost"></div>
        <div class="cov-head">ADD OR REPLACE</div>
        <div class="two" style="margin-top:12px">
          <div><label>Scope</label><select id="proxyProvider">
            <option value="*">&#42; &#183; every provider (global)</option>
            ${PROXY_CATEGORIES.map((c) => `<option value="cat:${esc(c)}">category &#183; ${esc(c)}</option>`).join("")}
            ${s.providers.map((x) => `<option value="${esc(x.id)}">provider &#183; ${esc(x.name)}</option>`).join("")}
          </select></div>
          <div><label>Proxy URL (blank removes)</label><input id="proxyUrl" placeholder="http://host:8080 or socks5://host:1080" /></div>
        </div>
        <button class="primary sm" id="proxySave" style="margin-top:13px">Save rule</button>
      </div>
      <aside class="pane">
        <div class="p-head"><span class="p-t">TLS shaping</span><span class="p-s" id="tlsMeta"></span></div>
        <div id="tlsHost"><div class="empty-note">Loading profiles&hellip;</div></div>
      </aside>
    </section>`;

  // --- rules by level ---
  const ruleHost = el.querySelector("#ruleHost");
  const levelBlock = (label, tag, entries, delAttr, hint) => `
    <div class="rule-level">
      <div class="rl-h"><span class="scope-tag ${tag}">${label}</span><span>${esc(entries.length)} RULE(S)</span></div>
      ${entries.length
        ? entries.map(([k, v]) => `<div class="rule-row">
            <span class="rr-k">${esc(k === "*" ? "every provider" : k)}</span>
            <span class="rr-v">${esc(v)}</span>
            <button class="sm danger" ${delAttr}="${esc(k)}">Remove</button>
          </div>`).join("")
        : `<div class="rule-none">${esc(hint)}</div>`}
    </div>`;
  ruleHost.innerHTML =
    levelBlock("LEVEL 1 &#183; PROVIDER", "p", configured.filter(([k]) => k !== "*"), "data-proxy-del",
      "No per-provider rule. A lane falls through to its category.")
    + levelBlock("LEVEL 2 &#183; CATEGORY", "c", categories, "data-proxy-cat-del",
      "No category rule. Lanes fall through to the global rule.")
    + levelBlock("LEVEL 3 &#183; GLOBAL", "m", configured.filter(([k]) => k === "*"), "data-proxy-del",
      "No global rule. Lanes fall through to the environment, then go direct.");

  el.querySelectorAll("[data-proxy-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api("/api/panel/proxy", { method: "POST", body: JSON.stringify({ providerId: b.dataset.proxyDel, url: null }) });
      proxyPlan = null;
      refresh();
    }));
  el.querySelectorAll("[data-proxy-cat-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api("/api/panel/proxy/category", { method: "POST", body: JSON.stringify({ category: b.dataset.proxyCatDel, url: null }) });
      proxyPlan = null;
      refresh();
    }));
  el.querySelector("#proxySave").addEventListener("click", async () => {
    const scope = el.querySelector("#proxyProvider").value;
    const url = el.querySelector("#proxyUrl").value || null;
    try {
      if (scope.startsWith("cat:")) {
        await api("/api/panel/proxy/category", { method: "POST", body: JSON.stringify({ category: scope.slice(4), url }) });
      } else {
        await api("/api/panel/proxy", { method: "POST", body: JSON.stringify({ providerId: scope, url }) });
      }
      proxyPlan = null;
      refresh();
    } catch (err) { alert(err.message); }
  });

  paintPlan(s);
  paintTls();
  loadProxyExtras(s);
  wireFocusLink(el);
  restoreFocus();
};

async function loadProxyExtras(s) {
  try {
    const r = await api("/api/panel/proxy/plan");
    proxyPlan = r.plan || [];
  } catch { proxyPlan = null; }
  try {
    tlsInfo = await api("/api/panel/tls");
  } catch { tlsInfo = null; }
  if (current === "proxy" && state) { paintPlan(state); paintTls(); }
}

function paintPlan(s) {
  const host = document.getElementById("planHost");
  const meta = document.getElementById("planMeta");
  if (!host) return;
  if (proxyPlan === null) {
    host.innerHTML = '<div class="empty-note"><b>The plan could not be resolved.</b>The gateway did not answer, so nothing is shown rather than a guess at what egress will do.</div>';
    return;
  }
  const routed = proxyPlan.filter((x) => x.proxy);
  if (meta) {
    meta.textContent = routed.length
      ? `${routed.length} OF ${proxyPlan.length} LANE(S) PROXIED`
      : `ALL ${proxyPlan.length} LANES DIRECT`;
  }
  if (!proxyPlan.length) {
    host.innerHTML = '<div class="empty-note"><b>No provider configured.</b>Lanes appear here with the proxy each one resolves to.</div>';
    return;
  }
  const LEVEL_TAG = { provider: "p", category: "c", global: "m", env: "" };
  host.innerHTML = `<div class="plan">
    <div class="plan-row head"><span>LANE</span><span>CATEGORY</span><span>DECIDED AT</span><span>EGRESS</span></div>
    ${[...proxyPlan].sort((a, b) => Number(Boolean(b.proxy)) - Number(Boolean(a.proxy))).map((x) => `
      <div class="plan-row${x.proxy ? "" : " direct"}" data-prov="${esc(x.provider)}">
        <span class="pn-p">${esc(x.provider)}</span>
        <span class="pn-c">${esc(x.category || "—")}</span>
        <span class="pn-l">${x.proxy
          ? `<span class="scope-tag ${LEVEL_TAG[x.level] || ""}">${esc(String(x.level).toUpperCase())}</span>`
          : '<span class="pn-none">no rule</span>'}</span>
        <span class="pn-e">${x.proxy ? esc(x.proxy) : "direct"}</span>
      </div>`).join("")}
  </div>`;
}

function paintTls() {
  const host = document.getElementById("tlsHost");
  const meta = document.getElementById("tlsMeta");
  if (!host) return;
  if (!tlsInfo) {
    host.innerHTML = '<div class="empty-note">TLS profiles unavailable.</div>';
    return;
  }
  if (meta) meta.textContent = esc(String(tlsInfo.active || "default").toUpperCase());
  host.innerHTML = `
    <div class="tls-note">${esc(tlsInfo.caveat || "")}</div>
    <div class="tls-list">${(tlsInfo.profiles || []).map((pr) => `
      <div class="tls-row${pr.id === tlsInfo.active ? " on" : ""}" data-tls="${esc(pr.id)}">
        <div class="tl-h">${esc(pr.label)}${pr.id === tlsInfo.active ? '<em>ACTIVE</em>' : ""}</div>
        <div class="tl-d">${esc(pr.description)}</div>
      </div>`).join("")}</div>`;
  host.querySelectorAll("[data-tls]").forEach((n) => n.addEventListener("click", async () => {
    if (n.dataset.tls === tlsInfo.active) return;
    try {
      tlsInfo = await api("/api/panel/tls", { method: "POST", body: JSON.stringify({ profile: n.dataset.tls }) });
      paintTls();
      refresh();
    } catch (err) { alert(err.message); }
  }));
}

PAGES.endpoints = (el, s) => {
  const e = s.endpoints || {};
  const base = e.base || location.origin;
  const modelCount = s.providers.reduce((a, p) => a + p.models.length, 0);
  const first = s.providers.find((p) => p.hasKey && p.enabled);
  const sample = first ? `${first.id}/${first.models[0]}` : "provider/model";
  const locked = s.gatewayAuthEnabled;

  // The snippets are the point of this page: something you can paste. They are
  // built from the gateway's own reported base URL, never from a guess.
  const SNIPPETS = [
    { id: "curl", label: "curl", lang: "bash", body:
`curl ${base}/v1/chat/completions \\
  -H "Content-Type: application/json"${locked ? ` \\
  -H "Authorization: Bearer $TOLLPIKE_KEY"` : ""} \\
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'` },
    { id: "openai-py", label: "OpenAI · Python", lang: "python", body:
`from openai import OpenAI

client = OpenAI(
    base_url="${base}/v1",
    api_key=${locked ? '"…your gateway key…"' : '"unused"'},
)
r = client.chat.completions.create(
    model="auto",                 # or "${sample}" to pin one lane
    messages=[{"role": "user", "content": "hello"}],
)` },
    { id: "openai-js", label: "OpenAI · Node", lang: "javascript", body:
`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}/v1",
  apiKey: ${locked ? "process.env.TOLLPIKE_KEY" : '"unused"'},
});
const r = await client.chat.completions.create({
  model: "auto",                  // or "${sample}" to pin one lane
  messages: [{ role: "user", content: "hello" }],
});` },
    { id: "env", label: "Environment", lang: "bash", body:
`OPENAI_BASE_URL=${base}/v1
OPENAI_API_KEY=${locked ? "…your gateway key…" : "unused"}` }
  ];

  const ROUTES = [
    { m: "POST", p: "/v1/chat/completions", tag: "buffered + SSE", ok: true,
      n: "The one that matters. Streams if you ask for it, and the fallback chain is walked before the first byte." },
    { m: "GET", p: "/v1/models", tag: `${modelCount} listed`, ok: true,
      n: "Every model on every configured lane, as <em>provider/model</em>. Unavailable lanes are listed with <em>available: false</em> rather than hidden." },
    { m: "GET", p: "/health", tag: "open", ok: true,
      n: "Liveness only. No configuration, no traffic figures, no key required." },
    { m: "·", p: "/api/panel/*", tag: locked ? "locked" : "unlocked", ok: locked,
      n: "The control plane behind this panel. Same key as <em>/v1</em>, deliberately not rate limited." },
    { m: "·", p: "/mcp · /a2a", tag: "agent surface", ok: true,
      n: "The gateway as tools an agent can operate. Same key and the same limiter as <em>/v1</em>." }
  ];

  const HEADERS = [
    ["X-Tollpike-Provider", "Which lane actually answered, not which one you asked for."],
    ["X-Tollpike-Cache", "HIT, MISS or BYPASS. BYPASS means the request was not cacheable, usually temperature above zero."],
    ["X-Tollpike-Attempts", "How many candidates were walked before one answered. Greater than 1 means a fallback fired."],
    ["X-Tollpike-Compression-Saved-Pct", "What the compression passes removed, as a share of the original."],
    ["X-Tollpike-Compression-Detail", "The same figure split per layer, matching the waterfall on the Compression page."]
  ];

  el.innerHTML = `
    <section class="zone connect">
      <div class="pane">
        <div class="p-head">
          <span class="p-t">Connect</span>
          <span class="p-s">OPENAI-COMPATIBLE &#183; ${locked ? "KEY REQUIRED" : "NO KEY SET"}</span>
        </div>
        <div class="conn-lede">
          <div class="cl-k">API BASE</div>
          <div class="cl-v" id="baseUrl">${esc(base)}/v1</div>
          <button class="sm" id="copyBase">Copy</button>
        </div>
        <div class="conn-note">Point any OpenAI-compatible client at that URL. Use <em>auto</em> as the model to walk
          the fallback chain, or <em>${esc(sample)}</em> to pin one lane.
          ${locked ? "Every request needs <em>Authorization: Bearer &lt;key&gt;</em>." : "No key is set, so the bearer header is optional, and so is everyone else's."}</div>

        <div class="seg" id="snipSeg" style="margin-top:18px">${SNIPPETS.map((x, i) =>
          `<b data-snip="${esc(x.id)}"${i === 0 ? ' class="on"' : ""}>${esc(x.label)}</b>`).join("")}</div>
        <div class="snip"><pre id="snipBody" class="mono"></pre><button class="sm" id="copySnip">Copy</button></div>
      </div>
      <aside class="pane posture-pane">
        <div class="p-head"><span class="p-t">Response headers</span><span class="p-s">ON EVERY /v1 REPLY</span></div>
        <div class="hdrs">${HEADERS.map(([k, v]) => `<div class="hdr-row">
          <div class="hdr-k">${esc(k)}</div><div class="hdr-v">${esc(v)}</div></div>`).join("")}</div>
        <div class="cov-foot">These are how you tell what happened without opening this panel. Every one of
          them is also a column somewhere on the control center.</div>
      </aside>
    </section>

    <section class="zone routes">
      <div class="pane">
        <div class="p-head"><span class="p-t">Surface</span><span class="p-s">${esc(ROUTES.length)} ROUTES</span></div>
        <div class="rt">${ROUTES.map((r) => `<div class="rt-row">
          <span class="rt-m">${esc(r.m)}</span>
          <span class="rt-p">${esc(r.p)}</span>
          <span class="badge ${r.ok ? "on" : "warn"}">${esc(r.tag)}</span>
          <span class="rt-n">${r.n}</span>
        </div>`).join("")}</div>
      </div>
      <aside class="pane">
        <div class="p-head"><span class="p-t">Pinning a lane</span></div>
        <div class="why-note">
          <p><b>auto</b> walks the fallback chain and is what you want almost always. It is the only mode
            where a dead provider costs you a retry rather than an outage.</p>
          <p><b>auto/&lt;strategy&gt;</b> keeps the fallback but changes the order. <b>combo/&lt;name&gt;</b> uses a
            tiered policy. Both are on the <em>Combos</em> page.</p>
          <p><b>${esc(sample)}</b> pins one lane exactly. Nothing falls back from a pinned request: if that lane is
            cooling, capped or open, the call fails rather than quietly going somewhere you did not ask for.</p>
        </div>
      </aside>
    </section>`;

  const body = el.querySelector("#snipBody");
  const show = (id) => {
    const snip = SNIPPETS.find((x) => x.id === id) || SNIPPETS[0];
    body.textContent = snip.body;   // never markup
  };
  show(SNIPPETS[0].id);
  el.querySelectorAll("#snipSeg b").forEach((b) => b.addEventListener("click", () => {
    el.querySelectorAll("#snipSeg b").forEach((x) => x.classList.toggle("on", x === b));
    show(b.dataset.snip);
  }));
  const copy = (text, btn) => {
    navigator.clipboard?.writeText(text).then(() => {
      const was = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = was; }, 1400);
    }).catch(() => {});
  };
  el.querySelector("#copyBase").addEventListener("click", (ev) => copy(`${base}/v1`, ev.currentTarget));
  el.querySelector("#copySnip").addEventListener("click", (ev) => copy(body.textContent, ev.currentTarget));
};

// --- Pages: routing combos, quota, memory, knowledge, agents -------------
//
// These pages fetch their own data rather than reading `state`: each is backed
// by an endpoint doing real work (a Qdrant probe, a health poll, a vault scan)
// that has no business running on the 8-second dashboard refresh.
//
// Anything that originated outside this process — recalled memory text, note
// excerpts, sidecar log lines, cloud-agent output — is written with
// textContent, never interpolated into markup. Escaping would be sufficient
// today; DOM nodes are what survives someone later "simplifying" a template.
// The panel holds the gateway key in localStorage, so this is a credential
// boundary, not a formatting preference.

function textRows(container, items, render) {
  container.textContent = "";
  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "row";
    render(row, item, index);
    container.appendChild(row);
  });
}

// How many lanes the chain preview lists before summarising the rest. The full
// chain is every configured provider, and rendering 36 rows pushes everything
// else on the page below the fold — the useful part is the head of the chain.
const PREVIEW_ROWS = 14;

function span(className, text) {
  const el = document.createElement("span");
  if (className) el.className = className;
  el.textContent = String(text ?? "");
  return el;
}

// The eight self-fetching pages all pass through here. Both states below are
// on screen often enough to deserve the same grammar as everything else: a
// loading state that does not shift the layout when it resolves, and a failure
// that says which page, what went wrong, and what to do about it.
async function loadPage(el, fetcher, render) {
  el.innerHTML = `<section class="zone loadstate"><div class="pane">
      <div class="p-head"><span class="p-t">Loading</span><span class="p-s">ASKING THE GATEWAY</span></div>
      <div class="skel"><i></i><i></i><i></i></div>
    </div></section>`;
  try {
    render(el, await fetcher());
  } catch (err) {
    // This endpoint does real work — a Qdrant probe, a health poll, a vault
    // scan — so a failure here is usually a subsystem being down rather than
    // the gateway itself, and the difference is worth stating.
    el.innerHTML = `<section class="zone loadstate"><div class="pane">
      <div class="p-head"><span class="p-t">Could not load this page</span><span class="p-s">NOTHING SHOWN RATHER THAN A GUESS</span></div>
      <div class="empty-note">
        <b>${esc(err.message)}</b>
        This page fetches its own data instead of reading the dashboard's state, because the endpoint
        behind it does real work. A failure here usually means that subsystem is unreachable rather
        than the gateway being down. The rest of the console will still be live.
      </div>
      <div class="row"><button class="sm" data-retry="1">Try again</button></div>
    </div></section>`;
    el.querySelector("[data-retry]")?.addEventListener("click", () => loadPage(el, fetcher, render));
  }
}

// =========================================================================
// COMBOS — a combo is a tiered structure, so it is drawn as one. Tier 1 is
// where you want traffic, tier 2 is what you accept when tier 1 is out,
// tier 3 is what you accept rather than fail. That sentence was the page's
// opening paragraph; it is now the shape of every card on it.
// =========================================================================

const TIER_ROLE = [
  "WHERE YOU WANT TRAFFIC",
  "ACCEPTED WHEN TIER 1 IS OUT",
  "ACCEPTED RATHER THAN FAIL",
  "LAST RESORT"
];

PAGES.combos = (el) =>
  loadPage(el, () => api("/api/panel/strategies"), (root, data) => {
    root.innerHTML = `
      <section class="zone combozone">
        <div class="pane">
          <div class="p-head">
            <span class="p-t">Routing combos</span>
            <span class="p-s">${esc(data.combos.length)} DEFINED · UP TO ${esc(data.maxTiers)} TIERS EACH</span>
          </div>
          <div class="combo-intro">A <b>strategy</b> orders every lane best-first. A <b>combo</b> stacks strategies
            into tiers and walks them in order. Every strategy is a total order and never a filter, so the fallback
            chain always contains every lane. Nothing silently disappears from it.</div>
          <div id="comboHost"></div>
        </div>
        <aside class="pane preview-pane">
          <div class="p-head"><span class="p-t">Chain preview</span><span class="p-s" id="pvMeta"></span></div>
          <div class="pv-note">The exact order a request would try, resolved by the engine, without sending one.</div>
          <div class="row" style="margin:13px 0 4px">
            <input id="previewModel" class="mono" placeholder="combo/free-first" value="${esc(data.defaultCombo ? "combo/" + data.defaultCombo : "combo/free-first")}" style="flex:1" />
            <button class="sm" id="previewBtn">Preview</button>
          </div>
          <div id="previewOut"></div>
        </aside>
      </section>

      <section class="zone strategyzone">
        <div class="pane">
          <div class="p-head">
            <span class="p-t">Strategy catalogue</span>
            <span class="p-s">${esc(data.strategies.length)} AVAILABLE · ROUTE WITH auto/&lt;id&gt;</span>
          </div>
          <div class="strat-grid">${data.strategies.map((st) => `
            <div class="strat-card">
              <div class="sc-h">${esc(st.label)}</div>
              <div class="sc-r">${esc(st.route)}</div>
              <div class="sc-d">${esc(st.description)}</div>
            </div>`).join("")}
          </div>
        </div>
        <aside class="pane">
          <div class="p-head"><span class="p-t">Subscription lanes</span><span class="p-s" id="subMeta"></span></div>
          <div class="sub-note"><b>You declare this.</b> Nothing in a provider's API reports "this key is included
            in a plan you already bought", so it cannot be detected, and a gateway that guessed would either
            waste a plan you are paying for or bill you for one you are not.
            <span class="mono">auto/drain-subscription</span> puts whatever you tick here first.</div>
          <div id="subsList" class="filters" style="margin-top:15px"></div>
        </aside>
      </section>`;

    // --- combo ladders ---
    const host = root.querySelector("#comboHost");
    host.innerHTML = data.combos.length ? data.combos.map((combo) => {
      const isDefault = data.defaultCombo === combo.name;
      return `<div class="combo${isDefault ? " on" : ""}">
        <div class="cb-head">
          <span class="cb-nm">${esc(combo.label)}</span>
          ${combo.custom ? '<span class="badge on">custom</span>' : ""}
          ${combo.strict ? '<span class="badge warn">strict</span>' : ""}
          ${isDefault
            ? '<span class="cb-default">DEFAULT FOR auto</span>'
            : `<button class="sm" data-default="${esc(combo.name)}">Make default</button>`}
        </div>
        <div class="cb-route">combo/${esc(combo.name)}</div>
        ${combo.description ? `<div class="cb-desc">${esc(combo.description)}</div>` : ""}
        <div class="cb-tiers">${combo.tiers.map((tier, i) => {
          const filter = Object.keys(tier.filter || {}).length ? JSON.stringify(tier.filter) : "";
          return `<div class="cb-tier">
            <div class="ct-n">T${i + 1}</div>
            <div class="ct-body">
              <div class="ct-s">${esc(tier.strategy)}${filter ? `<em>${esc(filter)}</em>` : ""}</div>
              <div class="ct-r">${esc(TIER_ROLE[i] || TIER_ROLE[TIER_ROLE.length - 1])}</div>
            </div>
          </div>`;
        }).join("")}</div>
        ${combo.custom ? `<div class="cb-foot"><button class="sm danger" data-delete="${esc(combo.name)}">Delete</button></div>` : ""}
      </div>`;
    }).join("") : `<div class="empty-note">
      <b>No combo defined.</b>
      A combo stacks up to ${esc(data.maxTiers)} strategies into tiers and walks them in order, so you can say
      "free lanes first, then whatever is cheapest, then anything at all rather than fail" as one route.
      Until one exists, <em>auto</em> walks plain priority order.</div>`;

    // --- preview ---
    const preview = async () => {
      const model = root.querySelector("#previewModel").value.trim();
      const out = root.querySelector("#previewOut");
      const meta = root.querySelector("#pvMeta");
      out.innerHTML = '<div class="pv-empty">Resolving&hellip;</div>';
      try {
        const result = await api("/api/panel/routing/preview", {
          method: "POST", body: JSON.stringify({ model })
        });
        const rows = result.chain.slice(0, PREVIEW_ROWS);
        if (meta) meta.textContent = `${result.chainLength} HOP${result.chainLength === 1 ? "" : "S"}`;
        if (!rows.length) {
          out.innerHTML = '<div class="pv-empty">That route resolves to nothing. Every candidate is missing a credential or switched off.</div>';
          return;
        }
        // Built as DOM nodes: the route string is operator input and the
        // provider and model ids travel from the registry.
        out.textContent = "";
        const list = document.createElement("div");
        list.className = "pv-list";
        rows.forEach((c, i) => {
          const row = document.createElement("div");
          row.className = `pv-row${c.hasKey && c.enabled ? "" : " off"}`;
          row.setAttribute("data-prov", c.provider);
          row.appendChild(span("pv-n", String(i + 1).padStart(2, "0")));
          const body = document.createElement("div");
          body.className = "pv-b";
          body.appendChild(span("pv-p", c.provider));
          body.appendChild(span("pv-m", c.model));
          row.appendChild(body);
          row.appendChild(span("pv-t", `T${c.tier}`));
          row.appendChild(span("pv-s", c.hasKey ? (c.enabled ? c.strategy : "off") : "no key"));
          list.appendChild(row);
        });
        out.appendChild(list);
        if (result.chainLength > PREVIEW_ROWS) {
          out.appendChild(span("pv-empty", `+ ${result.chainLength - PREVIEW_ROWS} further hop(s) below these`));
        }
      } catch (err) {
        out.innerHTML = "";
        out.appendChild(span("pv-empty", err.message));
        if (meta) meta.textContent = "UNRESOLVED";
      }
    };
    root.querySelector("#previewBtn").addEventListener("click", preview);
    root.querySelector("#previewModel").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); preview(); }
    });
    preview();

    root.querySelectorAll("[data-default]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api("/api/panel/default-combo", { method: "POST", body: JSON.stringify({ name: b.dataset.default }) });
        renderPage("combos");
      })
    );
    root.querySelectorAll("[data-delete]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm(`Delete combo "${b.dataset.delete}"?`)) return;
        await api(`/api/panel/combos/${encodeURIComponent(b.dataset.delete)}`, { method: "DELETE" });
        renderPage("combos");
      })
    );

    const subs = new Set(state?.routing?.subscriptionProviders || []);
    const subsList = root.querySelector("#subsList");
    const subMeta = root.querySelector("#subMeta");
    if (subMeta) subMeta.textContent = subs.size ? `${subs.size} DECLARED` : "NONE DECLARED";
    for (const provider of (state?.providers || []).filter((p) => p.category !== "local")) {
      const chip = document.createElement("div");
      chip.className = `chip ${subs.has(provider.id) ? "on" : ""}`;
      chip.setAttribute("data-prov", provider.id);
      chip.textContent = provider.id;
      chip.addEventListener("click", async () => {
        if (subs.has(provider.id)) subs.delete(provider.id);
        else subs.add(provider.id);
        await api("/api/panel/subscription-providers", {
          method: "POST", body: JSON.stringify({ providerIds: [...subs] })
        });
        refresh();
      });
      subsList.appendChild(chip);
    }
    wireFocusLink(root);
    restoreFocus();
  });

// =========================================================================
// FREE QUOTA — the whole point of this page is that a pool is not a
// provider. Counting per provider reports quota you do not have, so the
// pool meters lead and the providers that collapse into each one are drawn
// inside their own pool rather than listed somewhere else.
// =========================================================================

PAGES.quota = (el) =>
  loadPage(el, () => api("/api/panel/quota"), (root, data) => {
    const t = data.totals;
    root.innerHTML = `
      <div class="alerts-band">
        <div class="alert">
          <div class="ai" style="background:var(--model-dim);color:var(--model)">&#8226;</div>
          <div><div class="at">Observed here, never read from the vendor</div>
            <div class="ab">Almost no provider exposes remaining quota, so every figure below is what this gateway
              itself counted. Usage of the same key from another client is invisible to it. Real remaining
              quota is always this or less, never more.</div></div>
        </div>
        ${t.unverifiedLimits ? `<div class="alert warn"><div class="ai">&#8226;</div>
          <div><div class="at">${esc(t.unverifiedLimits)} free-tier limit(s) unverified</div>
            <div class="ab">These are the vendors' published shapes, not numbers checked against a real account.
              Headroom computed from a wrong limit is confidently wrong.</div></div></div>` : ""}
        ${t.undeclaredFreeTiers?.length ? `<div class="alert warn"><div class="ai">&#8226;</div>
          <div><div class="at">${esc(t.undeclaredFreeTiers.length)} lane(s) have a free tier with no limits configured</div>
            <div class="ab">${esc(t.undeclaredFreeTiers.join(", "))}. Quota that cannot be counted is not counted.
              They are treated as paid lanes rather than reported with imaginary headroom.</div></div></div>` : ""}
      </div>

      <section class="zone poolzone">
        <div class="pane">
          <div class="p-head">
            <span class="p-t">Pools</span>
            <span class="p-s">${esc(data.pools.length)} DISTINCT · WHAT ACTUALLY GETS CONSUMED</span>
          </div>
          <div class="pool-intro">The pool is the honest unit. Two lanes sharing one vendor allowance share one
            counter, so counting per provider would report twice the quota you have.
            <b>${esc(t.dedupedAway)}</b> lane${t.dedupedAway === 1 ? " was" : "s were"} folded away by that rule.
            <span class="mono">assumed</span> means we have not confirmed the vendors really share an allowance.</div>
          <div id="poolHost"></div>
        </div>
        <div class="pane instr-pane">
          <div class="p-head"><span class="p-t">Free tier at a glance</span></div>
          <div class="instr" id="quotaInstr"></div>
        </div>
      </section>

      <section class="zone perprov">
        <div class="pane">
          <div class="p-head"><span class="p-t">Per provider</span><span class="p-s">${esc(data.providers.length)} DECLARED FREE LANE(S)</span></div>
          <div id="qpHost"></div>
        </div>
        <aside class="pane">
          <div class="p-head"><span class="p-t">Counters</span></div>
          <div class="recon-body">
            <div class="setrow">
              <div><div class="nm">Clear observed counters</div>
                <div class="hh">Resets what this gateway has counted today. It changes nothing at the vendor.
                  Their limits keep counting, and the next request still lands against the real allowance.</div></div>
              <button class="sm danger" id="resetQuota">Reset</button>
            </div>
          </div>
        </aside>
      </section>`;

    // --- pool meters: used against the tightest declared limit ---
    const poolHost = root.querySelector("#poolHost");
    poolHost.innerHTML = data.pools.length ? data.pools.map((pool) => {
      const pct = Math.max(0, Math.min(100, (1 - (pool.headroom ?? 1)) * 100));
      const ink = pool.exhausted ? SCOPE.bad : pool.headroom > 0.5 ? SCOPE.ok : pool.headroom > 0 ? SCOPE.conn : SCOPE.bad;
      const shown = Object.entries(pool.remaining || {}).filter(([, v]) => v !== null);
      return `<div class="pool ${pool.exhausted ? "out" : ""}">
        <div class="pool-head">
          <span class="pool-nm">${esc(pool.pool)}</span>
          <span class="badge ${pool.confidence === "known" ? "on" : "warn"}">${esc(pool.confidence)}</span>
          ${pool.exhausted ? '<span class="badge warn">exhausted</span>' : ""}
          <span class="pool-hr" style="color:${ink}">${esc(Math.round((pool.headroom ?? 0) * 100))}<em>% headroom</em></span>
        </div>
        <div class="pool-track"><i style="width:${pct.toFixed(1)}%;background:${ink}"></i></div>
        <div class="pool-scale"><span>${esc(Math.round(pct))}% DRAWN</span><span>${esc(Math.round(100 - pct))}% LEFT</span></div>
        <div class="pool-members">${(pool.members || []).map((m) =>
          `<span data-prov="${esc(m)}">${esc(m)}</span>`).join("")}${
          (pool.members || []).length > 1
            ? `<em>share one counter</em>` : ""}</div>
        <div class="pool-nums">
          <span><b>${esc(pool.used.requestsToday)}</b> req today</span>
          <span><b>${esc(fmtTokens(pool.used.tokensToday))}</b> tok today</span>
          ${shown.map(([k, v]) => `<span class="rem"><b>${esc(v)}</b> ${esc(k.replace("requests", "req").replace("tokens", "tok").replace("ThisMinute", "/min").replace("Today", " left today"))}</span>`).join("")}
        </div>
      </div>`;
    }).join("") : `<div class="empty-note">
      <b>No free-tier pool is being counted.</b>
      A pool appears here for every declared free allowance, with the lanes that draw on it listed inside it and a
      meter against the tightest limit that will actually reject the next request. Lanes whose free tier has no
      configured limits are deliberately excluded rather than shown with invented headroom.</div>`;

    // --- instruments ---
    const ih = root.querySelector("#quotaInstr");
    const dedupPct = t.declaredFreeProviders ? (t.dedupedAway / t.declaredFreeProviders) * 100 : 0;
    ih.innerHTML = `
      <div class="icell">
        <div class="ik">DISTINCT POOLS</div>
        <div class="iv ${t.exhaustedPools ? "warn" : ""}">${esc(t.distinctPools)}</div>
        <div class="segbar">${Array.from({ length: Math.max(1, t.declaredFreeProviders) }, (_, i) =>
          `<i class="${i < t.distinctPools ? "f" : "m"}"></i>`).join("")}</div>
        <div class="is">FROM <em>${esc(t.declaredFreeProviders)}</em> DECLARED FREE LANE(S)</div>
      </div>

      <div class="icell">
        <div class="ik">DEDUPED AWAY</div>
        <div class="iv ${t.dedupedAway ? "warn" : ""}">${esc(t.dedupedAway)}</div>
        ${arcGauge(dedupPct, t.dedupedAway ? SCOPE.conn : SCOPE.dim)}
        <div class="is">${t.dedupedAway
          ? `<em>${esc(Math.round(dedupPct))}%</em> OF FREE LANES SHARE SOMEONE ELSE'S COUNTER`
          : "EVERY FREE LANE HAS ITS OWN ALLOWANCE"}</div>
      </div>

      <div class="icell">
        <div class="ik">EXHAUSTED</div>
        <div class="iv ${t.exhaustedPools ? "bad" : "ok"}">${esc(t.exhaustedPools)}</div>
        <div class="lanestrip">${data.pools.map((p) =>
          `<i class="${p.exhausted ? "open" : p.headroom > 0.5 ? "on" : "cold"}" title="${esc(p.pool)}"></i>`).join("") || "<i></i>"}</div>
        <div class="is">${t.exhaustedPools ? "THE ROUTER SKIPS THESE UNTIL THE WINDOW ROLLS" : "EVERY POOL STILL HAS ROOM"}</div>
      </div>

      <div class="icell">
        <div class="ik">ASSUMED POOLS</div>
        <div class="iv ${t.assumedPools ? "warn" : ""}">${esc(t.assumedPools ?? 0)}<span class="u"> / ${esc(t.distinctPools)}</span></div>
        <div class="segbar">${Array.from({ length: Math.max(1, t.distinctPools) }, (_, i) =>
          `<i class="${i < (t.assumedPools ?? 0) ? "m" : "f"}"></i>`).join("")}</div>
        <div class="is">${t.assumedPools ? "SHARING NOT CONFIRMED WITH THE VENDOR" : "EVERY POOL BOUNDARY IS CONFIRMED"}</div>
      </div>

      <div class="icell">
        <div class="ik">FREE REQUESTS TODAY</div>
        <div class="iv ok">${esc(t.freeRequestsToday)}</div>
        <div class="is">CROSSINGS THIS GATEWAY DREW FROM A FREE ALLOWANCE</div>
      </div>

      <div class="icell">
        <div class="ik">FREE TOKENS TODAY</div>
        <div class="iv ok">${esc(fmtTokens(t.freeTokensToday))}</div>
        <div class="is">COUNTED PER POOL, NOT PER LANE</div>
      </div>`;

    // --- per provider ---
    const qp = root.querySelector("#qpHost");
    qp.innerHTML = data.providers.length ? data.providers.map((p) => {
      const limits = Object.entries(p.limits).filter(([, v]) => v !== null);
      const rem = Object.entries(p.remaining).filter(([, v]) => v !== null);
      return `<div class="qp-row" data-prov="${esc(p.providerId)}">
        <div class="qp-nm">${esc(p.providerId)}
          <span>${esc(p.pool)}${p.poolMembers?.length > 1 ? ` &#183; shares with ${esc(p.poolMembers.filter((m) => m !== p.providerId).join(", "))}` : " &#183; own pool"}</span></div>
        <div class="qp-lim">${limits.length
          ? limits.map(([k, v]) => `<span>${esc(k.replace("requestsPer", "req/").replace("tokensPer", "tok/"))} <b>${esc(v)}</b></span>`).join("")
          : '<span class="none">no limits declared</span>'}</div>
        <div class="qp-rem">${rem.length
          ? rem.map(([k, v]) => `<span><b>${esc(v)}</b> ${esc(k.replace("requestsThisMinute", "req/min").replace("requestsToday", "req today").replace("tokensThisMinute", "tok/min").replace("tokensToday", "tok today"))}</span>`).join("")
          : '<span class="none">nothing to count</span>'}</div>
        ${p.limitsVerified ? '<span class="badge on">verified</span>' : '<span class="badge warn">unverified</span>'}
      </div>`;
    }).join("") : `<div class="empty-note">
      <b>No lane declares a free tier.</b>
      Providers with a configured free allowance appear here with their limits, what is left of each one, and
      which pool they draw from, so a lane sharing an allowance with another is obvious before it runs out.</div>`;

    root.querySelector("#resetQuota").addEventListener("click", async () => {
      if (!confirm("Clear observed quota counters?")) return;
      await api("/api/panel/quota/reset", { method: "POST" });
      renderPage("quota");
    });
    wireFocusLink(root);
    restoreFocus();
  });

// =========================================================================
// MEMORY — recall is two halves fused, and the honest thing to show is
// which halves are actually running. A page that says "hybrid" while the
// vector side is unreachable is worse than one that says keyword-only.
// =========================================================================

// Preserved across the repaint that follows every save, so a recall you just
// ran is not thrown away by the page reloading its own settings.
let memLastQuery = "";
let memLastResult = null;

PAGES.memory = (el) =>
  loadPage(el, () => api("/api/panel/memory"), (root, data) => {
    const emb = data.embedding || {};
    const vec = data.vector || {};
    const store = data.store || {};
    const drifted = data.mode !== data.effectiveMode;
    const wantsVector = data.mode === "vector" || data.mode === "hybrid";
    const vectorLive = data.effectiveMode === "vector" || data.effectiveMode === "hybrid";
    const embeddedPct = store.total ? (store.embedded / store.total) * 100 : 0;

    const half = (name, live, why, detail) => `
      <div class="half ${live ? "live" : "down"}">
        <div class="hf-h"><span class="hf-n">${esc(name)}</span>
          <span class="hf-s">${live ? "RUNNING" : "NOT RUNNING"}</span></div>
        <div class="hf-w">${why}</div>
        <div class="hf-d">${detail}</div>
      </div>`;

    root.innerHTML = `
      ${drifted ? `<div class="alerts-band"><div class="alert warn">
        <div class="ai">&#8226;</div>
        <div><div class="at">Configured ${esc(data.mode)}, actually running ${esc(data.effectiveMode)}</div>
          <div class="ab">${esc(emb.reason || "The vector half is unavailable.")}
            Recall is still working. It is just working with one half.</div></div>
      </div></div>` : ""}

      <section class="zone recallzone">
        <div class="pane">
          <div class="p-head">
            <span class="p-t">Recall</span>
            <span class="p-s">${esc(String(data.effectiveMode || "off").toUpperCase())} &#183; TOP ${esc(data.topK)}</span>
          </div>
          <div class="mem-lede">Turns are stored after a successful answer and recalled against the newest user
            message on the next request. <b>Off by default</b>, because it changes the prompt the model sees.
            When it is on, every affected response carries <em>X-Tollpike-Memory-Recalled</em>.</div>

          <div class="halves">
            ${half("KEYWORD", store.fts && store.fts !== "none",
              store.fts && store.fts !== "none"
                ? `Full-text index: <em>${esc(store.fts)}</em>.`
                : "No full-text index reported.",
              "Matches on the words that were actually written. Cheap, exact, and blind to a synonym.")}
            ${half("VECTOR", vectorLive,
              vectorLive
                ? `Qdrant reachable &#183; <em>${esc(vec.points ?? 0)}</em> points at <em>${esc(vec.dimensions ?? "?")}</em> dims.`
                : esc(vec.reason || emb.reason || "No embedding provider configured."),
              "Matches on meaning. Needs a real embedding provider. There is deliberately no built-in fallback embedder.")}
          </div>
          <div class="fuse ${data.effectiveMode === "hybrid" ? "on" : ""}">
            <b>${data.effectiveMode === "hybrid" ? "FUSED" : "NOT FUSED"}</b>
            <span>${data.effectiveMode === "hybrid"
              ? "Both halves run and are combined by reciprocal rank, which is scale-free, so neither half can dominate because its numbers happen to be bigger."
              : "Only one half is contributing, so there is nothing to fuse. Reciprocal-rank fusion needs two ranked lists."}</span>
          </div>

          <div class="cov-head">SEARCH</div>
          <div class="row" style="margin-top:12px">
            <input id="memQuery" placeholder="what did we decide about fallback order?" style="flex:1" value="${esc(memLastQuery)}" />
            <button class="sm primary nowrap" id="memSearch">Recall</button>
          </div>
          <div id="memMeta" class="mem-meta"></div>
          <div id="memOut" class="out" style="margin-top:10px"></div>
        </div>

        <aside class="pane instr-pane">
          <div class="p-head"><span class="p-t">Store</span><span class="p-s">${esc(store.backend || "?")}</span></div>
          <div class="instr" id="memInstr">
            <div class="icell">
              <div class="ik">MEMORIES</div>
              <div class="iv">${esc(store.total ?? 0)}</div>
              <div class="is">ACROSS <em>${esc(store.sessions ?? 0)}</em> SESSION(S)</div>
            </div>
            <div class="icell">
              <div class="ik">EMBEDDED</div>
              <div class="iv ${embeddedPct >= 99 ? "ok" : embeddedPct > 0 ? "warn" : ""}">${esc(store.embedded ?? 0)}<span class="u"> / ${esc(store.total ?? 0)}</span></div>
              <div class="bar big"><i style="width:${embeddedPct.toFixed(1)}%"></i></div>
              <div class="is">${store.total && store.embedded < store.total
                ? `<em>${esc(store.total - store.embedded)}</em> NOT YET VECTORISED &#183; USE EMBED PENDING`
                : "EVERY MEMORY HAS A VECTOR"}</div>
            </div>
            <div class="icell">
              <div class="ik">BACKEND</div>
              <div class="iv small" style="font-size:17px">${esc(store.backend || "—")}</div>
              <div class="is">KEYWORD INDEX <em>${esc(store.fts || "none")}</em></div>
            </div>
            <div class="icell">
              <div class="ik">PARTITIONING</div>
              <div class="iv ${data.crossSession ? "warn" : "ok"}" style="font-size:17px">${data.crossSession ? "SHARED" : "PER CALLER"}</div>
              <div class="is">${data.crossSession
                ? "<em>CROSS-SESSION IS ON</em> · ONE CALLER CAN RECALL ANOTHER'S TURNS"
                : "A CALLER ONLY EVER RECALLS ITS OWN TURNS"}</div>
            </div>
          </div>
        </aside>
      </section>

      <section class="zone memcfg">
        <div class="pane">
          <div class="p-head"><span class="p-t">Settings</span><span class="p-s">${data.enabled ? "ON" : "OFF"}</span></div>
          <div class="setrow">
            <div><div class="nm">Memory</div><div class="hh">Recall on every request, ingest after every successful answer.</div></div>
            <div class="switch ${data.enabled ? "on" : ""}" id="toggleMemory"></div>
          </div>
          <div class="setrow">
            <div><div class="nm">Recall mode</div><div class="hh">What you are asking for. If a half is unavailable the effective mode above will differ, and this page will say so rather than quietly degrade.</div></div>
            <select id="recallMode" style="width:120px">${["keyword", "vector", "hybrid"].map((m) =>
              `<option value="${m}" ${data.mode === m ? "selected" : ""}>${m}</option>`).join("")}</select>
          </div>
          <div class="setrow">
            <div><div class="nm">Top K</div><div class="hh">How many memories to inject into the prompt.</div></div>
            <input type="number" min="1" max="50" id="topK" value="${esc(data.topK)}" style="width:88px" />
          </div>
          <div class="setrow">
            <div><div class="nm">Cross-session recall</div><div class="hh">Off by default: memory is caller-partitioned like the response cache, and one caller reading another's turns is a data leak, not a feature.</div></div>
            <div class="switch ${data.crossSession ? "on" : ""}" id="toggleCross"></div>
          </div>
        </div>

        <div class="pane">
          <div class="p-head"><span class="p-t">Vector half</span><span class="p-s">${vectorLive ? "LIVE" : wantsVector ? "REQUESTED, DOWN" : "NOT REQUESTED"}</span></div>
          <div class="vec-note">There is deliberately no built-in fallback embedder. A hash-based "embedding"
            clusters on spelling rather than meaning, and a vector search over those returns confident nonsense.
            Without a real provider, recall is keyword-only and says so.</div>
          <div class="setrow">
            <div><div class="nm">Embedding provider</div><div class="hh">Any OpenAI-compatible provider with an <span class="mono">/embeddings</span> endpoint.</div></div>
            <input id="embProvider" class="mono" placeholder="openai" value="${esc(emb.provider || "")}" style="width:150px" />
          </div>
          <div class="setrow">
            <div><div class="nm">Embedding model</div><div class="hh">Changing this invalidates every stored vector. The collection's dimension count is fixed at creation.</div></div>
            <input id="embModel" class="mono" placeholder="text-embedding-3-small" value="${esc(emb.model || "")}" style="width:210px" />
          </div>
          <div class="setrow">
            <div><div class="nm">Qdrant</div><div class="hh">${vec.reachable
              ? `Reachable &#183; ${esc(vec.points)} points &#183; ${esc(vec.dimensions)} dims`
              : esc(vec.reason || "not configured")}</div></div>
            <input id="qdrantUrl" class="mono" placeholder="http://127.0.0.1:6333" value="${esc(vec.configured ? vec.url : "")}" style="width:190px" />
          </div>
          <div class="row" style="margin-top:12px">
            <button class="sm primary" id="saveEmbedding">Save</button>
            <button class="sm" id="syncVectors">Embed pending</button>
          </div>
        </div>

        <aside class="pane">
          <div class="p-head"><span class="p-t">Forget</span><span class="p-s">NOT RECOVERABLE</span></div>
          <div class="setrow">
            <div><div class="nm">This session</div><div class="hh">Deletes only memories written under your caller identity. The other partitions are untouched.</div></div>
            <button class="sm danger" id="forgetSession">Forget session</button>
          </div>
          <div class="setrow">
            <div><div class="nm">Everything</div><div class="hh">Every session, every memory, every partition. There is no undo and no export first.</div></div>
            <button class="sm danger" id="forgetAll">Forget all</button>
          </div>
        </aside>
      </section>`;

    const save = async (patch) => {
      try {
        await api("/api/panel/memory", { method: "POST", body: JSON.stringify(patch) });
        renderPage("memory");
      } catch (err) { alert(err.message); }
    };

    root.querySelector("#toggleMemory").addEventListener("click", () => save({ enabled: !data.enabled }));
    root.querySelector("#toggleCross").addEventListener("click", () => save({ crossSession: !data.crossSession }));
    root.querySelector("#recallMode").addEventListener("change", (e) => save({ recall: e.target.value }));
    root.querySelector("#topK").addEventListener("change", (e) => save({ topK: Number(e.target.value) }));
    root.querySelector("#saveEmbedding").addEventListener("click", () =>
      save({
        embeddingProvider: root.querySelector("#embProvider").value.trim() || null,
        embeddingModel: root.querySelector("#embModel").value.trim() || null,
        qdrantUrl: root.querySelector("#qdrantUrl").value.trim() || null
      }));
    root.querySelector("#syncVectors").addEventListener("click", async () => {
      const result = await api("/api/panel/memory/sync-vectors", { method: "POST", body: "{}" });
      alert(result.ok ? `Embedded ${result.embedded}` : result.reason);
      renderPage("memory");
    });

    const q = root.querySelector("#memQuery");
    q.addEventListener("input", () => { memLastQuery = q.value; });
    const runSearch = async () => {
      memLastQuery = q.value;
      const out = root.querySelector("#memOut");
      out.textContent = "Recalling…";
      try {
        memLastResult = await api("/api/panel/memory/search", { method: "POST", body: JSON.stringify({ query: memLastQuery }) });
      } catch (err) {
        memLastResult = { error: err.message };
      }
      paintMemResults();
    };
    root.querySelector("#memSearch").addEventListener("click", runSearch);
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(); } });
    paintMemResults();
  });

function paintMemResults() {
  const out = document.getElementById("memOut");
  const meta = document.getElementById("memMeta");
  if (!out) return;
  if (!memLastResult) {
    out.textContent = "Nothing recalled yet. This runs the same retrieval a real request would.";
    if (meta) meta.textContent = "";
    return;
  }
  if (memLastResult.error) {
    out.textContent = memLastResult.error;
    if (meta) meta.textContent = "";
    return;
  }
  const found = memLastResult;
  if (meta) {
    meta.textContent = `RAN: ${found.used?.join(" + ") || "nothing"}`
      + (found.degraded?.length ? ` · DEGRADED: ${found.degraded.map((d) => `${d.half} (${d.reason})`).join("; ")}` : "");
  }
  // Recalled text is prior untrusted conversation. DOM nodes only.
  textRows(out, found.results || [], (row, r) => {
    row.className = "mem-row";
    row.appendChild(span("badge", r.role));
    if (r.ranks) row.appendChild(span("mem-rank", Object.entries(r.ranks).map(([k, v]) => `${k}#${v}`).join(" ")));
    row.appendChild(span("mem-t", r.text.slice(0, 400)));
  });
  if (!(found.results || []).length) out.textContent = "Nothing recalled for that query.";
}

// =========================================================================
// KNOWLEDGE — two read-only sources, and the reason they are read-only is
// the most important thing on the page rather than a footnote.
// =========================================================================

let kLastQuery = "";
let kLastResult = null;

PAGES.knowledge = (el) =>
  loadPage(el, () => api("/api/panel/knowledge"), (root, data) => {
    const ob = data.obsidian || {};
    const no = data.notion || {};

    root.innerHTML = `
      <div class="alerts-band">
        <div class="alert">
          <div class="ai" style="background:var(--ok-dim);color:var(--ok)">&#8226;</div>
          <div><div class="at">Read-only, both of them</div>
            <div class="ab">${esc(data.access || "")} Notes and pages are a prime indirect-injection vector: a
              writable knowledge source is one an injected instruction can use to edit your notes, and then read
              them back to itself as fact. Read-only removes that loop entirely.</div></div>
        </div>
      </div>

      <section class="zone sources">
        <div class="pane">
          <div class="p-head">
            <span class="p-t">Obsidian</span>
            <span class="p-s">${ob.configured ? esc(ob.notes) + " NOTES" : "NOT CONFIGURED"}</span>
          </div>
          <div class="src ${ob.configured ? "on" : ""}">
            <div class="src-v">${ob.configured ? esc(ob.notes) : "&mdash;"}<span>${ob.configured ? "notes indexed" : "no vault"}</span></div>
            <div class="src-n">${ob.configured
              ? `Containment: <em>${esc(ob.containment || "path-checked")}</em>. Reads cannot escape the vault
                 directory, so a note containing a traversal path cannot pull a file from elsewhere on the disk.`
              : esc(ob.reason || "Point this at a vault directory to index it.")}</div>
          </div>
          <div class="setrow">
            <div><div class="nm">Vault path</div><div class="hh">A local directory. Nothing is copied. Notes are read at query time.</div></div>
            <input id="vaultPath" class="mono" placeholder="C:\\Users\\you\\vault" value="${esc(ob.vault || "")}" style="width:250px" />
          </div>
          <div class="row"><button class="sm primary" id="saveVault">Save</button></div>
        </div>

        <div class="pane">
          <div class="p-head">
            <span class="p-t">Notion</span>
            <span class="p-s">${no.configured ? (no.reachable ? "CONNECTED" : "UNREACHABLE") : "NO KEY"}</span>
          </div>
          <div class="src ${no.configured && no.reachable ? "on" : ""}">
            <div class="src-v">${no.configured ? (no.reachable ? "connected" : "unreachable") : "no key"}<span>${
              no.configured && no.reachable ? `api ${esc(no.apiVersion || "?")}` : "integration status"}</span></div>
            <div class="src-n">${no.configured
              ? (no.reachable
                  ? "Reachable, and unverified against a live workspace. The connection works, but nothing here has confirmed which pages are actually shared with the integration."
                  : esc(no.reason || "The API did not answer."))
              : esc(no.reason || "No integration key present.")}</div>
          </div>
          <div class="setrow">
            <div><div class="nm">Where the key lives</div>
              <div class="hh">Set <span class="mono">NOTION_API_KEY</span> in the environment and share pages with the
                integration. Keys live in env, not in settings. This panel never handles them, which is why
                there is no field here to paste one into.</div></div>
            <span class="badge">env only</span>
          </div>
        </div>
      </section>

      <section class="zone ksearch">
        <div class="pane">
          <div class="p-head"><span class="p-t">Search both</span><span class="p-s" id="kMeta"></span></div>
          <div class="row" style="margin-bottom:12px">
            <input id="kQuery" placeholder="budget caps" style="flex:1" value="${esc(kLastQuery)}" />
            <button class="sm primary nowrap" id="kSearch">Search</button>
          </div>
          <div id="kOut" class="out"></div>
        </div>
      </section>`;

    root.querySelector("#saveVault").addEventListener("click", async () => {
      try {
        await api("/api/panel/knowledge", {
          method: "POST",
          body: JSON.stringify({ obsidianVault: root.querySelector("#vaultPath").value.trim() || null })
        });
        renderPage("knowledge");
      } catch (err) { alert(err.message); }
    });

    const kq = root.querySelector("#kQuery");
    kq.addEventListener("input", () => { kLastQuery = kq.value; });
    const runK = async () => {
      kLastQuery = kq.value;
      const out = root.querySelector("#kOut");
      out.textContent = "Searching…";
      try {
        kLastResult = await api("/api/panel/knowledge/search", { method: "POST", body: JSON.stringify({ query: kLastQuery }) });
      } catch (err) {
        kLastResult = { error: err.message };
      }
      paintKResults();
    };
    root.querySelector("#kSearch").addEventListener("click", runK);
    kq.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runK(); } });
    paintKResults();
  });

function paintKResults() {
  const out = document.getElementById("kOut");
  const meta = document.getElementById("kMeta");
  if (!out) return;
  if (!kLastResult) {
    out.textContent = "Nothing searched yet. This reads both sources exactly as a request would.";
    if (meta) meta.textContent = "";
    return;
  }
  if (kLastResult.error) { out.textContent = kLastResult.error; if (meta) meta.textContent = ""; return; }
  const results = kLastResult;
  const rows = [
    ...(results.obsidian?.results || []).map((r) => ({ source: "obsidian", title: r.path, body: r.excerpt || "" })),
    ...(results.notion?.results || []).map((r) => ({ source: "notion", title: r.title, body: r.url || "" }))
  ];
  if (meta) meta.textContent = rows.length ? `${rows.length} MATCH(ES)` : "NO MATCH";
  // File and page content — never interpolated into markup.
  textRows(out, rows, (row, r) => {
    row.className = "k-row";
    row.appendChild(span("badge", r.source));
    row.appendChild(span("k-t", r.title));
    row.appendChild(span("k-b", r.body.slice(0, 300)));
  });
  if (!rows.length) {
    out.textContent = results.obsidian?.reason || results.notion?.reason || "No matches in either source.";
  }
}

// =========================================================================
// PROTOCOLS — two surfaces onto the same gateway at two different grains.
// The useful comparison is grain, so the page puts them side by side rather
// than stacking one list of tools on top of another.
// =========================================================================

PAGES.protocols = (el) =>
  loadPage(el, () => api("/api/panel/protocols"), (root, data) => {
    const mcp = data.mcp || {};
    const a2a = data.a2a || {};
    const readOnly = Math.max(0, (mcp.tools || 0) - (mcp.mutatingTools || 0));

    root.innerHTML = `
      <section class="zone protozone">
        <div class="pane">
          <div class="p-head">
            <span class="p-t">MCP</span>
            <span class="scope-tag m">FINE GRAIN</span>
            <span class="p-s">${esc(mcp.tools ?? 0)} TOOLS &#183; ${esc(mcp.scopes ?? 0)} SCOPES</span>
          </div>
          <div class="proto-lede">For a model driving this gateway step by step. It gets the individual levers
            (read a figure, set a cap, toggle a lane) and is expected to know what it is doing with them.</div>

          <div class="mix">
            <div class="mix-bar">
              <i class="ro" style="width:${mcp.tools ? ((readOnly / mcp.tools) * 100).toFixed(1) : 0}%"></i>
              <i class="rw" style="width:${mcp.tools ? (((mcp.mutatingTools || 0) / mcp.tools) * 100).toFixed(1) : 0}%"></i>
            </div>
            <div class="mix-key">
              <span><i class="ro"></i>${esc(readOnly)} READ-ONLY</span>
              <span><i class="rw"></i>${esc(mcp.mutatingTools ?? 0)} MUTATING</span>
            </div>
            <div class="mix-n">A mutating tool changes configuration or spends money. Unauthenticated MCP-over-HTTP
              defaults to the read-only set, so a peer that has not proved anything cannot reach the other ${esc(mcp.mutatingTools ?? 0)}.</div>
          </div>

          <div class="cov-head">SCOPES</div>
          <div class="scopes-list">${(mcp.scopeList || []).map((sc) => `
            <div class="scope-row">
              <div class="sr-h"><span class="sr-n">${esc(sc.scope)}</span><span class="sr-c">${esc(sc.tools)} tool${sc.tools === 1 ? "" : "s"}</span></div>
              <div class="sr-d">${esc(sc.description)}</div>
            </div>`).join("") || '<div class="empty-note">No scope reported.</div>'}</div>

          <div class="cov-head">TRANSPORTS</div>
          <div class="tp">${Object.entries(mcp.transports || {}).map(([name, value]) => `
            <div class="tp-row"><span class="tp-k">${esc(name)}</span><span class="tp-v">${esc(value)}</span></div>`).join("")
            || '<div class="empty-note">No transport reported.</div>'}</div>
        </div>

        <div class="pane">
          <div class="p-head">
            <span class="p-t">A2A</span>
            <span class="scope-tag p">COARSE GRAIN</span>
            <span class="p-s">${esc((a2a.skills || []).length)} SKILLS</span>
          </div>
          <div class="proto-lede">For a peer agent that wants an outcome and does not want to learn the internals.
            It asks for a result; the gateway decides how to get it.</div>

          <div class="cov-head">SKILLS</div>
          <div class="skills">${(a2a.skills || []).map((sk) =>
            `<span class="skill">${esc(sk)}</span>`).join("") || '<div class="empty-note">No skill advertised.</div>'}</div>

          <div class="cov-head">TRANSPORT</div>
          <div class="tp">
            <div class="tp-row"><span class="tp-k">json-rpc ${esc(a2a.protocolVersion || "2.0")}</span>
              <span class="tp-v">POST ${esc(a2a.endpoints?.jsonrpc || "/a2a")}</span></div>
            <div class="tp-row"><span class="tp-k">agent card</span>
              <span class="tp-v">GET ${esc(a2a.endpoints?.agentCard || "/.well-known/agent-card.json")}</span></div>
            ${(a2a.methods || []).length
              ? `<div class="tp-row"><span class="tp-k">methods</span><span class="tp-v">${esc(a2a.methods.join(", "))}</span></div>`
              : ""}
          </div>

          <div class="cov-head">HONESTY NOTES</div>
          <div class="hon">
            <div class="hon-row"><b>Streaming is advertised as ${esc(String(a2a.streaming === true))}</b>
              <span>${a2a.streaming
                ? "and <em>message/stream</em> honours it."
                : "and <em>message/stream</em> refuses accordingly. Advertising a capability that returns one chunk at the end is worse than not advertising it at all."}</span></div>
            <div class="hon-row"><b>Task history: ${esc(a2a.taskHistory || "in-process")}</b>
              <span>· <em>${esc(a2a.tasksTracked ?? 0)}</em> tracked right now.
                A peer that reconnects after a restart gets an honest "unknown task", not a fabricated one.</span></div>
            <div class="hon-row"><b>The Agent Card is unauthenticated</b>
              <span>on purpose. A peer has to be able to read how to authenticate before it can.</span></div>
          </div>
        </div>
      </section>

      <section class="zone protofoot">
        <div class="pane">
          <div class="p-head"><span class="p-t">Both surfaces</span><span class="p-s">SAME GATE AS /v1</span></div>
          <div class="recon-body">
            <div class="setrow">
              <div><div class="nm">Same key, same limiter</div>
                <div class="hh">MCP and A2A sit behind the gateway key and the rate limiter exactly as
                  <span class="mono">/v1</span> does. Both can reach the router, so leaving either off the limiter
                  would leave a way around the one control that stops a runaway agent loop, and an
                  unauthenticated MCP endpoint is a remote control for this gateway's spend.</div></div>
              <span class="badge on">enforced</span>
            </div>
            <div class="setrow">
              <div><div class="nm">Cross-site guard runs first</div>
                <div class="hh">Ahead of authentication on both, because the case it exists for is the one where
                  auth is a no-op: with no key set, a form on any page you visit could otherwise drive them.</div></div>
              <span class="badge on">enforced</span>
            </div>
          </div>
        </div>
      </section>`;
  });

// =========================================================================
// CLOUD AGENTS — these spend money at the vendor, outside this gateway's
// caps. That is the single most important fact on the page, so it is stated
// where the button is rather than in a paragraph above it.
// =========================================================================

let agentOut = null;
let lookupOut = null;

PAGES.agents = (el) =>
  loadPage(el, () => api("/api/panel/agents"), (root, data) => {
    const drivers = data.drivers || [];
    const ready = drivers.filter((d) => d.hasKey);

    root.innerHTML = `
      <div class="alerts-band">
        <div class="alert warn">
          <div class="ai">&#8226;</div>
          <div><div class="at">Every driver here is unverified, and every task bypasses your caps</div>
            <div class="ab">${esc(data.caveat || "")} A task created here is billed by the vendor directly.
              It does not pass through this gateway's router, so no monthly cap, breaker or free-quota rule applies
              to it.</div></div>
        </div>
      </div>

      <section class="zone driverzone">
        <div class="pane">
          <div class="p-head">
            <span class="p-t">Drivers</span>
            <span class="p-s">${esc(ready.length)} OF ${esc(drivers.length)} CREDENTIALLED</span>
          </div>
          <div class="drivers">${drivers.map((d) => `
            <div class="drv ${d.hasKey ? "on" : ""}">
              <div class="drv-h">
                <span class="drv-n">${esc(d.label)}</span>
                <span class="badge ${d.hasKey ? "on" : "warn"}">${d.hasKey ? "key set" : esc(d.apiKeyEnv)}</span>
              </div>
              <div class="drv-d">${esc(d.description)}</div>
              <div class="drv-caps">
                ${(d.capabilities || []).map((c) => `<span class="cap yes">${esc(c)}</span>`).join("")}
                ${(d.unsupported || []).map((c) => `<span class="cap no">${esc(c)}</span>`).join("")}
              </div>
              ${(d.unsupported || []).length
                ? `<div class="drv-n">Struck-through capabilities have no vendor API. They are reported as
                    unsupported rather than faked with a stub that always returns success.</div>`
                : ""}
            </div>`).join("") || '<div class="empty-note"><b>No driver configured.</b>Each driver needs its vendor key in the environment before it appears usable here.</div>'}
          </div>
        </div>

        <aside class="pane">
          <div class="p-head"><span class="p-t">Create a task</span><span class="p-s">SPENDS AT THE VENDOR</span></div>
          <div class="spend-warn">This creates real work on a real account. It is charged by the vendor, not
            metered here, and nothing on the Budgets page can stop it.</div>
          <div class="row" style="margin-top:13px">
            <select id="agentDriver" style="flex:1">${drivers.map((d) =>
              `<option value="${esc(d.id)}" ${d.hasKey ? "" : "disabled"}>${esc(d.label)}${d.hasKey ? "" : " (no key)"}</option>`).join("")}</select>
          </div>
          <input id="agentRepo" class="mono" placeholder="owner/repo (optional)" style="margin-top:9px" />
          <textarea id="agentPrompt" rows="4" placeholder="What should the agent do?" style="width:100%;margin-top:9px"></textarea>
          <div class="row" style="margin-top:10px"><button class="primary sm" id="agentCreate">Create task</button></div>
          <div id="agentOut" class="out" style="margin-top:12px"></div>
        </aside>
      </section>

      <section class="zone inspectzone">
        <div class="pane">
          <div class="p-head"><span class="p-t">Inspect a task</span><span class="p-s">READ, THEN APPROVE</span></div>
          <div class="row">
            <select id="lookupDriver" style="width:170px">${drivers.map((d) =>
              `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join("")}</select>
            <input id="lookupId" class="mono" placeholder="task id" style="flex:1" />
            <button class="sm nowrap" id="lookupBtn">Fetch</button>
            <button class="sm nowrap" id="approveBtn">Approve plan</button>
          </div>
          <div class="inspect-n">Fetch is read-only. <b>Approve plan</b> is not. The agent acts on the plan
            the moment you confirm, on the vendor's account.</div>
          <div id="lookupOut" class="out" style="margin-top:12px"></div>
        </div>
      </section>`;

    const show = (target, payload) => {
      // Cloud-agent output is third-party text. DOM node, not markup.
      target.textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    };
    const restore = (id, cache) => {
      const t = root.querySelector(id);
      if (t) t.textContent = cache ?? "Nothing fetched yet.";
    };
    restore("#agentOut", agentOut);
    restore("#lookupOut", lookupOut);

    root.querySelector("#agentCreate").addEventListener("click", async () => {
      const out = root.querySelector("#agentOut");
      const driver = root.querySelector("#agentDriver").value;
      const prompt = root.querySelector("#agentPrompt").value.trim();
      const repo = root.querySelector("#agentRepo").value.trim() || undefined;
      if (!prompt) { agentOut = "Enter a prompt first."; return show(out, agentOut); }
      if (!confirm(`Create a task on ${driver}? This spends money at the vendor, outside this gateway's caps.`)) return;
      try {
        const r = await api(`/api/panel/agents/${encodeURIComponent(driver)}/tasks`, {
          method: "POST", body: JSON.stringify({ prompt, repo })
        });
        agentOut = JSON.stringify(r, null, 2);
      } catch (err) { agentOut = err.message; }
      show(out, agentOut);
    });

    root.querySelector("#lookupBtn").addEventListener("click", async () => {
      const out = root.querySelector("#lookupOut");
      const driver = root.querySelector("#lookupDriver").value;
      const id = root.querySelector("#lookupId").value.trim();
      if (!id) { lookupOut = "Enter a task id."; return show(out, lookupOut); }
      try {
        lookupOut = JSON.stringify(await api(`/api/panel/agents/${encodeURIComponent(driver)}/tasks/${encodeURIComponent(id)}`), null, 2);
      } catch (err) { lookupOut = err.message; }
      show(out, lookupOut);
    });

    root.querySelector("#approveBtn").addEventListener("click", async () => {
      const out = root.querySelector("#lookupOut");
      const driver = root.querySelector("#lookupDriver").value;
      const id = root.querySelector("#lookupId").value.trim();
      if (!id) { lookupOut = "Enter a task id."; return show(out, lookupOut); }
      if (!confirm(`Approve the plan on ${driver} task ${id}? The agent will act on it immediately.`)) return;
      try {
        lookupOut = JSON.stringify(await api(`/api/panel/agents/${encodeURIComponent(driver)}/tasks/${encodeURIComponent(id)}/approve`, {
          method: "POST", body: "{}"
        }), null, 2);
      } catch (err) { lookupOut = err.message; }
      show(out, lookupOut);
    });
  });

// =========================================================================
// SERVICES — supervises what is already on your PATH. The refusal to install
// anything is the design, so it leads rather than sits in a banner.
// =========================================================================

PAGES.services = (el) =>
  loadPage(el, () => api("/api/panel/services"), (root, data) => {
    const svcs = data.services || [];
    const up = svcs.filter((s) => s.running);

    root.innerHTML = `
      <section class="zone svczone">
        <div class="pane">
          <div class="p-head">
            <span class="p-t">Supervised services</span>
            <span class="p-s">${esc(up.length)} OF ${esc(svcs.length)} RUNNING</span>
          </div>
          <div class="svc-lede"><b>Supervises, ${esc(data.installs || "never installs")}.</b> Each service must
            already be on your PATH. Downloading and running a binary on your behalf is a supply-chain decision,
            and a dashboard button is not consent.</div>
          <div class="svcs">${svcs.map((s) => `
            <div class="svc ${s.running ? "up" : "down"}">
              <div class="svc-h">
                <span class="dot ${s.running ? "live" : ""}"></span>
                <span class="svc-n">${esc(s.label)}</span>
                <span class="svc-s">${s.running ? `PID ${esc(s.pid)} &#183; PORT ${esc(s.port)} &#183; UP ${esc(Math.round((s.uptimeMs || 0) / 1000))}s` : "STOPPED"}</span>
              </div>
              <div class="svc-d">${esc(s.description)}</div>
              <div class="svc-bin"><span>BINARY</span><b>${esc(s.binary.binary)}</b><span>via ${esc(s.binary.via)}</span></div>
              ${s.lastExit ? `<div class="svc-exit">LAST EXIT &#183; CODE ${esc(s.lastExit.code)} ${esc(s.lastExit.error || "")}</div>` : ""}
              <div class="row" style="margin-top:11px">
                ${s.running
                  ? `<button class="sm danger" data-stop="${esc(s.id)}">Stop</button><button class="sm" data-health="${esc(s.id)}">Health</button>`
                  : `<button class="sm primary" data-start="${esc(s.id)}">Start</button>`}
                <button class="sm" data-logs="${esc(s.id)}">Logs (${esc(s.logLines)})</button>
              </div>
              <div class="out svc-out" id="svc-${esc(s.id)}"></div>
            </div>`).join("") || '<div class="empty-note"><b>No service is declared.</b>Services appear here once the gateway knows about them; each still has to be on your PATH before it can be started.</div>'}
          </div>
        </div>

        <aside class="pane">
          <div class="p-head"><span class="p-t">Cluster profiles</span><span class="p-s">${esc((data.profiles || []).length)} DEFINED</span></div>
          <div class="prof-n">Starts several at once. Partial success is reported as partial. A half-started
            cluster does not report healthy, because the thing you would do about it differs.</div>
          <div class="profs">${(data.profiles || []).map((p) =>
            `<button class="sm" data-profile="${esc(p.id)}">${esc(p.label)}</button>`).join("")
            || '<div class="empty-note">No profile defined.</div>'}</div>
        </aside>
      </section>`;

    const act = async (path, options) => {
      try { return await api(path, options); } catch (err) { return { error: err.message }; }
    };

    root.querySelectorAll("[data-start]").forEach((b) =>
      b.addEventListener("click", async () => {
        await act(`/api/panel/services/${encodeURIComponent(b.dataset.start)}/start`, { method: "POST", body: "{}" });
        renderPage("services");
      }));
    root.querySelectorAll("[data-stop]").forEach((b) =>
      b.addEventListener("click", async () => {
        await act(`/api/panel/services/${encodeURIComponent(b.dataset.stop)}/stop`, { method: "POST", body: "{}" });
        renderPage("services");
      }));
    root.querySelectorAll("[data-profile]").forEach((b) =>
      b.addEventListener("click", async () => {
        const result = await act(`/api/panel/services/profile/${encodeURIComponent(b.dataset.profile)}`, { method: "POST", body: "{}" });
        alert(result.error || `started: ${(result.started || []).join(", ") || "none"}${result.failed?.length ? `\nfailed: ${result.failed.map((f) => `${f.id} (${f.error})`).join(", ")}` : ""}`);
        renderPage("services");
      }));
    root.querySelectorAll("[data-health]").forEach((b) =>
      b.addEventListener("click", async () => {
        const out = root.querySelector(`#svc-${b.dataset.health}`);
        out.textContent = JSON.stringify(await act(`/api/panel/services/${encodeURIComponent(b.dataset.health)}/health`), null, 2);
      }));
    root.querySelectorAll("[data-logs]").forEach((b) =>
      b.addEventListener("click", async () => {
        const out = root.querySelector(`#svc-${b.dataset.logs}`);
        const result = await act(`/api/panel/services/${encodeURIComponent(b.dataset.logs)}/logs?lines=40`);
        if (result.error) return (out.textContent = result.error);
        // Child-process output. Text nodes only.
        textRows(out, result.lines, (row, line) => {
          row.className = "log-row";
          row.appendChild(span("log-t", fmtTime(new Date(line.at).toISOString())));
          row.appendChild(span("log-l", line.line));
        });
        if (!result.lines.length) out.textContent = "No output yet.";
      }));
  });

// =========================================================================
// ACHIEVEMENTS — the savings figure is a comparison against a baseline, and
// a comparison is only worth anything if the baseline is stated. So the
// baseline is stated first and the number second.
// =========================================================================

PAGES.achievements = (el) =>
  loadPage(el, () => api("/api/panel/achievements"), (root, data) => {
    const sv = data.savings || {};
    const st = data.streak || {};
    const tot = data.totals || {};
    const list = data.achievements || [];
    const unlocked = list.filter((a) => a.unlocked);
    const inProgress = list.filter((a) => !a.unlocked).sort((a, b) => (b.pct || 0) - (a.pct || 0));
    const donePct = tot.total ? (tot.unlocked / tot.total) * 100 : 0;

    root.innerHTML = `
      <section class="zone savingszone">
        <div class="pane">
          <div class="p-head"><span class="p-t">Savings</span><span class="p-s">${sv.available ? esc(sv.savedPct) + "% AGAINST BASELINE" : "UNAVAILABLE"}</span></div>
          ${sv.available ? `
            <div class="save-lede">
              <div class="sl-k">BASELINE</div>
              <div class="sl-v">${esc(sv.baseline?.description || "—")}</div>
              <div class="sl-n">${esc(sv.caveat || "")}</div>
            </div>
            <div class="save-bar">
              <i class="spent" style="width:${sv.baselineCostUsd ? Math.min(100, (sv.actualCostUsd / sv.baselineCostUsd) * 100).toFixed(1) : 0}%"></i>
              <i class="saved"></i>
            </div>
            <div class="save-key">
              <span><i class="spent"></i>SPENT ${esc(fmtUsd(sv.actualCostUsd))}</span>
              <span><i class="saved"></i>AVOIDED ${esc(fmtUsd(sv.savedUsd))}</span>
              <span class="r">BASELINE ${esc(fmtUsd(sv.baselineCostUsd))}</span>
            </div>
            <div class="save-grid">
              <div><b>${esc(fmtUsd(sv.savedUsd))}</b><span>NOT SPENT</span></div>
              <div><b>${esc(sv.savedPct)}%</b><span>OF THE BASELINE</span></div>
              <div><b>${esc(fmtTokens(sv.freeTokensToday))}</b><span>FREE TOKENS TODAY</span></div>
              <div><b>${esc(fmtUsd(sv.freeValueTodayUsd))}</b><span>WHAT THEY WOULD HAVE COST</span></div>
            </div>`
          : `<div class="empty-note"><b>Savings cannot be computed.</b>${esc(sv.reason || "")}
              A savings figure without a stated baseline is a marketing number, so nothing is shown rather than
              a number you could not check.</div>`}
        </div>

        <aside class="pane instr-pane">
          <div class="p-head"><span class="p-t">Streak</span><span class="p-s">${esc(st.windowDays ?? 0)}-DAY WINDOW</span></div>
          <div class="instr">
            <div class="icell">
              <div class="ik">CURRENT</div>
              <div class="iv ${st.currentDays ? "ok" : ""}">${esc(st.currentDays ?? 0)}<span class="u"> days</span></div>
              <div class="is">CONSECUTIVE DAYS WITH TRAFFIC</div>
            </div>
            <div class="icell">
              <div class="ik">LONGEST</div>
              <div class="iv">${esc(st.longestDays ?? 0)}<span class="u"> days</span></div>
              <div class="is">BEST RUN ON RECORD</div>
            </div>
            <div class="icell">
              <div class="ik">ACTIVE DAYS</div>
              <div class="iv">${esc(st.activeDaysInWindow ?? 0)}<span class="u"> / ${esc(st.windowDays ?? 0)}</span></div>
              <div class="segbar">${Array.from({ length: st.windowDays || 1 }, (_, i) =>
                `<i class="${i < (st.activeDaysInWindow || 0) ? "f" : ""}"></i>`).join("")}</div>
              <div class="is">IN THE WINDOW</div>
            </div>
            <div class="icell">
              <div class="ik">UNLOCKED</div>
              <div class="iv">${esc(tot.unlocked ?? 0)}<span class="u"> / ${esc(tot.total ?? 0)}</span></div>
              ${arcGauge(donePct, donePct >= 100 ? SCOPE.ok : SCOPE.provider)}
              <div class="is">${esc(Math.round(donePct))}% OF THE SET</div>
            </div>
          </div>
        </aside>
      </section>

      <section class="zone achzone">
        <div class="pane">
          <div class="p-head"><span class="p-t">In progress</span><span class="p-s">${esc(inProgress.length)} REMAINING</span></div>
          <div class="ach-list">${inProgress.map((a) => `
            <div class="ach">
              <div class="ach-h"><span class="ach-n">${esc(a.label)}</span><span class="ach-p">${esc(a.pct)}%</span></div>
              <div class="ach-d">${esc(a.description)}</div>
              <div class="bar"><span style="width:${esc(a.pct)}%"></span></div>
              <div class="ach-f">${esc(a.progress)} of ${esc(a.target)}</div>
            </div>`).join("") || '<div class="empty-note"><b>Everything is unlocked.</b>Nothing left to chase.</div>'}
          </div>
        </div>
        <aside class="pane">
          <div class="p-head"><span class="p-t">Unlocked</span><span class="p-s">${esc(unlocked.length)}</span></div>
          <div class="ach-done">${unlocked.map((a) => `
            <div class="ach done">
              <div class="ach-h"><span class="ach-n">${esc(a.label)}</span><span class="badge on">unlocked</span></div>
              <div class="ach-d">${esc(a.description)}</div>
            </div>`).join("") || '<div class="empty-note"><b>Nothing unlocked yet.</b>These are milestones on real traffic, so they arrive on their own.</div>'}
          </div>
        </aside>
      </section>`;
  });

// --- Boot ----------------------------------------------------------------

// The sidebar foot is the one instrument that is on screen no matter which
// subsystem you are looking at: is the plaza up, and how many lanes are open.
function paintSidebarFoot(s) {
  const open = openCircuits(s);
  const active = s.providers.filter((p) => p.hasKey && p.enabled).length;
  const stateEl = document.getElementById("sfState");
  const dot = document.querySelector("#sbFoot .dot");
  const degraded = open > 0;
  stateEl.textContent = active === 0 ? "NO LANE OPEN" : degraded ? "DEGRADED" : "SYSTEM ONLINE";
  dot.className = `dot ${active === 0 ? "idle" : degraded ? "warn" : "live"} beat`;
  document.getElementById("sfLanes").innerHTML =
    `<b>${esc(active)}</b> <span>/ ${esc(s.providers.length)} ACTIVE</span>`;
  document.getElementById("sfStrip").innerHTML = s.providers.map((p) => {
    const st = laneState(p);
    const cls = st === "open" ? "open" : st === "cold" || st === "half" ? "cold" : st === "live" || st === "idle" ? "on" : "";
    return `<i class="sf-tick ${cls}" title="${esc(p.name)} · ${esc(LANE_LABEL[st])}"></i>`;
  }).join("");
  const cool = Object.keys(s.resilience?.connections || {}).length;
  const locked = Object.keys(s.resilience?.models || {}).length;
  document.getElementById("sfSub").textContent =
    open || cool || locked ? `${open} OPEN · ${cool} COOLING · ${locked} LOCKED` : `${s.totals.totalRequests} CROSSINGS LIFETIME`;
}

// The rail is what makes twenty pages read as one console: whichever
// subsystem you are looking at, the bar above it reports that subsystem's
// live numbers in the same instrument type. Every value here is read from
// state — a page with nothing measurable falls back to the plaza totals
// rather than inventing a metric to fill the slot.
function railCells(s) {
  const open = openCircuits(s);
  const active = s.providers.filter((p) => p.hasKey && p.enabled).length;
  const spend = s.providers.reduce((a, p) => a + p.monthlySpendUsd, 0);
  const cap = s.providers.reduce((a, p) => a + (p.budgetCapUsd || 0), 0);
  const sec = s.security || {};
  const trust = s.pricingTrust || {};
  const qt = s.quota?.totals || {};
  const comp = s.compression || {};
  const cache = s.cache || {};
  const proxy = s.proxy || {};
  const cool = Object.keys(s.resilience?.connections || {}).length;
  const locked = Object.keys(s.resilience?.models || {}).length;
  const lanes = ["LANES", `${active}<small> / ${s.providers.length}</small>`, active ? "" : "warn"];
  const state = ["STATE", `<span class="dot ${active === 0 ? "idle" : open ? "warn" : "live"} beat"></span>${active === 0 ? "IDLE" : open ? "DEGRADED" : "LIVE"}`,
    active === 0 ? "" : open ? "bad" : "ok"];

  switch (current) {
    case "home": return [state, lanes,
      ["CROSSINGS", String(s.totals.totalRequests), "", true],
      ["AVG LATENCY", s.totals.avgLatencyMs ? fmtMs(s.totals.avgLatencyMs) : "—", "", true],
      ["SPEND MTD", fmtUsd(spend)]];
    case "providers": return [lanes,
      ["CREDENTIALLED", String(s.providers.filter((p) => p.hasKey).length)],
      ["DEGRADED", String(s.providers.filter((p) => p.circuit === "OPEN" || p.connectionsCoolingDown > 0).length),
        s.providers.some((p) => p.circuit === "OPEN") ? "bad" : ""],
      ["SPEND MTD", fmtUsd(spend), "", true]];
    case "routing": return [
      ["STRATEGIES", String(s.routing?.strategyCount ?? 0)],
      ["DEFAULT", s.routing?.defaultCombo ? `combo/${esc(trunc(s.routing.defaultCombo, 11))}` : "priority"],
      // Read from the engine's own chain, not re-derived from priority order.
      // The old version sorted providers by priority and reported that index,
      // which disagreed with the walk below it whenever a combo was active —
      // same lane, different hop number, and under some combos a different
      // lane entirely. The rail exists to make the pages agree.
      ["FIRST SERVABLE", (() => {
        if (routingChain === null) return "—";
        const byId = new Map(s.providers.map((p) => [p.id, p]));
        const i = routingChain.findIndex((c) => {
          const p = byId.get(c.provider);
          return c.hasKey && c.enabled && p?.circuit !== "OPEN"
            && !(p && p.budgetCapUsd !== null && p.monthlySpendUsd >= p.budgetCapUsd)
            && !(p?.connectionsCoolingDown > 0);
        });
        return i < 0 ? "NONE" : `#${String(i + 1).padStart(2, "0")} ${esc(trunc(routingChain[i].provider, 9))}`;
      })(), "", true], lanes];
    case "budgets": return [
      ["SPEND MTD", fmtUsd(spend)],
      ["CAPS", cap ? fmtUsd(cap) : "none", cap ? "" : "warn"],
      ["HEADROOM", cap ? fmtUsd(Math.max(0, cap - spend)) : "—", "", true],
      ["CAPPED LANES", String(s.providers.filter((p) => p.budgetCapUsd !== null).length)]];
    case "ledger": return [
      ["MONTH SPEND", fmtUsd(spend)],
      ["PRICE TABLE", `${trust.verified ?? 0}<small> / ${trust.total ?? 0}</small>`,
        trust.activeUnverified?.length ? "bad" : "ok"],
      ["BACKED", s.confidence?.reportedPct == null ? "—" : `${s.confidence.reportedPct}%`, s.confidence?.reportedPct == null ? "" : s.confidence.reportedPct >= 95 ? "ok" : "warn", true]];
    case "resilience": return [
      ["BREAKERS", open ? `${open} OPEN` : "CLOSED", open ? "bad" : "ok"],
      ["COOLING KEYS", String(cool), cool ? "warn" : ""],
      ["LOCKED MODELS", String(locked), locked ? "warn" : ""], lanes];
    case "combos": return [
      ["STRATEGIES", String(s.routing?.strategyCount ?? 0)],
      ["COMBOS", String(s.routing?.comboCount ?? 0)],
      ["DEFAULT", s.routing?.defaultCombo ? esc(trunc(s.routing.defaultCombo, 12)) : "priority", "", true]];
    case "quota": return [
      ["POOLS", String(qt.distinctPools ?? 0)],
      ["DECLARED", String(qt.declaredFreeProviders ?? 0), "", true],
      ["DEDUPED", String(qt.dedupedAway ?? 0), "", true],
      ["EXHAUSTED", String(qt.exhaustedPools ?? 0), qt.exhaustedPools ? "warn" : "ok"]];
    case "cache": return [
      ["HIT RATE", `${cache.hitRatePct ?? 0}%`, (cache.hitRatePct ?? 0) >= 40 ? "ok" : ""],
      ["ENTRIES", String(cache.entries ?? 0)],
      ["HIT / MISS", `${cache.hits ?? 0} / ${cache.misses ?? 0}`, "", true]];
    case "compression": return [
      ["COMPRESSION", comp.enabled ? "ON" : "OFF", comp.enabled ? "ok" : "warn"],
      ["RTK", comp.rtk?.enabled ? "ON" : "OFF", comp.rtk?.enabled ? "ok" : ""],
      ["CAVEMAN", comp.caveman?.enabled ? esc(String(comp.caveman.level || "on")) : "OFF", comp.caveman?.enabled ? "warn" : "", true],
      ["HISTORY", `${comp.historyWindow ?? 12}<small> msg</small>`, "", true]];
    case "guards": return [
      ["PII", sec.redactPii ? "REDACTED" : "OFF", sec.redactPii ? "ok" : "warn"],
      ["INJECTION", esc(String(sec.injectionMode || "off").toUpperCase()),
        sec.injectionMode && sec.injectionMode !== "off" ? "ok" : "warn"]];
    case "access": return [
      ["GATEWAY", s.gatewayAuthEnabled ? "LOCKED" : "OPEN", s.gatewayAuthEnabled ? "ok" : sec.exposedBeyondLoopback ? "bad" : "warn"],
      ["BOUND", esc(String(sec.boundHost || "?")), sec.exposedBeyondLoopback ? "warn" : ""],
      ["AT REST", sec.keyEncryptedAtRest ? "ENCRYPTED" : sec.encryptionAvailable ? "READY" : "PLAINTEXT",
        sec.keyEncryptedAtRest ? "ok" : "warn", true],
      ["RATE LIMIT", sec.rateLimit?.enabled ? `${sec.rateLimit.refillPerMinute}<small>/min</small>` : "OFF", sec.rateLimit?.enabled ? "ok" : "", true]];
    case "proxy": return [
      ["EGRESS", Object.keys(proxy.configured || {}).length ? "PROXIED" : "DIRECT"],
      ["RULES", String(Object.keys(proxy.configured || {}).length + Object.keys(proxy.categories || {}).length)],
      ["TLS", esc(String(proxy.tls?.profile || "default")), "", true],
      ["AGENT", proxy.available ? "READY" : "UNAVAILABLE", proxy.available ? "ok" : "bad", true]];
    case "endpoints": return [
      ["GATEWAY", s.gatewayAuthEnabled ? "LOCKED" : "OPEN", s.gatewayAuthEnabled ? "ok" : "warn"],
      ["MODELS", String(s.providers.reduce((a, p) => a + p.models.length, 0))], lanes];
    default: return [state, lanes,
      ["CROSSINGS", String(s.totals.totalRequests), "", true],
      ["SPEND MTD", fmtUsd(spend), "", true]];
  }
}

function paintCommandRail(s) {
  const rail = document.getElementById("cmdRail");
  if (!rail) return;
  const cells = railCells(s).concat([
    ["LAST SYNC", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })]
  ]);
  rail.innerHTML = cells.map(([k, v, cls = "", opt = false]) =>
    `<div class="rail-cell${opt ? " opt" : ""}"><div class="rail-k">${esc(k)}</div><div class="rail-v ${esc(cls)}">${v}</div></div>`
  ).join("");
}

async function refresh() {
  try {
    state = await api("/api/panel/state");

    paintSidebarFoot(state);
    paintCommandRail(state);

    const lock = document.getElementById("lockPill");
    lock.innerHTML = `<span class="dot ${state.gatewayAuthEnabled ? "live" : "idle"}"></span><span>${state.gatewayAuthEnabled ? "locked" : "unlocked"}</span>`;

    renderNav();
    renderPage(current);
  } catch (err) {
    const dot = document.querySelector("#sbFoot .dot");
    if (dot) dot.className = "dot warn";
    const st = document.getElementById("sfState");
    if (st) st.textContent = "DISCONNECTED";
    console.error(err);
  }
}

// navigate() writes location.hash, which fires hashchange, which called
// navigate() again — every navigation rendered the page twice, and the second
// pass replaced the DOM the first had just focused. Only react to a hash that
// actually differs from where we already are (back/forward, a pasted link).
window.addEventListener("hashchange", () => {
  const next = location.hash.slice(1) || "home";
  if (next !== current) navigate(next);
});
document.getElementById("refreshBtn").addEventListener("click", refresh);

navigate(current);
refresh();
setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 8000);

// Polling pauses while the tab is hidden, so coming back could otherwise
// leave up to eight seconds of stale figures — and a pixel-laid-out chart
// stretched to whatever width the window changed to in the meantime.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});
