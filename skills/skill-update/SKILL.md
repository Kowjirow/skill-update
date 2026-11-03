---
name: skill-update
description: Update the skills a user copied from GitHub or any git repository into a skills folder (~/.claude/skills, ~/.agents/skills, a project's skills folder, or any folder, sub-folders included). Checks what changed upstream, merges it with the user's own edits (three-way merge), backs up every replaced file, records where each skill comes from in a lock file and writes a dated log of each update. Also adopts skills installed by `npx skills`, fast-forwards skills that are git clones, and reports Claude Code plugins behind their marketplace. Use when the user asks to update, upgrade, refresh or check their skills, runs /skill-update or $skill-update, or wants to record where a skill comes from.
license: MIT
compatibility: Requires Node.js 18+ and git, and network access to the skills' repositories. Works in Claude Code, Codex and other agents that read SKILL.md.
---

# Skill Update

Keeps copied skills up to date without losing local edits. All the work is done by one script; this file says how to drive it and what to ask the user. It works the same in Claude Code (`/skill-update`) and Codex (`$skill-update`).

The script is `scripts/skill-update.mjs`, next to this file (the folder this skill was loaded from). It needs Node.js 18+ and git, and nothing else. Below, `su` stands for:

```bash
node "<this skill's folder>/scripts/skill-update.mjs"
```

Always add `--json` and read the JSON: the human output is for terminals. Speak to the user in their language; add `--lang fr` (or `en`) when they want the script's own messages in it.

**Asking the user.** Where this file says *ask*, use the agent's question tool when it has one (AskUserQuestion in Claude Code), otherwise ask in the chat and wait for the answer. Never pick for the user.

## 1. Know the skills folder

```bash
su config --json
```

If `configured` is `false`, ask the user where their skills are, two choices:

- **Default location**: the folder your agent loads personal skills from. `knownRoots` in the JSON lists them with `exists`: `claude` (`~/.claude/skills`, Claude Code), `agents` (`~/.agents/skills`, Codex and others), `codex` (`$CODEX_HOME/skills`, older Codex setups). Propose the one of the agent you are running in; say if it does not exist yet.
- **Choose a folder**: they type the path (a project's `.claude/skills` or `.agents/skills`, a vault, a repository of skills…). Sub-folders are fine: any folder holding a `SKILL.md` is a skill, at any depth.

Then save the answer, once:

```bash
su config --root claude --json           # or agents, codex
su config --root "<folder>" --json       # optional: --lock "<file>" to keep the lock file elsewhere
```

The configuration is shared by every agent on the machine (`~/.claude/skill-update/`, or `~/.agents/skill-update/` without Claude Code).

Several folders can be configured (run `config --root` once per folder). `--root <folder>` on any other command works on that folder alone.

## 2. Check

```bash
su check --json
```

The first run clones each source repository into a cache (blobless: commits and trees only), so it can take a minute; later runs only fetch. Each skill has a `status`:

| status | meaning | what to do |
| --- | --- | --- |
| `update-available` | upstream changed, local copy untouched where it changed | offer the update |
| `merge-available` | upstream and the user changed the same file, in different places | offer the update: the merge keeps both |
| `conflict` | both changed the same lines | see step 5 |
| `modified` | only the user changed it | nothing; their edits are kept |
| `up-to-date` | nothing to do | count only |
| `untracked` | origin unknown | see step 3 |
| `source-missing` | the folder is gone upstream (moved, renamed) | find its new place, `track` again with `--path` |
| `manual` | marked as updated by hand | report, do nothing |
| `linked` | a symlink or junction to elsewhere | it is updated where it points |
| `missing` | in the lock file, not on disk | ask whether to `untrack` it |
| `error` | fetch failed, private repo, bad ref… | show `error` |

Present a short table: skills to update with `commit → head`, the number of upstream commits (`behind`), the files (`files.update`, `add`, `remove`, `merge`), and the commit subjects (`log`). Give only the count of up-to-date skills.

## 3. Track untracked skills

A skill copied by hand has no record of its origin. Offer to record it; ask the user for the repository URL when you do not know it (a `https://github.com/owner/repo/tree/<branch>/<path>` link is best: it gives the folder).

```bash
su track <id> <url> --json                      # finds the folder and the commit the copy was made from
su track <id> <url> --path <folder> --json      # when the repository has several candidates
su track <id> <url> --commit <sha> --json       # when the user knows the commit
su track --from-npx --json                      # every skill `npx skills` recorded
su track <id> --manual "<why>" --json           # generated or hand-made: never updated here
```

`<id>` is the path under the skills folder (`video/brag`) or just the folder name when it is unique (`brag`). Read the result to the user: `modified` lists files that already differ from upstream (their edits, which future updates will merge, never overwrite), `exclude` the upstream files that were not copied (they stay out), `extras` files taken from elsewhere in the repository (a root `LICENSE`), `localOnly` the user's own files (kept).

## 4. Update, only with consent

Updated skills bring new instructions and sometimes new scripts that will run with the agent's permissions. Show what changes (step 2), then ask: **Update all** / **Choose** (which skill ids) / **Cancel**. Never update without that answer.

```bash
su update --all --json
su update <id> <id>… --json
su update <id> --dry-run --json                 # to show the plan without writing
```

For each file: taken from upstream when the user had not touched it, merged when both changed it, moved to the backup when deleted upstream, left alone when only the user changed it. Every replaced or removed file is first copied to `backupDir`. The lock file records the new commit. Report `updated` (with `files`), `backupDir`, `conflicts`, `skipped`, `errors`, and `afterUpdate` if present (a command the user configured to run after each update; relay its output).

Every update that changes something is also listed in a dated Markdown file, `logFile` in the JSON: `<log folder>/<YYYY-MM-DD>.md`, one section per run of the day, with a table of the skills updated (before and after commits, commit date, files) and, for each skill, its files and upstream commits; conflicts and errors follow. Give the user its path. The log folder is `logDir` in `config --json`; `su config --log-dir "<folder>"` moves it (into a notes vault, a repository…).

Skills that are git clones (`kind: checkout`) are fast-forwarded with `git merge --ff-only --autostash`.

## 5. Conflicts

A skill with a conflict is not touched at all. Its merge, with `<<<<<<<` markers, is saved under `conflictDir`. Show the user the conflicting parts and ask:

- **Keep mine**: `su update <id> --ours --json` (the rest of the update is applied; their version of the conflicting files stays).
- **Take upstream**: `su update <id> --theirs --json` (their version is in the backup).
- **Merge by hand**: write the merged content into the skill's file yourself (no markers left), show it, then `su update <id> --ours --json`.

## 6. Plugins and `npx skills`

```bash
su plugins --json
```

Claude Code only: lists Claude Code plugins whose marketplace has a newer version, each with the `command` to run (`claude plugin marketplace update <market> && claude plugin update <plugin>@<market>`). Run it only with the user's consent; a restart of Claude Code applies it. In Codex, skip this step.

Skills installed by `npx skills` show `npx` in `check`. Either adopt them (`track --from-npx`) so this tool updates them with merges and backups, or leave them to `npx skills update`.

## Rules

- In a sandboxed agent (Codex's default sandbox), `check`, `track` and `update` need network access (git fetch) and write access to the skills folder and to `~/.claude/skill-update/` or `~/.agents/skill-update/`. When the sandbox refuses, ask the user to approve the command with those permissions; do not work around it.
- Never delete a skill or a file outright: removed files go to the backup folder.
- Do not edit the lock file by hand; use `track` and `untrack <id>`.
- Config, cache, backups, conflict files and logs live in `~/.claude/skill-update/` (`~/.agents/skill-update/` without Claude Code; `SKILL_UPDATE_HOME` overrides it).
- `check --exit-code` exits with 1 when updates exist, for scripts and CI.
- Lock file format and fields: `references/lockfile.md`.
