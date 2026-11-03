# skill-update

[Français](README.fr.md)

A Claude Code skill (`/skill-update`) that keeps the skills you **copied from GitHub** up to date, in any folder, without losing your own edits.

Most skills are installed by copying a folder from a repository into `~/.claude/skills/`, a project's `.claude/skills/`, or a personal library organised in sub-folders. Once copied, nothing remembers where they came from, and updating means copying again by hand and redoing your tweaks. `skill-update` fixes that:

- **Any folder, any depth.** You choose the folder on first run: the default `~/.claude/skills` or your own. Every folder holding a `SKILL.md` is found, even in sub-folders (`video/brag`) or plugin wrappers.
- **Knows where each skill comes from.** `track` finds the repository folder and even the exact commit your copy was made from, and records it in a lock file.
- **Keeps your edits.** Updates are three-way merges (`git merge-file`): your local patches survive, a real overlap is reported as a conflict and the skill is left untouched.
- **Safe.** Shows upstream commits before anything is written, asks before updating, copies every replaced or removed file to a backup folder, never deletes a skill.
- **No API, no token, no rate limit.** It uses git directly (bare, blobless clones in a cache), so it works with GitHub, GitLab, any git host or a local folder, on any default branch.
- **The rest of your skills too.** Adopts skills installed by `npx skills`, fast-forwards skills that are git clones, and lists Claude Code plugins behind their marketplace with the command to update them.
- **English and French** messages, picked from your locale or `--lang`.

Requirements: Node.js 18+ and git. No dependency.

## Install

As a Claude Code plugin:

```
/plugin marketplace add <owner>/skill-update
/plugin install skill-update@skill-update
```

Or with the skills CLI: `npx skills add <owner>/skill-update`.

Or by hand: copy `skills/skill-update/` into `~/.claude/skills/`.

## Use

In Claude Code, type `/skill-update` or ask "update my skills". The skill asks for your skills folder the first time, checks every skill, shows what changed, and updates what you approve.

The script also runs on its own:

```bash
node skills/skill-update/scripts/skill-update.mjs config --root default        # or --root <folder>
node skills/skill-update/scripts/skill-update.mjs check
node skills/skill-update/scripts/skill-update.mjs track brag https://github.com/latent-spaces/brag/tree/main/skills/brag
node skills/skill-update/scripts/skill-update.mjs update --all --dry-run
node skills/skill-update/scripts/skill-update.mjs update --all
node skills/skill-update/scripts/skill-update.mjs plugins
```

`--json` on any command gives machine-readable output. `--help` lists every option.

## How it works

For each tracked skill the lock file records the source, the folder in the repository and the commit the copy matches. `check` fetches the source and compares three versions of every file by their git blob ids: the recorded commit (base), the current head (upstream) and your copy (local). Line endings do not count as changes. `update` then takes upstream where you did not touch the file, merges where you both did, and moves to the backup what upstream deleted. Details: [references/lockfile.md](skills/skill-update/references/lockfile.md).

An optional `afterUpdate` command receives the update report as JSON, to update a registry, write a changelog or commit.

## Tests

```bash
node --test
```

## Credits

Inspired by [yizhiyanhua-ai/skills-updater](https://github.com/yizhiyanhua-ai/skills-updater), which checks plugin and `npx skills` installs. `skill-update` adds what it leaves out: skills copied by hand into any folder, real three-way merges, and git instead of the GitHub API.

## License

MIT
