// Endpoint telemetry parsers: turn what an OS sensor emits into one shape.
//
// Supported inputs, each as its shippers actually produce it:
//
//   sysmon   Windows Sysmon events, as XML (Get-WinEvent ... .ToXml(), the
//            form the built-in collector uses) or as JSON (Winlogbeat's
//            winlog.event_data, or a flat object with EventID and fields)
//   auditd   Linux audit log text: SYSCALL, EXECVE, CWD, PATH records grouped
//            by their audit(<time>:<serial>) id
//   osquery  results log lines (process_events, socket_events, file_events,
//            and snapshot queries of the processes table)
//   falco    Falco JSON alerts (eBPF), with output_fields
//   native   Tollpike's own normalized JSON, for any other shipper
//
// Normalized event:
//   { kind: "process" | "snapshot" | "file" | "network" | "dns",
//     ts (ISO), host, pid, ppid, image, commandLine, user, cwd,
//     parentImage, path, action, destHost, destIp, destPort, query }
//
// Parsers never throw on bad input: unparsable records are counted and
// skipped, because one malformed line must not drop a whole batch.

const MAX_FIELD = 8_192;

function clip(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v);
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function isoOf(v) {
  if (v === undefined || v === null || v === "") return new Date().toISOString();
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  // Sysmon UtcTime is "2026-10-03 08:15:30.123", UTC without a zone marker.
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(String(v)) ? `${String(v).replace(" ", "T")}Z` : String(v);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function result() {
  return { events: [], skipped: 0 };
}

// --- Sysmon ---------------------------------------------------------------

// Sysmon event ids worth importing: 1 process create, 3 network connect,
// 11 file create, 22 DNS query, 23 and 26 file delete.
function fromSysmonFields(id, d, host) {
  const base = { ts: isoOf(d.UtcTime), host: clip(host || d.Computer), pid: num(d.ProcessId), image: clip(d.Image), user: clip(d.User) };
  switch (Number(id)) {
    case 1:
      return { ...base, kind: "process", ppid: num(d.ParentProcessId), commandLine: clip(d.CommandLine), cwd: clip(d.CurrentDirectory), parentImage: clip(d.ParentImage), parentCommandLine: clip(d.ParentCommandLine) };
    case 3:
      return { ...base, kind: "network", destHost: clip(d.DestinationHostname), destIp: clip(d.DestinationIp), destPort: num(d.DestinationPort) };
    case 11:
      return { ...base, kind: "file", path: clip(d.TargetFilename), action: "create" };
    case 22:
      return { ...base, kind: "dns", query: clip(d.QueryName) };
    case 23:
    case 26:
      return { ...base, kind: "file", path: clip(d.TargetFilename), action: "delete" };
    default:
      return null;
  }
}

export function parseSysmon(input, { host } = {}) {
  const out = result();
  const push = (e) => (e ? out.events.push(e) : (out.skipped += 1));

  if (typeof input === "string" && input.includes("<Event")) {
    for (const xml of input.match(/<Event[\s>][\s\S]*?<\/Event>/g) || []) {
      const id = xml.match(/<EventID[^>]*>(\d+)<\/EventID>/)?.[1];
      const computer = xml.match(/<Computer>([^<]*)<\/Computer>/)?.[1];
      const d = { Computer: computer };
      for (const m of xml.matchAll(/<Data Name=['"]([^'"]+)['"]>([\s\S]*?)<\/Data>/g)) d[m[1]] = decodeXml(m[2]);
      for (const m of xml.matchAll(/<Data Name=['"]([^'"]+)['"]\s*\/>/g)) d[m[1]] = "";
      push(id ? fromSysmonFields(id, d, host) : null);
    }
    return out;
  }

  const records = typeof input === "string" ? parseJsonLines(input, out) : Array.isArray(input) ? input : [input];
  for (const r of records) {
    if (!r || typeof r !== "object") {
      out.skipped += 1;
      continue;
    }
    // Winlogbeat: winlog.event_id + winlog.event_data; flat: EventID + fields.
    const id = r.winlog?.event_id ?? r.EventID ?? r.event_id ?? r.Id;
    const d = r.winlog?.event_data ?? r.event_data ?? r.EventData ?? r;
    push(id ? fromSysmonFields(id, { ...d, Computer: r.winlog?.computer_name ?? r.host?.name ?? r.Computer ?? d.Computer }, host) : null);
  }
  return out;
}

// --- auditd ---------------------------------------------------------------

// EXECVE arguments are quoted, or hex-encoded when they contain spaces or
// non-printable bytes. a0=726D -> "rm".
function auditValue(v) {
  if (v === undefined) return undefined;
  if (/^".*"$/.test(v)) return v.slice(1, -1);
  if (/^[0-9A-F]+$/.test(v) && v.length % 2 === 0 && v.length >= 2) {
    try {
      const s = Buffer.from(v, "hex").toString("utf8");
      if (/^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(s)) return s;
    } catch {
      // not hex after all
    }
  }
  return v;
}

function auditFields(rest) {
  const f = {};
  for (const m of rest.matchAll(/([A-Za-z0-9_]+)=("[^"]*"|\S+)/g)) f[m[1]] = m[2];
  return f;
}

export function parseAuditd(text, { host } = {}) {
  const out = result();
  const groups = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^(?:node=(\S+)\s+)?type=(\w+)\s+msg=audit\((\d+(?:\.\d+)?):(\d+)\):\s?(.*)$/);
    if (!m) {
      if (line.trim()) out.skipped += 1;
      continue;
    }
    const [, node, type, time, serial, rest] = m;
    const key = `${node || ""}|${serial}`;
    if (!groups.has(key)) groups.set(key, { node, time: Number(time), records: {} });
    const g = groups.get(key);
    (g.records[type] ||= []).push(auditFields(rest));
  }
  for (const g of groups.values()) {
    const sys = g.records.SYSCALL?.[0];
    const exec = g.records.EXECVE?.[0];
    const base = { ts: isoOf(g.time), host: clip(host || g.node), pid: num(sys?.pid), user: clip(sys?.auid ?? sys?.uid) };
    if (exec) {
      const argc = Number(exec.argc) || 0;
      const argv = [];
      for (let i = 0; i < argc; i++) argv.push(auditValue(exec[`a${i}`]) ?? "");
      out.events.push({ ...base, kind: "process", ppid: num(sys?.ppid), image: clip(auditValue(sys?.exe)), commandLine: clip(argv.join(" ")), cwd: clip(auditValue(g.records.CWD?.[0]?.cwd)) });
    } else if (sys && g.records.PATH) {
      const paths = g.records.PATH.map((p) => auditValue(p.name)).filter(Boolean);
      const deleting = g.records.PATH.some((p) => p.nametype === "DELETE");
      for (const p of paths) out.events.push({ ...base, kind: "file", image: clip(auditValue(sys.exe)), path: clip(p), action: deleting ? "delete" : "access" });
    } else {
      out.skipped += 1;
    }
  }
  return out;
}

// --- osquery --------------------------------------------------------------

function parseJsonLines(text, out) {
  const s = String(text || "").trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      return JSON.parse(s);
    } catch {
      out.skipped += 1;
      return [];
    }
  }
  const rows = [];
  for (const line of s.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      out.skipped += 1;
    }
  }
  return rows;
}

export function parseOsquery(input, { host } = {}) {
  const out = result();
  const rows = typeof input === "string" ? parseJsonLines(input, out) : Array.isArray(input) ? input : [input];
  for (const r of rows) {
    // Event-format lines carry `columns`; snapshot-format lines carry `snapshot` rows.
    const name = String(r?.name || "");
    const items = Array.isArray(r?.snapshot) ? r.snapshot : r?.columns ? [r.columns] : [];
    if (!items.length) {
      out.skipped += 1;
      continue;
    }
    const h = clip(host || r.hostIdentifier);
    for (const c of items) {
      const ts = isoOf(c.time ? Number(c.time) : r.unixTime ? Number(r.unixTime) : undefined);
      if (/process_events|processes/.test(name) || (c.cmdline !== undefined && c.pid !== undefined)) {
        out.events.push({ kind: /process_events/.test(name) ? "process" : "snapshot", ts, host: h, pid: num(c.pid), ppid: num(c.parent), image: clip(c.path), commandLine: clip(c.cmdline), cwd: clip(c.cwd), user: clip(c.uid) });
      } else if (/socket_events/.test(name)) {
        out.events.push({ kind: "network", ts, host: h, pid: num(c.pid), image: clip(c.path), destIp: clip(c.remote_address), destPort: num(c.remote_port) });
      } else if (/file_events/.test(name)) {
        out.events.push({ kind: "file", ts, host: h, path: clip(c.target_path), action: String(c.action || "").toLowerCase().includes("delete") ? "delete" : "write" });
      } else {
        out.skipped += 1;
      }
    }
  }
  return out;
}

// --- Falco ----------------------------------------------------------------

export function parseFalco(input, { host } = {}) {
  const out = result();
  const rows = typeof input === "string" ? parseJsonLines(input, out) : Array.isArray(input) ? input : [input];
  for (const r of rows) {
    const f = r?.output_fields;
    if (!f) {
      out.skipped += 1;
      continue;
    }
    const base = { ts: isoOf(r.time), host: clip(host || r.hostname || f["evt.hostname"]), pid: num(f["proc.pid"]), ppid: num(f["proc.ppid"]), image: clip(f["proc.exepath"] || f["proc.exe"] || f["proc.name"]), commandLine: clip(f["proc.cmdline"]), user: clip(f["user.name"]), cwd: clip(f["proc.cwd"]) };
    const type = String(f["evt.type"] || "");
    if (f["fd.name"] && /connect|sendto/.test(type)) {
      const [ip, port] = String(f["fd.sip"] || "").length ? [f["fd.sip"], f["fd.sport"]] : String(f["fd.name"]).split("->").pop().split(":");
      out.events.push({ ...base, kind: "network", destIp: clip(ip), destPort: num(port), destHost: clip(f["fd.sip.name"]) });
    } else if (f["fd.name"] && /open|unlink|rename/.test(type)) {
      out.events.push({ ...base, kind: "file", path: clip(f["fd.name"]), action: /unlink/.test(type) ? "delete" : "access" });
    } else {
      out.events.push({ ...base, kind: "process" });
    }
  }
  return out;
}

// --- native ---------------------------------------------------------------

const KINDS = new Set(["process", "snapshot", "file", "network", "dns"]);

export function parseNative(input, { host } = {}) {
  const out = result();
  const rows = typeof input === "string" ? parseJsonLines(input, out) : Array.isArray(input) ? input : input?.events || [input];
  for (const r of rows) {
    if (!r || !KINDS.has(r.kind)) {
      out.skipped += 1;
      continue;
    }
    out.events.push({
      kind: r.kind,
      ts: isoOf(r.ts),
      host: clip(host || r.host),
      pid: num(r.pid),
      ppid: num(r.ppid),
      image: clip(r.image),
      commandLine: clip(r.commandLine),
      user: clip(r.user),
      cwd: clip(r.cwd),
      parentImage: clip(r.parentImage),
      path: clip(r.path),
      action: clip(r.action),
      destHost: clip(r.destHost),
      destIp: clip(r.destIp),
      destPort: num(r.destPort),
      query: clip(r.query)
    });
  }
  return out;
}

export const FORMATS = { sysmon: parseSysmon, auditd: parseAuditd, osquery: parseOsquery, falco: parseFalco, native: parseNative };

export function parseEndpoint(format, input, opts) {
  const parser = FORMATS[format];
  if (!parser) return { events: [], skipped: 0, error: `Unknown format "${format}". Use one of: ${Object.keys(FORMATS).join(", ")}.` };
  return parser(input, opts);
}
