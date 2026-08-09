/* ============================================================================
   Motion engine: SVG path particles, section-gated, reduced-motion aware.
   ========================================================================== */
(() => {
const NS = 'http://www.w3.org/2000/svg';
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp01 = v => Math.min(1, Math.max(0, v));

/* The spatial layer is a pure enhancement: fine pointer, desktop viewport,
   and no reduced-motion preference. Everyone else gets the page as-is. */
const FINE = matchMedia('(pointer: fine)').matches;
const SPATIAL = !RM && FINE && innerWidth >= 900;
/* touch tier: the same story, tuned for tap and touch scrolling */
const TSPATIAL = !RM && !SPATIAL && matchMedia('(hover: none)').matches;
if (SPATIAL) document.documentElement.classList.add('spatial');
if (TSPATIAL) document.documentElement.classList.add('spatial-t');

/* shared state between the story modules and the spatial engine */
const S = { routeP: (SPATIAL || TSPATIAL) ? 0 : 1, setResPhase: null };

/* This page ships to two places. The gateway serves it at /panel/landing.html,
   where /panel is a real running control panel and "Sign in" is meaningful.
   The public site has no gateway at all, so:
     - "Sign in" has nothing to sign into and is removed rather than sent
       somewhere confusing (it used to bounce to GitHub, which made no sense);
     - the "control center" links point at the on-page install section, so a
       visitor stays on the page and sees how to bring their own up.
   One file, correct in both contexts. */
if (!location.pathname.startsWith('/panel')) {
  for (const a of $$('a[href="/panel"]')) {
    if (a.hasAttribute('data-signin')) { a.remove(); continue; }
    a.href = '#start';
  }
}

/* nav opacity on scroll */
const nav = $('#nav');
addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 24), { passive: true });
nav.classList.toggle('scrolled', scrollY > 24);

/* scroll reveal: IO for the normal path, plus a scroll fallback so content
   jumped past (End key, scrollbar drag, anchor links) still reveals */
const rvPending = new Set($$('.rv'));
function reveal(el) { el.classList.add('in'); rvPending.delete(el); rvObs.unobserve(el); }
const rvObs = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) reveal(e.target);
}), { threshold: .12 });
rvPending.forEach(el => rvObs.observe(el));
let rvTick = 0;
addEventListener('scroll', () => {
  const now = performance.now();
  if (now - rvTick < 180 || !rvPending.size) return;
  rvTick = now;
  rvPending.forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.top < innerHeight * .96 && r.bottom > -200) reveal(el);
    else if (r.bottom < 0) reveal(el); // already scrolled past; never hide content
  });
}, { passive: true });

/* particle along an SVG path */
function ride(layer, pathEl, { dur = 900, r = 2.6, color = 'var(--route)', reverse = false, glow = true, opacity = 1 } = {}) {
  return new Promise(done => {
    if (RM || !pathEl) return done();
    const len = pathEl.getTotalLength();
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('r', r);
    c.setAttribute('fill', color);
    if (opacity < 1) c.setAttribute('opacity', opacity);
    if (glow) c.setAttribute('style', `filter: drop-shadow(0 0 4px ${color.startsWith('var') ? 'rgba(167,139,250,.8)' : color})`);
    layer.appendChild(c);
    const t0 = performance.now();
    (function step(now) {
      const t = (now - t0) / dur;
      if (t >= 1 || !layer.isConnected) { c.remove(); return done(); }
      const p = pathEl.getPointAtLength((reverse ? 1 - t : t) * len);
      c.setAttribute('cx', p.x); c.setAttribute('cy', p.y);
      requestAnimationFrame(step);
    })(t0);
  });
}

/* run an async looping timeline only while its canvas is on screen */
function loopWhileVisible(el, fn) {
  if (RM) return;
  let alive = false, running = false;
  const run = async () => {
    if (running) return; running = true;
    while (alive) { await fn(() => alive); }
    running = false;
  };
  new IntersectionObserver(es => es.forEach(e => {
    alive = e.isIntersecting;
    if (alive) run();
  }), { threshold: .18 }).observe(el);
}

/* the rolling request stream shown across the page */
const LEDGER = [
  { prov: 'anthropic', model: 'claude-sonnet-4-6',    tok: 1204, cost: '$0.0142', lat: '892ms'  },
  { prov: 'openai',    model: 'gpt-4o',               tok: 2340, cost: '$0.0234', lat: '720ms'  },
  { prov: 'gemini',    model: 'gemini-2.5-pro',       tok: 1480, cost: '$0.0058', lat: '640ms'  },
  { prov: 'anthropic', model: 'claude-opus-4-8',      tok: 1850, cost: '$0.0891', lat: '1120ms' },
  { prov: 'xai',       model: 'grok-4.5',             tok: 890,  cost: '$0.0134', lat: '1042ms' },
  { prov: 'deepseek',  model: 'deepseek-v4-pro',      tok: 2310, cost: '$0.0028', lat: '780ms'  },
  { prov: 'openai',    model: 'gpt-4o-mini',          tok: 486,  cost: '$0.0006', lat: '340ms'  },
  { prov: 'gemini',    model: 'gemini-2.5-flash',     tok: 640,  cost: '$0.0004', lat: '310ms'  },
  { prov: 'mistral',   model: 'mistral-large-latest', tok: 512,  cost: '$0.0031', lat: '604ms'  },
  { prov: 'anthropic', model: 'claude-haiku-4-5',     tok: 380,  cost: '$0.0009', lat: '412ms'  },
];

/* live counters: numbers the visitor can watch move */
function tickCounter(el, start, minStep, maxStep, interval, fmt) {
  if (!el) return;
  let v = start;
  el.textContent = fmt(v);
  if (RM) return;
  setInterval(() => {
    v += minStep + Math.random() * (maxStep - minStep);
    el.textContent = fmt(v);
  }, interval);
}
tickCounter($('#liveReq'), 141204, 1, 3, 620, v => Math.round(v).toLocaleString('en-US'));
tickCounter($('#obsCross'), 4218930, 1, 3, 560, v => Math.round(v).toLocaleString('en-US'));
tickCounter($('#obsSpend'), 48290.14, 0.005, 0.045, 900, v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/* -------------------------------------------------- REQUEST JOURNEY (thread)
   One request travels the whole page. Each inter-section conduit is tagged
   with the routing stage the request is entering, so scrolling reads as the
   request advancing APPLICATION -> ROUTER -> ... -> RESPONSE -> TELEMETRY,
   not as moving between unrelated blocks. Reuses the existing .conduit pulse;
   adds only a label. Order follows the sections top to bottom. */
(() => {
  const STAGES = [
    'REQUEST · <b>IN</b>', 'ONE · <b>ENDPOINT</b>', '<b>&#8594;</b> ROUTER',
    'ROUTE · <b>SELECTED</b>', 'PROVIDER · <b>BOUND</b>', 'COST · <b>METERED</b>',
    'LATENCY · <b>OBSERVED</b>', 'TRAFFIC · <b>LIVE</b>', 'FAILOVER · <b>READY</b>',
    'RESPONSE · <b>OUT</b>', 'HEADERS · <b>X-TOLLPIKE-*</b>', 'TELEMETRY · <b>LOGGED</b>',
    '<b>CONTROL</b> CENTER', '<b>GET STARTED</b>'
  ];
  $$('.conduit').forEach((c, i) => {
    if (!STAGES[i]) return;
    const tag = document.createElement('span');
    tag.className = 'conduit-tag';
    tag.innerHTML = STAGES[i];
    c.appendChild(tag);
  });
})();

/* -------------------------------------------------- SIGNATURE (types itself)
   The creator credit is a command being entered: it types out when it scrolls
   into view, with a blinking caret. Reduced motion gets the finished line at
   once. The full text lives in aria-label, so screen readers never depend on
   the animation. */
(() => {
  const el = $('.sig-type');
  if (!el) return;
  const text = el.getAttribute('data-text') || '';
  if (RM) { el.textContent = text; return; }
  let started = false;
  const type = () => {
    let i = 0;
    (function step() {
      el.textContent = text.slice(0, i);
      if (i++ <= text.length) setTimeout(step, 58);
    })();
  };
  new IntersectionObserver((es, o) => es.forEach(e => {
    if (e.isIntersecting && !started) { started = true; type(); o.disconnect(); }
  }), { threshold: .35 }).observe(el);
})();

/* ------------------------------------------------------------------ HERO */
(() => {
  const svg = $('#heroSvg'); if (!svg) return;
  const layer = $('#heroParticles');
  const tele = $('#heroTele');
  const wIn = $('#hw-in');
  const core = $('#hn-router-core'), respCore = $('#hn-resp-core');

  const CYCLES = [
    { pv: '#hn-p-1', model: '#hn-m-1', w1: $('#hw-l1'), w2: $('#hw-m1'), w3: $('#hw-r1'),
      html: '<span class="t-lat">892ms</span> · <span class="t-cost">$0.0142</span><br/><span class="t-tok">1.2K TOKENS · anthropic</span>' },
    { pv: '#hn-p-2', model: '#hn-m-2', w1: $('#hw-l2'), w2: $('#hw-m2'), w3: $('#hw-r2'),
      html: '<span class="t-lat">720ms</span> · <span class="t-cost">$0.0234</span><br/><span class="t-tok">2.3K TOKENS · openai</span>' },
    { pv: '#hn-p-3', model: '#hn-m-3', w1: $('#hw-l3'), w2: $('#hw-m3'), w3: $('#hw-r3'),
      html: '<span class="t-lat">640ms</span> · <span class="t-cost">$0.0058</span><br/><span class="t-tok">1.5K TOKENS · gemini</span>' },
  ];
  let i = 0;

  // ambient traffic: every lane carries requests at all times, independent of
  // the featured cycle, so the network reads as a system under real load
  const AMBIENT = [
    [$('#hw-l1'), $('#hw-m1')], [$('#hw-l2'), $('#hw-m2')], [$('#hw-l3'), $('#hw-m3')],
    [$('#hw-l4'), $('#hw-m4')], [$('#hw-l5'), $('#hw-m5')],
  ];
  loopWhileVisible($('#heroCanvas'), async () => {
    const [lw, mw] = AMBIENT[Math.floor(Math.random() * AMBIENT.length)];
    ride(layer, $('#hw-in'), { dur: 380, color: '#6d5bb8', r: 1.8, glow: false })
      .then(() => ride(layer, lw, { dur: 520 + Math.random() * 260, color: '#6d5bb8', r: 1.8, glow: false }))
      .then(() => ride(layer, mw, { dur: 260, color: '#0a8f8b', r: 1.6, glow: false }));
    await sleep(210 + Math.random() * 240);
  });

  if (RM) { // static, fully-lit state
    wIn.classList.add('hot'); CYCLES[0].w1.classList.add('hot');
    CYCLES[0].w2.classList.add('hot-cyan'); CYCLES[0].w3.classList.add('hot-cyan');
    tele.classList.add('show');
    return;
  }

  loopWhileVisible($('#heroCanvas'), async alive => {
    const c = CYCLES[i % CYCLES.length]; i++;
    const pv = $(c.pv), mBox = $(c.model);
    // 1. request in
    wIn.classList.add('hot');
    await ride(layer, wIn, { dur: 620, color: '#a78bfa' });
    if (!alive()) return;
    // 2. router evaluates
    core.setAttribute('r', 10);
    await sleep(300); core.setAttribute('r', 7);
    // 3. route selected → provider
    c.w1.classList.add('hot');
    await ride(layer, c.w1, { dur: 800, color: '#a78bfa' });
    pv.querySelector('.nodebox').classList.add('on');
    // 4. provider → model
    c.w2.classList.add('hot-cyan');
    await ride(layer, c.w2, { dur: 380, color: '#00cec9' });
    mBox.querySelector('.nodebox').classList.add('on-cyan');
    await sleep(260);
    // 5. model → response
    c.w3.classList.add('hot-cyan');
    await ride(layer, c.w3, { dur: 520, color: '#00cec9' });
    respCore.setAttribute('r', 6.5);
    // 6. telemetry
    tele.innerHTML = c.html;
    tele.classList.add('show');
    await sleep(1500);
    // 7. fade route back
    respCore.setAttribute('r', 4);
    [wIn, c.w1].forEach(w => w.classList.remove('hot'));
    [c.w2, c.w3].forEach(w => w.classList.remove('hot-cyan'));
    pv.querySelector('.nodebox').classList.remove('on');
    mBox.querySelector('.nodebox').classList.remove('on-cyan');
    await sleep(700);
    tele.classList.remove('show');
    await sleep(500);
  });
})();

/* ------------------------------------------------------------ POSITIONING */
(() => {
  const svg = $('#posSvg'); if (!svg) return;
  const layer = $('#posParticles');
  const appW = $('#pw-app');
  const outs = ['#pw-1', '#pw-2', '#pw-3', '#pw-4'].map(s => $(s));
  loopWhileVisible($('#posCanvas'), async alive => {
    await ride(layer, appW, { dur: 620, color: '#a78bfa' });
    if (!alive()) return;
    const w = outs[Math.floor(Math.random() * outs.length)];
    w.classList.add('hot');
    await ride(layer, w, { dur: 680, color: '#a78bfa' });
    await sleep(180);
    await ride(layer, w, { dur: 680, color: '#00cec9', reverse: true });
    await ride(layer, appW, { dur: 560, color: '#00cec9', reverse: true });
    w.classList.remove('hot');
    await sleep(420);
  });
})();

/* --------------------------------------------------------- CHAOS / ORDER */
(() => {
  const linesG = $('#chaosLines'), nodesG = $('#chaosNodes'); if (!linesG) return;
  // scattered endpoint nodes
  const pts = [
    [560, 44,  'anthropic', '$ / 1m ?'],     [760, 96,  'claude-sonnet-4-6', 'quota ?'],
    [520, 150, 'openai', 'latency ?'],       [920, 60,  'gpt-4o', 'price ?'],
    [640, 236, 'gemini', '429'],             [860, 190, 'gemini-2.5-flash', 'fallback ?'],
    [540, 330, 'deepseek', 'key rotation'],  [780, 300, 'grok-4.5', 'timeout'],
    [960, 260, 'xai', '5xx'],                [1010, 350, 'mistral', 'unobserved'],
  ];
  const bad = new Set([4, 7, 8]);
  pts.forEach(([x, y, label, sub], idx) => {
    const g = document.createElementNS(NS, 'g');
    g.innerHTML = `<rect class="nodebox${bad.has(idx) ? ' down' : ''}" x="${x}" y="${y}" width="132" height="40" rx="8"></rect>
      <text x="${x + 14}" y="${y + 17}" font-size="9.5" fill="var(--txt)">${label}</text>
      <text class="nsub" x="${x + 14}" y="${y + 32}" fill="${bad.has(idx) ? 'var(--bad)' : 'var(--txt-4)'}">${sub}</text>`;
    nodesG.appendChild(g);
    const p = document.createElementNS(NS, 'path');
    const midX = 210 + (x - 210) * (0.35 + (idx % 4) * 0.11);
    const midY = 200 + ((idx % 3) - 1) * 120;
    p.setAttribute('d', `M 210 200 C ${midX} ${midY} ${x - 90} ${y + 20} ${x} ${y + 20}`);
    p.setAttribute('class', 'wire' + (bad.has(idx) ? ' dead' : ''));
    linesG.appendChild(p);
  });
  // ordered lanes for the "with" layer
  const lanes = $('#orderLanes');
  const laneDefs = [
    ['anthropic', 'SERVING · 1.2M', 'var(--ok)', 84], ['openai', 'SERVING · 1.1M', 'var(--ok)', 154],
    ['gemini', 'SERVING · 860K', 'var(--ok)', 224], ['xai', 'SERVING · 420K', 'var(--ok)', 294],
  ];
  laneDefs.forEach(([name, state, rail, y]) => {
    const g = document.createElementNS(NS, 'g');
    const on = rail === 'var(--ok)';
    g.innerHTML = `<path class="wire${on ? ' hot' : ''}" d="M 508 200 C 580 200 590 ${y + 20} 660 ${y + 20}"></path>
      <rect class="nodebox${on ? ' on' : ''}" x="660" y="${y}" width="150" height="42" rx="8" ${on ? '' : 'opacity=".6"'}></rect>
      <rect x="660" y="${y}" width="2.5" height="42" fill="${rail}"></rect>
      <text x="676" y="${y + 18}" font-size="10" fill="var(--txt)">${name}</text>
      <text class="nsub" x="676" y="${y + 33}" fill="${on ? 'var(--ok)' : 'var(--txt-4)'}">${state}</text>`;
    lanes.appendChild(g);
  });
  // annotations right of lanes
  const anno = document.createElementNS(NS, 'g');
  anno.innerHTML = `
    <text class="nsub" x="850" y="105" fill="var(--txt-3)">PRICED · HEALTH TRACKED</text>
    <text class="nsub" x="850" y="175" fill="var(--txt-3)">PRICED · QUOTA COUNTED</text>
    <text class="nsub" x="850" y="245" fill="var(--txt-3)">PRICED · LATENCY MEASURED</text>
    <text class="nsub" x="850" y="315" fill="var(--txt-3)">PRICED · CAPPED MONTHLY</text>`;
  lanes.appendChild(anno);

  // toggle + auto-reveal
  const cChaos = $('#chipChaos'), cOrder = $('#chipOrder');
  const lChaos = $('#layerChaos'), lOrder = $('#layerOrder');
  const note = $('#chaosNote');
  function setMode(order) {
    lChaos.classList.toggle('hide', order);
    lOrder.classList.toggle('hide', !order);
    cChaos.setAttribute('aria-pressed', String(!order));
    cOrder.setAttribute('aria-pressed', String(order));
    note.textContent = order ? 'ONE SEAM · OBSERVED, PRICED, ORDERED' : 'DIRECT WIRING · UNOBSERVED';
  }
  cChaos.addEventListener('click', () => setMode(false));
  cOrder.addEventListener('click', () => setMode(true));
  let auto = false;
  new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting && !auto) { auto = true; setTimeout(() => setMode(true), 2200); }
  }), { threshold: .4 }).observe($('#chaosCanvas'));
  // chaos jitter particles
  const cLayer = $('#chaosParticles');
  const chaosPaths = $$('path', linesG);
  loopWhileVisible($('#chaosCanvas'), async alive => {
    if (!lChaos.classList.contains('hide')) {
      const p = chaosPaths[Math.floor(Math.random() * chaosPaths.length)];
      ride(cLayer, p, { dur: 700 + Math.random() * 500, color: p.classList.contains('dead') ? '#f87171' : '#737b8a', r: 2, glow: false });
    } else {
      const hots = $$('#orderLanes path.hot');
      if (hots.length) ride($('#orderParticles'), hots[Math.floor(Math.random() * hots.length)], { dur: 750, color: '#7ee787', r: 2.2 });
    }
    await sleep(340);
  });
})();

/* ------------------------------------------------------ ROUTING (the wow) */
(() => {
  const svg = $('#routeSvg'); if (!svg) return;
  const layer = $('#routeParticles');
  const gates = ['policy', 'quota', 'health', 'latency', 'cost'].map(g => $(`#gate-${g}`));
  const stream = $('#streamBody');
  const rwIn = $('#rw-in'), rwResp = $('#rw-resp');
  const CAND = {
    anthropic: { w: $('#rw-1'), box: $('#rb-1'), rail: $('#rr-1') },
    openai:    { w: $('#rw-2'), box: $('#rb-2'), rail: $('#rr-2') },
    gemini:    { w: $('#rw-3'), box: $('#rb-3'), rail: $('#rr-3') },
  };
  const ranks = [$('#rt-1'), $('#rt-2'), $('#rt-3')];
  let li = 0;

  function pushStream(row) {
    const el = document.createElement('div');
    el.className = 'stream-row';
    el.innerHTML = `<span class="sr-prov">${row.prov}</span><span class="sr-model">${row.model}</span>
      <span><span class="sr-lat">${row.lat}</span> · <span class="sr-cost">${row.cost}</span></span>`;
    stream.prepend(el);
    while (stream.children.length > 9) stream.lastChild.remove();
  }
  // seed the stream
  LEDGER.slice(0, 5).forEach(pushStream);

  if (RM) {
    gates.forEach(g => g.classList.add('lit'));
    CAND.anthropic.w.classList.add('hot');
    CAND.anthropic.box.classList.add('on');
    CAND.anthropic.rail.setAttribute('fill', 'var(--ok)');
    ranks.forEach(r => r.setAttribute('opacity', '1'));
    return;
  }

  loopWhileVisible($('#routeCanvas'), async alive => {
    // in the pinned spatial scene, scroll reveals the gates first;
    // the live cycle starts once the visitor has seen every layer
    if (S.routeP < .78) { await sleep(160); return; }
    const row = LEDGER[li % LEDGER.length]; li++;
    const cand = CAND[row.prov] || CAND.anthropic;
    // request in
    rwIn.classList.add('hot');
    await ride(layer, rwIn, { dur: 500, color: '#a78bfa' });
    if (!alive()) return;
    // gates evaluate in order
    for (const g of gates) {
      g.classList.add('lit');
      await sleep(190);
    }
    await sleep(120);
    // candidates ranked
    ranks.forEach(r => r.setAttribute('opacity', '1'));
    await sleep(220);
    // selected route illuminates
    cand.w.classList.add('hot');
    await ride(layer, cand.w, { dur: 640, color: '#a78bfa' });
    cand.box.classList.add('on'); cand.rail.setAttribute('fill', 'var(--ok)');
    await sleep(320);
    // response returns and the same event lands in the stream
    rwResp.classList.add('hot-cyan');
    ride(layer, rwResp, { dur: 1150, color: '#00cec9' });
    await sleep(700);
    pushStream(row);
    await sleep(650);
    // reset
    gates.forEach(g => g.classList.remove('lit'));
    [rwIn, cand.w].forEach(x => x.classList.remove('hot'));
    rwResp.classList.remove('hot-cyan');
    cand.box.classList.remove('on'); cand.rail.setAttribute('fill', '#2a3140');
    ranks.forEach(r => r.setAttribute('opacity', '0'));
    await sleep(800);
  });
})();

/* ------------------------------------------------------- PROVIDER TOPOLOGY */
(() => {
  const svg = $('#topoSvg'); if (!svg) return;
  const layer = $('#topoParticles');
  const lanes = {
    anthropic: { wire: $('#tw-anthropic'), mwire: $('#tw-anthropic-m1'), group: $('#tg-anthropic'), tele: $('#tt-anthropic') },
    openai:    { wire: $('#tw-openai'),    mwire: $('#tw-openai-m1'),    group: $('#tg-openai'),    tele: $('#tt-openai') },
    gemini:    { wire: $('#tw-gemini'),    mwire: $('#tw-gemini-m1'),    group: $('#tg-gemini'),    tele: $('#tt-gemini') },
    xai:       { wire: $('#tw-xai'),       mwire: $('#tw-xai-m1'),       group: $('#tg-xai'),       tele: $('#tt-xai') },
  };
  let active = 'anthropic';
  function activate(name) {
    active = name;
    Object.entries(lanes).forEach(([k, l]) => {
      const on = k === name;
      l.wire.classList.toggle('hot', on);
      l.mwire.classList.toggle('hot-cyan', on);
      if (l.tele) l.tele.setAttribute('opacity', on ? '1' : '0');
      l.group.setAttribute('opacity', on ? '1' : '.55');
    });
    $$('.topo-btn').forEach(b => b.classList.toggle('active', b.dataset.lane === name));
  }
  activate('anthropic');
  $$('.topo-btn').forEach(b => {
    b.addEventListener('mouseenter', () => activate(b.dataset.lane));
    b.addEventListener('focus', () => activate(b.dataset.lane));
    b.addEventListener('click', () => activate(b.dataset.lane));
  });
  Object.entries(lanes).forEach(([k, l]) => {
    l.group.addEventListener('mouseenter', () => activate(k));
  });
  loopWhileVisible($('#topoCanvas'), async alive => {
    const l = lanes[active];
    await ride(layer, l.wire, { dur: 720, color: '#a78bfa' });
    if (!alive()) return;
    await ride(layer, l.mwire, { dur: 360, color: '#00cec9' });
    await sleep(600);
  });
})();

/* ----------------------------------------------------------------- COST */
(() => {
  const bars = $$('.cf-bar'); if (!bars.length) return;
  new IntersectionObserver((es, o) => es.forEach(e => {
    if (!e.isIntersecting) return;
    o.unobserve(e.target);
    $$('.cf-bar', e.target).forEach((b, idx) => setTimeout(() => { b.style.width = b.dataset.w + '%'; }, idx * 140));
  }), { threshold: .3 }).observe($('.costflow'));
  new IntersectionObserver((es, o) => es.forEach(e => {
    if (!e.isIntersecting) return;
    o.unobserve(e.target);
    setTimeout(() => { $('#bbFill').style.width = '64%'; }, 300);
  }), { threshold: .3 }).observe($('.budgetbar'));
})();

/* --------------------------------------------------------------- LATENCY */
(() => {
  const chart = $('#latChart'); if (!chart) return;
  const SAMPLES = [
    [114, 'llama-70b'], [310, 'gemini-flash'], [340, 'gpt-4o-mini'], [412, 'claude-haiku'],
    [604, 'mistral-large'], [640, 'gemini-pro'], [720, 'gpt-4o'], [780, 'deepseek-v4'],
    [892, 'claude-sonnet'], [1042, 'grok-4.5'], [1120, 'claude-opus'], [2131, 'free-tier'],
  ];
  const AVG = 486;
  const lmin = Math.log(60), lmax = Math.log(2600);
  const h = v => Math.round(((Math.log(v) - lmin) / (lmax - lmin)) * 100);
  SAMPLES.forEach(([v, prov]) => {
    const col = document.createElement('div');
    col.className = 'lat-col' + (v >= 2000 ? ' extreme' : v >= 1000 ? ' outlier' : '');
    col.innerHTML = `<span class="lat-bar" data-h="${h(v)}"></span><span class="lat-val">${v}ms</span><span class="lat-prov">${prov}</span>`;
    chart.appendChild(col);
  });
  const avg = document.createElement('div');
  avg.className = 'lat-avg';
  avg.style.bottom = `calc(${h(AVG)}% * .72 + 44px)`;
  avg.innerHTML = `<span class="tag">AVG 486ms</span>`;
  chart.appendChild(avg);
  new IntersectionObserver((es, o) => es.forEach(e => {
    if (!e.isIntersecting) return;
    o.unobserve(e.target);
    $$('.lat-bar', chart).forEach((b, i) => setTimeout(() => {
      b.style.height = `calc(${b.dataset.h}% * .72)`;
    }, i * 70));
  }), { threshold: .3 }).observe(chart);
})();

/* --------------------------------------------------------------- TRAFFIC */
(() => {
  const svg = $('#trafSvg'); if (!svg) return;
  const wiresG = $('#trafWires'), nodesG = $('#trafNodes'), layer = $('#trafParticles');
  const P = [ // name, y, state, weight, model
    ['anthropic', 110, 'SERVING · 1.2M', 32, 'claude-sonnet-4-6'],
    ['openai',    190, 'SERVING · 1.1M', 28, 'gpt-4o'],
    ['gemini',    270, 'SERVING · 860K', 22, 'gemini-2.5-pro'],
    ['xai',       350, 'SERVING · 420K', 11, 'grok-4.5'],
    ['deepseek',  430, 'SERVING · 380K', 10, 'deepseek-v4-pro'],
    ['mistral',   500, 'SERVING · 240K', 6,  'mistral-large-latest'],
  ];
  const RX = 372; // router x
  // app -> router
  const appWire = document.createElementNS(NS, 'path');
  appWire.setAttribute('d', 'M 196 300 H 330');
  appWire.setAttribute('class', 'wire hot');
  wiresG.appendChild(appWire);
  const lanePaths = [], modelPaths = [], respPaths = [];
  P.forEach(([name, y, state, w, model], i) => {
    const serving = w > 0;
    const lp = document.createElementNS(NS, 'path');
    lp.setAttribute('d', `M ${RX + 34} 300 C 470 300 480 ${y + 24} 560 ${y + 24}`);
    lp.setAttribute('class', 'wire');
    lp.style.strokeWidth = serving ? (1 + w / 30) : 1;
    if (serving) lp.style.stroke = `rgba(167,139,250,${.25 + w / 90})`;
    wiresG.appendChild(lp); lanePaths.push(lp);
    const mp = document.createElementNS(NS, 'path');
    mp.setAttribute('d', `M 700 ${y + 24} H 860`);
    mp.setAttribute('class', 'wire');
    if (serving) mp.style.stroke = 'rgba(0,206,201,.35)';
    wiresG.appendChild(mp); modelPaths.push(mp);
    const rp = document.createElementNS(NS, 'path');
    rp.setAttribute('d', `M 1054 ${y + 24} C 1110 ${y + 24} 1130 ${280 + i * 8} 1150 296`);
    rp.setAttribute('class', 'wire');
    if (serving) rp.style.stroke = 'rgba(0,206,201,.3)';
    wiresG.appendChild(rp); respPaths.push(rp);

    const g = document.createElementNS(NS, 'g');
    if (!serving) g.setAttribute('opacity', '.55');
    g.innerHTML = `<rect class="nodebox" x="560" y="${y}" width="140" height="48" rx="9"></rect>
      <rect x="560" y="${y}" width="2.5" height="48" fill="${serving ? 'var(--ok)' : '#2a3140'}"></rect>
      <text class="nlabel" x="578" y="${y + 20}">${name}</text>
      <text class="nsub" x="578" y="${y + 37}" fill="${serving ? 'var(--ok)' : 'var(--txt-4)'}">${state}</text>
      <rect class="nodebox" x="860" y="${y + 6}" width="194" height="36" rx="7" ${serving ? '' : 'opacity=".55"'}></rect>
      <rect x="860" y="${y + 6}" width="2.5" height="36" fill="${serving ? 'var(--model)' : '#2a3140'}"></rect>
      <text x="876" y="${y + 28}" font-size="10" fill="${serving ? 'var(--txt)' : 'var(--txt-3)'}">${model}</text>`;
    nodesG.appendChild(g);
  });
  // app + router + response nodes
  const fixed = document.createElementNS(NS, 'g');
  fixed.innerHTML = `
    <rect class="nodebox" x="36" y="276" width="160" height="48" rx="9"></rect>
    <rect x="36" y="276" width="2.5" height="48" fill="var(--txt-3)"></rect>
    <text class="nlabel" x="54" y="296">your app</text>
    <text class="nsub" x="54" y="313">OPENAI-COMPATIBLE</text>
    <circle cx="372" cy="300" r="34" fill="var(--bg-deep)" stroke="rgba(167,139,250,.45)" stroke-width="1.2"></circle>
    <circle cx="372" cy="300" r="24" fill="none" stroke="rgba(167,139,250,.5)" stroke-width="1" stroke-dasharray="4 5"></circle>
    <circle cx="372" cy="300" r="7" fill="var(--route-deep)"></circle>
    <text class="nsub" x="344" y="352" fill="var(--route)" letter-spacing=".16em">TOLLPIKE</text>
    <circle cx="1162" cy="300" r="13" fill="var(--bg-deep)" stroke="rgba(0,206,201,.5)" stroke-width="1.3"></circle>
    <circle cx="1162" cy="300" r="4.5" fill="var(--model)"></circle>
    <text class="nsub" x="1128" y="336" fill="var(--txt-4)">RESPONSE</text>`;
  nodesG.appendChild(fixed);

  const weights = P.map(p => p[3]);
  const total = weights.reduce((a, b) => a + b, 0);
  function pickLane() {
    let r = Math.random() * total;
    for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
    return 0;
  }
  const trafCanvas = $('#trafCanvas');
  loopWhileVisible(trafCanvas, async alive => {
    // traffic accelerates as the scene centers in the viewport, and each
    // particle carries a depth tier: far traffic is smaller and dimmer,
    // near traffic is larger and brighter
    const rc = trafCanvas.getBoundingClientRect();
    const centered = clamp01(1 - Math.abs(rc.top + rc.height / 2 - innerHeight / 2) / (innerHeight * 1.05));
    const burst = 1 + Math.floor(Math.random() * 2 + centered * 2);
    for (let n = 0; n < burst; n++) {
      const i = pickLane();
      const depth = .3 + Math.random() * .7;
      const opts = { r: 1.2 + depth * 1.5, opacity: .3 + depth * .7, glow: depth > .75 };
      sleep(n * 90).then(() =>
        ride(layer, appWire, { dur: 420, color: '#a78bfa', ...opts })
          .then(() => alive() && ride(layer, lanePaths[i], { dur: 560 + Math.random() * 220, color: '#a78bfa', ...opts }))
          .then(() => alive() && ride(layer, modelPaths[i], { dur: 320, color: '#00cec9', ...opts }))
          .then(() => alive() && ride(layer, respPaths[i], { dur: 400, color: '#00cec9', ...opts })));
    }
    await sleep(180 + (1 - centered) * 260 + Math.random() * 160);
  });
})();

/* -------------------------------------------------------------- RESILIENCE */
(() => {
  const svg = $('#resSvg'); if (!svg) return;
  const layer = $('#resParticles');
  const wGroq = $('#xw-groq'), wGroqM = $('#xw-groq-m'), wOlla = $('#xw-olla'), wOllaM = $('#xw-olla-m');
  const bGroq = $('#xb-groq'), bGroqM = $('#xb-groq-m');
  const rGroq = $('#xr-groq'), rGroqM = $('#xr-groq-m'), rOlla = $('#xr-olla'), rOllaM = $('#xr-olla-m');
  const sGroq = $('#xs-groq'), sGroqM = $('#xs-groq-m'), sOlla = $('#xs-olla');
  const lock = $('#xlock'), reroute = $('#xreroute'), caption = $('#xcaption');

  if (RM) {
    lock.setAttribute('opacity', '1'); reroute.setAttribute('opacity', '1');
    wOlla.classList.add('hot'); wOllaM.classList.add('hot-cyan');
    rOlla.setAttribute('fill', 'var(--ok)'); rOllaM.setAttribute('fill', 'var(--model)');
    caption.textContent = '429 ON ONE MODEL → THAT MODEL LOCKS · TRAFFIC RE-ROUTES · SYSTEM CONTINUES';
    return;
  }

  // idempotent phase states, so either the clock or the scroll can drive them
  function nominalVisuals() {
    wGroq.classList.add('hot'); wGroqM.classList.add('hot-cyan'); wGroqM.classList.remove('dead');
    bGroqM.classList.remove('down'); rGroqM.setAttribute('fill', 'var(--model)');
    sGroqM.textContent = 'OK'; sGroqM.setAttribute('fill', 'var(--txt-4)');
    sGroq.textContent = 'SERVING'; sGroq.setAttribute('fill', 'var(--ok)');
    lock.setAttribute('opacity', '0'); reroute.setAttribute('opacity', '0');
    wOlla.classList.remove('hot'); wOllaM.classList.remove('hot-cyan');
    rOlla.setAttribute('fill', '#2a3140'); rOllaM.setAttribute('fill', '#2a3140');
    sOlla.textContent = 'STANDBY'; sOlla.setAttribute('fill', 'var(--txt-4)');
  }
  function lockedVisuals() {
    bGroqM.classList.add('down'); rGroqM.setAttribute('fill', 'var(--bad)');
    sGroqM.textContent = 'LOCKED 60s'; sGroqM.setAttribute('fill', 'var(--bad)');
    lock.setAttribute('opacity', '1');
    wGroq.classList.remove('hot'); wGroqM.classList.remove('hot-cyan'); wGroqM.classList.add('dead');
    sGroq.textContent = 'HEALTHY · OTHER MODELS SERVE'; sGroq.setAttribute('fill', 'var(--txt-3)');
  }
  const PHASES = [
    () => { caption.textContent = 'ALL LANES NOMINAL · SERVING VIA anthropic'; nominalVisuals(); },
    () => {
      caption.textContent = '429 RATE LIMIT · SCOPE: ONE MODEL, NOT THE KEY, NOT THE PROVIDER';
      lockedVisuals(); reroute.setAttribute('opacity', '0');
      wOlla.classList.remove('hot'); wOllaM.classList.remove('hot-cyan');
      rOlla.setAttribute('fill', '#2a3140'); rOllaM.setAttribute('fill', '#2a3140');
      sOlla.textContent = 'STANDBY'; sOlla.setAttribute('fill', 'var(--txt-4)');
    },
    () => {
      caption.textContent = 'FALLBACK WALK · NEXT CANDIDATE: openai / gpt-4o';
      lockedVisuals(); reroute.setAttribute('opacity', '1');
      wOlla.classList.add('hot'); wOllaM.classList.add('hot-cyan');
      rOlla.setAttribute('fill', 'var(--ok)'); rOllaM.setAttribute('fill', 'var(--model)');
      sOlla.textContent = 'SERVING'; sOlla.setAttribute('fill', 'var(--ok)');
    },
    () => { caption.textContent = 'LOCK EXPIRED · LAZY RECOVERY · LANE REJOINS THE ORDER'; nominalVisuals(); },
  ];
  let phase = -1;
  function setPhase(k) { if (k === phase) return; phase = k; PHASES[k](); }
  S.setResPhase = setPhase;
  setPhase(0);

  // ambient traffic always follows whichever route is currently serving
  loopWhileVisible($('#resCanvas'), async alive => {
    const lanes = phase === 2 ? [wOlla, wOllaM] : (phase === 1 ? null : [wGroq, wGroqM]);
    if (lanes) {
      await ride(layer, lanes[0], { dur: 620, color: '#a78bfa' });
      if (!alive()) return;
      await ride(layer, lanes[1], { dur: 300, color: '#00cec9' });
    }
    await sleep(320);
  });

  // without a pinned spatial scene, the clock tells the story instead
  if (!SPATIAL && !TSPATIAL) {
    let k = 0;
    loopWhileVisible($('#resCanvas'), async () => { setPhase(k % 4); k++; await sleep(2700); });
  }
})();

/* ---------------------------------------------------------- OBSERVABILITY */
(() => {
  const strip = $('#laneStrip'); if (!strip) return;
  const offLanes = [9, 21, 33, 44];
  for (let i = 0; i < 46; i++) {
    const t = document.createElement('i');
    if (!offLanes.includes(i)) t.className = 'on';
    strip.appendChild(t);
  }
  // latency sparkline across the fleet
  const spark = $('#sparkLat');
  const S = [204, 114, 310, 98, 240, 540, 460, 604, 892, 780, 1042, 2131, 310, 240, 114, 486, 632, 540, 376, 240];
  const max = Math.log(2600), min = Math.log(60);
  const pts = S.map((v, i) => `${(i / (S.length - 1)) * 520},${88 - ((Math.log(v) - min) / (max - min)) * 80}`).join(' ');
  spark.innerHTML = `
    <polyline points="${pts}" fill="none" stroke="var(--model)" stroke-width="1.5" opacity=".85"/>
    ${S.map((v, i) => v >= 1000 ? `<circle cx="${(i / (S.length - 1)) * 520}" cy="${88 - ((Math.log(v) - min) / (max - min)) * 80}" r="2.5" fill="${v >= 3000 ? 'var(--bad)' : 'var(--conn)'}"/>` : '').join('')}`;
  // event stream
  const es = $('#obsStream');
  function pushObs(row) {
    const el = document.createElement('div');
    el.className = 'stream-row';
    el.style.padding = '6px 0';
    el.innerHTML = `<span class="sr-prov">${row.prov}</span><span class="sr-model">${row.model}</span>
      <span><span class="sr-lat">${row.lat}</span> · <span class="sr-cost">${row.cost}</span></span>`;
    es.prepend(el);
    while (es.children.length > 5) es.lastChild.remove();
  }
  LEDGER.slice(0, 5).forEach(pushObs);
  if (!RM) {
    let i = 5;
    loopWhileVisible($('#observability'), async () => {
      await sleep(900 + Math.random() * 500);
      pushObs(LEDGER[i % LEDGER.length]); i++;
    });
  }
})();

/* ------------------------------------------------------------ DASH MINI */
(() => {
  const layer = $('#dashParticles'); if (!layer) return;
  const paths = $$('#dashSvg path.hot, #dashSvg path.hot-ok');
  const mpaths = $$('#dashSvg path.hot-cyan');
  loopWhileVisible($('.dash-frame'), async alive => {
    const i = Math.random() < .55 ? 0 : 1;
    await ride(layer, paths[i], { dur: 600, color: i ? '#7ee787' : '#a78bfa', r: 2.2 });
    if (!alive()) return;
    await ride(layer, mpaths[i], { dur: 300, color: '#00cec9', r: 2 });
    await sleep(420);
  });
})();

/* ------------------------------------------------------------- FINAL CTA */
(() => {
  const g = $('#ctaWires'); if (!g) return;
  const layer = $('#ctaParticles');
  const paths = [];
  for (let i = 0; i < 7; i++) {
    const y = 60 + i * 66;
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', `M -20 ${y} C 360 ${y + (i % 2 ? 40 : -30)} 1040 ${y + (i % 2 ? -50 : 36)} 1420 ${y}`);
    p.setAttribute('class', 'wire');
    p.style.stroke = 'rgba(255,255,255,.05)';
    g.appendChild(p); paths.push(p);
  }
  loopWhileVisible($('#cta'), async alive => {
    const p = paths[Math.floor(Math.random() * paths.length)];
    ride(layer, p, { dur: 2600 + Math.random() * 1400, color: Math.random() < .5 ? '#a78bfa' : '#00cec9', r: 1.8, glow: false });
    await sleep(500);
  });
})();

/* ============================================================================
   SPATIAL ENGINE
   One pointer state, one lerped rAF loop, scroll handlers that only set
   transforms and classes. Everything here is depth, never layout.
   ========================================================================== */
(() => {
  if (RM) return;

  let mx = 0, my = 0, smx = 0, smy = 0;
  const anims = [];
  addEventListener('pointermove', e => {
    mx = (e.clientX / innerWidth) * 2 - 1;
    my = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });
  (function frame() {
    smx += (mx - smx) * .07;
    smy += (my - smy) * .07;
    for (const f of anims) f();
    requestAnimationFrame(frame);
  })();

  /* ghost labels are the distant atmosphere layer: they drift slower than the
     content in front on scroll, and now also lean with the cursor so the
     background has real depth. Scroll sets the base offset; the rAF loop adds
     the (smoothed) mouse term, so the two never fight. */
  const ghosts = $$('.ghostlabel');
  function layoutGhosts() {
    for (const g of ghosts) {
      const r = g.parentElement.getBoundingClientRect();
      if (r.bottom < -200 || r.top > innerHeight + 200) { g.dataset.vis = '0'; continue; }
      g.dataset.vis = '1';
      g.dataset.by = String(Math.round((r.top + r.height / 2 - innerHeight / 2) * .12));
    }
  }
  addEventListener('scroll', layoutGhosts, { passive: true });
  layoutGhosts();
  anims.push(() => {
    for (const g of ghosts) {
      if (g.dataset.vis === '0') continue;
      const by = +(g.dataset.by || 0);
      g.style.transform = `translate3d(${(smx * 5).toFixed(1)}px, ${(by + smy * 3).toFixed(1)}px, 0)`;
    }
  });

  if (!SPATIAL && !TSPATIAL) return;

  /* ---------------- hero: sticky scene + depth ----------------
     Desktop: mouse parallax plus scroll transformation.
     Touch: scroll is the camera. The copy lifts away, the network rises
     into view and grows. No pointer-tracking at all. */
  const hero = $('#hero'), heroBg = $('#heroBgLayer'), heroSvgEl = $('#heroSvg');
  const heroCopy = $('.hero-copy'), heroIn = $('.hero-in'), teleHolder = $('.tele-holder');
  let heroP = 0, heroOn = true;
  new IntersectionObserver(es => es.forEach(e => { heroOn = e.isIntersecting; })).observe(hero);
  function heroScroll() {
    const r = hero.getBoundingClientRect();
    heroP = clamp01(-r.top / Math.max(1, r.height - innerHeight));
  }
  addEventListener('scroll', heroScroll, { passive: true });
  heroScroll();
  anims.push(() => {
    if (!heroOn) return;
    if (SPATIAL) {
      heroBg.style.transform = `translate3d(${smx * 4}px, ${smy * 4 + heroP * 46}px, 0)`;
      heroSvgEl.style.transform = `translate3d(${smx * 9 - heroP * 26}px, ${smy * 7 - heroP * 16}px, 0) scale(${1 + heroP * .06})`;
      heroCopy.style.transform = `translate3d(${smx * 2 - heroP * 30}px, ${smy * 2 - heroP * 24}px, 0)`;
      heroCopy.style.opacity = String(1 - heroP * .28);
      teleHolder.style.transform = `translate3d(${smx * 14}px, ${smy * 11}px, 0)`;
    } else {
      const lift = -heroP * Math.min(260, innerHeight * .3);
      heroBg.style.transform = `translate3d(0, ${heroP * 36}px, 0)`;
      heroIn.style.transform = `translate3d(0, ${lift}px, 0)`;
      heroSvgEl.style.transform = `scale(${1 + heroP * .05})`;
      heroCopy.style.opacity = String(1 - heroP * .4);
    }
  });

  /* ---------------- hero: node inspection ---------------- */
  const NODE_INFO = {
    'hn-p-1': { t: 'anthropic', rows: [['STATE', 'SERVING', 'ok'], ['MODEL', 'claude-sonnet-4-6', 'cy'], ['VOLUME', '1.2M REQ · MO'], ['AVG LATENCY', '892ms', 'cy'], ['AVG COST', '$0.0142', 'ok']], y: 20.7, wl: 'hw-l1', wm: 'hw-m1', m: 'hn-m-1' },
    'hn-p-2': { t: 'openai', rows: [['STATE', 'SERVING', 'ok'], ['MODEL', 'gpt-4o', 'cy'], ['VOLUME', '1.1M REQ · MO'], ['AVG LATENCY', '720ms', 'cy'], ['AVG COST', '$0.0234', 'ok']], y: 35, wl: 'hw-l2', wm: 'hw-m2', m: 'hn-m-2' },
    'hn-p-3': { t: 'gemini', rows: [['STATE', 'SERVING', 'ok'], ['MODEL', 'gemini-2.5-pro', 'cy'], ['VOLUME', '860K REQ · MO'], ['AVG LATENCY', '640ms', 'cy'], ['AVG COST', '$0.0058', 'ok']], y: 49.3, wl: 'hw-l3', wm: 'hw-m3', m: 'hn-m-3' },
    'hn-p-4': { t: 'xai', rows: [['STATE', 'SERVING', 'ok'], ['MODEL', 'grok-4.5', 'cy'], ['VOLUME', '420K REQ · MO'], ['AVG LATENCY', '1042ms', 'cy'], ['AVG COST', '$0.0134', 'ok']], y: 63.6, wl: 'hw-l4', wm: 'hw-m4', m: 'hn-m-4' },
    'hn-p-5': { t: 'deepseek', rows: [['STATE', 'SERVING', 'ok'], ['MODEL', 'deepseek-v4-pro', 'cy'], ['VOLUME', '380K REQ · MO'], ['AVG LATENCY', '780ms', 'cy'], ['AVG COST', '$0.0028', 'ok']], y: 77.9, wl: 'hw-l5', wm: 'hw-m5', m: 'hn-m-5' },
    'hn-router': { t: 'routing engine', rows: [['STRATEGY', 'combo/quality-first', 'cy'], ['STRATEGIES', '19'], ['COMBOS', '8'], ['GATES', 'policy · quota · health', 'cy']], y: 34, right: 58 },
    'hn-resp': { t: 'response', rows: [['FORMAT', 'openai-compatible', 'cy'], ['HEADERS', 'X-Tollpike-*', 'ok'], ['CACHE', 'HIT · MISS · BYPASS']], y: 68, right: 10 },
  };
  const heroCanvasEl = $('#heroCanvas');
  const np = document.createElement('div');
  np.className = 'node-panel';
  heroCanvasEl.appendChild(np);
  let focusedId = null;
  function focusNode(id) {
    const info = NODE_INFO[id];
    const g = document.getElementById(id);
    if (!info || !g) return;
    clearFocus();
    focusedId = id;
    heroSvgEl.classList.add('inspect');
    g.classList.add('focus');
    const mg = info.m && document.getElementById(info.m);
    const wl = info.wl && document.getElementById(info.wl);
    const wm = info.wm && document.getElementById(info.wm);
    if (mg) mg.classList.add('focus');
    if (wl) wl.classList.add('hot');
    if (wm) wm.classList.add('hot-cyan');
    np.innerHTML = `<div class="np-t"><span class="dot ok"></span>${info.t}</div>` +
      info.rows.map(([k, v, c]) => `<div class="np-r"><span class="k">${k}</span><span class="v ${c || ''}">${v}</span></div>`).join('');
    if (SPATIAL) {
      np.style.top = info.y + '%';
      np.style.right = (info.right != null ? info.right : 53.4) + '%';
    }
    np.classList.add('show');
  }
  function clearFocus() {
    if (!focusedId) return;
    const info = NODE_INFO[focusedId];
    const g = document.getElementById(focusedId);
    heroSvgEl.classList.remove('inspect');
    if (g) g.classList.remove('focus');
    const mg = info.m && document.getElementById(info.m);
    const wl = info.wl && document.getElementById(info.wl);
    const wm = info.wm && document.getElementById(info.wm);
    if (mg) mg.classList.remove('focus');
    if (wl) wl.classList.remove('hot');
    if (wm) wm.classList.remove('hot-cyan');
    np.classList.remove('show');
    focusedId = null;
  }
  Object.keys(NODE_INFO).forEach(id => {
    const g = document.getElementById(id); if (!g) return;
    if (SPATIAL) {
      g.addEventListener('pointerenter', () => focusNode(id));
      g.addEventListener('pointerleave', clearFocus);
    } else {
      // touch: tap a node to inspect it, tap it again (or elsewhere) to close
      g.addEventListener('click', e => {
        e.stopPropagation();
        focusedId === id ? clearFocus() : focusNode(id);
      });
    }
  });
  if (TSPATIAL) heroSvgEl.addEventListener('click', clearFocus);

  /* ---------------- routing engine: pinned reveal ---------------- */
  const routing = $('#routing');
  const gateEls = ['policy', 'quota', 'health', 'latency', 'cost'].map(g => $(`#gate-${g}`));
  const candEls = [$('#rn-1'), $('#rn-2'), $('#rn-3')];
  const streamP = $('.stream-panel');
  function routeScroll() {
    const r = routing.getBoundingClientRect();
    const p = clamp01(-r.top / Math.max(1, r.height - innerHeight));
    S.routeP = p;
    gateEls.forEach((g, i) => g && g.classList.toggle('gvis', p > .05 + i * .1));
    candEls.forEach((c, i) => c && c.classList.toggle('cvis', p > .56 + i * .07));
    if (streamP) streamP.classList.toggle('svis', p > .5);
  }
  addEventListener('scroll', routeScroll, { passive: true });
  routeScroll();

  /* ---------------- resilience: scroll drives the failure ---------------- */
  const res = $('#resilience');
  function resScroll() {
    if (!S.setResPhase) return;
    const r = res.getBoundingClientRect();
    const p = clamp01(-r.top / Math.max(1, r.height - innerHeight));
    S.setResPhase(p < .22 ? 0 : p < .5 ? 1 : p < .78 ? 2 : 3);
  }
  addEventListener('scroll', resScroll, { passive: true });
  resScroll();

  /* ---------------- dashboard: suspended, tilts toward the cursor -------- */
  const dwrap = $('.dash-wrap'), dframe = $('.dash-frame');
  const annos = $$('.dash-anno');
  let cRx = 0, cRy = 0, tRx = 0, tRy = 0, dOn = false, dP = 0;
  new IntersectionObserver(es => es.forEach(e => { dOn = e.isIntersecting; }), { threshold: .02 }).observe(dwrap);
  function dashScroll() {
    const r = dwrap.getBoundingClientRect();
    dP = clamp01(1 - (r.top - innerHeight * .1) / (innerHeight * .7));
  }
  addEventListener('scroll', dashScroll, { passive: true });
  dashScroll();
  dwrap.addEventListener('pointermove', e => {
    const r = dwrap.getBoundingClientRect();
    tRy = ((e.clientX - r.left) / r.width - .5) * 2.6;
    tRx = -((e.clientY - r.top) / r.height - .5) * 2.2;
  });
  dwrap.addEventListener('pointerleave', () => { tRx = 0; tRy = 0; });
  anims.push(() => {
    if (!dOn) return;
    cRx += (tRx - cRx) * .08;
    cRy += (tRy - cRy) * .08;
    dframe.style.transform = `rotateX(${(1 - dP) * 3.2 + cRx}deg) rotateY(${cRy}deg)`;
    annos.forEach((a, i) => {
      const f = i % 2 ? 9 : 15;
      a.style.transform = `translate3d(${smx * f}px, ${smy * f * .6}px, 0)`;
    });
  });

  /* ---------------- provider topology: depth-aware hover or tap ---------- */
  const topoSvgEl = $('#topoSvg');
  function topoFocus(g) { topoSvgEl.classList.add('tinspect'); g.classList.add('tfocus'); }
  function topoClear(g) { topoSvgEl.classList.remove('tinspect'); g.classList.remove('tfocus'); }
  $$('#topoSvg g[data-lane]').forEach(g => {
    if (SPATIAL) {
      g.addEventListener('pointerenter', () => topoFocus(g));
      g.addEventListener('pointerleave', () => topoClear(g));
    } else {
      g.addEventListener('click', () => {
        const was = g.classList.contains('tfocus');
        $$('#topoSvg g[data-lane]').forEach(o => o.classList.remove('tfocus'));
        topoSvgEl.classList.remove('tinspect');
        if (!was) topoFocus(g);
      });
    }
  });
  if (TSPATIAL) {
    // the lane buttons drive the same depth state on touch
    $$('.topo-btn').forEach(b => b.addEventListener('click', () => {
      const g = $(`#topoSvg g[data-lane="${b.dataset.lane}"]`);
      if (!g) return;
      $$('#topoSvg g[data-lane]').forEach(o => o.classList.remove('tfocus'));
      topoFocus(g);
    }));
  }

  if (!SPATIAL) return; // everything below needs a fine pointer

  /* ---------------- custom cursor: precision dot + inspection ring ------- */
  const cur = document.createElement('div');
  cur.id = 'cursor';
  cur.innerHTML = '<i class="c-dot"></i><i class="c-ring"></i><span class="c-label">INSPECT</span>';
  document.body.appendChild(cur);
  const cDot = cur.querySelector('.c-dot'), cRing = cur.querySelector('.c-ring'), cLbl = cur.querySelector('.c-label');
  let px = -100, py = -100, rxp = -100, ryp = -100;
  addEventListener('pointermove', e => {
    px = e.clientX; py = e.clientY;
    document.documentElement.classList.add('curon');
    cur.classList.add('on');
    cDot.style.transform = `translate3d(${px}px, ${py}px, 0) translate(-50%, -50%)`;
  }, { passive: true });
  addEventListener('pointerout', e => { if (!e.relatedTarget) cur.classList.remove('on'); });
  anims.push(() => {
    rxp += (px - rxp) * .16;
    ryp += (py - ryp) * .16;
    cRing.style.transform = `translate3d(${rxp}px, ${ryp}px, 0) translate(-50%, -50%)`;
    cLbl.style.transform = `translate3d(${rxp + 16}px, ${ryp + 14}px, 0)`;
  });
  const HOT = 'a, button, .btn, .topo-btn, .mode-chip, .copybtn, .switch';
  const INSP = '#heroSvg g[id^="hn-"], #topoSvg g[data-lane], .dash-frame';
  addEventListener('pointerover', e => {
    const t = e.target;
    const has = sel => !!(t.closest && t.closest(sel));
    cur.classList.toggle('insp', has(INSP));
    cur.classList.toggle('hov', has(HOT));
  }, { passive: true });

  /* ---------------- magnetic buttons ---------------- */
  $$('.btn').forEach(b => {
    b.addEventListener('pointermove', e => {
      const r = b.getBoundingClientRect();
      const dx = (e.clientX - r.left - r.width / 2) / r.width;
      const dy = (e.clientY - r.top - r.height / 2) / r.height;
      b.style.transform = `translate(${(dx * 6).toFixed(1)}px, ${(dy * 4).toFixed(1)}px)`;
    });
    b.addEventListener('pointerleave', () => { b.style.transform = ''; });
  });

  /* ---------------- nav: active indicator follows the section ------------ */
  const navLinks = $$('.nav-links a');
  const secIO = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    const href = '#' + e.target.id;
    navLinks.forEach(a => a.classList.toggle('active', a.getAttribute('href') === href));
  }), { rootMargin: '-40% 0px -55% 0px' });
  ['product', 'how', 'providers', 'routing', 'developers', 'start'].forEach(id => {
    const el = document.getElementById(id);
    if (el) secIO.observe(el);
  });
})();

/* ------------------------------------------------------------- COPY BTNS */
/* Reads the command out of the element it points at, so the text on screen and
   the text on the clipboard cannot drift apart. The `$` prompt is drawn by CSS
   rather than written into the markup, which keeps it out of textContent and
   saves the reader deleting it. */
for (const btn of $$('.copybtn[data-copy]')) {
  btn.addEventListener('click', async () => {
    const target = document.querySelector(btn.getAttribute('data-copy'));
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      btn.textContent = 'Copied';
    } catch { btn.textContent = 'Select + copy'; }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
  });
}

$('#copyReq')?.addEventListener('click', async e => {
  const text = `curl http://localhost:20128/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'`;
  try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; }
  catch { e.target.textContent = 'Select + copy'; }
  setTimeout(() => { e.target.textContent = 'Copy'; }, 1600);
});
})();
