#!/usr/bin/env node
// Builds the multi-page website in site/ from the single landing page.
//
// public/landing.html stays the source of truth for the existing sections
// (their markup, styles and animations), so the site and the gateway's own
// copy at /panel/landing.html never drift. This script cuts those sections
// into pages, wraps every page in one shared head, menu and footer, rewrites
// same-page links (#audit) to cross-page ones (audit.html#audit), and adds
// the pages that are new here: pricing, guides and docs.
//
//   node scripts/build-site.mjs        writes site/
//
// Vercel and GitHub Pages run this on every deploy, and site/ is not
// committed, so what is published can never drift from its source.

import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const out = path.join(root, "site");
const src = fs.readFileSync(path.join(root, "public", "landing.html"), "utf8").replace(/\r\n/g, "\n");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const V = `v${pkg.version}`;
const GH = "https://github.com/IQGlitching/Tollpike";

// ---------------------------------------------------------------- pieces
const css = src.slice(src.indexOf("<style>") + 7, src.indexOf("</style>"));
const markStart = src.indexOf("<!-- Tollpike mark");
const markSvg = src.slice(markStart, src.indexOf("</svg>", markStart) + 6);

function section(id) {
  const start = src.indexOf(`<section id="${id}"`);
  if (start < 0) throw new Error(`section #${id} not found in landing.html`);
  const end = src.indexOf("</section>", start) + "</section>".length;
  const html = src.slice(start, end);
  if (html.slice(1).includes("<section")) throw new Error(`section #${id} contains a nested section`);
  return html;
}

// Which page each existing section lives on.
const PAGES = {
  "index.html": ["hero", "how", "dashboard", "start", "cta"],
  "routing.html": ["product", "why", "routing", "providers", "cost", "latency", "traffic", "resilience", "observability", "diff"],
  "audit.html": ["audit"],
  "docs.html": ["developers"]
};
const pageOf = {};
for (const [page, ids] of Object.entries(PAGES)) for (const id of ids) pageOf[id] = page;

// Same-page links to a section that now lives on another page point there.
function relink(html, page, prefix) {
  return html.replace(/href="#([a-z][\w-]*)"/g, (m, id) => {
    const target = pageOf[id];
    if (!target || target === page) return m;
    return `href="${prefix}${target}#${id}"`;
  });
}

// ---------------------------------------------------------------- chrome
const NAV = [
  ["routing.html", "Gateway"],
  ["audit.html", "Audit"],
  ["guides/index.html", "Guides"],
  ["docs.html", "Docs"],
  ["pricing.html", "Pricing"]
];

function head({ title, description, prefix }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<meta name="description" content="${description}" />
<link rel="icon" type="image/svg+xml" href="${prefix}favicon.svg" />
<link rel="stylesheet" href="${prefix}site.css" />
</head>
<body>

${markSvg}
`;
}

function nav({ page, prefix }) {
  const links = NAV.map(([href, label]) => {
    const here = page === href || (href.startsWith("guides/") && page.startsWith("guides/"));
    return `      <a href="${prefix}${href}"${here ? ' class="here" aria-current="page"' : ""}>${label}</a>`;
  }).join("\n");
  return `
<header class="nav" id="nav">
  <div class="nav-in">
    <a class="brand" href="${prefix}index.html" aria-label="Tollpike home">
      <span class="brand-mark"><svg><use href="#tp-mark"/></svg></span>
      <span>
        <span class="brand-name">tollpike</span><br/>
        <span class="brand-ver">${V}</span>
      </span>
    </a>
    <nav class="nav-links" aria-label="Primary">
${links}
    </nav>
    <div class="nav-right">
      <a class="ghost" href="${GH}" rel="noopener">GitHub</a>
      <a class="ghost" href="/panel" data-signin>Sign in</a>
      <a class="btn primary sm" href="${prefix}guides/getting-started.html">Get started</a>
      <details class="nav-menu">
        <summary aria-label="Menu">Menu</summary>
        <div class="nav-menu-list">
${links.replace(/^ {6}/gm, "          ")}
          <a href="${GH}" rel="noopener">GitHub</a>
        </div>
      </details>
    </div>
  </div>
</header>
`;
}

function footer({ prefix }) {
  return `
<footer>
  <div class="foot-in">
    <div class="foot-grid">
      <div class="foot-col">
        <a class="brand" href="${prefix}index.html" aria-label="Tollpike">
          <span class="brand-mark"><svg><use href="#tp-mark"/></svg></span>
          <span>
            <span class="brand-name">tollpike</span><br/>
            <span class="brand-ver">${V}</span>
          </span>
        </a>
        <p class="foot-tag">The checkpoint for AI traffic.<br/>Route every request. Audit every agent.</p>
      </div>
      <div class="foot-col">
        <h4>Product</h4>
        <a href="${prefix}routing.html">Gateway</a>
        <a href="${prefix}routing.html#providers">Providers</a>
        <a href="${prefix}audit.html">Agent audit</a>
        <a href="${prefix}pricing.html">Pricing</a>
      </div>
      <div class="foot-col">
        <h4>Learn</h4>
        <a href="${prefix}guides/getting-started.html">Get started</a>
        <a href="${prefix}guides/index.html">All guides</a>
        <a href="${prefix}docs.html">Docs and CLI</a>
        <a href="${GH}" rel="noopener">GitHub</a>
      </div>
      <div class="foot-col">
        <h4>Compliance</h4>
        <a href="${prefix}audit.html">ISO/IEC 42001 · 27001</a>
        <a href="${prefix}audit.html">SOC 2 · EU AI Act</a>
        <a href="${prefix}audit.html">NIST AI RMF · MITRE ATLAS</a>
        <a href="${prefix}guides/evidence.html">Evidence for auditors</a>
      </div>
    </div>
    <div class="foot-bottom">
      <span>tollpike · ${V} · MIT</span>
      <span class="status"><span class="dot ok beat"></span>SELF-HOSTED · YOUR KEYS STAY WITH YOU</span>
    </div>
    <div class="signature">
      <code class="sig-cmd" aria-label="Built by Faisal Alani">
        <span class="sig-prompt" aria-hidden="true">$</span><span class="sig-type" data-text="built by faisal alani" aria-hidden="true"></span><span class="sig-caret" aria-hidden="true"></span>
      </code>
      <span class="sig-meta">Tollpike · 2026</span>
    </div>
  </div>
</footer>

<script src="${prefix}landing.js" defer></script>
</body>
</html>
`;
}

function pageHeader({ kicker, title, lede, tone = "" }) {
  return `
<section class="band gridpaper page-head">
  <div class="band-in">
    <div class="rv" style="max-width:780px">
      <p class="kicker ${tone}">${kicker}</p>
      <h1 class="display">${title}</h1>
      <p class="lede">${lede}</p>
    </div>
  </div>
</section>
`;
}

function write(file, html) {
  const p = path.join(out, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, html);
}

function page({ file, title, description, body }) {
  const prefix = file.includes("/") ? "../" : "";
  write(file, head({ title, description, prefix }) + nav({ page: file, prefix }) + relink(body, file, prefix) + footer({ prefix }));
}

const cmd = (id, text) => `<div class="cmdrow"><code class="cmd" id="${id}">${text}</code><button class="copybtn" type="button" data-copy="#${id}">Copy</button></div>`;

// ---------------------------------------------------------------- home
const JOBS = `
<section id="jobs" class="band">
  <div class="band-in">
    <div class="rv" style="max-width:760px">
      <p class="kicker">WHAT IT DOES</p>
      <h2 class="display">One checkpoint. Two jobs.</h2>
      <p class="lede">Your apps and AI agents send their requests to Tollpike instead of straight to
        the AI companies. Everything passes through it, so it can route each request well and keep an
        honest record of what every agent did.</p>
    </div>
    <div class="jobs-grid rv">
      <a class="job" href="routing.html">
        <span class="job-k">01 · GATEWAY</span>
        <h3>Route every AI request</h3>
        <ul>
          <li>One endpoint and one key for 46 providers</li>
          <li>Picks a provider by price, speed or free quota</li>
          <li>Switches when a provider fails, so requests still land</li>
          <li>Hard spending caps, so a runaway script cannot run up a bill</li>
        </ul>
        <span class="job-more">See the gateway &#8594;</span>
      </a>
      <a class="job job-audit" href="audit.html">
        <span class="job-k">02 · AUDIT</span>
        <h3>Audit every AI agent</h3>
        <ul>
          <li>Every command, file edit and model call, recorded</li>
          <li>Each action carries the name of the agent that did it</li>
          <li>Risky actions flagged, blocked or sent to a person first</li>
          <li>A tamper-evident record an auditor will accept</li>
        </ul>
        <span class="job-more">See the audit trail &#8594;</span>
      </a>
    </div>
    <div class="trust rv" aria-label="Frameworks the evidence maps to">
      <span class="trust-k">EVIDENCE MAPPED TO</span>
      <span class="fw fw-ai"><b>ISO/IEC 42001</b></span>
      <span class="fw"><b>ISO/IEC 27001</b></span>
      <span class="fw"><b>SOC 2</b></span>
      <span class="fw fw-eu"><b>EU AI Act</b></span>
      <span class="fw fw-nist"><b>NIST AI RMF</b></span>
      <span class="fw fw-owasp"><b>OWASP Top 10s</b></span>
      <span class="fw fw-atlas"><b>MITRE ATLAS</b></span>
    </div>
  </div>
</section>
`;

page({
  file: "index.html",
  title: "Tollpike · the checkpoint for AI traffic",
  description: "Tollpike routes every AI request across 46 providers and keeps a tamper-evident record of what every AI agent did. Self-hosted, with your keys on your machine.",
  body: heroForSite(section("hero")) + JOBS + section("how") + section("dashboard") + section("start") + section("cta")
});

// The site's hero says both jobs; the gateway's own landing page keeps its copy.
function heroForSite(html) {
  const swaps = [
    ['<p class="kicker">AI ROUTING INFRASTRUCTURE</p>', '<p class="kicker">AI GATEWAY · AGENT AUDIT</p>'],
    ["<h1>Route every AI request with intelligence.</h1>", "<h1>Route every AI request. Audit every agent.</h1>"],
    [
      `<p class="lede">Tollpike sits between your application and every major AI provider.
          It routes each request to the best lane in real time and keeps <b>cost</b>,
          <b>latency</b>, <b>quotas</b>, and <b>health</b> in view. One endpoint in.
          The entire model ecosystem out.</p>`,
      `<p class="lede">Tollpike sits between your apps, your AI agents and every major AI provider.
          It sends each request to the best provider, keeps <b>cost</b> and <b>latency</b> in
          check, and keeps a <b>tamper-evident record</b> of everything your agents did.
          Self-hosted, with your keys on your machine.</p>`
    ],
    ['<a class="btn primary" href="#developers">Get started</a>', '<a class="btn primary" href="guides/getting-started.html">Get started</a>'],
    ['<a class="btn" href="#traffic">Explore the system</a>', '<a class="btn" href="#jobs">See what it does</a>']
  ];
  for (const [a, b] of swaps) {
    if (!html.includes(a)) throw new Error(`hero copy changed in landing.html; update heroForSite: ${a.slice(0, 50)}`);
    html = html.replace(a, b);
  }
  return html;
}

// ---------------------------------------------------------------- gateway
page({
  file: "routing.html",
  title: "Gateway · Tollpike",
  description: "One endpoint for 46 AI providers. Tollpike routes each request by price, speed or quota, fails over automatically and enforces hard spending caps.",
  body:
    pageHeader({
      kicker: "THE GATEWAY",
      title: "One endpoint for every AI&nbsp;provider.",
      lede: "Point your apps at Tollpike once. It picks the right provider for each request, switches when one fails, and shows what every request cost."
    }) + PAGES["routing.html"].map(section).join("\n")
});

// ---------------------------------------------------------------- audit
page({
  file: "audit.html",
  title: "Agent audit · Tollpike",
  description: "A tamper-evident record of every AI agent action, with risky actions blocked before they run and evidence mapped to ISO/IEC 42001, ISO/IEC 27001, SOC 2, the EU AI Act, NIST AI RMF, OWASP and MITRE ATLAS.",
  body: section("audit")
});

// ---------------------------------------------------------------- docs
const CLI = [
  ["tollpike", "start the gateway and the control panel"],
  ["tollpike panel", "open the control panel in your browser, already unlocked"],
  ["tollpike key", "print the operator key (key rotate replaces it)"],
  ["tollpike agents add NAME", "issue an agent key, shown once (--sensor for a sensor key)"],
  ["tollpike agents list", "the register of agent and sensor keys"],
  ["tollpike agents revoke NAME", "revoke a key at once"],
  ["tollpike audit", "audit coverage, gaps and rule modes"],
  ["tollpike audit events", "recent events (--flagged, --unreviewed, --agent)"],
  ["tollpike audit verify", "check the tamper-evident chain"],
  ["tollpike audit export", "evidence pack for an auditor (--from, --to, --out)"],
  ["tollpike audit grc", "compliance tests and the Vanta and Drata push"],
  ["tollpike hook config", "the Claude Code hooks block"],
  ["tollpike endpoint connections", "flag agents reaching providers directly (Windows)"],
  ["tollpike mcp", "serve the MCP tools over stdio"],
  ["tollpike where", "print the paths and URLs this install uses"]
];
const DOCS_CLI = `
<section id="cli" class="band">
  <div class="band-in">
    <div class="rv" style="max-width:760px">
      <p class="kicker sc-c">CLI REFERENCE</p>
      <h2 class="display">Every command in one&nbsp;place.</h2>
      <p class="lede">Run any of these with <b>npx tollpike@latest</b> in front, or install once with
        <b>npm install -g tollpike</b>. The full reference, API and design notes live in the
        <a href="${GH}#readme" rel="noopener">README</a> and the <a href="${GH}/tree/main/docs" rel="noopener">docs folder</a>.</p>
    </div>
    <div class="cli-table rv">
      ${CLI.map(([c, d]) => `<div class="cli-row"><code>${c}</code><span>${d}</span></div>`).join("\n      ")}
    </div>
  </div>
</section>
`;
page({
  file: "docs.html",
  title: "Docs · Tollpike",
  description: "The Tollpike API, protocols and CLI reference: OpenAI-compatible /v1, MCP, A2A and every command.",
  body: section("developers") + DOCS_CLI
});

// ---------------------------------------------------------------- pricing
const PRICING = `
<section id="pricing" class="band">
  <div class="band-in">
    <div class="price-grid rv">
      <div class="price">
        <span class="price-k">GATEWAY</span>
        <h3>Free</h3>
        <p class="price-d">Open source under MIT. Self-hosted, forever free.</p>
        <ul>
          <li>Routing across 46 AI providers</li>
          <li>Automatic failover and routing strategies</li>
          <li>Spending caps, cost and latency tracking</li>
          <li>Control panel, locked with your own key</li>
          <li>OpenAI-compatible API, MCP and A2A</li>
        </ul>
        <a class="btn" href="guides/getting-started.html">Get started</a>
      </div>
      <div class="price price-pro">
        <span class="price-k">AUDIT AND COMPLIANCE</span>
        <h3>Pro <span class="price-tag">EARLY ACCESS</span></h3>
        <p class="price-d">For teams that must prove what their AI agents did.</p>
        <ul>
          <li>Tamper-evident audit trail of every agent action</li>
          <li>Agent keys, Claude Code hooks, block and ask rules</li>
          <li>Endpoint sensors and hosted AI vendor logs</li>
          <li>Evidence mapped to ISO/IEC 42001, 27001, SOC 2, the EU AI Act, NIST AI RMF, OWASP and MITRE ATLAS</li>
          <li>Push to Vanta and Drata</li>
        </ul>
        <a class="btn primary" href="${GH}" rel="noopener">Follow for early access</a>
      </div>
      <div class="price">
        <span class="price-k">ENTERPRISE</span>
        <h3>Talk to us</h3>
        <p class="price-d">For organisations rolling AI agents out at scale.</p>
        <ul>
          <li>Everything in Pro</li>
          <li>Many machines and teams in one view</li>
          <li>Single sign-on and roles</li>
          <li>Onboarding and support</li>
        </ul>
        <a class="btn" href="${GH}" rel="noopener">Get in touch</a>
      </div>
    </div>
    <p class="price-note rv">During early access the audit features still ship in the open-source package.
      Pro pricing will be announced before any of them move.</p>
  </div>
</section>
`;
page({
  file: "pricing.html",
  title: "Pricing · Tollpike",
  description: "The Tollpike gateway is free and open source. Audit and compliance for AI agents is in early access.",
  body:
    pageHeader({
      kicker: "PRICING",
      title: "The gateway is free. Proof is the&nbsp;product.",
      lede: "Route AI traffic for free, on your own machine. Pay when you need to prove to an auditor what your AI agents did."
    }) + PRICING
});

// ---------------------------------------------------------------- guides
const GUIDES = [
  {
    slug: "getting-started",
    title: "Your first 15 minutes",
    kicker: "START HERE",
    summary: "Install Tollpike, open the control panel and send your first request.",
    body: `
<ol class="steps">
  <li><h3>Check you have Node.js</h3>
    <p>Tollpike needs <b>Node.js 18 or newer</b>. That is the only requirement. Download it from nodejs.org if you do not have it.</p></li>
  <li><h3>Start Tollpike</h3>
    <p>Open a terminal and run:</p>${cmd("g1", "npx tollpike@latest")}
    <p>On first start it creates its own <b>operator key</b>, your master key to the control panel, and stores it encrypted. Leave this window open: closing it stops Tollpike.</p></li>
  <li><h3>Open the control panel</h3>
    <p>In a second terminal:</p>${cmd("g2", "npx tollpike@latest panel")}
    <p>Your browser opens the panel already unlocked. It is your dashboard for everything.</p></li>
  <li><h3>Connect a provider</h3>
    <p>Tollpike does not own any AI accounts; it routes to yours. Follow <a href="providers.html">Connect an AI provider</a>. Groq has a free tier if you want to try without paying.</p></li>
  <li><h3>Send your first request</h3>
    <p>Use the test console on the Control center page, or point any OpenAI-compatible tool at:</p>${cmd("g3", "http://127.0.0.1:20128/v1")}
    <p>Ask for the model <b>auto</b> and Tollpike picks the provider. You can watch the request travel through it on the dashboard.</p></li>
</ol>
<p class="next">Next: <a href="agent-keys.html">give each AI tool its own key</a>.</p>`
  },
  {
    slug: "providers",
    title: "Connect an AI provider",
    kicker: "GATEWAY",
    summary: "Add your OpenAI, Anthropic, Groq or other key so Tollpike can route to it.",
    body: `
<ol class="steps">
  <li><h3>Get a key from the provider</h3>
    <p>Sign in to the provider's console (OpenAI, Anthropic, Groq, Google and 42 others) and create an API key.</p></li>
  <li><h3>Add it in the panel</h3>
    <p>Open the panel, go to <b>Providers</b>, pick the provider and paste the key. It is written to a protected file on your machine (<b>~/.tollpike/.env</b>), never to the browser.</p></li>
  <li><h3>Check it is live</h3>
    <p>The provider turns green on the Control center. Send a test request from the console there.</p></li>
</ol>
<p class="note">Keep provider keys only in Tollpike. Give your tools Tollpike agent keys instead, so nothing reaches a provider without passing the checkpoint.</p>
<p class="next">Next: <a href="budgets.html">cap your spending</a>.</p>`
  },
  {
    slug: "agent-keys",
    title: "Give each AI tool its own key",
    kicker: "AUDIT",
    summary: "Agent keys put a name on every action, so the record says which tool did what.",
    body: `
<ol class="steps">
  <li><h3>Issue a key</h3>${cmd("a1", "npx tollpike@latest agents add my-cursor")}
    <p>The key is printed <b>once</b>. Copy it straight into the tool; do not paste it into chats or documents.</p></li>
  <li><h3>Give it to the tool</h3>
    <p>In the tool's settings, use the key as its API key and <b>http://127.0.0.1:20128/v1</b> as the base URL.</p></li>
  <li><h3>See it in the record</h3>
    <p>On the Audit page, every action from that tool now carries its name.</p></li>
</ol>
<p class="note">Once the first agent key exists, the model endpoints require a key. Revoke one at any time with <b>npx tollpike@latest agents revoke my-cursor</b>; it stops working at once.</p>
<p class="next">Next: <a href="claude-code.html">audit Claude Code</a>.</p>`
  },
  {
    slug: "claude-code",
    title: "Audit Claude Code",
    kicker: "AUDIT",
    summary: "Record every command and file edit Claude Code makes, and stop risky ones before they run.",
    body: `
<ol class="steps">
  <li><h3>Print the hooks block</h3>${cmd("c1", "npx tollpike@latest hook config")}
    <p>This prints the settings that make Claude Code report each action to Tollpike before and after it runs.</p></li>
  <li><h3>Add it to Claude Code</h3>
    <p>Merge the output into <b>~/.claude/settings.json</b> under <b>hooks</b>, keeping any settings already there.</p></li>
  <li><h3>Give Claude Code a key</h3>
    <p>Issue an agent key (<a href="agent-keys.html">see this guide</a>) and save it as the user environment variable <b>TOLLPIKE_AGENT_KEY</b>. Then fully quit and reopen Claude Code.</p></li>
  <li><h3>Check the record</h3>
    <p>On the Audit page, the Claude Code hooks counter starts climbing and every action carries the agent's name.</p></li>
</ol>
<p class="note">If Tollpike is not running, Claude Code keeps working and those actions are simply not recorded. Start Tollpike first.</p>
<p class="next">Next: <a href="block-risky-actions.html">stop risky actions before they run</a>.</p>`
  },
  {
    slug: "block-risky-actions",
    title: "Stop risky actions before they run",
    kicker: "AUDIT",
    summary: "Turn a rule from flag into block or ask, so Tollpike stops the action or asks you first.",
    body: `
<ol class="steps">
  <li><h3>Open the rules</h3>
    <p>On the Audit page, scroll to <b>Rules</b>: destructive commands, download and execute, credential files, privilege changes and more.</p></li>
  <li><h3>Pick a mode</h3>
    <p><b>observe</b> records it. <b>flag</b> also puts it in the review queue. <b>ask</b> makes Claude Code ask you first. <b>block</b> refuses it.</p></li>
  <li><h3>Review the queue</h3>
    <p>Anything flagged waits for a person. Sign off what is normal and investigate what is not; each sign-off is itself recorded.</p></li>
</ol>
<p class="note">Ask and block only take effect where Tollpike sees an action before it runs: Claude Code hooks and the MCP proxy.</p>`
  },
  {
    slug: "endpoint-sensor",
    title: "Catch tools going around Tollpike",
    kicker: "AUDIT",
    summary: "A sensor on the machine flags any AI tool that reaches a provider directly.",
    body: `
<ol class="steps">
  <li><h3>Issue a sensor key</h3>${cmd("e1", "npx tollpike@latest agents add laptop-sensor --sensor")}
    <p>Save it as the user environment variable <b>TOLLPIKE_SENSOR_KEY</b>. A sensor key can report telemetry and nothing else.</p></li>
  <li><h3>Start the sensor (Windows)</h3>
    <p>In a new terminal:</p>${cmd("e2", "npx tollpike@latest endpoint connections")}
    <p>Every minute it checks open connections and sends only the ones to AI providers, so the rest of your traffic never leaves the machine. No administrator rights needed.</p></li>
  <li><h3>Watch for flags</h3>
    <p>An agent that reaches a provider around Tollpike is flagged on the Audit page, at most once an hour per program.</p></li>
</ol>
<p class="note">This detects; it does not block. Blocking belongs at the network: a company proxy or a container network. Linux and macOS can use auditd, osquery or Falco instead.</p>`
  },
  {
    slug: "budgets",
    title: "Cap your spending",
    kicker: "GATEWAY",
    summary: "Set a monthly limit per provider so nothing runs up a surprise bill.",
    body: `
<ol class="steps">
  <li><h3>Open Budgets</h3>
    <p>In the panel, go to <b>Budgets</b>. It shows what each provider has cost this month.</p></li>
  <li><h3>Set a cap</h3>
    <p>Enter a monthly limit in dollars for a provider. When it is reached, Tollpike stops sending requests there and routes to the next one.</p></li>
  <li><h3>Check the ledger</h3>
    <p>The <b>Ledger</b> page lists every request and its cost, and exports to CSV for your records.</p></li>
</ol>`
  },
  {
    slug: "evidence",
    title: "Evidence for auditors",
    kicker: "COMPLIANCE",
    summary: "Export a signed evidence pack mapped to ISO/IEC 42001, ISO/IEC 27001, SOC 2 and more.",
    body: `
<ol class="steps">
  <li><h3>Export a period</h3>${cmd("v1", "npx tollpike@latest audit export --from 2026-07-01 --to 2026-09-30")}
    <p>This writes <b>evidence.json</b> and a <b>SUMMARY.md</b> an auditor can read first: the chain check, the agent register, reviews, open flags and the control mapping.</p></li>
  <li><h3>Check the chain</h3>${cmd("v2", "npx tollpike@latest audit verify")}
    <p>Proves nothing in the record was edited, deleted or rolled back.</p></li>
  <li><h3>Send it to your compliance platform</h3>
    <p><b>npx tollpike@latest audit grc setup vanta</b> (or <b>drata</b>) walks through pushing the tests and evidence automatically.</p></li>
</ol>
<p class="note">Tollpike evidences the technical controls. A full ISO or SOC 2 programme also covers policy, risk, people and suppliers, which no tool can do for you.</p>`
  }
];

for (const g of GUIDES) {
  const i = GUIDES.indexOf(g);
  page({
    file: `guides/${g.slug}.html`,
    title: `${g.title} · Tollpike guides`,
    description: g.summary,
    body:
      pageHeader({ kicker: `GUIDE · ${g.kicker}`, title: g.title, lede: g.summary }) +
      `
<section class="band guide">
  <div class="band-in guide-in">
    <aside class="guide-nav">
      <span class="guide-nav-k">GUIDES</span>
      ${GUIDES.map((x) => `<a href="${x.slug}.html"${x.slug === g.slug ? ' class="here" aria-current="page"' : ""}>${x.title}</a>`).join("\n      ")}
    </aside>
    <article class="guide-body">${g.body}
      <div class="guide-pager">${i > 0 ? `<a href="${GUIDES[i - 1].slug}.html">&#8592; ${GUIDES[i - 1].title}</a>` : "<span></span>"}${i < GUIDES.length - 1 ? `<a href="${GUIDES[i + 1].slug}.html">${GUIDES[i + 1].title} &#8594;</a>` : ""}</div>
    </article>
  </div>
</section>
`
  });
}

page({
  file: "guides/index.html",
  title: "Guides · Tollpike",
  description: "Plain-English guides: install Tollpike, connect providers, give tools their own keys, audit Claude Code and produce evidence for auditors.",
  body:
    pageHeader({
      kicker: "GUIDES",
      title: "From install to audit, in plain&nbsp;English.",
      lede: "Short, step-by-step guides. Start with the first one; each ends with a link to the next."
    }) +
    `
<section class="band">
  <div class="band-in">
    <div class="guide-grid rv">
      ${GUIDES.map((g, i) => `<a class="guide-card" href="${g.slug}.html"><span class="guide-card-k">${String(i + 1).padStart(2, "0")} · ${g.kicker}</span><h3>${g.title}</h3><p>${g.summary}</p></a>`).join("\n      ")}
    </div>
  </div>
</section>
`
});

// ---------------------------------------------------------------- assets
const EXTRA_CSS = `

/* ============================================================================
   MULTI-PAGE SITE · added by scripts/build-site.mjs
   ========================================================================== */
.nav-links a.here { color: var(--txt); }
.nav-menu { display: none; position: relative; }
.nav-menu summary { list-style: none; cursor: pointer; font-family: var(--mono); font-size: 11px; letter-spacing: .1em; color: var(--txt); border: 1px solid var(--line-3); border-radius: 8px; padding: 7px 12px; }
.nav-menu summary::-webkit-details-marker { display: none; }
.nav-menu[open] summary { border-color: var(--route); }
.nav-menu-list { position: absolute; right: 0; top: calc(100% + 8px); min-width: 200px; display: flex; flex-direction: column; padding: 6px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--bg-deep); box-shadow: 0 12px 30px rgba(0,0,0,.45); z-index: 50; }
.nav-menu-list a { color: var(--txt-2); text-decoration: none; padding: 9px 12px; border-radius: 6px; font-size: 14px; }
.nav-menu-list a:hover, .nav-menu-list a.here { color: var(--txt); background: var(--surface); }
@media (max-width: 980px) { .nav-menu { display: block; } }
@media (max-width: 540px) { .nav-right .btn.sm { display: none; } }
.page-head .band-in { padding-bottom: clamp(24px, 4vh, 40px); }
.page-head h1.display { margin-top: 10px; }
.jobs-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 34px; }
@media (max-width: 820px) { .jobs-grid { grid-template-columns: 1fr; } }
.job { display: block; text-decoration: none; color: inherit; border: 1px solid var(--line-2); border-radius: 14px; background: var(--surface); padding: 22px 24px; transition: border-color .3s var(--ease), transform .3s var(--ease); }
.job:hover { border-color: rgba(167,139,250,.55); transform: translateY(-2px); }
.job-audit:hover { border-color: rgba(126,231,135,.5); }
.job-k { font-family: var(--mono); font-size: 10px; letter-spacing: .16em; color: var(--route); }
.job-audit .job-k { color: var(--ok); }
.job h3 { font-size: 22px; margin: 10px 0 12px; color: var(--txt); font-weight: 600; }
.job ul, .price ul { margin: 0; padding-left: 18px; color: var(--txt-2); font-size: 14px; line-height: 1.8; }
.job-more { display: inline-block; margin-top: 16px; font-family: var(--mono); font-size: 11px; letter-spacing: .1em; color: var(--txt); }
.trust { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 28px; }
.trust-k { font-family: var(--mono); font-size: 9.5px; letter-spacing: .16em; color: var(--txt-4); margin-right: 6px; }
.cli-table { margin-top: 26px; border: 1px solid var(--line-2); border-radius: 12px; overflow: hidden; }
.cli-row { display: grid; grid-template-columns: minmax(0, 300px) minmax(0, 1fr); gap: 16px; padding: 11px 16px; border-top: 1px solid var(--line); font-size: 13.5px; color: var(--txt-2); }
.cli-row:first-child { border-top: 0; }
.cli-row code { font-family: var(--mono); font-size: 12.5px; color: var(--txt); }
@media (max-width: 640px) { .cli-row { grid-template-columns: 1fr; gap: 4px; } }
.price-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
@media (max-width: 960px) { .price-grid { grid-template-columns: 1fr; } }
.price { display: flex; flex-direction: column; border: 1px solid var(--line-2); border-radius: 14px; background: var(--surface); padding: 24px; }
.price-pro { border-color: rgba(167,139,250,.55); box-shadow: 0 0 0 3px rgba(139,92,246,.07); }
.price-k { font-family: var(--mono); font-size: 10px; letter-spacing: .16em; color: var(--txt-4); }
.price h3 { font-size: 28px; margin: 8px 0 6px; color: var(--txt); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.price-tag { font-family: var(--mono); font-size: 9px; letter-spacing: .14em; color: var(--route); border: 1px solid rgba(167,139,250,.5); border-radius: 999px; padding: 3px 8px; }
.price-d { color: var(--txt-3); font-size: 14px; margin: 0 0 16px; }
.price ul { flex: 1; margin-bottom: 20px; }
.price .btn { align-self: flex-start; }
.price-note { margin-top: 20px; color: var(--txt-4); font-size: 13px; max-width: 760px; }
.guide-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
@media (max-width: 760px) { .guide-grid { grid-template-columns: 1fr; } }
.guide-card { display: block; text-decoration: none; color: inherit; border: 1px solid var(--line-2); border-radius: 12px; background: var(--surface); padding: 18px 20px; transition: border-color .3s var(--ease); }
.guide-card:hover { border-color: rgba(167,139,250,.55); }
.guide-card-k { font-family: var(--mono); font-size: 9.5px; letter-spacing: .16em; color: var(--route); }
.guide-card h3 { margin: 8px 0 6px; font-size: 18px; color: var(--txt); }
.guide-card p { margin: 0; color: var(--txt-3); font-size: 14px; line-height: 1.6; }
.guide-in { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 40px; align-items: start; }
@media (max-width: 860px) { .guide-in { grid-template-columns: 1fr; gap: 24px; } }
.guide-nav { position: sticky; top: 90px; display: flex; flex-direction: column; gap: 4px; }
@media (max-width: 860px) { .guide-nav { position: static; } }
.guide-nav-k { font-family: var(--mono); font-size: 9.5px; letter-spacing: .16em; color: var(--txt-4); margin-bottom: 6px; }
.guide-nav a { color: var(--txt-3); text-decoration: none; font-size: 13.5px; padding: 5px 10px; border-radius: 6px; border-left: 2px solid transparent; }
.guide-nav a:hover { color: var(--txt); }
.guide-nav a.here { color: var(--txt); border-left-color: var(--route); background: var(--surface); }
.guide-body { max-width: 720px; color: var(--txt-2); font-size: 15px; line-height: 1.75; }
.guide-body a { color: var(--route); }
.steps { list-style: none; counter-reset: step; margin: 0; padding: 0; }
.steps > li { counter-increment: step; position: relative; padding: 0 0 26px 52px; border-left: 1px solid var(--line-2); margin-left: 16px; }
.steps > li:last-child { border-left-color: transparent; }
.steps > li::before { content: counter(step); position: absolute; left: -17px; top: -2px; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; font-family: var(--mono); font-size: 13px; color: var(--txt); background: var(--surface-2); border: 1px solid var(--line-3); }
.steps h3 { margin: 2px 0 6px; font-size: 17px; color: var(--txt); }
.steps p { margin: 0 0 10px; }
.steps .cmdrow { margin: 8px 0 12px; max-width: 560px; }
.guide-body .note { border-left: 2px solid var(--conn); background: var(--surface); padding: 12px 16px; border-radius: 0 8px 8px 0; color: var(--txt-2); font-size: 14px; }
.guide-body .next { margin-top: 18px; }
.guide-pager { display: flex; justify-content: space-between; gap: 12px; margin-top: 34px; padding-top: 18px; border-top: 1px solid var(--line); font-family: var(--mono); font-size: 12px; }
.guide-pager a { color: var(--txt-2); text-decoration: none; }
.guide-pager a:hover { color: var(--txt); }
`;

fs.writeFileSync(path.join(out, "site.css"), css.trim() + "\n" + EXTRA_CSS);
fs.copyFileSync(path.join(root, "public", "landing.js"), path.join(out, "landing.js"));
fs.copyFileSync(path.join(root, "public", "favicon.svg"), path.join(out, "favicon.svg"));
fs.writeFileSync(path.join(out, "404.html"), fs.readFileSync(path.join(root, "deploy", "vercel", "404.html"), "utf8"));

const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else files.push(path.relative(out, p).replace(/\\/g, "/"));
  }
})(out);
console.log(`site/: ${files.length} files\n  ${files.sort().join("\n  ")}`);
