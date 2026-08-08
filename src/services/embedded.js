// Embedded services: managed sidecars.
//
// Bifrost (Go relay), 9Router and CLIProxy are separate programs that some
// deployments want running alongside the gateway. This supervises them —
// start, stop, health, logs — so they are visible in one place instead of
// being three terminal windows someone has to remember.
//
// IT DOES NOT INSTALL ANYTHING. Each service declares the command it expects
// on PATH (or an explicit binary path in settings) and `available` reports
// whether it is actually there. Downloading and executing a binary on an
// operator's behalf is precisely the supply-chain move this repo's provenance
// section exists to guard against, and a dashboard button is not consent.
//
// Two rules that shaped this file:
//
//   No shell. Every spawn is argv-array with shell:false. The service list is
//   a closed set in code, but the ARGUMENTS include operator-supplied values
//   (ports, config paths), and one string interpolated into a shell is a
//   command injection reachable from the control panel.
//
//   Children are killed on gateway exit. A supervisor that leaks orphaned
//   processes holding ports is worse than no supervisor: the next start fails
//   with EADDRINUSE against a process nobody can see.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const MAX_LOG_LINES = 300;

// The closed set. A service must be declared here to be startable; there is no
// "run this arbitrary command" endpoint, because that is a remote shell.
export const SERVICE_DEFINITIONS = {
  bifrost: {
    label: "Bifrost",
    description: "Go relay. Fronts the gateway with a fast connection pool.",
    command: "bifrost",
    defaultArgs: ["-port", "{port}"],
    defaultPort: 8080,
    healthPath: "/health",
    docs: "https://github.com/maximhq/bifrost"
  },
  "9router": {
    label: "9Router",
    description: "Multi-provider router run as a sidecar rather than in-process.",
    command: "9router",
    defaultArgs: ["--port", "{port}"],
    defaultPort: 9099,
    healthPath: "/health",
    docs: null
  },
  cliproxy: {
    label: "CLIProxy",
    description: "Exposes CLI-authenticated coding agents over an HTTP API.",
    command: "cliproxy",
    defaultArgs: ["--port", "{port}"],
    defaultPort: 8317,
    healthPath: "/",
    docs: null
  }
};

export const SERVICE_IDS = Object.keys(SERVICE_DEFINITIONS);

// Named groups, so "bring up the cluster" is one call rather than three that
// have to be issued in the right order.
export const CLUSTER_PROFILES = {
  minimal: { label: "Minimal", services: ["bifrost"] },
  relay: { label: "Relay + router", services: ["bifrost", "9router"] },
  full: { label: "Full cluster", services: ["bifrost", "9router", "cliproxy"] }
};

// id -> { child, startedAt, logs: [], port, exit }
const running = new Map();

function resolveBinary(definition, override) {
  if (override) return existsSync(override) ? override : null;
  // No PATH search here: spawn does that, and a `which` implementation that
  // disagrees with what spawn resolves is a bug generator. `available` reports
  // "explicitly configured and present" or "will be looked up on PATH".
  return definition.command;
}

export function serviceAvailable(id, override) {
  const definition = SERVICE_DEFINITIONS[id];
  if (!definition) return { available: false, reason: `unknown service "${id}"` };
  if (override) {
    return existsSync(override)
      ? { available: true, via: "configured path", binary: override }
      : { available: false, reason: `configured binary "${override}" does not exist` };
  }
  return {
    available: null, // genuinely unknown until spawn resolves it against PATH
    via: "PATH",
    binary: definition.command,
    reason: `"${definition.command}" is looked up on PATH at start time; install it yourself — this supervisor never downloads a binary`
  };
}

function pushLog(entry, line) {
  entry.logs.push({ at: Date.now(), line: line.slice(0, 2_000) });
  // Bounded: a chatty sidecar left running for a week would otherwise be a
  // slow memory leak in the gateway process.
  if (entry.logs.length > MAX_LOG_LINES) entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES);
}

/**
 * Start a declared service.
 *
 * `args` may override the default argv, but only as an array of strings — the
 * whole point of refusing a shell is undone if a caller can pass one string.
 */
export function startService(id, { port, binary = null, args = null, env = {} } = {}) {
  const definition = SERVICE_DEFINITIONS[id];
  if (!definition) return { ok: false, error: `unknown service "${id}"` };
  if (running.has(id) && !running.get(id).exit) {
    return { ok: false, error: `${id} is already running (pid ${running.get(id).child.pid})` };
  }

  // An ABSENT port falls back to the default; a port that was actually supplied
  // is validated. `Number(port) || default` conflated the two, so an explicit
  // port 0 silently became 8080 — the service then came up somewhere the caller
  // did not ask for and the dashboard reported success.
  const portProvided = port !== undefined && port !== null && port !== "";
  const resolvedPort = portProvided ? Number(port) : definition.defaultPort;
  if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65_535) {
    return { ok: false, error: "port must be an integer between 1 and 65535" };
  }

  if (args !== null && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
    return { ok: false, error: "args must be an array of strings" };
  }

  const command = resolveBinary(definition, binary);
  if (!command) return { ok: false, error: `configured binary "${binary}" does not exist` };

  const argv = (args || definition.defaultArgs).map((a) => a.replace("{port}", String(resolvedPort)));

  // Only string values, and only keys that look like env vars. This object
  // reaches a child process's environment.
  const childEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (/^[A-Z_][A-Z0-9_]*$/.test(key) && typeof value === "string") childEnv[key] = value;
  }

  let child;
  try {
    child = spawn(command, argv, {
      shell: false, // never. see the header comment.
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      cwd: path.resolve(".")
    });
  } catch (err) {
    return { ok: false, error: `spawn failed: ${err.message}` };
  }

  const entry = { child, startedAt: Date.now(), logs: [], port: resolvedPort, exit: null, command, argv };
  running.set(id, entry);

  child.stdout.on("data", (chunk) => String(chunk).split("\n").filter(Boolean).forEach((l) => pushLog(entry, l)));
  child.stderr.on("data", (chunk) => String(chunk).split("\n").filter(Boolean).forEach((l) => pushLog(entry, `[stderr] ${l}`)));

  child.on("error", (err) => {
    // ENOENT here is the common case: the binary is not on PATH. Recorded as an
    // exit reason rather than thrown, because the start call has already
    // returned by the time spawn resolves the name.
    pushLog(entry, `[spawn error] ${err.message}`);
    entry.exit = { code: null, signal: null, error: err.message, at: Date.now() };
  });

  child.on("exit", (code, signal) => {
    pushLog(entry, `[exit] code=${code} signal=${signal}`);
    entry.exit = { code, signal, error: null, at: Date.now() };
  });

  return { ok: true, id, pid: child.pid, port: resolvedPort, command, args: argv };
}

export function stopService(id, { signal = "SIGTERM" } = {}) {
  const entry = running.get(id);
  if (!entry) return { ok: false, error: `${id} is not running` };
  if (entry.exit) {
    running.delete(id);
    return { ok: true, id, alreadyExited: true, exit: entry.exit };
  }
  if (!["SIGTERM", "SIGINT", "SIGKILL"].includes(signal)) {
    return { ok: false, error: "signal must be SIGTERM, SIGINT or SIGKILL" };
  }
  try {
    entry.child.kill(signal);
  } catch (err) {
    return { ok: false, error: `kill failed: ${err.message}` };
  }
  return { ok: true, id, signal, pid: entry.child.pid };
}

export async function serviceHealth(id) {
  const definition = SERVICE_DEFINITIONS[id];
  const entry = running.get(id);
  if (!definition) return { ok: false, error: `unknown service "${id}"` };
  if (!entry || entry.exit) return { ok: false, running: false, exit: entry?.exit || null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}${definition.healthPath}`, {
      signal: controller.signal
    });
    return { ok: true, running: true, healthy: response.ok, status: response.status, port: entry.port };
  } catch (err) {
    // Running but not answering. That is a real and distinct state from "not
    // running" — usually still starting up.
    return { ok: true, running: true, healthy: false, reason: err.message, port: entry.port };
  } finally {
    clearTimeout(timer);
  }
}

export function serviceLogs(id, { lines = 100 } = {}) {
  const entry = running.get(id);
  if (!entry) return { ok: false, error: `no logs for "${id}" — it has not been started this session` };
  return {
    ok: true,
    id,
    lines: entry.logs.slice(-Math.min(Math.max(Number(lines) || 100, 1), MAX_LOG_LINES)),
    truncated: entry.logs.length >= MAX_LOG_LINES
  };
}

export function servicesStatus(settings = {}) {
  const overrides = settings.serviceBinaries || {};
  return {
    services: SERVICE_IDS.map((id) => {
      const definition = SERVICE_DEFINITIONS[id];
      const entry = running.get(id);
      return {
        id,
        label: definition.label,
        description: definition.description,
        docs: definition.docs,
        defaultPort: definition.defaultPort,
        binary: serviceAvailable(id, overrides[id]),
        running: Boolean(entry && !entry.exit),
        pid: entry && !entry.exit ? entry.child.pid : null,
        port: entry?.port ?? null,
        startedAt: entry?.startedAt ?? null,
        uptimeMs: entry && !entry.exit ? Date.now() - entry.startedAt : null,
        lastExit: entry?.exit ?? null,
        logLines: entry?.logs.length ?? 0
      };
    }),
    profiles: Object.entries(CLUSTER_PROFILES).map(([id, p]) => ({ id, ...p })),
    // Stated on the API, not just in a comment. Someone clicking "start" in a
    // dashboard should be able to see that nothing is being fetched.
    installs: "never — binaries must already be present; this supervises, it does not install"
  };
}

export function startProfile(name, { ports = {} } = {}) {
  const profile = CLUSTER_PROFILES[name];
  if (!profile) {
    return { ok: false, error: `unknown profile "${name}" (use ${Object.keys(CLUSTER_PROFILES).join(", ")})` };
  }
  const results = profile.services.map((id) => ({ id, ...startService(id, { port: ports[id] }) }));
  return {
    // Partial success is reported as partial. Reporting ok:true because one of
    // three came up is how a half-started cluster looks healthy on a dashboard.
    ok: results.every((r) => r.ok),
    profile: name,
    started: results.filter((r) => r.ok).map((r) => r.id),
    failed: results.filter((r) => !r.ok).map((r) => ({ id: r.id, error: r.error })),
    results
  };
}

export function stopAll() {
  const stopped = [];
  for (const id of [...running.keys()]) {
    const result = stopService(id, { signal: "SIGTERM" });
    if (result.ok) stopped.push(id);
  }
  return stopped;
}

// An orphaned sidecar holding a port is worse than no supervisor at all: the
// next start fails against a process the operator cannot see in this dashboard.
// `once` on each, so a SIGINT that also triggers exit does not double-kill.
let shutdownHooked = false;
export function installShutdownHooks() {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const shutdown = () => stopAll();
  process.once("exit", shutdown);
  process.once("SIGINT", () => {
    shutdown();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    shutdown();
    process.exit(143);
  });
}

export function _reset() {
  running.clear();
}
