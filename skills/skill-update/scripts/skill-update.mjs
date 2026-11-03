#!/usr/bin/env node
// skill-update — keep skills copied from git repositories up to date.
//
//   skill-update config [--root default|claude|agents|codex|<folder>] [--lock <file>]
//                       [--log-dir <folder>] [--after-update <command>]
//                       [--remove-root <folder>] [--ignore <a,b>] [--lang en|fr]
//   skill-update scan                     skills found and how each is tracked (no network)
//   skill-update check [<id>…]            what changed upstream and what you changed
//   skill-update update <id>… | --all     apply, with backups [--dry-run] [--ours | --theirs]
//   skill-update track <id> <url>         record where a skill comes from
//                       [--path <folder in repo>] [--ref <branch|tag>] [--commit <sha>]
//   skill-update track <id> --manual [<note>]   never updated by this tool
//   skill-update track --from-npx [<id>…]       adopt what `npx skills` recorded
//   skill-update untrack <id>
//   skill-update diff <id>…               the exact text an update would change [--file <path>] [--stat]
//   skill-update revert <id>…             put back the version before the last update [--dry-run]
//   skill-update pin <id>… [--note <why>] keep a skill at its version; unpin <id>… lets it update
//   skill-update add <url>                copy a new skill from a repository and track it
//                       [--to <folder>] [--name <name>] [--path <folder in repo>] [--ref <ref>] [--dry-run]
//   skill-update remind [--every <days>] [--hook]   one line when updates wait, from the last check
//   skill-update plugins                  Claude Code plugins behind their marketplace
//
// Folder names: default and claude = ~/.claude/skills (Claude Code), agents =
// ~/.agents/skills (Codex and other agents), codex = $CODEX_HOME/skills (~/.codex/skills).
// Each update that changes something is listed in <log folder>/<date>.md.
//
// Common options: --root <folder> (that folder only), --json, --lang en|fr,
// --offline (no fetch), --verbose, --exit-code (check: exit 1 when updates exist).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "./core.mjs";
import { detectLang, setLang, t } from "./i18n.mjs";
import { assessRisks } from "./risks.mjs";

const CONFIG_FILE = path.join(core.HOME, "config.json");
// Where each agent loads personal skills from.
const ROOT_NAMES = {
  default: path.join(core.claudeDir(), "skills"),
  claude: path.join(core.claudeDir(), "skills"),
  agents: path.join(core.agentsDir(), "skills"),
  codex: path.join(core.codexDir(), "skills"),
};
const DEFAULT_ROOT = ROOT_NAMES.default;
const DEFAULT_IGNORE = ["synced"]; // ~/.claude/skills/synced is managed by claude.ai
const DEFAULT_LOG_DIR = path.join(core.HOME, "logs");
const BACKUPS = path.join(core.HOME, "backups");
const LAST_CHECK = path.join(core.HOME, "last-check.json");
const REMIND_STATE = path.join(core.HOME, "remind.json");
const SCRIPT = fileURLToPath(import.meta.url);
const LOCK_NAME = ".skill-update-lock.json";
const VALUE_OPTIONS = new Set([
  "root", "lock", "after-update", "log-dir", "path", "ref", "commit", "lang", "ignore", "remove-root", "file", "to", "name", "every", "note",
]);
const ENTRY_FIELDS = ["type", "note", "source", "ref", "path", "commit", "pinned", "include", "exclude", "extras", "updatedAt"];
const STATUS_ORDER = [
  "update-available", "merge-available", "conflict", "pinned", "source-missing", "modified", "untracked", "missing", "error", "manual", "linked", "up-to-date",
];
const ICON = {
  "update-available": "⬆️ ", "merge-available": "🔀", conflict: "⚠️ ", pinned: "📌", "source-missing": "❓", modified: "✏️ ",
  untracked: "➕", missing: "🕳️ ", error: "❌", manual: "✋", linked: "🔗", "up-to-date": "✅",
};
const PENDING = ["update-available", "merge-available", "conflict"];
const APPLY = new Set(["update", "add", "remove", "merge"]);

const slash = core.slash;
const today = () => new Date().toLocaleDateString("sv-SE");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const short = (sha) => (sha ? sha.slice(0, 8) : "—");
const resolvePath = (p) => path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir()));
const rootPath = (name) => ROOT_NAMES[name] ?? resolvePath(name);
const knownRoots = () => Object.entries(ROOT_NAMES).filter(([n]) => n !== "default").map(([name, p]) => ({ name, path: slash(p), exists: fs.existsSync(p) }));
const samePath = (a, b) =>
  process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const clip = (list, n = 8) => (list.length > n ? `${list.slice(0, n).join(", ")} … (+${list.length - n})` : list.join(", "));
// Where a skill's files go inside a backup or conflict folder of one run.
const where = (rootDir, id, dir) => path.join(dir, path.basename(rootDir), ...id.split("/"));

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
    const p = rootPath(opts.root);
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
  // A pinned skill keeps its version: what upstream offers is only reported.
  const pending = entry.pinned && PENDING.includes(status) ? status : undefined;
  return {
    status: pending ? "pinned" : status,
    pending,
    pinned: entry.pinned,
    ...info,
    behind: moved ? core.commitCount(repo, base, head, paths) : undefined,
    log: moved ? core.commitLog(repo, base, head, paths) : undefined,
    risks: pending ? undefined : risksOf(repo, files),
    files,
    repo,
    local,
    base,
  };
}

// Risks of the files an update would write, compared with their installed version.
function risksOf(repo, files) {
  const changed = files.filter((f) => f.remote && ["update", "add", "merge", "conflict"].includes(f.action));
  if (!changed.length) return undefined;
  const blobs = core.readBlobs(repo, changed.flatMap((f) => [f.remote, f.base]));
  const risks = assessRisks(changed.map((f) => ({ rel: f.rel, before: f.base ? blobs.get(f.base) : null, after: blobs.get(f.remote), mode: f.mode })));
  return risks.length ? risks : undefined;
}

function evaluateCheckout(item, opts) {
  if (!checkouts.has(item.checkout)) checkouts.set(item.checkout, core.checkoutStatus(item.checkout, { fetch: !opts.offline }));
  const s = checkouts.get(item.checkout);
  if (s.error) return { status: "error", error: s.error, checkout: slash(item.checkout) };
  const status =
    s.ahead > 0 && s.behind > 0 ? "conflict" : s.behind > 0 ? (s.dirty ? "merge-available" : "update-available") : s.dirty ? "modified" : "up-to-date";
  return { status, checkout: slash(item.checkout), commit: s.head, head: s.upstream, behind: s.behind || undefined, ahead: s.ahead || undefined, log: s.log };
}

const GROUP_ORDER = ["update", "merge", "add", "remove", "conflict", "modified", "local-only"];

function groupFiles(files) {
  const group = {};
  const as = { "modified-locally": "modified", "deleted-locally": "modified", "kept-modified": "modified" };
  for (const f of files) {
    if (f.action === "same") continue;
    const k = as[f.action] ?? f.action;
    (group[k] ??= []).push(f.rel);
  }
  return Object.fromEntries(GROUP_ORDER.filter((k) => group[k]).map((k) => [k, group[k]]));
}

function publicResult(item, r) {
  const out = { id: item.id, kind: item.kind, status: r.status };
  for (const k of ["source", "path", "checkout", "target", "note", "error", "npx", "pinned", "pending", "commit", "head", "behind", "ahead", "log", "risks"]) {
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
    pinned: count("pinned"),
    risky: skills.filter((x) => x.risks?.some((r) => r.level === "high")).length,
    errors: count("error"),
  };
}

// --- Commands -------------------------------------------------------------------------------

function cmdConfig(args, opts) {
  let config = readJson(CONFIG_FILE, null);
  const changing = ["root", "remove-root", "after-update", "log-dir", "lang", "ignore"].some((k) => opts[k] !== undefined);
  if (changing) {
    config ??= {};
    config.roots ??= [];
    if (opts.root && opts.root !== true) {
      const p = rootPath(opts.root);
      let root = config.roots.find((r) => samePath(resolvePath(r.path), p));
      if (!root) config.roots.push((root = { path: slash(p) }));
      if (opts.lock && opts.lock !== true) root.lock = slash(resolvePath(opts.lock));
    }
    if (opts["remove-root"]) config.roots = config.roots.filter((r) => !samePath(resolvePath(r.path), resolvePath(opts["remove-root"])));
    if (opts["after-update"] !== undefined) {
      if (opts["after-update"] === true || opts["after-update"] === "") delete config.afterUpdate;
      else config.afterUpdate = opts["after-update"];
    }
    if (opts["log-dir"] !== undefined) {
      if (opts["log-dir"] === true || opts["log-dir"] === "") delete config.logDir;
      else config.logDir = slash(resolvePath(opts["log-dir"]));
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
    knownRoots: knownRoots(),
    roots,
    ignore: config?.ignore ?? DEFAULT_IGNORE,
    logDir: slash(logDir(config)),
    ...(config?.afterUpdate && { afterUpdate: config.afterUpdate }),
    ...(config?.lang && { lang: config.lang }),
  };
  if (opts.json) return print(out);
  console.log(t("config.file", { file: out.file }));
  if (!roots.length) console.log(t("config.none"));
  for (const r of roots) console.log(`${r.exists ? "📁" : "⚠️ "} ${t("config.root", { root: r.path, lock: r.lock })}`);
  console.log(t("config.log-dir", { dir: out.logDir }));
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
  const all = roots.flatMap((r) => r.skills);
  const summary = summarize(all);
  if (opts["exit-code"] && summary.updates) process.exitCode = 1;
  // A full, online check is what `remind` reports from.
  if (!args.length && !opts.offline && !(opts.root && opts.root !== true)) {
    writeJson(LAST_CHECK, {
      date: new Date().toISOString(),
      summary,
      updates: all.filter((s) => s.status === "update-available" || s.status === "merge-available").map((s) => s.id),
      risky: all.filter((s) => s.risks?.some((r) => r.level === "high")).map((s) => s.id),
    });
  }
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
  if (summary.risky) console.log(`🛡️  ${t("check.risky", { n: summary.risky })}`);
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
  if (s.pending) line += `  (${t(`status.${s.pending}`)})`;
  console.log(line);
  for (const [k, list] of Object.entries(s.files ?? {})) if (k !== "local-only" || opts.verbose) console.log(`       ${t(`files.${k}`)}: ${clip(list)}`);
  printRisks(s.risks, "       ");
  for (const l of (s.log ?? []).slice(0, opts.verbose ? 15 : 5)) console.log(`       ${l}`);
}

const riskLine = (r, code = (s) => s) => t("log.item", { label: t(`risk.${r.reason}`), list: `${code(r.rel)}${r.detail ? ` — ${code(r.detail)}` : ""}` });

function printRisks(risks, indent) {
  for (const r of risks ?? []) console.log(`${indent}🛡️  ${r.level === "high" ? "‼ " : ""}${riskLine(r)}`);
}

function cmdUpdate(args, opts, config) {
  if (!args.length && !opts.all) throw new CliError("nothing-selected");
  const data = gather(opts, config);
  let selected = select(data.flatMap((d) => d.items), args);
  if (!args.length) selected = selected.filter((i) => i.kind === "tracked" || i.kind === "checkout");
  const dryRun = !!opts["dry-run"];
  const time = stamp();
  const report = { action: "update", date: today(), dryRun, updated: [], conflicts: [], skipped: [], errors: [] };
  const changedLocks = new Set();
  const doneCheckouts = new Set();
  const backups = path.join(BACKUPS, time);
  const conflictDir = path.join(core.HOME, "conflicts", time);

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
      const result = { ...id, checkout: r.checkout, from: r.commit, to: r.head, commits: r.behind, ...(r.log?.length && { log: r.log }) };
      const error = dryRun ? null : core.fastForward(item.checkout);
      if (error) report.conflicts.push({ ...result, error });
      else report.updated.push(result);
      continue;
    }
    if (item.kind !== "tracked" || r.status === "source-missing" || r.status === "pinned") {
      skip(r.status);
      continue;
    }

    const conflicts = r.files.filter((f) => f.action === "conflict");
    if (conflicts.length && !opts.ours && !opts.theirs) {
      const saved = where(item.root.path, item.id, conflictDir);
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
      ...(r.log?.length && { log: r.log }),
      ...(r.risks && { risks: r.risks }),
    };
    if (!dryRun) {
      const backup = where(item.root.path, item.id, backups);
      if (applyOps(item, r, ops, backup)) result.backup = slash(backup);
      // What `revert` needs to undo this update.
      writeJson(`${backup}.json`, {
        id: item.id,
        root: slash(item.root.path),
        from: result.from,
        fromDate: r.base ? core.commitDate(r.repo, r.base) : null,
        to: r.head,
        files: result.files,
        entryBefore: item.entry,
        date: report.date,
      });
      item.rootData.lock.skills[item.id] = orderEntry({ ...item.entry, commit: r.head, updatedAt: report.date });
      changedLocks.add(item.rootData);
    }
    report.updated.push(result);
  }

  for (const d of changedLocks) writeLock(d.root.lock, d.lock);
  if (report.updated.some((u) => u.backup)) report.backupDir = slash(backups);
  if (report.conflicts.some((c) => c.saved)) report.conflictDir = slash(conflictDir);
  finish(report, config, opts);
}

// Log, after-update command and output, shared by update, revert and add.
function finish(report, config, opts) {
  if (!report.dryRun && (report.updated.length || report.conflicts.length)) report.logFile = slash(writeUpdateLog(report, config));
  if (report.logFile && config?.afterUpdate && !opts["no-after-update"]) report.afterUpdate = runAfterUpdate(config.afterUpdate, report);
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

const logDir = (config) => (config?.logDir ? resolvePath(config.logDir) : DEFAULT_LOG_DIR);

function sourceCell(u) {
  if (u.checkout) return `\`${u.checkout}\``;
  const gh = u.source?.match(/^https:\/\/(?:github|gitlab)\.com\/(.+)$/);
  const where = gh ? `[${gh[1]}](${u.source})` : `\`${u.source}\``;
  return u.path ? `${where} · \`${u.path}\`` : where;
}

// The trace of an update: <log folder>/<date>.md, one section per run of the
// day, with a table of the skills updated and the details below it.
function writeUpdateLog(report, config) {
  const file = path.join(logDir(config), `${report.date}.md`);
  const time = new Date().toLocaleTimeString("sv-SE").slice(0, 5);
  const code = (list) => list.map((f) => `\`${f}\``).join(", ");
  const filesCell = (u) =>
    u.checkout ? t("check.commits", { n: u.commits }) : Object.entries(u.files).map(([k, list]) => t("log.item", { label: t(`files.${k}`), list: list.length })).join(", ");
  const lines = [`## ${t(`log.run.${report.action}`, { time, n: report.updated.length })}`, ""];
  if (report.updated.length) {
    lines.push(`| ${["skill", "source", "from", "to", "date", "files"].map((k) => t(`log.col.${k}`)).join(" | ")} |`, `|${" --- |".repeat(6)}`);
    for (const u of report.updated) {
      lines.push(`| \`${u.id}\` | ${sourceCell(u)} | \`${short(u.from)}\` | \`${short(u.to)}\` | ${u.toDate ?? ""} | ${filesCell(u)} |`);
    }
    for (const u of report.updated) {
      lines.push("", `### \`${u.id}\``, "");
      for (const [k, list] of Object.entries(u.files ?? {})) lines.push(`- ${t("log.item", { label: t(`files.${k}`), list: code(list) })}`);
      if (u.resolved) lines.push(`- ${t("log.resolved", { files: code(u.conflicts), how: `--${u.resolved}` })}`);
      for (const r of u.risks ?? []) lines.push(`- 🛡️ ${r.level === "high" ? "**" : ""}${riskLine(r, (s) => `\`\` ${s} \`\``)}${r.level === "high" ? "**" : ""}`);
      if (u.log?.length) lines.push(`- ${t("log.item", { label: t("log.commits"), list: "" }).trim()}`, ...u.log.map((l) => `  - ${l}`));
    }
  }
  if (report.conflicts.length) {
    lines.push("", `### ${t("log.conflicts")}`, "");
    for (const c of report.conflicts) {
      lines.push(`- ${t("log.item", { label: `\`${c.id}\``, list: `${c.files ? code(c.files) : c.error}${c.saved ? ` (\`${c.saved}\`)` : ""}` })}`);
    }
  }
  if (report.errors.length) {
    lines.push("", `### ${t("status.error")}`, "");
    for (const e of report.errors) lines.push(`- ${t("log.item", { label: `\`${e.id}\``, list: e.error })}`);
  }
  if (report.backupDir) lines.push("", t("update.backup", { dir: `\`${report.backupDir}\`` }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.appendFileSync(file, `\n${lines.join("\n")}\n`);
  else fs.writeFileSync(file, `# ${t("log.title", { date: report.date })}\n\n${lines.join("\n")}\n`);
  return file;
}

function runAfterUpdate(command, report) {
  const r = spawnSync(command, { shell: true, input: JSON.stringify(report), encoding: "utf8", windowsHide: true });
  return { command, code: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(-2000) };
}

function printUpdate(report) {
  const done = { update: "update.done", revert: "update.reverted", add: "update.added" }[report.action];
  for (const u of report.updated) {
    const vars = { id: u.id, from: short(u.from), to: short(u.to), url: u.source, commit: short(u.to) };
    if (u.checkout) console.log(`⬆️  ${t("update.checkout", { id: u.id, n: u.commits })}`);
    else console.log(`⬆️  ${t(report.dryRun ? `${done}.dry` : done, vars)}`);
    for (const [k, list] of Object.entries(u.files ?? {})) console.log(`       ${t(`files.${k}`)}: ${clip(list)}`);
    printRisks(u.risks, "       ");
  }
  for (const c of report.conflicts) console.log(`⚠️  ${t("update.conflict", { id: c.id, files: c.files ? clip(c.files) : c.error })}`);
  for (const s of report.skipped) console.log(`·  ${t("update.skipped", { id: s.id, reason: t(`status.${s.reason}`) })}`);
  for (const e of report.errors) console.log(`❌ ${e.id}: ${e.error}`);
  if (!report.updated.length && !report.conflicts.length) console.log(t("update.nothing"));
  if (report.conflictDir) console.log(t("update.conflicts-saved", { dir: report.conflictDir }));
  if (report.backupDir) console.log(t("update.backup", { dir: report.backupDir }));
  if (report.logFile) console.log(t("log.written", { file: report.logFile }));
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

// --- Revert, diff, pin, add, remind ---------------------------------------------------------

// Backups of a skill, newest first, each with the manifest its update wrote.
function manifests(item) {
  if (!fs.existsSync(BACKUPS)) return [];
  return fs
    .readdirSync(BACKUPS)
    .sort()
    .reverse()
    .map((run) => `${where(item.root.path, item.id, path.join(BACKUPS, run))}.json`)
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ ...readJson(file, {}), file, dir: file.slice(0, -".json".length) }))
    .filter((m) => m.root && samePath(m.root, item.root.path));
}

const copyFile = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

// Puts back the files of the last update not yet reverted. The current files
// go to a new backup first; files the update added are moved there.
function cmdRevert(args, opts, config) {
  if (!args.length) throw new CliError("usage", { usage: "skill-update revert <id>… [--dry-run]" });
  const data = gather(opts, config);
  const dryRun = !!opts["dry-run"];
  const backups = path.join(BACKUPS, stamp());
  const report = { action: "revert", date: today(), dryRun, updated: [], conflicts: [], skipped: [], errors: [] };
  const changedLocks = new Set();
  for (const item of select(data.flatMap((d) => d.items), args)) {
    const m = manifests(item).find((x) => !x.revertedAt);
    if (!m) {
      report.skipped.push({ id: item.id, root: slash(item.root.path), reason: "no-backup" });
      continue;
    }
    const restore = [...(m.files.update ?? []), ...(m.files.merge ?? []), ...(m.files.remove ?? [])];
    const added = m.files.add ?? [];
    const result = {
      id: item.id,
      root: slash(item.root.path),
      source: m.entryBefore?.source ?? item.entry?.source,
      path: m.entryBefore?.path ?? item.entry?.path,
      from: m.to,
      to: m.from,
      toDate: m.fromDate,
      files: Object.fromEntries(
        [["update", [...(m.files.update ?? []), ...(m.files.merge ?? [])]], ["add", m.files.remove ?? []], ["remove", added]].filter(([, l]) => l.length),
      ),
    };
    if (!dryRun) {
      const save = where(item.root.path, item.id, backups);
      for (const rel of [...restore, ...added]) {
        const abs = path.join(item.dir, ...rel.split("/"));
        if (fs.existsSync(abs)) copyFile(abs, path.join(save, ...rel.split("/")));
      }
      for (const rel of restore) copyFile(path.join(m.dir, ...rel.split("/")), path.join(item.dir, ...rel.split("/")));
      for (const rel of added) {
        const abs = path.join(item.dir, ...rel.split("/"));
        if (!fs.existsSync(abs)) continue;
        fs.unlinkSync(abs);
        removeEmptyDirs(path.dirname(abs), path.dirname(item.dir));
      }
      if (fs.existsSync(save)) result.backup = slash(save);
      if (m.entryBefore) item.rootData.lock.skills[item.id] = orderEntry(m.entryBefore);
      else delete item.rootData.lock.skills[item.id]; // the skill was added by `add`: it is gone now
      changedLocks.add(item.rootData);
      writeJson(m.file, { ...readJson(m.file, {}), revertedAt: new Date().toISOString() });
    }
    report.updated.push(result);
  }
  for (const d of changedLocks) writeLock(d.root.lock, d.lock);
  if (report.updated.some((u) => u.backup)) report.backupDir = slash(backups);
  finish(report, config, opts);
}

// The exact text an update would change: current file against what it would become.
function cmdDiff(args, opts, config) {
  const data = gather(opts, config);
  const items = select(data.flatMap((d) => d.items), args).filter((i) => i.kind === "tracked");
  const results = [];
  for (const item of items) {
    const r = evaluateTracked(item, opts);
    const ops = (r.files ?? []).filter((f) => APPLY.has(f.action) || f.action === "conflict");
    const wanted = typeof opts.file === "string" ? ops.filter((f) => f.rel === opts.file.replace(/\\/g, "/")) : ops;
    if (!wanted.length) {
      if (args.length) results.push({ id: item.id, diff: "" });
      continue;
    }
    const blobs = core.readBlobs(r.repo, wanted.map((f) => f.remote));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-update-diff-"));
    const put = (side, rel, buf) => {
      const file = path.join(tmp, side, ...rel.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, core.toEol(buf, false));
    };
    try {
      for (const f of wanted) {
        const local = r.local.get(f.rel);
        if (local) put("a", f.rel, local.buf);
        const after = f.action === "merge" ? f.content : f.action === "conflict" ? f.preview : f.action === "remove" ? null : blobs.get(f.remote);
        if (after) put("b", f.rel, after);
      }
      for (const side of ["a", "b"]) fs.mkdirSync(path.join(tmp, side), { recursive: true });
      const out = core.git(["diff", "--no-index", "--no-color", "--src-prefix=", "--dst-prefix=", ...(opts.stat ? ["--stat"] : []), "a", "b"], {
        cwd: tmp,
        allowFail: true,
      });
      results.push({ id: item.id, diff: String(out.stdout) });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (opts.json) return print({ diffs: results });
  for (const r of results) console.log(r.diff ? `━━ ${r.id}\n${r.diff}` : t("diff.none", { id: r.id }));
}

function cmdPin(args, opts, config, pin) {
  if (!args.length) throw new CliError("usage", { usage: `skill-update ${pin ? "pin" : "unpin"} <id>… ${pin ? "[--note <why>]" : ""}` });
  const data = gather(opts, config);
  const done = [];
  for (const item of select(data.flatMap((d) => d.items), args)) {
    if (item.kind !== "tracked") throw new CliError("not-tracked", { id: item.id });
    const entry = { ...item.entry };
    if (pin) entry.pinned = typeof opts.note === "string" && opts.note ? opts.note : true;
    else delete entry.pinned;
    item.rootData.lock.skills[item.id] = orderEntry(entry);
    writeLock(item.root.lock, item.rootData.lock);
    done.push({ id: item.id, pinned: entry.pinned ?? false });
  }
  if (opts.json) return print({ pinned: done });
  for (const d of done) console.log(`📌 ${t(pin ? "pin.done" : "pin.undone", { id: d.id })}`);
}

// Copies a skill from a repository into the skills folder, with the licence
// files found beside it or above it, and tracks it at the commit copied.
function cmdAdd(args, opts, config) {
  if (!args[0]) throw new CliError("usage", { usage: "skill-update add <url> [--to <folder>] [--name <name>] [--path <folder in repo>] [--ref <ref>] [--dry-run]" });
  const roots = gather(opts, config);
  if (roots.length > 1) throw new CliError("choose-root", { list: roots.map((d) => slash(d.root.path)).join(", ") });
  const [{ root, lock }] = roots;
  const parsed = core.parseSource(args[0]);
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
    const candidates = core.skillPaths(repo, head);
    if (candidates.length !== 1) throw new CliError("no-skill-path", { url: parsed.url, list: clip(candidates, 15) || "—" });
    sub = candidates[0];
  }
  sub = sub.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/(^|\/)SKILL\.md$/i, "");
  const tree = core.listTree(repo, head, sub);
  if (!tree.has("SKILL.md")) throw new CliError("no-skill", { path: sub || "/", url: parsed.url });

  const name = typeof opts.name === "string" ? opts.name : sub.split("/").pop() || parsed.url.replace(/\.git$/, "").split(/[/\\]/).pop();
  const id = [typeof opts.to === "string" ? opts.to : "", name].join("/").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  const dir = path.join(root.path, ...id.split("/"));
  if (fs.existsSync(dir)) throw new CliError("exists", { dir: slash(dir) });

  const extras = Object.fromEntries(Object.entries(core.licenseFiles(repo, head, sub)).filter(([rel]) => !tree.has(rel)));
  const files = new Map(tree);
  for (const [rel, up] of Object.entries(extras)) files.set(rel, core.listPaths(repo, head, [up]).get(up));
  const blobs = core.readBlobs(repo, [...files.values()].map((e) => e.oid));
  const risks = assessRisks([...files].map(([rel, e]) => ({ rel, before: null, after: blobs.get(e.oid), mode: e.mode })));
  const dryRun = !!opts["dry-run"];
  const result = {
    id,
    root: slash(root.path),
    source: parsed.url,
    path: sub,
    from: null,
    to: head,
    toDate: core.commitDate(repo, head),
    files: { add: [...files.keys()].sort() },
    added: true,
    ...(risks.length && { risks }),
  };
  if (!dryRun) {
    for (const [rel, e] of files) {
      const abs = path.join(dir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, blobs.get(e.oid));
      if (e.mode === "100755" && process.platform !== "win32") fs.chmodSync(abs, 0o755);
    }
    const entry = orderEntry({
      source: parsed.url,
      ref: ref && ref !== "HEAD" ? ref : undefined,
      path: sub,
      commit: head,
      extras: Object.keys(extras).length ? extras : undefined,
      updatedAt: today(),
    });
    lock.skills[id] = entry;
    writeLock(root.lock, lock);
    // `revert` on a skill added here takes it out again (into a backup).
    writeJson(`${where(root.path, id, path.join(BACKUPS, stamp()))}.json`, {
      id, root: slash(root.path), from: null, fromDate: null, to: head, files: result.files, entryBefore: null, date: today(),
    });
  }
  finish({ action: "add", date: today(), dryRun, updated: [result], conflicts: [], skipped: [], errors: [] }, config, opts);
}

// One line when updates wait, read from the last full check: fast enough for a
// session-start hook. When that check is older than --every days (7), a new
// one starts in the background, for the next time. Never changes a skill.
function cmdRemind(args, opts, config) {
  const every = Number(typeof opts.every === "string" ? opts.every : config?.remindEvery ?? 7);
  let last = null;
  try {
    last = readJson(LAST_CHECK, null);
  } catch {}
  const age = last?.date ? (Date.now() - Date.parse(last.date)) / 86400000 : Infinity;
  let refreshing = false;
  if (age >= every && config?.roots?.length && !opts["no-refresh"]) {
    let state = {};
    try {
      state = readJson(REMIND_STATE, {});
    } catch {}
    // One background check at a time: another session may have started one.
    if (!state.startedAt || Date.now() - Date.parse(state.startedAt) > 3600000) {
      writeJson(REMIND_STATE, { startedAt: new Date().toISOString() });
      spawn(process.execPath, [SCRIPT, "check", "--json"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      refreshing = true;
    }
  }
  const ids = last?.updates ?? [];
  const date = last?.date?.slice(0, 10);
  if (opts.json && !opts.hook) return print({ updates: ids.length, ids, risky: last?.risky ?? [], checked: date ?? null, refreshing });
  if (!ids.length) return;
  const message = t("remind.message", { n: ids.length, date });
  if (!opts.hook) return console.log(message);
  const context = t("remind.context", { n: ids.length, date, list: clip(ids, 30), risky: clip(last?.risky ?? [], 30) || "—" });
  console.log(JSON.stringify({ systemMessage: message, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
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
  // remind runs in a session-start hook: it stays silent rather than fail.
  if (command === "remind") {
    try {
      cmdRemind(args, opts, config);
    } catch {}
    return;
  }
  if (spawnSync("git", ["--version"]).error) {
    console.error(`❌ ${t("err.git")}`);
    process.exitCode = 2;
    return;
  }
  if (!opts.json) core.hooks.fetch = (url) => process.stderr.write(`· ${url}\n`);
  const commands = {
    config: cmdConfig, scan: cmdScan, check: cmdCheck, update: cmdUpdate, track: cmdTrack, untrack: cmdUntrack, diff: cmdDiff, revert: cmdRevert,
    pin: (a, o, c) => cmdPin(a, o, c, true), unpin: (a, o, c) => cmdPin(a, o, c, false), add: cmdAdd, remind: cmdRemind, plugins: cmdPlugins,
  };
  try {
    if (!commands[command]) throw new CliError("usage", { usage: `skill-update <${Object.keys(commands).join("|")}> (--help)` });
    commands[command](args, opts, config);
  } catch (e) {
    if (opts.json) print({ error: e.code ?? "error", message: e.message, ...(e.code === "not-configured" && { defaultRoot: slash(DEFAULT_ROOT), knownRoots: knownRoots() }) });
    else console.error(`❌ ${e.message}`);
    process.exitCode = 2;
  }
}

main();
