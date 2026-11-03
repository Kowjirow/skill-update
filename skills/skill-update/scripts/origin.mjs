// Finding where a hand-copied skill comes from. Candidate repositories come
// from what the machine already knows (links in the skill's files, repositories
// of tracked skills, Claude Code marketplaces, `npx skills`), then from the
// public skills.sh index, searched by the skill's name only. Each candidate is
// checked the way `track` checks: the commit whose files match the copy best.

import fs from "node:fs";
import path from "node:path";
import * as core from "./core.mjs";

const SEARCH = process.env.SKILL_UPDATE_SEARCH_URL || "https://skills.sh/api/search";
const GITHUB_LINK = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/g;
const NOT_REPOS = new Set(["orgs", "settings", "features", "topics", "sponsors", "marketplace", "apps", "about", "login", "notifications"]);
const TEXT = /\.(md|markdown|txt|json|ya?ml|toml)$/i;

// GitHub repositories linked from the skill's own text files.
export function linkedRepos(local) {
  const urls = new Set();
  for (const [rel, f] of local) {
    if (!TEXT.test(rel) && !/^(LICEN[CS]E|NOTICE|README)/i.test(path.basename(rel))) continue;
    if (fs.statSync(f.abs).size > 512 * 1024) continue;
    for (const m of f.buf.toString("utf8").matchAll(GITHUB_LINK)) {
      const repo = m[2].replace(/\.git$/, "").replace(/\.+$/, "");
      if (!NOT_REPOS.has(m[1]) && repo) urls.add(`https://github.com/${m[1]}/${repo}`);
    }
  }
  return [...urls];
}

// Claude Code marketplaces whose local clone holds a skill folder of this name.
export function marketplaceRepos(names) {
  let known;
  try {
    known = JSON.parse(fs.readFileSync(path.join(core.claudeDir(), "plugins", "known_marketplaces.json"), "utf8"));
  } catch {
    return [];
  }
  const urls = [];
  for (const m of Object.values(known)) {
    const s = m.source ?? {};
    const url = s.source === "github" ? `https://github.com/${s.repo}` : s.source === "git" ? s.url?.replace(/\.git$/, "") : null;
    if (!url || !m.installLocation || !fs.existsSync(m.installLocation)) continue;
    const r = core.git(["ls-tree", "-r", "--name-only", "HEAD"], { cwd: m.installLocation, allowFail: true });
    if (r.status !== 0) continue;
    const files = String(r.stdout).split("\n");
    if (names.some((n) => files.some((p) => p === `${n}/SKILL.md` || p.endsWith(`/${n}/SKILL.md`)))) urls.push(url);
  }
  return urls;
}

const sourceUrl = (source) => {
  if (/^[\w.-]+\/[\w.-]+$/.test(source ?? "")) return `https://github.com/${source}`;
  if (/^(https?|git|ssh|file):/.test(source ?? "") || (source && fs.existsSync(source))) return source;
  return null;
};

// Repositories that publish a skill of exactly this name on skills.sh, most
// installed first (the original before its forks). Only the name is sent,
// with an owner when the skill's own links name one.
export async function searchIndex(name, owner) {
  try {
    const params = new URLSearchParams({ q: name, limit: "20", ...(owner && { owner: owner.toLowerCase() }) });
    const res = await fetch(`${SEARCH}?${params}`, {
      headers: { "User-Agent": "skill-update" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const { skills = [] } = await res.json();
    return skills
      .filter((s) => (s.skillId ?? s.name) === name)
      .sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0))
      .map((s) => ({ url: sourceUrl(s.source), installs: s.installs }))
      .filter((s) => s.url);
  } catch {
    return [];
  }
}

// How well a repository matches the local copy, or null when it holds no
// folder of this skill or no identical file.
export function verify(url, dir, local, { fetch = true } = {}) {
  const repo = core.openRepo(url, { fetch });
  const head = core.resolveCommit(repo);
  if (!head) return null;
  const found = core.findSkillPath(repo, head, dir);
  const paths = found.path !== undefined ? [found.path] : (found.candidates ?? []).slice(0, 5);
  let best = null;
  for (const sub of paths) {
    const b = core.bestCommit(repo, head, sub, local, 200);
    if (!b?.same) continue;
    const m = { source: url, path: sub, commit: b.commit, same: b.same, differ: b.differ, missing: b.missing, exact: b.differ === 0 };
    if (!best || rank(m) > rank(best)) best = m;
  }
  if (best) best.commitDate = core.commitDate(repo, best.commit);
  return best;
}

// Exact matches first, then most identical files, fewest different, fewest missing.
export const rank = (m) => (m.exact ? 1e9 : 0) + m.same * 1e4 - m.differ * 100 - Math.min(m.missing, 99);
