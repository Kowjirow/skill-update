// End-to-end tests: a temporary upstream git repository, a skills folder that
// holds copies of its skills, and the CLI run as a user would run it.
// Run with: node --test

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../skills/skill-update/scripts/skill-update.mjs", import.meta.url));
const GIT_ENV = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  if (r.status) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(base, ...rel.split("/"));
    if (content === null) fs.rmSync(file);
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
}

const read = (base, rel) => fs.readFileSync(path.join(base, ...rel.split("/")), "utf8");

const sandboxes = [];
process.on("exit", () => {
  for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });
});

function sandbox(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-update-test-"));
  sandboxes.push(dir);
  const s = { dir, home: path.join(dir, "home"), upstream: path.join(dir, "upstream"), root: path.join(dir, "skills"), claude: path.join(dir, "claude") };
  fs.mkdirSync(s.upstream);
  fs.mkdirSync(s.root);
  git(s.upstream, "init", "-q", "-b", "main");
  s.commit = (changes, message = "change") => {
    write(s.upstream, changes);
    git(s.upstream, "add", "-A");
    git(s.upstream, "commit", "-q", "-m", message);
    return git(s.upstream, "rev-parse", "HEAD");
  };
  s.c1 = s.commit(files, "first");
  s.copy = (from, to) => fs.cpSync(path.join(s.upstream, ...from.split("/")), path.join(s.root, ...to.split("/")), { recursive: true });
  s.run = (args, { root = true, env = {}, json = true } = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, ...(json ? ["--json"] : []), ...(root ? ["--root", s.root] : [])], {
      encoding: "utf8",
      env: { ...process.env, SKILL_UPDATE_HOME: s.home, CLAUDE_CONFIG_DIR: s.claude, XDG_STATE_HOME: path.join(dir, "state"), LANG: "en_US.UTF-8", ...env },
    });
    let out = r.stdout;
    if (json) {
      try {
        out = JSON.parse(r.stdout);
      } catch {
        throw new Error(`not JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
      }
    }
    return { code: r.status, out, stderr: r.stderr };
  };
  s.skill = (out, id) => out.roots.flatMap((r) => r.skills).find((x) => x.id === id);
  return s;
}

const DEMO = {
  "skills/demo/SKILL.md": "---\nname: demo\ndescription: Demo skill\n---\n\nLine one.\nLine two.\nLine three.\nLine four.\nLine five.\n",
  "skills/demo/notes.md": "notes v1\n",
  "skills/other/SKILL.md": "---\nname: other\n---\nother\n",
  "LICENSE": "MIT\n",
  "README.md": "readme\n",
};

// A skill copied into a domain folder, with the repository LICENSE beside it.
function tracked() {
  const s = sandbox(DEMO);
  s.copy("skills/demo", "design/demo");
  write(s.root, { "design/demo/LICENSE": "MIT\n" });
  const r = s.run(["track", "design/demo", s.upstream]);
  assert.equal(r.code, 0, r.stderr);
  return s;
}

test("track finds the folder, the commit and the extras", () => {
  const s = tracked();
  const lock = JSON.parse(read(s.root, ".skill-update-lock.json"));
  const entry = lock.skills["design/demo"];
  assert.equal(entry.path, "skills/demo");
  assert.equal(entry.commit, s.c1);
  assert.deepEqual(entry.extras, { LICENSE: "LICENSE" });
  assert.equal(entry.exclude, undefined);
  assert.equal(s.skill(s.run(["check"]).out, "design/demo").status, "up-to-date");
});

test("an upstream change is applied, backed up and recorded", () => {
  const s = tracked();
  const c2 = s.commit({ "skills/demo/notes.md": "notes v2\n", "skills/demo/new.md": "new\n", LICENSE: "MIT 2\n" });
  const check = s.skill(s.run(["check"]).out, "design/demo");
  assert.equal(check.status, "update-available");
  assert.deepEqual(check.files, { add: ["new.md"], update: ["LICENSE", "notes.md"] });
  assert.equal(check.behind, 1);

  const up = s.run(["update", "demo"]).out;
  assert.equal(up.updated.length, 1);
  assert.equal(up.updated[0].to, c2);
  assert.equal(read(s.root, "design/demo/notes.md"), "notes v2\n");
  assert.equal(read(s.root, "design/demo/new.md"), "new\n");
  assert.equal(read(s.root, "design/demo/LICENSE"), "MIT 2\n");
  assert.equal(read(up.updated[0].backup, "notes.md"), "notes v1\n");
  assert.equal(JSON.parse(read(s.root, ".skill-update-lock.json")).skills["design/demo"].commit, c2);
  assert.equal(s.skill(s.run(["check"]).out, "design/demo").status, "up-to-date");
});

test("a local change alone is kept and reported", () => {
  const s = tracked();
  write(s.root, { "design/demo/notes.md": "my notes\n" });
  const check = s.skill(s.run(["check"]).out, "design/demo");
  assert.equal(check.status, "modified");
  assert.deepEqual(check.files.modified, ["notes.md"]);
  s.run(["update", "--all"]);
  assert.equal(read(s.root, "design/demo/notes.md"), "my notes\n");
});

test("local and upstream changes in different places are merged", () => {
  const s = tracked();
  write(s.root, { "design/demo/SKILL.md": DEMO["skills/demo/SKILL.md"].replace("Line one.", "Ligne un (patch local).") });
  s.commit({ "skills/demo/SKILL.md": DEMO["skills/demo/SKILL.md"].replace("Line five.", "Line five, improved.") });
  assert.equal(s.skill(s.run(["check"]).out, "design/demo").status, "merge-available");
  s.run(["update", "--all"]);
  const merged = read(s.root, "design/demo/SKILL.md");
  assert.match(merged, /Ligne un \(patch local\)\./);
  assert.match(merged, /Line five, improved\./);
  // The local patch is now a local change on top of the new commit.
  assert.equal(s.skill(s.run(["check"]).out, "design/demo").status, "modified");
});

test("a conflict leaves the skill untouched until --ours or --theirs", () => {
  const s = tracked();
  write(s.root, { "design/demo/notes.md": "mine\n" });
  s.commit({ "skills/demo/notes.md": "theirs\n", "skills/demo/new.md": "new\n" });
  assert.equal(s.skill(s.run(["check"]).out, "design/demo").status, "conflict");

  const up = s.run(["update", "demo"]).out;
  assert.equal(up.updated.length, 0);
  assert.deepEqual(up.conflicts[0].files, ["notes.md"]);
  assert.equal(read(s.root, "design/demo/notes.md"), "mine\n");
  assert.equal(fs.existsSync(path.join(s.root, "design", "demo", "new.md")), false);
  assert.match(read(up.conflicts[0].saved, "notes.md"), /<<<<<<< local/);

  s.run(["update", "demo", "--ours"]);
  assert.equal(read(s.root, "design/demo/notes.md"), "mine\n");
  assert.equal(read(s.root, "design/demo/new.md"), "new\n");
  assert.equal(s.skill(s.run(["check"]).out, "design/demo").status, "modified");

  s.commit({ "skills/demo/notes.md": "theirs again\n" });
  assert.equal(s.skill(s.run(["check"]).out, "design/demo").status, "conflict");
  s.run(["update", "demo", "--theirs"]);
  assert.equal(read(s.root, "design/demo/notes.md"), "theirs again\n");
});

test("a file deleted upstream goes to the backup, a local file stays", () => {
  const s = tracked();
  write(s.root, { "design/demo/mine.md": "my own file\n" });
  s.commit({ "skills/demo/notes.md": null });
  const up = s.run(["update", "--all"]).out;
  assert.deepEqual(up.updated[0].files, { remove: ["notes.md"] });
  assert.equal(fs.existsSync(path.join(s.root, "design", "demo", "notes.md")), false);
  assert.equal(read(up.updated[0].backup, "notes.md"), "notes v1\n");
  assert.equal(read(s.root, "design/demo/mine.md"), "my own file\n");
});

test("files not copied at track time stay excluded", () => {
  const s = sandbox({ ...DEMO, "skills/demo/docs/a.md": "a\n", "skills/demo/docs/b.md": "b\n", "skills/demo/extra.md": "e\n" });
  s.copy("skills/demo", "demo");
  fs.rmSync(path.join(s.root, "demo", "docs"), { recursive: true });
  fs.rmSync(path.join(s.root, "demo", "extra.md"));
  const tr = s.run(["track", "demo", s.upstream]).out.tracked[0];
  assert.deepEqual(tr.exclude, ["docs/**", "extra.md"]);
  s.commit({ "skills/demo/docs/c.md": "c\n", "skills/demo/extra.md": "e2\n" });
  assert.equal(s.skill(s.run(["check"]).out, "demo").status, "up-to-date");
});

test("line endings do not count as changes, and are kept on update", () => {
  const s = tracked();
  const crlf = (rel) => write(s.root, { [rel]: read(s.root, rel).replace(/\n/g, "\r\n") });
  crlf("design/demo/notes.md");
  crlf("design/demo/SKILL.md");
  assert.equal(s.skill(s.run(["check"]).out, "design/demo").status, "up-to-date");
  s.commit({ "skills/demo/notes.md": "notes v2\nmore\n" });
  s.run(["update", "--all"]);
  assert.equal(read(s.root, "design/demo/notes.md"), "notes v2\r\nmore\r\n");
});

test("a folder moved upstream is reported, not deleted", () => {
  const s = tracked();
  git(s.upstream, "mv", "skills/demo", "skills/renamed");
  git(s.upstream, "commit", "-q", "-m", "move");
  assert.equal(s.skill(s.run(["check"]).out, "design/demo").status, "source-missing");
  s.run(["update", "--all"]);
  assert.equal(read(s.root, "design/demo/notes.md"), "notes v1\n");
});

test("track without --commit finds the commit the copy was made from", () => {
  const s = sandbox(DEMO);
  s.copy("skills/demo", "demo");
  const c2 = s.commit({ "skills/demo/notes.md": "notes v2\n" });
  s.commit({ "skills/demo/added-later.md": "later\n" });
  const tr = s.run(["track", "demo", s.upstream]).out.tracked[0];
  assert.equal(tr.commit, s.c1);
  assert.notEqual(tr.commit, c2);
  assert.equal(s.skill(s.run(["check"]).out, "demo").status, "update-available");
});

test("track accepts a GitHub-style tree URL tail and --manual", () => {
  const s = sandbox(DEMO);
  s.copy("skills/other", "x/other");
  const tr = s.run(["track", "other", s.upstream, "--path", "skills/other/SKILL.md", "--ref", "main"]).out.tracked[0];
  assert.equal(tr.path, "skills/other");
  assert.equal(tr.ref, "main");
  s.copy("skills/demo", "x/hand");
  s.run(["track", "hand", "--manual", "made by a generator"]);
  const check = s.run(["check"]).out;
  assert.equal(s.skill(check, "x/hand").status, "manual");
  assert.equal(s.skill(check, "x/hand").note, "made by a generator");
});

test("discovery walks domain folders and plugin wrappers, and skips synced", () => {
  const s = sandbox(DEMO);
  s.copy("skills/demo", "video/brag");
  s.copy("skills/other", "search/finder/skills/finder");
  s.copy("skills/other", "synced/docx");
  write(s.root, { "video/--index-video.md": "index\n", "search/finder/.claude-plugin/plugin.json": "{}" });
  const ids = s.run(["scan"]).out.roots[0].skills.map((x) => `${x.id}:${x.kind}`);
  assert.deepEqual(ids, ["search/finder/skills/finder:untracked", "video/brag:untracked"]);
});

test("config: no folder, then the default folder, then a chosen one", () => {
  const s = sandbox(DEMO);
  const none = s.run(["check"], { root: false });
  assert.equal(none.code, 2);
  assert.equal(none.out.error, "not-configured");
  assert.equal(none.out.defaultRoot, `${s.claude.split(path.sep).join("/")}/skills`);

  const def = s.run(["config", "--root", "default"], { root: false }).out;
  assert.equal(def.roots[0].path, `${s.claude.split(path.sep).join("/")}/skills`);
  const chosen = s.run(["config", "--root", s.root, "--lock", path.join(s.dir, "lock.json"), "--remove-root", path.join(s.claude, "skills")], { root: false }).out;
  assert.deepEqual(chosen.roots.map((r) => r.path), [s.root.split(path.sep).join("/")]);
  assert.equal(chosen.roots[0].lock, path.join(s.dir, "lock.json").split(path.sep).join("/"));

  s.copy("skills/demo", "demo");
  s.run(["track", "demo", s.upstream], { root: false });
  assert.ok(fs.existsSync(path.join(s.dir, "lock.json")));
});

test("the after-update command receives the report", () => {
  const s = tracked();
  const hook = path.join(s.dir, "hook.mjs");
  const out = path.join(s.dir, "hook-report.json");
  fs.writeFileSync(hook, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(out)}, fs.readFileSync(0));`);
  s.run(["config", "--root", s.root, "--after-update", `"${process.execPath}" "${hook}"`], { root: false });
  const c2 = s.commit({ "skills/demo/notes.md": "notes v2\n" });
  const up = s.run(["update", "--all"], { root: false }).out;
  assert.equal(up.afterUpdate.code, 0, up.afterUpdate.output);
  const report = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(report.updated[0].id, "design/demo");
  assert.equal(report.updated[0].to, c2);
  assert.match(report.updated[0].toDate, /^\d{4}-\d{2}-\d{2}$/);
});

test("--dry-run writes nothing", () => {
  const s = tracked();
  s.commit({ "skills/demo/notes.md": "notes v2\n" });
  const lockBefore = read(s.root, ".skill-update-lock.json");
  const up = s.run(["update", "--all", "--dry-run"]).out;
  assert.equal(up.updated.length, 1);
  assert.equal(read(s.root, "design/demo/notes.md"), "notes v1\n");
  assert.equal(read(s.root, ".skill-update-lock.json"), lockBefore);
});

test("a git checkout inside the folder is fast-forwarded", () => {
  const s = sandbox(DEMO);
  git(s.root, "clone", "-q", s.upstream, "pack");
  assert.equal(s.skill(s.run(["check"]).out, "pack/skills/demo").kind, "checkout");
  s.commit({ "skills/demo/notes.md": "notes v2\n" });
  assert.equal(s.skill(s.run(["check"]).out, "pack/skills/demo").status, "update-available");
  const up = s.run(["update", "--all"]).out;
  assert.equal(up.updated.length, 1);
  // The checkout follows the machine's core.autocrlf: compare the text only.
  assert.equal(read(s.root, "pack/skills/demo/notes.md").replace(/\r\n/g, "\n"), "notes v2\n");
});

test("skills installed by npx skills are adopted", () => {
  const s = sandbox(DEMO);
  s.copy("skills/demo", "demo");
  write(path.join(s.dir, "state", "skills"), {
    ".skill-lock.json": JSON.stringify({ version: 3, skills: { demo: { source: s.upstream, sourceType: "git", skillPath: "skills/demo/SKILL.md" } } }),
  });
  assert.equal(s.skill(s.run(["check"]).out, "demo").npx.path, "skills/demo");
  const tr = s.run(["track", "--from-npx"]).out.tracked;
  assert.equal(tr[0].path, "skills/demo");
  assert.equal(s.skill(s.run(["check"]).out, "demo").status, "up-to-date");
});

test("plugins behind their marketplace are listed with the command", () => {
  const s = sandbox({
    ".claude-plugin/marketplace.json": JSON.stringify({ name: "mk", plugins: [{ name: "alpha", version: "1.2.0", source: "./alpha" }, { name: "beta", source: "./beta" }] }),
    "beta/.claude-plugin/plugin.json": JSON.stringify({ name: "beta", version: "2.0.0" }),
  });
  write(path.join(s.claude, "plugins"), {
    "installed_plugins.json": JSON.stringify({ version: 2, plugins: { "alpha@mk": [{ scope: "user", version: "1.0.0" }], "beta@mk": [{ scope: "user", version: "2.0.0" }] } }),
    "known_marketplaces.json": JSON.stringify({ mk: { source: { source: "git", url: s.upstream } } }),
  });
  const plugins = s.run(["plugins"], { root: false }).out.plugins;
  const alpha = plugins.find((p) => p.id === "alpha@mk");
  assert.equal(alpha.status, "update-available");
  assert.equal(alpha.remote, "1.2.0");
  assert.match(alpha.command, /claude plugin update alpha@mk/);
  assert.equal(plugins.find((p) => p.id === "beta@mk").status, "up-to-date");
});

test("each update is listed in a dated log, one section per run", () => {
  const s = tracked();
  const date = new Date().toLocaleDateString("sv-SE");
  const c2 = s.commit({ "skills/demo/notes.md": "notes v2\n", "skills/demo/new.md": "new\n" }, "Improve the notes");
  const up = s.run(["update", "--all"]).out;
  const file = path.join(s.home, "logs", `${date}.md`);
  assert.equal(up.logFile, file.split(path.sep).join("/"));
  let log = read(s.home, `logs/${date}.md`);
  assert.match(log, new RegExp(`^# Skill updates — ${date}\\n`));
  assert.match(log, /\| `design\/demo` \| .* \| `[0-9a-f]{8}` \| `[0-9a-f]{8}` \| \d{4}-\d{2}-\d{2} \| 1 updated, 1 added \|/);
  assert.ok(log.includes(`\`${s.c1.slice(0, 8)}\``) && log.includes(`\`${c2.slice(0, 8)}\``));
  assert.match(log, /- updated: `notes\.md`/);
  assert.match(log, /Improve the notes/);

  s.commit({ "skills/demo/notes.md": "notes v3\n" });
  s.run(["update", "--all", "--dry-run"]);
  assert.equal(read(s.home, `logs/${date}.md`), log);
  s.run(["update", "--all", "--lang", "fr"]);
  log = read(s.home, `logs/${date}.md`);
  assert.equal(log.match(/^# /gm).length, 1);
  assert.equal(log.match(/^## /gm).length, 2);
  assert.match(log, /- mis à jour : `notes\.md`/);
});

test("the log folder can be moved, and a conflict is logged too", () => {
  const s = tracked();
  const journal = path.join(s.dir, "notes", "skill-updates");
  s.run(["config", "--root", s.root, "--log-dir", journal], { root: false });
  write(s.root, { "design/demo/notes.md": "mine\n" });
  s.commit({ "skills/demo/notes.md": "theirs\n" });
  const up = s.run(["update", "--all"], { root: false }).out;
  assert.equal(path.dirname(up.logFile), journal.split(path.sep).join("/"));
  assert.match(fs.readFileSync(up.logFile, "utf8"), /### Not updated: conflicts\n\n- `design\/demo`: `notes\.md`/);
});

test("Codex: the skill follows the Agent Skills spec and ships its Codex files", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const dir = path.join(repo, "skills", "skill-update");
  const front = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];
  const field = (k) => front.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1].trim();
  assert.match(field("name"), /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.equal(field("name"), path.basename(dir));
  assert.ok(field("description").length <= 1024);
  assert.ok(field("compatibility").length <= 500);
  assert.match(fs.readFileSync(path.join(dir, "agents", "openai.yaml"), "utf8"), /^interface:\n {2}display_name: "Skill Update"/);

  const codex = JSON.parse(fs.readFileSync(path.join(repo, ".codex-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(fs.readdirSync(path.join(repo, ".codex-plugin")), ["plugin.json"]);
  assert.ok(fs.existsSync(path.join(repo, codex.skills, "skill-update", "SKILL.md")));
  const claude = JSON.parse(fs.readFileSync(path.join(repo, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(codex.version, claude.version);
});

test("config knows each agent's folder; without Claude Code, state goes to ~/.agents", () => {
  const s = sandbox(DEMO);
  const user = path.join(s.dir, "user");
  const env = { SKILL_UPDATE_HOME: "", CLAUDE_CONFIG_DIR: "", HOME: user, USERPROFILE: user, CODEX_HOME: path.join(s.dir, "codex-home") };
  const slashed = (...p) => path.join(...p).split(path.sep).join("/");
  const cfg = s.run(["config"], { root: false, env }).out;
  assert.equal(cfg.file, slashed(user, ".agents", "skill-update", "config.json"));
  assert.deepEqual(Object.fromEntries(cfg.knownRoots.map((r) => [r.name, r.path])), {
    claude: slashed(user, ".claude", "skills"),
    agents: slashed(user, ".agents", "skills"),
    codex: slashed(s.dir, "codex-home", "skills"),
  });
  const set = s.run(["config", "--root", "agents"], { root: false, env }).out;
  assert.equal(set.roots[0].path, slashed(user, ".agents", "skills"));
});

test("messages follow --lang", () => {
  const s = tracked();
  const fr = s.run(["check", "--lang", "fr"], { json: false });
  assert.match(fr.out, /À jour \(1\)/);
  const en = s.run(["check", "--lang", "en"], { json: false });
  assert.match(en.out, /Up to date \(1\)/);
});
