// Collectors: run on an agent's machine, ship OS telemetry to the gateway.
//
// Tollpike reads what existing sensors already write instead of being one:
//
//   snapshot  the current process list (Windows CIM, Linux /proc, macOS ps),
//             sent at startup so agent sessions already running are known
//   sysmon    polls the Sysmon event log on Windows by record id
//   tail      follows a log file (auditd, osquery results, Falco JSON, or
//             Tollpike NDJSON), remembering its offset across restarts
//
// Nothing here runs a shell: PowerShell and ps get fixed argument arrays, and
// the only value interpolated into a script is an integer record id.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BOOKMARKS = path.join(os.homedir(), ".tollpike", "endpoint-bookmarks.json");

function readBookmarks() {
  try {
    return JSON.parse(fs.readFileSync(BOOKMARKS, "utf8"));
  } catch {
    return {};
  }
}

function writeBookmark(key, value) {
  const all = { ...readBookmarks(), [key]: value };
  fs.mkdirSync(path.dirname(BOOKMARKS), { recursive: true });
  const tmp = `${BOOKMARKS}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, BOOKMARKS);
}

function run(file, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out, err: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, err });
    });
  });
}

const powershell = (script, opts) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], opts);

/** POST one batch. Returns the gateway's counts or { ok:false, error }. */
export async function sendBatch({ url, key, format, body, host }) {
  const qs = new URLSearchParams({ format, ...(host ? { host } : {}) });
  const isText = typeof body === "string";
  try {
    const res = await fetch(`${String(url).replace(/\/+$/, "")}/audit/endpoint/events?${qs}`, {
      method: "POST",
      headers: { "content-type": isText ? "text/plain" : "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: isText ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    });
    const json = await res.json().catch(() => ({}));
    return res.ok ? json : { ok: false, error: json.error || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.cause?.code || err.message };
  }
}

/** The current process list as native snapshot events. */
export async function snapshotProcesses() {
  const host = os.hostname();
  if (process.platform === "win32") {
    const script =
      "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; image = $_.ExecutablePath; commandLine = $_.CommandLine; ts = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } } } | ConvertTo-Json -Compress";
    const r = await powershell(script);
    if (!r.ok) return { ok: false, error: r.err.trim().slice(0, 300) || "PowerShell failed" };
    const rows = JSON.parse(r.out || "[]");
    return { ok: true, events: (Array.isArray(rows) ? rows : [rows]).map((p) => ({ kind: "snapshot", host, ...p })) };
  }
  if (process.platform === "linux") {
    const events = [];
    for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
        let image = null;
        try {
          image = fs.readlinkSync(`/proc/${pid}/exe`);
        } catch {
          // other users' processes need root for exe
        }
        events.push({ kind: "snapshot", host, pid: Number(pid), ppid, image, commandLine: cmd || null });
      } catch {
        // the process exited while we read it
      }
    }
    return { ok: true, events };
  }
  const r = await run("ps", ["-axo", "pid=,ppid=,comm=,args="]);
  if (!r.ok) return { ok: false, error: r.err.trim() || "ps failed" };
  const events = r.out
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, comm, args]) => ({ kind: "snapshot", host, pid: Number(pid), ppid: Number(ppid), image: comm, commandLine: args }));
  return { ok: true, events };
}

/**
 * Read new Sysmon events after `afterRecordId`. Returns the XML and the
 * highest record id seen, or an error naming why (not installed, no access).
 */
export async function readSysmon(afterRecordId = 0, max = 500) {
  const n = Math.max(0, Math.floor(Number(afterRecordId) || 0));
  const script = `Get-WinEvent -LogName 'Microsoft-Windows-Sysmon/Operational' -FilterXPath '*[System[EventRecordID>${n}]]' -Oldest -MaxEvents ${Math.min(Math.max(Number(max) || 500, 1), 5000)} -ErrorAction Stop | ForEach-Object { $_.ToXml() }`;
  const r = await powershell(script);
  if (!r.ok) {
    if (/No events were found/i.test(r.err)) return { ok: true, xml: "", last: n };
    if (/not an event log|could not be found|There is not an event log/i.test(r.err)) return { ok: false, error: "Sysmon is not installed (no Microsoft-Windows-Sysmon/Operational log)." };
    if (/unauthorized|access is denied/i.test(r.err)) return { ok: false, error: "Reading the Sysmon log needs an elevated (administrator) session." };
    return { ok: false, error: r.err.trim().slice(0, 300) };
  }
  let last = n;
  for (const m of r.out.matchAll(/<EventRecordID>(\d+)<\/EventRecordID>/g)) last = Math.max(last, Number(m[1]));
  return { ok: true, xml: r.out, last };
}

export async function pollSysmon({ url, key, intervalMs = 5_000, log = console.error, once = false }) {
  const mark = "sysmon";
  let after = readBookmarks()[mark] ?? 0;
  for (;;) {
    const r = await readSysmon(after);
    if (!r.ok) {
      log(`sysmon: ${r.error}`);
      if (once) return r;
    } else if (r.xml.trim()) {
      const sent = await sendBatch({ url, key, format: "sysmon", body: r.xml, host: os.hostname() });
      if (sent.ok) {
        after = r.last;
        writeBookmark(mark, after);
        log(`sysmon: ${sent.received} events, ${sent.recorded} recorded, ${sent.unexplained} unexplained`);
      } else {
        log(`sysmon: gateway refused the batch: ${sent.error} (will retry)`);
      }
    }
    if (once) return { ok: true };
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

/**
 * Follow a log file. The bookmark is the file's identity (inode or size
 * shrinking means rotation) and the byte offset, so a restart neither
 * resends nor skips lines.
 */
export async function tailFile({ file, format, url, key, fromStart = false, intervalMs = 2_000, log = console.error, once = false }) {
  const mark = `tail:${path.resolve(file)}`;
  let state = readBookmarks()[mark] || null;
  for (;;) {
    let st;
    try {
      st = fs.statSync(file);
    } catch (err) {
      log(`tail: ${file}: ${err.code || err.message}`);
      if (once) return { ok: false, error: err.code };
      await new Promise((res) => setTimeout(res, intervalMs));
      continue;
    }
    const identity = `${st.ino}:${st.dev}`;
    if (!state || state.identity !== identity || st.size < state.offset) {
      // First run: start at the end unless asked for the history. A new
      // identity or a shorter file is a rotation: read the new file from 0.
      state = { identity, offset: !state && !fromStart ? st.size : 0 };
    }
    if (st.size > state.offset) {
      const length = Math.min(st.size - state.offset, 8 * 1024 * 1024);
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, state.offset);
      fs.closeSync(fd);
      const text = buf.toString("utf8");
      // Only whole lines: a record half-written at the end waits for the next read.
      const cut = text.lastIndexOf("\n") + 1;
      if (cut > 0) {
        const sent = await sendBatch({ url, key, format, body: text.slice(0, cut), host: os.hostname() });
        if (sent.ok) {
          state.offset += Buffer.byteLength(text.slice(0, cut));
          writeBookmark(mark, state);
          log(`tail ${format}: ${sent.received} events, ${sent.recorded} recorded, ${sent.unexplained} unexplained`);
        } else {
          log(`tail ${format}: gateway refused the batch: ${sent.error} (will retry)`);
        }
      }
    }
    if (once) return { ok: true, offset: state.offset };
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}
