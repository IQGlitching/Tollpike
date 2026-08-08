// Obsidian vault as a context source.
//
// A vault is a directory of markdown files, so this is filesystem access — no
// plugin, no local REST API, no Obsidian running. That makes it the most
// reliable knowledge source here and the most dangerous one, because a path
// bug reads arbitrary files off the operator's disk.
//
// The containment rule: every resolved path must stay inside the configured
// vault root, checked after realpath resolution. `..` is not enough to screen
// on — a symlink inside the vault pointing at ~/.ssh contains no `..` at all
// and resolves straight out of the tree. Read-only throughout: this text is a
// prime indirect-injection vector, and a knowledge source that can write is a
// knowledge source an injected instruction can use to edit your notes.

import fs from "node:fs";
import path from "node:path";
import { getSettings } from "../storage/settings.js";
import { tokenize } from "../memory/store.js";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_SCAN_FILES = 5_000;

export function vaultPath() {
  return getSettings().knowledge.obsidianVault || process.env.OBSIDIAN_VAULT || null;
}

export function obsidianConfigured() {
  const root = vaultPath();
  return Boolean(root && fs.existsSync(root) && fs.statSync(root).isDirectory());
}

function unconfigured() {
  const root = vaultPath();
  return {
    ok: false,
    reason: root
      ? `Configured Obsidian vault "${root}" is not an existing directory.`
      : "No Obsidian vault configured. Set knowledge.obsidianVault or OBSIDIAN_VAULT."
  };
}

// The containment check. Resolves symlinks on both sides before comparing, so a
// link inside the vault that points outside it is caught. Compares against
// root + separator, because a sibling directory named `vault-backup` shares the
// `vault` prefix and a plain startsWith would accept it.
function insideVault(candidate) {
  const root = vaultPath();
  if (!root) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const resolved = path.resolve(realRoot, candidate);
    const realTarget = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    if (realTarget === realRoot) return realTarget;
    return realTarget.startsWith(realRoot + path.sep) ? realTarget : null;
  } catch {
    return null;
  }
}

// Walks the vault for markdown files. Skips .obsidian (config, plugins, and the
// workspace file — none of it is notes) and .trash.
function* walk(dir, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    // Directory symlinks are not followed: a link back up the tree would make
    // this walk unbounded, and one pointing outside it would escape containment.
    if (entry.isDirectory()) yield* walk(full, depth + 1);
    else if (entry.isFile() && /\.(md|markdown|txt)$/i.test(entry.name)) yield full;
  }
}

export function listNotes({ limit = 200 } = {}) {
  if (!obsidianConfigured()) return unconfigured();
  const root = fs.realpathSync(vaultPath());
  const notes = [];
  let scanned = 0;
  for (const file of walk(root)) {
    if (++scanned > MAX_SCAN_FILES) break;
    if (notes.length >= limit) break;
    const stat = fs.statSync(file);
    notes.push({
      path: path.relative(root, file).split(path.sep).join("/"),
      bytes: stat.size,
      modified: stat.mtime.toISOString()
    });
  }
  return {
    ok: true,
    vault: root,
    notes: notes.sort((a, b) => b.modified.localeCompare(a.modified)),
    // Says when the listing is partial. A silently truncated list reads as
    // "these are all your notes".
    truncated: scanned > MAX_SCAN_FILES || notes.length >= limit
  };
}

export function readNote(relativePath) {
  if (!obsidianConfigured()) return unconfigured();
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    return { ok: false, reason: "path must be a non-empty string" };
  }
  const resolved = insideVault(relativePath);
  if (!resolved) {
    return { ok: false, reason: "path resolves outside the configured vault" };
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return { ok: false, reason: `no note at "${relativePath}"` };
  }
  const stat = fs.statSync(resolved);
  if (stat.size > MAX_FILE_BYTES) {
    return { ok: false, reason: `note is ${stat.size} bytes, over the ${MAX_FILE_BYTES} limit` };
  }
  const root = fs.realpathSync(vaultPath());
  return {
    ok: true,
    path: path.relative(root, resolved).split(path.sep).join("/"),
    text: fs.readFileSync(resolved, "utf-8"),
    bytes: stat.size,
    modified: stat.mtime.toISOString()
  };
}

/**
 * Search note text. BM25-ish term overlap scoring, reusing the memory store's
 * tokenizer so a query behaves the same way against notes and against memories.
 *
 * Reads every file each time — no index. A vault is thousands of small files,
 * the OS caches them, and an index would need invalidation on external edits,
 * which is the normal case for Obsidian (you edit in Obsidian, not here). If a
 * vault ever gets big enough for this to hurt, `scanned` in the response is the
 * number that will say so.
 */
export function searchNotes(query, { limit = 10 } = {}) {
  if (!obsidianConfigured()) return unconfigured();
  const terms = tokenize(query);
  if (terms.length === 0) return { ok: true, results: [], scanned: 0 };

  const root = fs.realpathSync(vaultPath());
  const results = [];
  let scanned = 0;

  for (const file of walk(root)) {
    if (++scanned > MAX_SCAN_FILES) break;
    let text;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const haystack = text.toLowerCase();
    const relative = path.relative(root, file).split(path.sep).join("/");
    const nameHaystack = relative.toLowerCase();

    let score = 0;
    for (const term of terms) {
      const inBody = haystack.split(term).length - 1;
      // A term in the filename is a much stronger signal than one buried in the
      // body — in a vault, the title is the note's subject.
      const inName = nameHaystack.includes(term) ? 3 : 0;
      score += Math.min(inBody, 10) + inName;
    }
    if (score === 0) continue;

    const firstTerm = terms.find((t) => haystack.includes(t));
    const at = firstTerm ? haystack.indexOf(firstTerm) : 0;
    results.push({
      path: relative,
      score,
      excerpt: text.slice(Math.max(0, at - 120), at + 280).replace(/\s+/g, " ").trim()
    });
  }

  return {
    ok: true,
    vault: root,
    results: results.sort((a, b) => b.score - a.score).slice(0, limit),
    scanned,
    truncated: scanned > MAX_SCAN_FILES
  };
}

export function obsidianStatus() {
  const root = vaultPath();
  if (!obsidianConfigured()) return { configured: Boolean(root), vault: root, ...unconfigured() };
  const listed = listNotes({ limit: MAX_SCAN_FILES });
  return {
    configured: true,
    vault: fs.realpathSync(root),
    notes: listed.ok ? listed.notes.length : 0,
    truncated: listed.ok ? listed.truncated : false,
    access: "read-only",
    containment: "every path is realpath-resolved and must remain inside the vault root"
  };
}
