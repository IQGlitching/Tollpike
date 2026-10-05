// The audit log: data/audit.jsonl, append-only and hash-chained.
//
// Same construction as the usage ledger (storage/costTracker.js) and the same
// primitives (security/chain.js): every row carries `h`, a MAC over the
// previous row's `h` and this row's canonical payload, keyed with a key
// derived from TOLLPIKE_SECRET under its own label. A sidecar, audit.head,
// anchors the count and head so deleting the newest rows is detectable too.
// Without TOLLPIKE_SECRET the chain is a plain SHA-256: it still catches
// accidental damage and naive edits, and every report says `keyed: false`
// rather than claiming tamper-evidence it cannot provide.
//
// Append-only means the log is never rewritten, including by Tollpike.
// A review of a flagged event is a new `review` row pointing at it, not an
// edit to the original, so the record of what happened and the record of
// who looked at it are both preserved.
//
// Several processes may write (the gateway, the CLI, hooks): appends take a
// lock file so each one chains from the true head.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../paths.js";
import { auditKey } from "../security/crypto.js";
import { canonicalPayload, chainHashWith, hexEqual, anchorTag } from "../security/chain.js";

export const logPath = path.join(dataDir, "audit.jsonl");
const headPath = path.join(dataDir, "audit.head");
const GENESIS = "tollpike-audit-v1";

let state = null; // { head, count, size }

// Another process (the CLI recording a review while the gateway runs) may
// have appended since this one last wrote. Appending from a stale head would
// fork the chain, so the head is re-read whenever the file size moved.
function fileSize() {
  try {
    return fs.statSync(logPath).size;
  } catch {
    return 0;
  }
}

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

function readLines() {
  try {
    return fs.readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
}

// The chain head is recovered from the file itself at first use. Trusting
// the anchor for it would let a damaged anchor fork the chain silently; the
// file is the record, the anchor only witnesses its length.
function load() {
  if (state) return state;
  const lines = readLines();
  let head = GENESIS;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i]);
      if (typeof row.h === "string") {
        head = row.h;
        break;
      }
    } catch {
      // keep walking back to the last parseable row
    }
  }
  state = { head, count: lines.length, size: fileSize() };
  return state;
}

function readAnchor() {
  try {
    const a = JSON.parse(fs.readFileSync(headPath, "utf8"));
    return a && typeof a.count === "number" && typeof a.head === "string" ? a : null;
  } catch {
    return null;
  }
}

function writeAnchor(count, head) {
  const key = auditKey();
  const anchor = { v: 1, count, head, ...(key ? { tag: anchorTag(key, count, head) } : {}) };
  try {
    const tmp = `${headPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(anchor), { mode: 0o600 });
    fs.renameSync(tmp, headPath);
  } catch (err) {
    console.error(`[audit] failed to write the head anchor: ${err.message}`);
  }
}

export function newEventId() {
  return `evt_${Date.now().toString(36)}${crypto.randomBytes(5).toString("hex")}`;
}

/**
 * Append one event. Returns the stored row. Never throws: an audit write
 * that fails is reported on stderr and counted, and the request it describes
 * still completes. Failing the request instead would let a full disk take the
 * gateway down; the failure count is surfaced in the status so a gap in the
 * record is visible rather than silent.
 */
let writeFailures = 0;
export function appendEvent(event) {
  const row = { v: 1, id: event.id || newEventId(), ts: new Date().toISOString(), ...event };
  delete row.h;
  let h = "";
  let release = null;
  try {
    ensureDir();
    release = acquireLock();
    // Read the head and append under one lock. Checking the size first and
    // appending later left a window in which the gateway and the CLI could
    // both append after the same head, forking the chain for good.
    if (state && fileSize() !== state.size) state = null;
    const s = load();
    h = chainHashWith(auditKey(), s.head, canonicalPayload(row));
    // A crash mid-write can leave a last line with no newline. Appending
    // straight after it would glue this row onto the torn one, and both
    // would be lost; start on a fresh line instead.
    const lead = s.size > 0 && !endsWithNewline() ? "\n" : "";
    fs.appendFileSync(logPath, lead + JSON.stringify({ ...row, h }) + "\n", { mode: 0o600 });
    s.head = h;
    s.count += 1; // a torn line was already counted when the file was read
    s.size = fileSize();
    writeAnchor(s.count, s.head);
  } catch (err) {
    writeFailures += 1;
    console.error(`[audit] failed to append an event: ${err.message}`);
  } finally {
    release?.();
  }
  return { ...row, h };
}

function endsWithNewline() {
  let fd;
  try {
    fd = fs.openSync(logPath, "r");
    const size = fs.fstatSync(fd).size;
    if (!size) return true;
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    return b[0] === 0x0a;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// A lock file shared by every process writing this data directory. Appends
// are a few milliseconds, so a holder older than LOCK_STALE_MS crashed while
// holding it and the lock is taken over. If the lock cannot be had in
// LOCK_WAIT_MS the append goes ahead anyway: a rare fork, which verify then
// reports, is better than losing the event.
const lockPath = path.join(dataDir, "audit.lock");
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function acquireLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => fs.rmSync(lockPath, { force: true });
    } catch (err) {
      // Windows answers EPERM or EACCES, not EEXIST, while another process's
      // lock file is still being deleted: that is "busy", not "no locking".
      if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(err.code)) return null;
      if (Date.now() > deadline) {
        console.error("[audit] the audit log lock is held by another process; appending without it");
        return null;
      }
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // released between the open and the stat, or still being deleted
      }
      Atomics.wait(sleeper, 0, 0, 5);
    }
  }
}

export function writeFailureCount() {
  return writeFailures;
}

/**
 * Walk the whole file and verify every row.
 * intact: every row chains, the anchor agrees with the file, nothing deleted.
 */
export function verifyAudit() {
  const key = auditKey();
  const lines = readLines();
  let head = GENESIS;
  const brokenAt = [];
  let unparsable = 0;
  let headAtAnchor = null;
  const anchor = readAnchor();
  if (anchor && anchor.count === 0) headAtAnchor = GENESIS;

  lines.forEach((line, i) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      unparsable += 1;
      brokenAt.push(i);
      return;
    }
    const expected = chainHashWith(key, head, canonicalPayload(row));
    if (!hexEqual(expected, row.h || "")) brokenAt.push(i);
    // Resynchronise on the stored hash, so one bad row is reported as one
    // break instead of cascading through every row after it.
    head = typeof row.h === "string" ? row.h : expected;
    if (anchor && i + 1 === anchor.count) headAtAnchor = head;
  });

  let anchorOk = null;
  let truncated = false;
  let rolledBack = false;
  if (anchor) {
    if (key) anchorOk = hexEqual(anchorTag(key, anchor.count, anchor.head), anchor.tag || "");
    if (anchorOk !== false) {
      if (lines.length < anchor.count) truncated = true;
      else if (headAtAnchor !== null && headAtAnchor !== anchor.head) rolledBack = true;
    }
  } else if (lines.length > 0) {
    // Rows exist but the witness of their length is gone. Not proof of
    // tampering on its own, but deleting the anchor is the first step of a
    // truncation, so it is never reported as clean.
    anchorOk = false;
  }

  const intact = brokenAt.length === 0 && !truncated && !rolledBack && anchorOk !== false;
  return {
    ok: true,
    intact,
    keyed: Boolean(key),
    algo: key ? "hmac-sha256" : "sha256",
    total: lines.length,
    brokenLinks: brokenAt.length,
    brokenAt: brokenAt.slice(0, 50),
    unparsable,
    anchored: Boolean(anchor),
    anchorOk,
    truncated,
    rolledBack,
    head,
    writeFailures,
    note: key
      ? "Keyed chain: rewriting history needs TOLLPIKE_SECRET, which lives outside the data directory."
      : "Unkeyed chain: detects damage and naive edits only. Set TOLLPIKE_SECRET for tamper-evidence."
  };
}

/** Parse every row. For queries and export; the file is the database. */
export function readEvents() {
  const out = [];
  for (const line of readLines()) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // verifyAudit reports unparsable rows; a query skips them
    }
  }
  return out;
}

/** Tests only. */
export function _resetAuditState() {
  state = null;
  writeFailures = 0;
}
