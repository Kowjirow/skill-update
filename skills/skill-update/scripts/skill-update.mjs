#!/usr/bin/env node
// skill-update — keep skills copied from git repositories up to date.
//
//   skill-update config [--root default|<folder>] [--lock <file>] [--after-update <command>]
//                       [--remove-root <folder>] [--ignore <a,b>] [--lang en|fr]
//   skill-update scan                     skills found and how each is tracked (no network)
//   skill-update check [<id>…]            what changed upstream and what you changed
//   skill-update update <id>… | --all     apply, with backups [--dry-run] [--ours | --theirs]
//   skill-update track <id> <url>         record where a skill comes from
//                       [--path <folder in repo>] [--ref <branch|tag>] [--commit <sha>]
//   skill-update track <id> --manual [<note>]   never updated by this tool
//   skill-update track --from-npx [<id>…]       adopt what `npx skills` recorded
//   skill-update untrack <id>
//   skill-update plugins                  Claude Code plugins behind their marketplace
//
// Common options: --root <folder> (that folder only), --json, --lang en|fr,
// --offline (no fetch), --verbose, --exit-code (check: exit 1 when updates exist).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "./core.mjs";
import { detectLang, setLang, t } from "./i18n.mjs";

const CONFIG_FILE = path.join(core.HOME, "config.json");
const DEFAULT_ROOT = path.join(core.claudeDir(), "skills");
const DEFAULT_IGNORE = ["synced"]; // ~/.claude/skills/synced is managed by claude.ai
const LOCK_NAME = ".skill-update-lock.json";
const VALUE_OPTIONS = new Set(["root", "lock", "after-update", "path", "ref", "commit", "lang", "ignore", "remove-root"]);
const ENTRY_FIELDS = ["type", "note", "source", "ref", "path", "commit", "include", "exclude", "extras", "updatedAt"];
const STATUS_ORDER = ["update-available", "merge-available", "conflict", "source-missing", "modified", "untracked", "missing", "error", "manual", "linked", "up-to-date"];
const ICON = {
  "update-available": "⬆️ ", "merge-available": "🔀", conflict: "⚠️ ", "source-missing": "❓", modified: "✏️ ",
  untracked: "➕", missing: "🕳️ ", error: "❌", manual: "✋", linked: "🔗", "up-to-date": "✅",
};
const APPLY = new Set(["update", "add", "remove", "merge"]);

const slash = core.slash;
const today = () => new Date().toLocaleDateString("sv-SE");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const short = (sha) => (sha ? sha.slice(0, 8) : "—");
const resolvePath = (p) => path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir()));
const samePath = (a, b) =>
  process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const clip = (list, n = 8) => (list.length > n ? `${list.slice(0, n).join(", ")} … (+${list.length - n})` : list.join(", "));

class CliError extends Error {
  constructor(code, vars = {}) {
    super(t(`err.${code}`, vars));
    this.code = code;
  }
}

// --- Arguments, files ----------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    let value = eq > 0 ? a.slice(eq + 1) : true;
    if (value === true && VALUE_OPTIONS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) value = argv[++i];
    opts[key] = value;
  }
  return { command: pos[0], args: pos.slice(1), opts };
}

// A file that exists but does not parse is an error: never overwrite it.
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

const orderEntry = (e) =>
  Object.fromEntries([
    ...ENTRY_FIELDS.filter((k) => e[k] !== undefined).map((k) => [k, e[k]]),
    ...Object.entries(e).filter(([k]) => !ENTRY_FIELDS.includes(k)),
  ]);

function readLock(file) {
  const lock = readJson(file, { version: 1, skills: {} });
  lock.skills ??= {};
  return lock;
}

function writeLock(file, lock) {
  const skills = Object.fromEntries(Object.keys(lock.skills).sort().map((id) => [id, orderEntry(lock.skills[id])]));
  writeJson(file, { version: 1, skills });
}

const print = (data) => console.log(JSON.stringify(data, null, 2));

// --- Roots and inventory ---------------------------------------------------------------

function rootsFor(opts, config) {
  const configured = (config?.roots ?? []).map((r) => ({ path: resolvePath(r.path), lock: r.lock ? resolvePath(r.lock) : null }));
  const withLock = (r) => ({ ...r, lock: r.lock ?? path.join(r.path, LOCK_NAME) });
  if (opts.root && opts.root !== true) {
    const p = opts.root === "default" ? DEFAULT_ROOT : resolvePath(opts.root);
    const known = configured.find((r) => samePath(r.path, p));
    return [withLock({ path: p, lock: opts.lock && opts.lock !== true ? resolvePath(opts.lock) : known?.lock })];
  }
  if (!configured.length) throw new CliError("not-configured");
  return configured.map(withLock);
}

function inventory(root, config) {
  const lock = readLock(root.lock);
  const npx = core.npxLocks(root.path);
  const found = core.discover(root.path, config?.ignore ?? DEFAULT_IGNORE);
  const items = found.map((s) => {
    const entry = lock.skills[s.id];
    const kind = entry ? (entry.type === "manual" ? "manual" : "tracked") : s.link ? "linked" : s.checkout ? "checkout" : "untracked";
    const item = { ...s, kind, entry };
    if (kind === "untracked" && npx.has(path.basename(s.dir))) item.npx = npx.get(path.basename(s.dir));
    return item;
  });
  const seen = new Set(found.map((s) => s.id));
  for (const id of Object.keys(lock.skills)) {
    if (!seen.has(id)) items.push({ id, dir: path.join(root.path, ...id.split("/")), kind: "missing", entry: lock.skills[id] });
  }
  return { lock, items };
}

function gather(opts, config) {
  return rootsFor(opts, config).map((root) => {
    const data = { root, ...inventory(root, config) };
    for (const item of data.items) Object.assign(item, { root, rootData: data });
    return data;
  });
}

// Skills named on the command line: full id (video/brag) or folder name (brag).
function select(items, ids) {
  if (!ids.length) return items;
  return ids.map((id) => {
    const want = id.replace(/\\/g, "/").replace(/\/+$/, "");
    const exact = items.filter((s) => s.id === want);
    const matches = exact.length ? exact : items.filter((s) => s.id.split("/").pop() === want);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new CliError("ambiguous", { id, list: matches.map((s) => s.id).join(", ") });
    throw new CliError("unknown-skill", { id });
  });
}

// --- Evaluation ---------------------------------------------------------------------------

const checkouts = new Map();

function evaluate(item, opts) {
  try {
    switch (item.kind) {
      case "tracked":
        return evaluateTracked(item, opts);
      case "checkout":
        return evaluateCheckout(item, opts);
      case "manual":
        return { status: "manual", note: item.entry.note || undefined };
      case "linked":
        return { status: "linked", target: item.link ?? undefined };
      case "missing":
        return { status: "missing", source: item.entry.source };
      default:
        return { status: "untracked", npx: item.npx };
    }
  } catch (e) {
    if (e instanceof CliError) throw e;
    return { status: "error", error: e.message };
  }
}

function evaluateTracked(item, opts) {
  const { entry } = item;
  const repo = core.openRepo(entry.source, { fetch: !opts.offline });
  const head = core.resolveCommit(repo, entry.ref);
  if (!head) return { status: "error", error: t("err.bad-ref", { ref: entry.ref, url: entry.source }) };
  const base = entry.commit ? core.ensureCommit(repo, entry.commit) : null;
  const info = { source: entry.source, path: entry.path, commit: base ?? entry.commit, head };
  const remote = core.managedTree(repo, head, entry);
  // Extras (a root LICENSE) alone do not make a skill: its folder is gone.
  const extras = new Set(Object.keys(entry.extras ?? {}));
  if (![...remote.keys()].some((rel) => !extras.has(rel))) return { status: "source-missing", ...info };
  const local = core.localFiles(item.dir);
  const files = core.plan(base ? core.managedTree(repo, base, entry) : null, remote, local);

  const merges = files.filter((f) => f.action === "merge");
  if (merges.length) {
    const blobs = core.readBlobs(repo, merges.flatMap((f) => [f.base, f.remote]));
    for (const f of merges) {
      const m = core.merge3(local.get(f.rel).buf, blobs.get(f.base), blobs.get(f.remote));
      if (m.conflict) Object.assign(f, { action: "conflict", preview: m.content });
      else f.content = m.content;
    }
  }
  for (const f of files) if (f.action === "conflict-add") f.action = "conflict";

  const has = (...actions) => files.some((f) => actions.includes(f.action));
  const status = has("conflict")
    ? "conflict"
    : has("merge")
      ? "merge-available"
      : has("update", "add", "remove")
        ? "update-available"
        : has("modified-locally", "deleted-locally", "kept-modified")
          ? "modified"
          : "up-to-date";
  const paths = [entry.path ?? "", ...Object.values(entry.extras ?? {})];
  const moved = base && base !== head && status !== "up-to-date" && status !== "modified";
  return {
    status,
    ...info,
    behind: moved ? core.commitCount(repo, base, head, paths) : undefined,
    log: moved ? core.commitLog(repo, base, head, paths) : undefined,
    files,
    repo,
    local,
    base,
  };
}

function evaluateCheckout(item, opts) {
  if (!checkouts.has(item.checkout)) checkouts.set(item.checkout, core.checkoutStatus(item.checkout, { fetch: !opts.offline }));
  const s = checkouts.get(item.checkout);
  if (s.error) return { status: "error", error: s.error, checkout: slash(item.checkout) };
  const status =
    s.ahead > 0 && s.behind > 0 ? "conflict" : s.behind > 0 ? (s.dirty ? "merge-available" : "update-available") : s.dirty ? "modified" : "up-to-date";
  return { status, checkout: slash(item.checkout), commit: s.head, head: s.upstream, behind: s.behind || undefined, ahead: s.ahead || undefined, log: s.log };
}

function groupFiles(files) {
  const group = {};
  const as = { "modified-locally": "modified", "deleted-locally": "modified", "kept-modified": "modified" };
  for (const f of files) {
    if (f.action === "same") continue;
    const k = as[f.action] ?? f.action;
    (group[k] ??= []).push(f.rel);
  }
  return group;
}

function publicResult(item, r) {
  const out = { id: item.id, kind: item.kind, status: r.status };
  for (const k of ["source", "path", "checkout", "target", "note", "error", "npx", "commit", "head", "behind", "ahead", "log"]) {
    const v = r[k];
    if (v !== undefined && v !== null && !(Array.isArray(v) && !v.length)) out[k] = v;
  }
  if (r.files) {
    const files = groupFiles(r.files);
    if (Object.keys(files).length) out.files = files;
  }
  return out;
}

function summarize(skills) {
  const count = (...s) => skills.filter((x) => s.includes(x.status)).length;
  return {
    total: skills.length,
    updates: count("update-available", "merge-available"),
    conflicts: count("conflict"),
    untracked: count("untracked"),
    errors: count("error"),
  };
}

// --- Commands -------------------------------------------------------------------------------

function cmdConfig(args, opts) {
  let config = readJson(CONFIG_FILE, null);
  const changing = ["root", "remove-root", "after-update", "lang", "ignore"].some((k) => opts[k] !== undefined);
  if (changing) {
    config ??= {};
    config.roots ??= [];
    if (opts.root && opts.root !== true) {
      const p = opts.root === "default" ? DEFAULT_ROOT : resolvePath(opts.root);
      let root = config.roots.find((r) => samePath(resolvePath(r.path), p));
      if (!root) config.roots.push((root = { path: slash(p) }));
      if (opts.lock && opts.lock !== true) root.lock = slash(resolvePath(opts.lock));
    }
    if (opts["remove-root"]) config.roots = config.roots.filter((r) => !samePath(resolvePath(r.path), resolvePath(opts["remove-root"])));
    if (opts["after-update"] !== undefined) {
      if (opts["after-update"] === true || opts["after-update"] === "") delete config.afterUpdate;
      else config.afterUpdate = opts["after-update"];
    }
    if (opts.lang && opts.lang !== true) config.lang = opts.lang;
    if (opts.ignore !== undefined) config.ignore = String(opts.ignore === true ? "" : opts.ignore).split(",").map((s) => s.trim()).filter(Boolean);
    writeJson(CONFIG_FILE, config);
  }
  const roots = (config?.roots ?? []).map((r) => {
    const p = resolvePath(r.path);
    const lock = r.lock ? resolvePath(r.lock) : path.join(p, LOCK_NAME);
    return { path: slash(p), lock: slash(lock), exists: fs.existsSync(p) };
  });
  const out = {
    configured: roots.length > 0,
    file: slash(CONFIG_FILE),
    defaultRoot: slash(DEFAULT_ROOT),
    defaultRootExists: fs.existsSync(DEFAULT_ROOT),
    roots,
    ignore: config?.ignore ?? DEFAULT_IGNORE,
    ...(config?.afterUpdate && { afterUpdate: config.afterUpdate }),
    ...(config?.lang && { lang: config.lang }),
  };
  if (opts.json) return print(out);
  console.log(t("config.file", { file: out.file }));
  if (!roots.length) console.log(t("config.none"));
  for (const r of roots) console.log(`${r.exists ? "📁" : "⚠️ "} ${t("config.root", { root: r.path, lock: r.lock })}`);
  if (out.afterUpdate) console.log(t("config.after", { cmd: out.afterUpdate }));
}

function cmdScan(args, opts, config) {
  const report = gather(opts, config).map(({ root, items }) => ({
    path: slash(root.path),
    lock: slash(root.lock),
    skills: items.map((i) => ({
      id: i.id,
      kind: i.kind,
      ...(i.entry?.source && { source: i.entry.source, path: i.entry.path, commit: i.entry.commit }),
      ...(i.entry?.note && { note: i.entry.note }),
      ...(i.checkout && { checkout: slash(i.checkout) }),
      ...(i.link && { target: i.link }),
      ...(i.npx && { npx: i.npx }),
    })),
  }));
  if (opts.json) return print({ roots: report });
  const KIND_STATUS = { tracked: "up-to-date", checkout: "up-to-date" };
  for (const root of report) {
    console.log(`\n📦 ${t("check.root", { root: root.path })}  (${t("check.lock", { lock: root.lock })})`);
    for (const kind of ["tracked", "checkout", "manual", "linked", "untracked", "missing"]) {
      const list = root.skills.filter((s) => s.kind === kind);
      if (!list.length) continue;
      console.log(`\n${ICON[KIND_STATUS[kind] ?? kind]} ${kind} (${list.length})`);
      console.log(`   ${list.map((s) => s.id).join(", ")}`);
    }
  }
}

function cmdCheck(args, opts, config) {
  const data = gather(opts, config);
  const selected = select(data.flatMap((d) => d.items), args);
  const roots = data.map((d) => ({ path: slash(d.root.path), lock: slash(d.root.lock), skills: [] }));
  for (const item of selected) {
    const root = roots[data.findIndex((d) => d.root === item.root)];
    root.skills.push(publicResult(item, evaluate(item, opts)));
  }
  for (const root of roots) root.summary = summarize(root.skills);
  const summary = summarize(roots.flatMap((r) => r.skills));
  if (opts["exit-code"] && summary.updates) process.exitCode = 1;
  if (opts.json) return print({ roots, summary });
  for (const root of roots) {
    console.log(`\n📦 ${t("check.root", { root: root.path })}  (${t("check.lock", { lock: root.lock })})`);
    for (const status of STATUS_ORDER) {
      const list = root.skills.filter((s) => s.status === status);
      if (!list.length) continue;
      console.log(`\n${ICON[status]} ${t(`status.${status}`)} (${list.length})`);
      if (status === "up-to-date" && !opts.verbose) {
        console.log(`   ${list.map((s) => s.id).join(", ")}`);
        continue;
      }
      for (const s of list) printSkill(s, opts);
    }
  }
  console.log(`\n${"━".repeat(40)}\n${t("check.summary", summary)}`);
  if (summary.updates) console.log(t("check.hint.update"));
  if (summary.untracked) console.log(t("check.hint.track"));
}

function printSkill(s, opts) {
  let line = `   • ${s.id}`;
  if (s.behind) line += `  ${short(s.commit)} → ${short(s.head)}  (${t("check.commits", { n: s.behind })})`;
  if (s.source) line += `  ${s.source}${s.path ? ` · ${s.path}` : ""}`;
  if (s.checkout) line += `  ${s.checkout}`;
  if (s.target) line += `  → ${s.target}`;
  if (s.note) line += `  — ${s.note}`;
  if (s.error) line += `  ${s.error}`;
  if (s.npx) line += `  (${t("check.hint.npx")})`;
  console.log(line);
  for (const [k, list] of Object.entries(s.files ?? {})) if (k !== "local-only" || opts.verbose) console.log(`       ${t(`files.${k}`)}: ${clip(list)}`);
  for (const l of (s.log ?? []).slice(0, opts.verbose ? 15 : 5)) console.log(`       ${l}`);
}

function cmdUpdate(args, opts, config) {
  if (!args.length && !opts.all) throw new CliError("nothing-selected");
  const data = gather(opts, config);
  let selected = select(data.flatMap((d) => d.items), args);
  if (!args.length) selected = selected.filter((i) => i.kind === "tracked" || i.kind === "checkout");
  const dryRun = !!opts["dry-run"];
  const time = stamp();
  const report = { date: today(), dryRun, updated: [], conflicts: [], skipped: [], errors: [] };
  const changedLocks = new Set();
  const doneCheckouts = new Set();
  const backups = path.join(core.HOME, "backups", time);
  const conflictDir = path.join(core.HOME, "conflicts", time);
  const where = (item, dir) => path.join(dir, path.basename(item.root.path), ...item.id.split("/"));

  for (const item of selected) {
    const r = evaluate(item, opts);
    const id = { id: item.id, root: slash(item.root.path) };
    const skip = (reason) => args.length && report.skipped.push({ ...id, reason });
    if (r.status === "error") {
      report.errors.push({ ...id, error: r.error });
      continue;
    }
    if (item.kind === "checkout") {
      if (doneCheckouts.has(item.checkout)) continue;
      doneCheckouts.add(item.checkout);
      if (r.status !== "update-available" && r.status !== "merge-available") {
        skip(r.status);
        continue;
      }
      const result = { ...id, checkout: r.checkout, from: r.commit, to: r.head, commits: r.behind };
      const error = dryRun ? null : core.fastForward(item.checkout);
      if (error) report.conflicts.push({ ...result, error });
      else report.updated.push(result);
      continue;
    }
    if (item.kind !== "tracked" || r.status === "source-missing") {
      skip(r.status);
      continue;
    }

    const conflicts = r.files.filter((f) => f.action === "conflict");
    if (conflicts.length && !opts.ours && !opts.theirs) {
      const saved = where(item, conflictDir);
      if (!dryRun) {
        for (const f of conflicts.filter((f) => f.preview)) {
          const file = path.join(saved, ...f.rel.split("/"));
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, f.preview);
        }
      }
      report.conflicts.push({ ...id, files: conflicts.map((f) => f.rel), ...(!dryRun && { saved: slash(saved) }) });
      continue;
    }

    const ops = r.files.filter((f) => APPLY.has(f.action) || (f.action === "conflict" && opts.theirs));
    // Nothing to write: only record the commit when it was unknown or when a
    // conflict was settled with --ours, so the conflict does not come back.
    if (!ops.length && r.base && !conflicts.length) {
      skip(r.status);
      continue;
    }
    const result = {
      ...id,
      source: item.entry.source,
      path: item.entry.path,
      from: r.base ?? item.entry.commit ?? null,
      to: r.head,
      toDate: core.commitDate(r.repo, r.head),
      files: groupFiles(ops.map((f) => ({ rel: f.rel, action: f.action === "conflict" ? "update" : f.action }))),
      ...(conflicts.length && { resolved: opts.theirs ? "theirs" : "ours", conflicts: conflicts.map((f) => f.rel) }),
    };
    if (!dryRun) {
      const backup = where(item, backups);
      if (applyOps(item, r, ops, backup)) result.backup = slash(backup);
      item.rootData.lock.skills[item.id] = orderEntry({ ...item.entry, commit: r.head, updatedAt: report.date });
      changedLocks.add(item.rootData);
    }
    report.updated.push(result);
  }

  for (const d of changedLocks) writeLock(d.root.lock, d.lock);
  if (report.updated.some((u) => u.backup)) report.backupDir = slash(backups);
  if (report.conflicts.some((c) => c.saved)) report.conflictDir = slash(conflictDir);
  if (!dryRun && report.updated.length && config?.afterUpdate && !opts["no-after-update"]) {
    report.afterUpdate = runAfterUpdate(config.afterUpdate, report);
  }
  if (opts.json) return print(report);
  printUpdate(report);
}

// Writes the planned files; every file it replaces or removes is copied to
// `backup` first. Returns true when something was backed up.
function applyOps(item, r, ops, backup) {
  const blobs = core.readBlobs(r.repo, ops.filter((f) => f.action !== "merge" && f.action !== "remove").map((f) => f.remote));
  let backedUp = false;
  for (const f of ops) {
    const abs = path.join(item.dir, ...f.rel.split("/"));
    const local = r.local.get(f.rel);
    if (local) {
      const copy = path.join(backup, ...f.rel.split("/"));
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.copyFileSync(abs, copy);
      backedUp = true;
    }
    if (f.action === "remove") {
      fs.unlinkSync(abs);
      removeEmptyDirs(path.dirname(abs), item.dir);
      continue;
    }
    let content = f.action === "merge" ? f.content : blobs.get(f.remote);
    if (local?.crlf && f.action !== "merge") content = core.toEol(content, true);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    if (f.mode === "100755" && process.platform !== "win32") fs.chmodSync(abs, 0o755);
  }
  return backedUp;
}

function removeEmptyDirs(dir, stop) {
  while (dir.length > stop.length && dir.startsWith(stop) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

function runAfterUpdate(command, report) {
  const r = spawnSync(command, { shell: true, input: JSON.stringify(report), encoding: "utf8", windowsHide: true });
  return { command, code: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(-2000) };
}

function printUpdate(report) {
  for (const u of report.updated) {
    if (u.checkout) console.log(`⬆️  ${t("update.checkout", { id: u.id, n: u.commits })}`);
    else console.log(`⬆️  ${t(report.dryRun ? "update.dry" : "update.done", { id: u.id, from: short(u.from), to: short(u.to) })}`);
    for (const [k, list] of Object.entries(u.files ?? {})) console.log(`       ${t(`files.${k}`)}: ${clip(list)}`);
  }
  for (const c of report.conflicts) console.log(`⚠️  ${t("update.conflict", { id: c.id, files: c.files ? clip(c.files) : c.error })}`);
  for (const s of report.skipped) console.log(`·  ${t("update.skipped", { id: s.id, reason: t(`status.${s.reason}`) })}`);
  for (const e of report.errors) console.log(`❌ ${e.id}: ${e.error}`);
  if (!report.updated.length && !report.conflicts.length) console.log(t("update.nothing"));
  if (report.conflictDir) console.log(t("update.conflicts-saved", { dir: report.conflictDir }));
  if (report.backupDir) console.log(t("update.backup", { dir: report.backupDir }));
  if (report.dryRun) console.log(t("update.dry-run"));
  if (report.afterUpdate) {
    console.log(t("update.after", { cmd: report.afterUpdate.command, code: report.afterUpdate.code }));
    if (report.afterUpdate.output) console.log(report.afterUpdate.output);
  }
}

function cmdTrack(args, opts, config) {
  const data = gather(opts, config);
  const items = data.flatMap((d) => d.items);
  const results = [];
  if (opts["from-npx"]) {
    for (const item of (args.length ? select(items, args) : items).filter((i) => i.npx)) {
      results.push(trackOne(item, item.npx.url, { ref: item.npx.ref, path: item.npx.path }));
    }
  } else {
    if (!args[0] || (!args[1] && !opts.manual)) {
      throw new CliError("usage", { usage: "skill-update track <id> <url> [--path <folder>] [--ref <ref>] [--commit <sha>]" });
    }
    const [item] = select(items, [args[0]]);
    if (item.kind === "checkout") throw new CliError("not-a-checkout", { id: item.id });
    if (opts.manual) {
      const note = typeof opts.manual === "string" ? opts.manual : args[1];
      item.rootData.lock.skills[item.id] = orderEntry({ type: "manual", note, updatedAt: today() });
      results.push({ id: item.id, manual: true, ...(note && { note }) });
    } else results.push(trackOne(item, args[1], opts));
  }
  for (const d of new Set(items.filter((i) => results.some((r) => r.id === i.id)).map((i) => i.rootData))) writeLock(d.root.lock, d.lock);
  if (opts.json) return print({ tracked: results });
  for (const r of results) {
    if (r.manual) {
      console.log(`✋ ${t("track.manual", { id: r.id })}`);
      continue;
    }
    console.log(`✅ ${t("track.done", { id: r.id, url: r.source, path: r.path || "/", commit: `${short(r.commit)} (${r.commitDate})` })}`);
    console.log(`   ${t("track.match", { same: r.same, differ: r.modified.length, missing: r.missing })}`);
    if (r.modified.length) console.log(`   ${t("track.modified", { files: clip(r.modified) })}`);
    if (r.exclude?.length) console.log(`   ${t("track.excluded", { globs: clip(r.exclude) })}`);
    if (r.extras.length) console.log(`   ${t("track.extras", { files: clip(r.extras) })}`);
    if (r.localOnly.length) console.log(`   ${t("track.local-only", { files: clip(r.localOnly) })}`);
  }
}

function trackOne(item, source, opts) {
  const parsed = core.parseSource(source);
  const repo = core.openRepo(parsed.url, { fetch: !opts.offline });
  let ref = typeof opts.ref === "string" ? opts.ref : undefined;
  let sub = typeof opts.path === "string" ? opts.path : undefined;
  if (parsed.refPath) {
    const split = core.splitRefPath(repo, parsed.refPath);
    ref ??= split.ref;
    sub ??= split.path;
  }
  const head = core.resolveCommit(repo, ref);
  if (!head) throw new CliError("bad-ref", { ref, url: parsed.url });
  if (sub === undefined) {
    const found = core.findSkillPath(repo, head, item.dir);
    if (found.path === undefined) throw new CliError("no-skill-path", { url: parsed.url, list: clip(found.candidates, 10) || "—" });
    sub = found.path;
  }
  sub = sub.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/(^|\/)SKILL\.md$/i, "");

  const local = core.localFiles(item.dir);
  let commit = head;
  if (typeof opts.commit === "string") {
    commit = core.ensureCommit(repo, opts.commit);
    if (!commit) throw new CliError("bad-commit", { commit: opts.commit, url: parsed.url });
  } else {
    commit = core.bestCommit(repo, head, sub, local)?.commit ?? head;
  }
  const tree = core.listTree(repo, commit, sub);
  if (!tree.size) throw new CliError("no-path", { path: sub || "/", commit: short(commit), url: parsed.url });

  const missing = new Set([...tree.keys()].filter((rel) => !local.has(rel)));
  const exclude = core.compressPaths(missing, tree.keys());
  const localOnly = [...local.keys()].filter((rel) => !tree.has(rel));
  const extras = core.findExtras(repo, commit, sub, localOnly);
  const entry = orderEntry({
    source: parsed.url,
    ref: ref && ref !== "HEAD" ? ref : undefined,
    path: sub,
    commit,
    exclude: exclude.length ? exclude : undefined,
    extras: Object.keys(extras).length ? extras : undefined,
    updatedAt: today(),
  });
  const managed = core.managedTree(repo, commit, entry);
  const modified = [...managed].filter(([rel, e]) => local.has(rel) && !local.get(rel).is(e.oid)).map(([rel]) => rel);
  item.rootData.lock.skills[item.id] = entry;
  return {
    id: item.id,
    ...entry,
    commitDate: core.commitDate(repo, commit),
    same: [...managed].filter(([rel, e]) => local.get(rel)?.is(e.oid)).length,
    missing: missing.size,
    modified,
    extras: Object.keys(extras),
    localOnly: localOnly.filter((rel) => !extras[rel]),
  };
}

function cmdUntrack(args, opts, config) {
  if (!args.length) throw new CliError("usage", { usage: "skill-update untrack <id>" });
  const data = gather(opts, config);
  const items = data.flatMap((d) => d.items);
  for (const item of select(items, args)) {
    delete item.rootData.lock.skills[item.id];
    writeLock(item.root.lock, item.rootData.lock);
    if (!opts.json) console.log(t("track.untracked", { id: item.id }));
  }
  if (opts.json) print({ untracked: args });
}

// --- Claude Code plugins ------------------------------------------------------------------

function marketSource(market) {
  const s = market?.source;
  if (s?.source === "github") return { url: `https://github.com/${s.repo}`, ref: s.ref };
  if (s?.source === "git" || s?.source === "url") return /\.json$/i.test(s.url ?? "") ? null : { url: s.url, ref: s.ref };
  return null;
}

function remotePluginVersion(name, market, catalogs, opts) {
  const src = marketSource(market);
  if (!src) return { remote: null };
  const repo = core.openRepo(src.url, { fetch: !opts.offline });
  const head = core.resolveCommit(repo, src.ref);
  if (!catalogs.has(src.url)) catalogs.set(src.url, JSON.parse(core.showFile(repo, head, ".claude-plugin/marketplace.json") ?? "{}"));
  const catalog = catalogs.get(src.url);
  const plugin = (catalog.plugins ?? []).find((p) => p.name === name);
  if (!plugin) return { remote: null };
  if (plugin.version) return { remote: plugin.version };
  const readVersion = (r, commit, dir) => {
    const json = core.showFile(r, commit, `${dir ? `${dir}/` : ""}.claude-plugin/plugin.json`);
    return json ? (JSON.parse(json).version ?? null) : null;
  };
  if (typeof plugin.source === "string") {
    let dir = plugin.source.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!plugin.source.startsWith("./") && catalog.metadata?.pluginRoot) dir = `${catalog.metadata.pluginRoot.replace(/^\.\//, "").replace(/\/+$/, "")}/${dir}`;
    return { remote: readVersion(repo, head, dir) };
  }
  const ps = plugin.source ?? {};
  const url = ps.source === "github" ? `https://github.com/${ps.repo}` : ps.url;
  if (!url) return { remote: null };
  const other = core.openRepo(url, { fetch: !opts.offline });
  return { remote: readVersion(other, core.resolveCommit(other, ps.ref ?? ps.sha), ps.path ?? "") };
}

function cmdPlugins(args, opts) {
  const dir = path.join(core.claudeDir(), "plugins");
  const installed = readJson(path.join(dir, "installed_plugins.json"), { plugins: {} });
  const markets = readJson(path.join(dir, "known_marketplaces.json"), {});
  const catalogs = new Map();
  const plugins = [];
  for (const [id, list] of Object.entries(installed.plugins ?? {})) {
    const inst = list?.[0];
    if (!inst) continue;
    const market = id.slice(id.lastIndexOf("@") + 1);
    const name = id.slice(0, id.lastIndexOf("@"));
    const res = { id, scope: inst.scope, local: inst.version ?? null, remote: null, status: "unknown" };
    try {
      res.remote = remotePluginVersion(name, markets[market], catalogs, opts).remote;
      const newer = core.newerVersion(res.local, res.remote);
      res.status = newer === true ? "update-available" : newer === false || (res.remote && res.remote === res.local) ? "up-to-date" : "unknown";
      if (newer === true) res.command = `claude plugin marketplace update ${market} && claude plugin update ${id}${inst.scope && inst.scope !== "user" ? ` --scope ${inst.scope}` : ""}`;
    } catch (e) {
      Object.assign(res, { status: "error", error: e.message });
    }
    plugins.push(res);
  }
  if (opts.json) return print({ plugins });
  console.log(`🧩 ${t("plugins.title")}`);
  if (!plugins.length) return console.log(t("plugins.none"));
  for (const status of ["update-available", "error", "unknown", "up-to-date"]) {
    const list = plugins.filter((p) => p.status === status);
    if (!list.length) continue;
    console.log(`\n${ICON[status] ?? "❔"} ${t(`status.${status === "unknown" ? "untracked" : status}`)} (${list.length})`);
    for (const p of list) {
      console.log(`   • ${t("plugins.update", { id: p.id, local: p.local ?? "?", remote: p.remote ?? "?" })}${p.error ? `  ${p.error}` : ""}`);
      if (p.command) console.log(`     ${t("plugins.hint", { cmd: p.command })}`);
    }
  }
}

// --- Main ---------------------------------------------------------------------------------------

function help() {
  const text = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n");
  const end = text.findIndex((l, i) => i > 1 && !l.startsWith("//"));
  console.log(text.slice(1, end).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}

function main() {
  const { command, args, opts } = parseArgs(process.argv.slice(2));
  let config = null;
  try {
    config = readJson(CONFIG_FILE, null);
  } catch (e) {
    console.error(`❌ ${CONFIG_FILE}: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  setLang(detectLang(typeof opts.lang === "string" ? opts.lang : undefined, config?.lang));
  if (!command || command === "help" || opts.help) return help();
  if (spawnSync("git", ["--version"]).error) {
    console.error(`❌ ${t("err.git")}`);
    process.exitCode = 2;
    return;
  }
  if (!opts.json) core.hooks.fetch = (url) => process.stderr.write(`· ${url}\n`);
  const commands = { config: cmdConfig, scan: cmdScan, check: cmdCheck, update: cmdUpdate, track: cmdTrack, untrack: cmdUntrack, plugins: cmdPlugins };
  try {
    if (!commands[command]) throw new CliError("usage", { usage: "skill-update <config|scan|check|update|track|untrack|plugins> (--help)" });
    commands[command](args, opts, config);
  } catch (e) {
    if (opts.json) print({ error: e.code ?? "error", message: e.message, ...(e.code === "not-configured" && { defaultRoot: slash(DEFAULT_ROOT) }) });
    else console.error(`❌ ${e.message}`);
    process.exitCode = 2;
  }
}

main();
