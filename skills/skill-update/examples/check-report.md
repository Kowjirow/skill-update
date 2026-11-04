# Sample check report

What the agent shows after `check`, following the layout in `SKILL.md` (step 2). Taken from a real library of 139 skills, shortened.

---

**139 skills checked · 21 to update · 0 in conflict · 0 not tracked**

| Skill | Version | Upstream commits | Files | To review |
| --- | --- | --- | --- | --- |
| `anthropic/mcp-builder` | `dbd4588f → ca45fc49` | 1 | 2 updated, 1 added | — |
| `developpement/implement-spec` | `49dd158d → 4ae2317d` | 2 | 1 updated | — |
| `frontend/taste-skill` | `b9ca2fd8 → 12af471f` | 9 | 8 updated, 1 added | ‼ new script `scripts/lib/inspection-files.mjs` |
| `higgsfield/higgsfield-video-explainer` | `9b13ee6c → 4d075747` | 1 | 1 updated, 1 removed | — |
| `vercel/deploy-to-vercel` | `063bee94 → 1a2c79d4` | 3 | 1 updated, 3 removed | — |

- **Changes upstream:**
  - `anthropic/mcp-builder`: ca45fc4 2026-10-28 Update mcp-builder skill: teach v2 of the MCP TypeScript SDK
  - `developpement/implement-spec`: a496f55 2026-10-29 implement-spec: a fresh implementer subagent per ticket; 7739eae 2026-10-29 Start subagents with a fresh context window, not a fork
  - `frontend/taste-skill`: af8a897 2026-10-25 v2.1.5: community fixes and an encoding check … and 8 more
  - `vercel/deploy-to-vercel`: dfeeb54 2026-10-27 fix(deploy-to-vercel): clarify sandbox login check … and 2 more
- **Also to review:** `frontend/taste-skill` changes 7 existing scripts (`assets/charts.js`, `scripts/inspect.mjs`, …).
- **Your own edits, kept:** `linkedin/li-human` (`detect.py`, `slop.json`), `redaction/humanizer` (`SKILL.md`).
- **Up to date:** 116.

Update all 21, choose some, or cancel? `frontend/taste-skill` brings a new script: say its name to include it.
