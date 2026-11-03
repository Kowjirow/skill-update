# skill-update

[Français](README.fr.md)

An agent skill — for Claude Code, Codex, and any `SKILL.md`-compatible agent — that **keeps the skills you copied from GitHub up to date**, in any folder, without losing your own edits. It finds where each skill came from, shows what changed upstream and what deserves a look, merges the update with your changes, backs up every file it replaces, and writes a dated log of every update.

## Install

### Claude Code — as a plugin (recommended)

```
/plugin marketplace add Kowjirow/skill-update
/plugin install skill-update@skill-update
```

Then type `/skill-update`, or just ask to update your skills.

### Codex & other agents — via the skills CLI

Using [Vercel's skills CLI](https://github.com/vercel-labs/skills), which installs into Codex, Claude Code, Cursor and 20+ other agents:

```bash
npx skills add Kowjirow/skill-update            # pick your agent(s) when prompted
npx skills add Kowjirow/skill-update -a codex   # or target Codex directly
```

In Codex, invoke it with `$skill-update` (or `/skills` to browse), or just ask to update your skills.

### Manually (drop-in skill)

Copy the skill folder into your agent's skills directory:

```bash
git clone https://github.com/Kowjirow/skill-update
cp -R skill-update/skills/skill-update ~/.claude/skills/   # Claude Code
cp -R skill-update/skills/skill-update ~/.agents/skills/   # Codex (older setups: ~/.codex/skills/)
```

## Requirements

- **Node.js 18+** — the skill's script uses nothing else from npm: no dependency.
- **git** — every repository is read with git, so there is no GitHub API, token or rate limit, and any git host works (GitHub, GitLab, self-hosted, a local folder).
- **Network access** to the repositories your skills come from, and to [skills.sh](https://skills.sh) for `find` (optional: `--no-search`).
- Windows, macOS or Linux.

## What it does

Most skills are installed by copying a folder from a repository into `~/.claude/skills/`, a project's skills folder, or a personal library organised in sub-folders. Once copied, nothing remembers where they came from, and updating means copying again by hand and redoing your tweaks. When invoked, the skill:

1. **Asks where your skills are** — the first time only: your agent's default folder (`~/.claude/skills`, `~/.agents/skills`) or one you choose. Sub-folders are fine: every folder holding a `SKILL.md` is a skill, at any depth.
2. **Finds where each skill comes from** — from links in its files, the repositories you already track, your Claude Code marketplaces, then the public skills.sh index. Every candidate is checked file by file against its git history, so it finds the original rather than a fork, and the exact commit your copy was made from. It records that in a lock file; you give a URL only when it cannot tell.
3. **Checks what changed** — on both sides: upstream since your copy, and your own edits. It compares git blob ids, so nothing is downloaded to decide, and line endings do not count as changes.
4. **Flags what deserves a look** — a skill's scripts run with your agent's permissions, so before you accept it points out new scripts, lines that run code downloaded from the network (`curl https://… | sh`), newly pre-approved tools, hook configuration and licence changes, and shows the exact diff on request.
5. **Updates, with your consent** — a three-way merge: upstream changes are taken where you did not touch the file, merged where you both did, and a real overlap is reported as a conflict with the skill left untouched. Every replaced or removed file is backed up first, and every update is listed in a dated Markdown log.

## What's in the skill

```
skills/skill-update/
├── SKILL.md                  the procedure, the subcommands and the rules the agent follows
├── agents/openai.yaml        display name and default prompt for Codex
├── references/lockfile.md    formats: lock file, config, update log, risks, after-update report
└── scripts/
    ├── skill-update.mjs      the command line behind every subcommand
    ├── core.mjs              git plumbing, file fingerprints, the three-way plan and merge
    ├── origin.mjs            finding the repository a copied skill comes from
    ├── risks.mjs             what an update brings that deserves a look
    └── i18n.mjs              English and French messages
```

The repository also carries `.claude-plugin/` (Claude Code plugin and marketplace), `.codex-plugin/plugin.json` (Codex plugin) and the tests (`node --test`).

### Subcommands

Type a subcommand after the skill name to go straight to one action: `/skill-update revert brag` in Claude Code, `$skill-update revert brag` in Codex. A subcommand you type is your consent for that action; a high risk is always shown first and asked again.

| Subcommand | What it does |
| --- | --- |
| *(none)* | Full run: check every skill, show what changed and its risks, ask, update. |
| `check [skill…]` | Check only: what changed upstream, what you changed, what to review. Changes nothing. |
| `update [skill…]` | Update the named skills (or ask which), with merge, backups, lock and log. |
| `diff <skill>` | Show the exact text an update would change, file by file. |
| `revert <skill>` | Put back the version before the last update; run again to go further back. Also undoes an `add`. |
| `pin <skill> [why]` | Keep a skill at its version (a client project, a known-good state); `check` still says what waits. |
| `unpin <skill>` | Let a pinned skill update again. |
| `add <url> [folder]` | Copy a new skill from a repository, with its licence, and track it. Shows the files and risks first. |
| `find [skill…]` | Find where untracked skills come from; exact matches can be tracked in one go. |
| `track <skill> <url>` | Record where a copied skill comes from (the folder and commit are found for you). |
| `untrack <skill>` | Stop tracking a skill; its files stay. |
| `scan` | List the skills found and how each is tracked, offline. |
| `remind` | One line when updates wait, from the last check; can run at every session start. |
| `plugins` | Claude Code plugins behind their marketplace, with the command to update them. |
| `config [folder]` | Show or change the skills folder(s), the log folder and the after-update command. |

The script runs on its own too, with the same subcommands:

```bash
node skills/skill-update/scripts/skill-update.mjs check
node skills/skill-update/scripts/skill-update.mjs update --all --dry-run
node skills/skill-update/scripts/skill-update.mjs find --track
```

Common options: `--json` (machine-readable output), `--dry-run` (write nothing), `--lang en|fr`, `--offline` (no fetch), `--root <folder>` (one folder only), `--help`.

## Notes

- **Nothing is deleted.** Files an update replaces or removes are copied to `~/.claude/skill-update/backups/` first (`~/.agents/skill-update/` without Claude Code); `revert` uses them. A skill with a conflict is not touched at all.
- **Privacy.** `find` sends only the skill's name to the skills.sh index; `--no-search` keeps it to what your machine already knows. No other data leaves your machine besides the git fetches.
- **Review before accepting.** Risk flags are prompts to look, not verdicts: an update can still bring instructions you do not want. `diff` shows the lines.
- **Codex sandbox.** `check`, `update` and `find` need network access and write access outside the project; approve them when the sandbox asks.
- **The log** goes to `~/.claude/skill-update/logs/<date>.md` by default; `config --log-dir` moves it into your notes. An optional `afterUpdate` command receives each update report as JSON, to keep a registry or commit a vault.
- **Reminder at session start** in Claude Code — add to the `SessionStart` hooks of `~/.claude/settings.json`:

  ```json
  { "type": "command", "command": "node \"<path>/skills/skill-update/scripts/skill-update.mjs\" remind --hook", "timeout": 10 }
  ```

## License

MIT — see [LICENSE](LICENSE).
