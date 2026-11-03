# skill-update

[Français](README.fr.md)

An agent skill for Claude Code (`/skill-update`) and Codex (`$skill-update`) that keeps the skills you **copied from GitHub** up to date, in any folder, without losing your own edits.

Most skills are installed by copying a folder from a repository into `~/.claude/skills/`, a project's `.claude/skills/`, or a personal library organised in sub-folders. Once copied, nothing remembers where they came from, and updating means copying again by hand and redoing your tweaks. `skill-update` fixes that:

- **Any folder, any depth.** You choose the folder on first run: your agent's default (`~/.claude/skills` for Claude Code, `~/.agents/skills` for Codex) or your own. Every folder holding a `SKILL.md` is found, even in sub-folders (`video/brag`) or plugin wrappers.
- **Knows where each skill comes from.** `track` finds the repository folder and even the exact commit your copy was made from, and records it in a lock file.
- **Keeps your edits.** Updates are three-way merges (`git merge-file`): your local patches survive, a real overlap is reported as a conflict and the skill is left untouched.
- **Safe.** Shows upstream commits before anything is written, asks before updating, copies every replaced or removed file to a backup folder, never deletes a skill.
- **A dated log.** Every update is listed in `<date>.md`: the skills, their commits before and after, the files changed and the upstream commit subjects. Put the log folder wherever you keep notes.
- **Flags what deserves a look.** A skill's scripts run with your agent's permissions. Before you accept, it points out new scripts, lines that run code downloaded from the network (`curl … | sh`), newly pre-approved tools, hook configuration and licence changes, and `diff` shows the exact text.
- **Undo, pin, add.** `revert` puts back the version before the last update; `pin` keeps a skill where it is; `add` copies a new skill from GitHub with its licence and tracks it in one step.
- **A reminder.** `remind` prints one line when updates wait, from the last check, and refreshes that check in the background once a week. In Claude Code it can run as a session-start hook.
- **No API, no token, no rate limit.** It uses git directly (bare, blobless clones in a cache), so it works with GitHub, GitLab, any git host or a local folder, on any default branch.
- **The rest of your skills too.** Adopts skills installed by `npx skills`, fast-forwards skills that are git clones, and lists Claude Code plugins behind their marketplace with the command to update them.
- **English and French** messages, picked from your locale or `--lang`.

Requirements: Node.js 18+ and git. No dependency.

## Install

**Claude Code**, as a plugin:

```
/plugin marketplace add <owner>/skill-update
/plugin install skill-update@skill-update
```

or by hand: copy `skills/skill-update/` into `~/.claude/skills/`.

**Codex**: copy `skills/skill-update/` into `~/.agents/skills/` (or a project's `.agents/skills/`). The repository also carries a Codex plugin manifest, `.codex-plugin/plugin.json`, and `agents/openai.yaml` gives Codex the skill's display name.

**Any agent**, with the skills CLI: `npx skills add <owner>/skill-update`.

## Use

Type `/skill-update` in Claude Code or `$skill-update` in Codex, or ask "update my skills". The skill asks for your skills folder the first time, checks every skill, shows what changed, and updates what you approve. Claude Code and Codex share one configuration, so a folder used by both is tracked once.

The script also runs on its own:

```bash
node skills/skill-update/scripts/skill-update.mjs config --root claude         # or agents, codex, <folder>
node skills/skill-update/scripts/skill-update.mjs check
node skills/skill-update/scripts/skill-update.mjs track brag https://github.com/latent-spaces/brag/tree/main/skills/brag
node skills/skill-update/scripts/skill-update.mjs diff brag
node skills/skill-update/scripts/skill-update.mjs update --all --dry-run
node skills/skill-update/scripts/skill-update.mjs update --all
node skills/skill-update/scripts/skill-update.mjs revert brag
node skills/skill-update/scripts/skill-update.mjs pin brag --note "client project"
node skills/skill-update/scripts/skill-update.mjs add https://github.com/anthropics/skills/tree/main/skills/canvas-design --to design --dry-run
node skills/skill-update/scripts/skill-update.mjs remind
node skills/skill-update/scripts/skill-update.mjs plugins
```

Reminder at each Claude Code session start, in `~/.claude/settings.json`:

```json
{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"<path>/skills/skill-update/scripts/skill-update.mjs\" remind --hook", "timeout": 10 }] }] } }
```

`--json` on any command gives machine-readable output. `--help` lists every option.

## How it works

For each tracked skill the lock file records the source, the folder in the repository and the commit the copy matches. `check` fetches the source and compares three versions of every file by their git blob ids: the recorded commit (base), the current head (upstream) and your copy (local). Line endings do not count as changes. `update` then takes upstream where you did not touch the file, merges where you both did, and moves to the backup what upstream deleted. Details: [references/lockfile.md](skills/skill-update/references/lockfile.md).

Each update adds a section to `<log folder>/<YYYY-MM-DD>.md` (`config --log-dir <folder>`, default `~/.claude/skill-update/logs`). An optional `afterUpdate` command receives the update report as JSON, to update a registry or commit.

## Tests

```bash
node --test
```

## Credits

Inspired by [yizhiyanhua-ai/skills-updater](https://github.com/yizhiyanhua-ai/skills-updater), which checks plugin and `npx skills` installs. `skill-update` adds what it leaves out: skills copied by hand into any folder, real three-way merges, and git instead of the GitHub API.

## License

MIT
