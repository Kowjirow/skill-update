# Sample update report

What the agent shows after `update`, following the layout in `SKILL.md` (step 4).

---

**3 skills updated** · backups: `~/.claude/skill-update/backups/2026-11-03T21-06-47-512Z` · log: `~/.claude/skill-update/logs/2026-11-03.md`

- `anthropic/mcp-builder` `dbd4588f → ca45fc49`: 2 updated, 1 added
- `redaction/humanizer` `8c307f36 → 0ef9fe5b`: 1 merged (your edits kept)
- `vercel/deploy-to-vercel` `063bee94 → 1a2c79d4`: 1 updated, 3 removed (moved to the backup)
- **Not updated, conflict:** `linkedin/li-human` in `slop.json` → keep yours (`--ours`), take upstream (`--theirs`), or merge by hand
- **After-update command:** `node ~/notes/tools/after-skill-update.mjs` → exit 0: "registry updated"

To undo one: `/skill-update revert mcp-builder`.
