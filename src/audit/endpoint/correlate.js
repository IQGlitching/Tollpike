// Correlation: which endpoint processes belong to an agent, and which audited
// action explains each one.
//
// A process table per host is rebuilt from process events and snapshots
// (pid -> parent, image, command line). A process belongs to an agent when an
// ancestor is an agent runtime: Claude Code, Cursor, Codex and the rest,
// recognised by image and command line. For each such process the correlator
// looks for the audited action that accounts for it: a tool call recorded by
// a Claude Code hook, the MCP proxy or the model connection, whose command
// matches this process's command line within a short time window. Children
// of an explained process inherit the explanation, so `bash -c "cd x && rm
// -rf y"` explains the `rm` it spawns.
//
// What is left over is the signal this layer exists for: a process in an
// agent's tree that no audited action accounts for. Either the agent did
// something without telling anyone, or its hooks are not wired.
//
// The table is in memory and rebuilt after a restart; collectors send a
// process snapshot when they start so long-running agent sessions are known.

const MAX_PER_HOST = 50_000;
const MAX_DEPTH = 64;
const WINDOW_BEFORE_MS = 5 * 60 * 1000; // the action is recorded before the process starts
const WINDOW_AFTER_MS = 10 * 1000; // clock skew between the agent host and the gateway

// Agent runtimes recognised out of the box. `image` is matched against the
// executable path, `commandLine` against the full command line.
export const DEFAULT_RUNTIMES = [
  { name: "claude", image: "(^|[\\\\/])claude(\\.exe)?$", commandLine: "@anthropic-ai[\\\\/]claude-code" },
  { name: "codex", image: "(^|[\\\\/])codex(\\.exe)?$", commandLine: "@openai[\\\\/]codex" },
  { name: "cursor", image: "(^|[\\\\/])cursor(\\.exe)?$" },
  { name: "windsurf", image: "(^|[\\\\/])windsurf(\\.exe)?$" },
  { name: "gemini", image: "(^|[\\\\/])gemini(\\.exe)?$", commandLine: "@google[\\\\/]gemini-cli" },
  { name: "aider", commandLine: "(^|[\\\\/\\s])aider(\\.exe)?(\\s|$)" },
  { name: "opencode", image: "(^|[\\\\/])opencode(\\.exe)?$" },
  { name: "goose", image: "(^|[\\\\/])goose(\\.exe)?$" }
];

// Processes a runtime starts for its own bookkeeping, not as an agent action:
// an Electron app's helper processes, the console host, ripgrep behind a
// search tool, and read-only git queries for the prompt. Counted, not recorded.
const HELPER_IMAGES = /(^|[\\/])(conhost\.exe|crashpad_handler(\.exe)?|rg(\.exe)?|cmd\.exe)$/i;
const GIT_READ_ONLY = /(^|[\\/\s])git(\.exe)?["']?\s+(-c\s+\S+\s+)*(status|diff|log|rev-parse|show|branch|config\s+--get|ls-files|remote|symbolic-ref|for-each-ref|describe|cat-file|worktree\s+list)\b/i;

function compile(runtimes) {
  return runtimes.map((r) => ({
    name: r.name,
    image: r.image ? new RegExp(r.image, "i") : null,
    commandLine: r.commandLine ? new RegExp(r.commandLine, "i") : null
  }));
}

function basename(p) {
  return String(p || "").split(/[\\/]/).pop().toLowerCase();
}

export function normaliseCommand(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class ProcessTables {
  constructor({ runtimes = [] } = {}) {
    this.hosts = new Map();
    this.runtimes = compile([...DEFAULT_RUNTIMES, ...runtimes]);
  }

  table(host) {
    const key = String(host || "unknown").toLowerCase();
    if (!this.hosts.has(key)) this.hosts.set(key, new Map());
    return this.hosts.get(key);
  }

  runtimeOf(e) {
    for (const r of this.runtimes) {
      if (r.image && e.image && r.image.test(e.image)) return r.name;
      if (r.commandLine && e.commandLine && r.commandLine.test(e.commandLine)) return r.name;
    }
    return null;
  }

  /** Record a process (event or snapshot row). Returns the stored entry. */
  upsert(e) {
    if (!Number.isFinite(e.pid)) return null;
    const t = this.table(e.host);
    const entry = {
      pid: e.pid,
      ppid: Number.isFinite(e.ppid) ? e.ppid : null,
      image: e.image || null,
      commandLine: e.commandLine || null,
      ts: e.ts,
      runtime: this.runtimeOf(e),
      explainedBy: null
    };
    // A new process with a pid already in the table is pid reuse: the old
    // entry is dead, and keeping its explanation would hand it to a stranger.
    // A snapshot row for the same process (same image and parent) is not: the
    // collector restarted and listed what is still running, and resetting the
    // explanation would flag a long-running, already explained process.
    const prev = t.get(e.pid);
    if (prev && e.kind === "snapshot" && prev.image === entry.image && prev.ppid === entry.ppid) {
      entry.explainedBy = prev.explainedBy;
      entry.ts = prev.ts || entry.ts;
    }
    t.delete(e.pid);
    t.set(e.pid, entry);
    if (t.size > MAX_PER_HOST) this.evict(t);
    return entry;
  }

  // Oldest first, but agent runtimes stay: a session open for days is the
  // root every later process is traced to, and losing it would make all of
  // its children look like they belong to no agent.
  evict(t) {
    let scanned = 0;
    for (const [pid, entry] of t) {
      if (!entry.runtime) {
        t.delete(pid);
        return;
      }
      if (++scanned > 1000) break;
    }
    t.delete(t.keys().next().value);
  }

  get(host, pid) {
    return this.table(host).get(pid) || null;
  }

  /**
   * Where a process sits relative to agent runtimes.
   * { runtime, root, isRoot, helper, inherited } where root is the runtime
   * process at the top of its tree and inherited is the nearest ancestor's
   * explanation, if any.
   */
  classify(host, entry) {
    const t = this.table(host);
    if (!entry) return { runtime: null };
    const parent = entry.ppid != null ? t.get(entry.ppid) : null;
    if (entry.runtime && !(parent && parent.runtime === entry.runtime)) {
      return { runtime: entry.runtime, root: entry, isRoot: true, helper: false, inherited: null };
    }
    let inherited = null;
    let node = parent;
    const seen = new Set([entry.pid]);
    for (let depth = 0; node && depth < MAX_DEPTH && !seen.has(node.pid); depth++) {
      seen.add(node.pid);
      if (!inherited && node.explainedBy) inherited = node.explainedBy;
      if (node.runtime) {
        const rootParent = node.ppid != null ? t.get(node.ppid) : null;
        if (!(rootParent && rootParent.runtime === node.runtime)) {
          const sameApp = basename(entry.image) === basename(node.image);
          const helper = sameApp || HELPER_IMAGES.test(entry.image || "") || GIT_READ_ONLY.test(entry.commandLine || "");
          return { runtime: node.runtime, root: node, isRoot: false, helper, inherited };
        }
      }
      node = node.ppid != null ? t.get(node.ppid) : null;
    }
    return { runtime: null };
  }

  stats() {
    return Object.fromEntries([...this.hosts].map(([h, t]) => [h, { processes: t.size, runtimes: [...t.values()].filter((e) => e.runtime).length }]));
  }
}

/**
 * The audited action that accounts for a process, or null. `actions` are
 * recent tool calls from every capture point: { ts, command, eventId, type,
 * toolUseId, agent }.
 */
export function findExplanation(entry, actions) {
  const cmd = normaliseCommand(entry.commandLine);
  if (!cmd) return null;
  const at = Date.parse(entry.ts);
  let best = null;
  for (const a of actions) {
    const t = Date.parse(a.ts);
    if (Number.isFinite(at) && Number.isFinite(t) && (t < at - WINDOW_BEFORE_MS || t > at + WINDOW_AFTER_MS)) continue;
    const action = normaliseCommand(a.command);
    if (action.length < 3) continue;
    // The shell that runs a command carries it in its command line; a child
    // the command spawned is a piece of it. Short process command lines are
    // not trusted in the second direction: "node" is a piece of everything.
    const hit = cmd.includes(action) || (cmd.length >= 8 && action.includes(cmd));
    if (!hit) continue;
    const distance = Number.isFinite(at) && Number.isFinite(t) ? Math.abs(at - t) : Infinity;
    if (!best || distance < best.distance) best = { action: a, distance };
  }
  return best ? best.action : null;
}
