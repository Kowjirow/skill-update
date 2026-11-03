// Core of skill-update: git plumbing, file fingerprints and the three-way plan.
// No dependency besides Node (>= 18) and the git command line.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

// Config, cache, backups. Outside the skill folder, which an update replaces.
export const HOME = process.env.SKILL_UPDATE_HOME || path.join(claudeDir(), "skill-update");

export class GitError extends Error {}

export function git(args, { cwd, input, buffer = false, allowFail = false } = {}) {
  const r = spawnSync("git", args, {
    cwd,
    input,
    encoding: buffer ? "buffer" : "utf8",
    maxBuffer: 1 << 30,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" },
  });
  if (r.error) throw new GitError(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    const msg = String(r.stderr).trim().split("\n").filter(Boolean).pop() || `exit ${r.status}`;
    throw new GitError(`git ${args[0]}: ${msg}`);
  }
  return r;
}

export const gitOut = (args, opts) => String(git(args, opts).stdout).trim();

export const slash = (p) => p.split(path.sep).join("/");

// --- Sources ---------------------------------------------------------------

const WEB_URL = /^https?:\/\/(?:www\.)?(github\.com|gitlab\.com)\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:-\/)?(?:tree|blob)\/(.+?))?\/?$/i;

// Turns what a user pastes (owner/repo, a GitHub page URL, a git URL, a local
// folder) into a git URL, plus the "<ref>/<path>" tail of a tree or blob URL.
export function parseSource(input) {
  if (fs.existsSync(input)) return { url: slash(path.resolve(input)) };
  const web = input.match(WEB_URL);
  if (web) return { url: `https://${web[1].toLowerCase()}/${web[2]}/${web[3]}`, refPath: web[4] && decodeURIComponent(web[4]) };
  if (/^[\w.-]+\/[\w.-]+$/.test(input)) return { url: `https://github.com/${input.replace(/\.git$/, "")}` };
  return { url: input };
}

export function cacheDir(url) {
  const m =
    url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i) ||
    url.match(/^[^@/\\]+@([^:/]+):(.+?)(?:\.git)?$/);
  const parts = m ? [m[1], ...m[2].split("/")] : ["local", sha1(url).slice(0, 12)];
  return path.join(HOME, "cache", ...parts.map((p) => p.replace(/[^\w.-]/g, "_")));
}

// --- Cached repositories -----------------------------------------------------
// One bare, blobless clone per source: commits and trees are local, file
// contents are fetched only when an update needs them.

const repos = new Map();
export const hooks = { fetch: null };

export function openRepo(url, { fetch = true } = {}) {
  if (repos.has(url)) return repos.get(url);
  const dir = cacheDir(url);
  const cloned = fs.existsSync(path.join(dir, "HEAD"));
  if (!cloned || fetch) hooks.fetch?.(url);
  if (!cloned) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(["clone", "--quiet", "--bare", "--filter=blob:none", url, dir]);
  } else if (fetch) {
    git(["fetch", "--quiet", "--prune", "--force", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], { cwd: dir });
    const head = gitOut(["ls-remote", "--symref", "origin", "HEAD"], { cwd: dir, allowFail: true }).match(/^ref: (refs\/heads\/\S+)\s+HEAD/m);
    if (head) git(["symbolic-ref", "HEAD", head[1]], { cwd: dir });
  }
  const partial = gitOut(["config", "--get", "remote.origin.promisor"], { cwd: dir, allowFail: true }) === "true";
  const repo = { url, dir, partial };
  repos.set(url, repo);
  return repo;
}

export function resolveCommit(repo, ref) {
  const candidates = !ref || ref === "HEAD" ? ["HEAD"] : [`refs/heads/${ref}`, `refs/tags/${ref}`, ref];
  for (const c of candidates) {
    const r = git(["rev-parse", "--verify", "--quiet", `${c}^{commit}`], { cwd: repo.dir, allowFail: true });
    if (r.status === 0) return r.stdout.trim();
  }
  return null;
}

// A recorded commit may have left every branch (force push): ask for it by id.
export function ensureCommit(repo, sha) {
  let full = resolveCommit(repo, sha);
  if (!full && /^[0-9a-f]{40,64}$/i.test(sha)) {
    git(["fetch", "--quiet", "--no-tags", "origin", sha], { cwd: repo.dir, allowFail: true });
    full = resolveCommit(repo, sha);
  }
  return full;
}

// "main/skills/foo" from a tree URL: the ref may itself contain slashes.
export function splitRefPath(repo, refPath) {
  const segs = refPath.split("/");
  for (let i = 1; i <= segs.length; i++) {
    const ref = segs.slice(0, i).join("/");
    if (resolveCommit(repo, ref)) return { ref, path: segs.slice(i).join("/") };
  }
  return { ref: segs[0], path: segs.slice(1).join("/") };
}

// Files under `sub` at `commit`, keyed by their path relative to `sub`.
export function listTree(repo, commit, sub = "") {
  const args = ["ls-tree", "-r", "-z", "--full-tree", commit];
  if (sub) args.push("--", sub);
  const prefix = sub ? `${sub}/` : "";
  const map = new Map();
  for (const e of parseLsTree(git(args, { cwd: repo.dir }).stdout)) {
    if (prefix && !e.path.startsWith(prefix)) continue;
    map.set(e.path.slice(prefix.length), e);
  }
  return map;
}

// Entries for exact paths (any depth), keyed by full path.
export function listPaths(repo, commit, paths) {
  const map = new Map();
  for (let i = 0; i < paths.length; i += 200) {
    const out = git(["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...paths.slice(i, i + 200)], { cwd: repo.dir }).stdout;
    for (const e of parseLsTree(out)) map.set(e.path, e);
  }
  return map;
}

function parseLsTree(out) {
  const entries = [];
  for (const line of out.split("\0")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    const [mode, type, oid] = line.slice(0, tab).split(" ");
    // Symlinks and submodules are not copied into a skill folder.
    if (type === "blob" && mode !== "120000") entries.push({ mode, oid, path: line.slice(tab + 1) });
  }
  return entries;
}

export function readBlobs(repo, oids) {
  const wanted = [...new Set(oids.filter(Boolean))];
  if (repo.partial && wanted.length) {
    // The batch fetch git itself runs for a promisor remote: one round trip
    // instead of one per missing file. On failure, cat-file fetches lazily.
    git(
      ["-c", "fetch.negotiationAlgorithm=noop", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head",
        "--recurse-submodules=no", "--filter=blob:none", "--stdin", "origin"],
      { cwd: repo.dir, input: wanted.join("\n") + "\n", allowFail: true },
    );
  }
  const blobs = new Map();
  for (const oid of wanted) blobs.set(oid, git(["cat-file", "blob", oid], { cwd: repo.dir, buffer: true }).stdout);
  return blobs;
}

export function showFile(repo, commit, file) {
  const r = git(["show", `${commit}:${file}`], { cwd: repo.dir, allowFail: true });
  return r.status === 0 ? r.stdout : null;
}

const pathspec = (paths) => (paths.some((p) => !p) ? [] : ["--", ...paths]);

export function commitLog(repo, from, to, paths, max = 15) {
  const out = gitOut(["log", "--format=%h %cs %s", `--max-count=${max}`, `${from}..${to}`, ...pathspec(paths)], { cwd: repo.dir, allowFail: true });
  return out ? out.split("\n") : [];
}

export function commitCount(repo, from, to, paths) {
  return Number(gitOut(["rev-list", "--count", `${from}..${to}`, ...pathspec(paths)], { cwd: repo.dir, allowFail: true })) || 0;
}

export const commitDate = (repo, sha) => gitOut(["show", "-s", "--format=%cs", sha], { cwd: repo.dir });

// --- Local files ------------------------------------------------------------

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
export const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

export function toEol(buf, crlf) {
  if (isBinary(buf)) return buf;
  const lf = buf.toString("latin1").replace(/\r\n/g, "\n");
  return Buffer.from(crlf ? lf.replace(/\n/g, "\r\n") : lf, "latin1");
}

const hasCrlf = (buf) => buf.includes("\r\n");

// A file of the skill folder. `is(oid)` compares it to a git blob without
// reading the blob: same bytes, or the same text with other line endings.
export class LocalFile {
  constructor(abs) {
    this.abs = abs;
    this.hashes = {};
  }
  get buf() {
    return (this._buf ??= fs.readFileSync(this.abs));
  }
  get crlf() {
    return !isBinary(this.buf) && hasCrlf(this.buf);
  }
  is(oid) {
    if (!oid) return false;
    const algo = oid.length === 64 ? "sha256" : "sha1";
    if (!this.hashes[algo]) {
      const variants = [this.buf];
      if (!isBinary(this.buf)) variants.push(toEol(this.buf, false), toEol(this.buf, true));
      this.hashes[algo] = new Set(variants.map((b) => blobId(b, algo)));
    }
    return this.hashes[algo].has(oid);
  }
}

export const blobId = (buf, algo = "sha1") => crypto.createHash(algo).update(`blob ${buf.length}\0`).update(buf).digest("hex");

export function localFiles(dir) {
  const map = new Map();
  (function walk(abs, rel) {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(a, r);
      else if (e.isFile()) map.set(r, new LocalFile(a));
    }
  })(dir, "");
  return map;
}

// --- Discovery --------------------------------------------------------------
// A folder holding a SKILL.md is a skill; the walk does not go inside it, so
// skills nested in domain folders (video/brag) or plugin wrappers are found.

export function discover(root, ignore = []) {
  const skills = [];
  const ignored = (name, rel) => name.startsWith(".") || name === "node_modules" || matchAny(rel, ignore) || ignore.includes(name);
  (function walk(dir, rel, checkout) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel && entries.some((e) => e.name === ".git")) checkout = dir;
    if (rel && entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      skills.push({ id: rel, dir, ...(checkout && { checkout }) });
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (ignored(e.name, childRel)) continue;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        if (fs.existsSync(path.join(abs, "SKILL.md"))) skills.push({ id: childRel, dir: abs, link: realpath(abs) });
      } else if (e.isDirectory()) walk(abs, childRel, checkout);
    }
  })(root, "", null);
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

function realpath(p) {
  try {
    return slash(fs.realpathSync(p));
  } catch {
    return null;
  }
}

// --- Globs --------------------------------------------------------------------
// Patterns match the whole path relative to the skill folder; ** crosses folders.

const globCache = new Map();
export function globToRegExp(glob) {
  if (globCache.has(glob)) return globCache.get(glob);
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const rx = new RegExp(`^${re}$`);
  globCache.set(glob, rx);
  return rx;
}

export const matchAny = (rel, globs = []) => globs.some((g) => globToRegExp(g).test(rel));

// Shortest list of globs naming exactly the `missing` paths among `all`:
// a folder whose files are all missing becomes "folder/**".
export function compressPaths(missing, all) {
  const out = [];
  (function visit(prefix, files) {
    if (prefix && files.every((f) => missing.has(f))) return out.push(`${prefix}/**`);
    const groups = new Map();
    for (const f of files) {
      const rest = prefix ? f.slice(prefix.length + 1) : f;
      const i = rest.indexOf("/");
      if (i < 0) {
        if (missing.has(f)) out.push(f);
        continue;
      }
      const d = (prefix ? `${prefix}/` : "") + rest.slice(0, i);
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(f);
    }
    for (const [d, list] of groups) if (list.some((f) => missing.has(f))) visit(d, list);
  })("", [...all]);
  return out.sort();
}

// --- The skill as git sees it ------------------------------------------------------

// Files of a tracked skill at a commit: its folder, filtered by include and
// exclude, plus the extras copied from elsewhere in the repository.
export function managedTree(repo, commit, entry) {
  const map = new Map();
  for (const [rel, e] of listTree(repo, commit, entry.path)) {
    if (entry.include && !matchAny(rel, entry.include)) continue;
    if (matchAny(rel, entry.exclude)) continue;
    map.set(rel, e);
  }
  const extras = Object.entries(entry.extras ?? {});
  if (extras.length) {
    const found = listPaths(repo, commit, extras.map(([, up]) => up));
    for (const [rel, up] of extras) if (found.has(up)) map.set(rel, found.get(up));
  }
  return map;
}

// --- Three-way plan -------------------------------------------------------------
// base = files at the installed commit (null if unknown), remote = files
// upstream now, local = files on disk. One action per file:
//   same            nothing to do
//   update / add    take upstream (local untouched since base, or new file)
//   remove          deleted upstream, untouched locally: moved to the backup
//   merge           changed on both sides: three-way merge
//   conflict-add    added upstream, a different file exists locally
//   modified-locally, deleted-locally, kept-modified   local change, kept
//   local-only      file the user added: kept

export function plan(base, remote, local) {
  const files = [];
  const rels = new Set([...(base?.keys() ?? []), ...remote.keys()]);
  for (const rel of [...rels].sort()) {
    const b = base?.get(rel)?.oid;
    const r = remote.get(rel);
    const l = local.get(rel);
    let action;
    if (b && r && b === r.oid) action = !l ? "deleted-locally" : l.is(b) ? "same" : "modified-locally";
    else if (b && r) action = !l ? "deleted-locally" : l.is(b) ? "update" : l.is(r.oid) ? "same" : "merge";
    else if (b) action = !l ? "same" : l.is(b) ? "remove" : "kept-modified";
    else action = !l ? "add" : l.is(r.oid) ? "same" : "conflict-add";
    files.push({ rel, action, base: b, remote: r?.oid, mode: r?.mode });
  }
  for (const rel of local.keys()) if (!rels.has(rel)) files.push({ rel, action: "local-only" });
  return files;
}

export function merge3(localBuf, baseBuf, remoteBuf) {
  if ([localBuf, baseBuf, remoteBuf].some(isBinary)) return { conflict: true, conflicts: 1, binary: true };
  const crlf = hasCrlf(localBuf);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-update-"));
  try {
    const files = ["local", "base", "upstream"].map((n, i) => {
      const f = path.join(tmp, n);
      fs.writeFileSync(f, toEol([localBuf, baseBuf, remoteBuf][i], false));
      return f;
    });
    const r = git(["merge-file", "-p", "-L", "local", "-L", "base", "-L", "upstream", ...files], { buffer: true, allowFail: true });
    if (r.status < 0 || r.status > 127) throw new GitError(`git merge-file: ${String(r.stderr).trim()}`);
    return { conflict: r.status > 0, conflicts: r.status, content: toEol(r.stdout, crlf) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Finding where a copied skill came from ------------------------------------------

export function skillPaths(repo, commit) {
  const out = gitOut(["ls-tree", "-r", "-z", "--name-only", "--full-tree", commit], { cwd: repo.dir });
  return out
    .split("\0")
    .filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"))
    .map((p) => p.slice(0, -"SKILL.md".length).replace(/\/$/, ""));
}

export function skillName(dir) {
  try {
    const head = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return head?.[1].match(/^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

// The folder of the repository that holds this skill: same folder name, or
// same `name:` in SKILL.md, or the only skill of the repository.
export function findSkillPath(repo, commit, skillDir) {
  const candidates = skillPaths(repo, commit);
  const base = path.basename(skillDir);
  const name = skillName(skillDir);
  const byDir = candidates.filter((c) => (c.split("/").pop() || "") === base);
  if (byDir.length === 1) return { path: byDir[0] };
  const byName = candidates.filter((c) => name && (c.split("/").pop() || "") === name);
  if (byName.length === 1) return { path: byName[0] };
  if (candidates.length === 1) return { path: candidates[0] };
  return { candidates: byDir.length ? byDir : candidates };
}

const better = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

// The commit whose files match the local copy best: most identical files,
// then fewest different ones, then fewest missing; newest on a tie.
export function bestCommit(repo, head, sub, local, max = 500) {
  const commits = gitOut(["rev-list", `--max-count=${max}`, head, ...pathspec([sub])], { cwd: repo.dir }).split("\n").filter(Boolean);
  let best = null;
  for (const commit of commits) {
    let same = 0, differ = 0, missing = 0;
    for (const [rel, e] of listTree(repo, commit, sub)) {
      const l = local.get(rel);
      if (!l) missing++;
      else if (l.is(e.oid)) same++;
      else differ++;
    }
    const key = [same, -differ, -missing];
    if (!best || better(key, best.key)) best = { commit, key, same, differ, missing };
  }
  return best;
}

// Local files absent from the skill folder upstream but present higher up in
// the repository (LICENSE, NOTICE at the root): copied with the skill.
export function findExtras(repo, commit, sub, rels) {
  const ancestors = [];
  for (let d = sub; d; ) {
    d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "";
    ancestors.push(d);
  }
  if (!ancestors.length) return {};
  const wanted = rels.flatMap((rel) => ancestors.map((d) => (d ? `${d}/${rel}` : rel)));
  const found = listPaths(repo, commit, wanted);
  const extras = {};
  for (const rel of rels) {
    const hit = ancestors.map((d) => (d ? `${d}/${rel}` : rel)).find((p) => found.has(p));
    if (hit) extras[rel] = hit;
  }
  return extras;
}

// --- Skills installed by `npx skills` ------------------------------------------------

export function npxLocks(root) {
  const files = [
    process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, "skills", ".skill-lock.json") : path.join(os.homedir(), ".agents", ".skill-lock.json"),
    path.join(root, "..", "..", "skills-lock.json"),
    path.join(process.cwd(), "skills-lock.json"),
  ];
  const map = new Map();
  for (const f of new Set(files.map((f) => path.resolve(f)))) {
    let lock;
    try {
      lock = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    for (const [name, e] of Object.entries(lock.skills ?? {})) {
      if (map.has(name) || !["github", "gitlab", "git"].includes(e.sourceType)) continue;
      const url = /^(https?|git|ssh):\/\//.test(e.sourceUrl ?? "") ? e.sourceUrl.replace(/\.git$/, "") : parseSource(e.source).url;
      const skillPath = e.skillPath ? e.skillPath.replace(/\/?SKILL\.md$/i, "") : undefined;
      map.set(name, { url, ref: e.ref || undefined, path: skillPath, lock: slash(f) });
    }
  }
  return map;
}

// --- Plain git checkouts inside the skills folder ------------------------------------

export function checkoutStatus(dir, { fetch = true } = {}) {
  if (fetch) git(["fetch", "--quiet"], { cwd: dir });
  const upstream = git(["rev-parse", "--verify", "--quiet", "@{u}"], { cwd: dir, allowFail: true });
  if (upstream.status !== 0) return { error: "no-upstream" };
  const count = (range) => Number(gitOut(["rev-list", "--count", range], { cwd: dir }));
  return {
    head: gitOut(["rev-parse", "HEAD"], { cwd: dir }),
    upstream: upstream.stdout.trim(),
    behind: count("HEAD..@{u}"),
    ahead: count("@{u}..HEAD"),
    dirty: gitOut(["status", "--porcelain"], { cwd: dir }) !== "",
    log: gitOut(["log", "--format=%h %cs %s", "--max-count=15", "HEAD..@{u}"], { cwd: dir }).split("\n").filter(Boolean),
  };
}

export function fastForward(dir) {
  const r = git(["merge", "--ff-only", "--autostash", "--quiet", "@{u}"], { cwd: dir, allowFail: true });
  return r.status === 0 ? null : String(r.stderr).trim().split("\n").pop();
}

// --- Version strings -----------------------------------------------------------------------

export function newerVersion(local, remote) {
  if (!remote || !local || local === remote) return false;
  const parse = (v) => String(v).replace(/^v/, "").split(/[.+-]/).slice(0, 3).map(Number);
  const a = parse(local), b = parse(remote);
  if ([...a, ...b].some(Number.isNaN)) return null;
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) > (a[i] ?? 0);
  return false;
}
