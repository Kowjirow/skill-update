# Lock file, config and reports

## Lock file

One per skills folder: `<folder>/.skill-update-lock.json` unless `config --lock` puts it elsewhere. Keys are the skill paths relative to the folder, with `/`.

```json
{
  "version": 1,
  "skills": {
    "linkedin/li-human": {
      "source": "https://github.com/Jakeschincariol/linkedin-agent-skill",
      "path": "skills/li-human",
      "commit": "add2c2380f3c6d0c3a8b5e1f1a0d2c4b6e8f0a1b",
      "extras": { "LICENSE": "LICENSE" },
      "exclude": ["README.md", "templates/**"],
      "updatedAt": "2026-11-03"
    },
    "developpement/graphify": {
      "type": "manual",
      "note": "written by `graphify install`",
      "updatedAt": "2026-11-03"
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `source` | Any git URL: `https://github.com/o/r`, GitLab, SSH, or a local folder. |
| `ref` | Branch or tag followed. Absent: the repository's default branch. |
| `path` | Folder of the skill in the repository. `""` when the skill is the whole repository. |
| `commit` | Commit the local copy matches. The three-way merge uses it as the base. |
| `include` | Optional globs: only these files are managed. |
| `exclude` | Globs of upstream files left out (not copied at track time). New files under an excluded folder stay out. |
| `extras` | Local file → path elsewhere in the repository (a root `LICENSE` copied beside the skill). |
| `type: "manual"` | Never updated by the tool; `note` says why. |
| `updatedAt` | Date of the last track or update. |

Globs match the whole path relative to the skill folder: `*` stays in one folder, `**` crosses folders, `docs/**` is everything under `docs/`.

## How a file is compared

For each file the tool knows three versions: **base** (at `commit`), **upstream** (at the head of `ref`) and **local** (on disk). It compares git blob ids, so nothing is downloaded to decide; line endings (LF or CRLF) do not count as a change.

| base → upstream | local | action |
| --- | --- | --- |
| unchanged | unchanged | none |
| unchanged | changed | kept (`modified`) |
| changed | unchanged | take upstream |
| changed | changed | `git merge-file`: clean → written; overlapping → `conflict`, skill untouched |
| added | absent | added |
| deleted | unchanged | moved to the backup |
| deleted | changed | kept |
| — | file only local | kept |

## Config

`~/.claude/skill-update/config.json` (`SKILL_UPDATE_HOME` or `CLAUDE_CONFIG_DIR` move it):

```json
{
  "roots": [{ "path": "C:/Users/me/.claude/skills" }, { "path": "D:/vault/skills", "lock": "D:/vault/registry/skills-lock.json" }],
  "ignore": ["synced"],
  "lang": "fr",
  "afterUpdate": "node D:/vault/tools/after-skill-update.mjs"
}
```

`ignore` lists folder names or glob paths skipped by discovery (`synced` is the folder claude.ai manages in `~/.claude/skills`). Folders starting with `.` and `node_modules` are always skipped.

## After-update command

When `afterUpdate` is set, `update` runs it through the shell after writing, with the report as JSON on standard input:

```json
{
  "date": "2026-11-03",
  "dryRun": false,
  "updated": [
    {
      "id": "anthropic/canvas-design",
      "root": "C:/Users/me/skills",
      "source": "https://github.com/anthropics/skills",
      "path": "skills/canvas-design",
      "from": "dbd4588…",
      "to": "1a2b3c4…",
      "toDate": "2026-10-30",
      "files": { "update": ["SKILL.md"], "add": ["fonts/new.ttf"] },
      "backup": "C:/Users/me/.claude/skill-update/backups/2026-11-03T10-12-00/skills/anthropic/canvas-design"
    }
  ],
  "conflicts": [],
  "skipped": [],
  "errors": [],
  "backupDir": "…"
}
```

Use it to update a registry page, write a changelog, or commit. Its exit code and output come back in `afterUpdate`.

## Folders

| Folder | Content |
| --- | --- |
| `~/.claude/skill-update/cache/<host>/<owner>/<repo>` | bare, blobless clones of the sources |
| `~/.claude/skill-update/backups/<time>/` | files replaced or removed by each update |
| `~/.claude/skill-update/conflicts/<time>/` | merges with conflict markers, for review |
