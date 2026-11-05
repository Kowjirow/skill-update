# skill-update

Keeps the skills you copied from GitHub (or any git repository) up to date, in any folder, without losing your own edits. Works in Claude Code (`/skill-update`), Codex (`$skill-update`) and any agent that reads `SKILL.md`.

## Use

Ask your agent to update your skills, or type `/skill-update` (`$skill-update` in Codex). The first time, it asks where your skills are: your agent's default folder or one you choose, sub-folders included. Then it:

1. finds where each skill came from (repository, folder, commit);
2. shows what changed upstream, what you changed, and what deserves a look (new scripts, code downloaded and run, pre-approved tools, licence changes);
3. updates only what you approve, with a three-way merge that keeps your edits, a backup of every replaced file and a dated log.

Go straight to one action with a subcommand: `check`, `update`, `diff`, `revert`, `pin`, `unpin`, `add`, `find`, `track`, `remind`… — the full list is at the top of `SKILL.md`.

## Requirements

Node.js 18+ and git. Network access to the skills' repositories, and to the skills.sh index for `find` (`--no-search` to skip it). No dependency, no API key.

## Settings

Everything is set with `node scripts/skill-update.mjs config`:

| Option | What it sets |
| --- | --- |
| `--root default\|claude\|agents\|codex\|<folder>` | a skills folder to manage (several are allowed) |
| `--lock <file>` | where that folder's lock file lives (default: `<folder>/.skill-update-lock.json`) |
| `--log-dir <folder>` | where the dated update logs go (default: `~/.claude/skill-update/logs`) |
| `--after-update "<command>"` | a command run after each update, with the report as JSON on standard input |
| `--ignore <a,b>` | folder names or paths to skip |
| `--lang en\|fr` | language of the script's messages |

Config, cache, backups and logs live in `~/.claude/skill-update/` (`~/.agents/skill-update/` without Claude Code; `SKILL_UPDATE_HOME` moves it).

The after-update command runs without a shell, and only when you set it: your agent never sets it on its own.

## Security

No package install, no `sudo`, no telemetry, no change to your agent's settings. The network is used only for git fetches from the skills' repositories and, for `find`, to send a skill's name to the skills.sh index. Writes stay inside the skill being updated: a file name from a repository that leads outside its folder is refused. The full list of what is read, written, sent and run is in the `Security` section of `SKILL.md`.

## Files

- `SKILL.md` — what the agent follows.
- `scripts/` — the command line (`skill-update.mjs`) and its modules.
- `references/lockfile.md` — formats: lock file, config, log, risks, after-update report.
- `examples/` — sample check and update reports, and a dated log page.

Source, tests and issues: https://github.com/Kowjirow/skill-update — MIT licence.
