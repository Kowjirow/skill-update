// What an update brings that deserves a look before it is applied. A skill's
// scripts run with the agent's permissions, and its instructions steer it: new
// scripts, commands that run code fetched from the network, pre-approved tools,
// hook configuration and licence changes are flagged. Lines already present
// before the update are not flagged again.

import { isBinary } from "./core.mjs";

const SCRIPT = /\.(sh|bash|zsh|fish|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php)$/i;
const HOOK_CONFIG = /(^|\/)(hooks\/hooks\.json|\.mcp\.json|settings(\.local)?\.json|\.claude-plugin\/plugin\.json|\.codex-plugin\/plugin\.json)$/i;
const LICENSE = /(^|\/)(LICEN[CS]E|COPYING|NOTICE)(\.[a-z]+)?$/i;

// [reason, level, pattern]: checked on every line the update adds.
const LINES = [
  ["pipe-to-shell", "high", /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/i],
  ["pipe-to-shell", "high", /\|\s*(iex|Invoke-Expression)\b/i],
  ["pipe-to-shell", "high", /\bbase64\s+(-d|--decode)\b[^\n]*\|\s*(ba|z)?sh\b/i],
  ["wipe", "high", /\brm\s+-[a-z]*(rf|fr)[a-z]*\s+(\/|~|\$HOME|\$\{HOME\})(\s|\/?\*?$|["'])/i],
  ["shell-profile", "medium", /(>>?\s*(~|\$HOME)\/\.(bashrc|zshrc|profile|bash_profile)\b|\$PROFILE\b)/],
  ["sudo", "medium", /(^|[\s;&|`(])sudo\s+\S/],
];

const text = (buf) => (buf && !isBinary(buf) ? buf.toString("utf8") : null);
const lines = (s) => new Set((s ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
const clip = (s) => (s.length > 160 ? `${s.slice(0, 157)}…` : s);

function frontmatter(s, key) {
  const head = s?.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  return head?.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1].trim() ?? null;
}

// changes: [{ rel, before: Buffer|null, after: Buffer|null, mode }] for files the
// update writes. Returns [{ level, reason, rel, detail? }], high first.
export function assessRisks(changes) {
  const risks = [];
  const add = (level, reason, rel, detail) => risks.push({ level, reason, rel, ...(detail && { detail: clip(detail) }) });
  for (const { rel, before, after, mode } of changes) {
    if (!after) continue;
    const script = SCRIPT.test(rel) || mode === "100755";
    if (script && !before) add("high", "new-script", rel);
    else if (script && !before.equals(after)) add("medium", "script-changed", rel);
    if (HOOK_CONFIG.test(rel) && !(before && before.equals(after))) add("high", "hook-config", rel);
    if (LICENSE.test(rel) && before && !before.equals(after)) add("medium", "license-changed", rel);

    const now = text(after);
    if (now === null) continue;
    const was = text(before);
    if (/(^|\/)SKILL\.md$/.test(rel)) {
      const tools = frontmatter(now, "allowed-tools");
      if (tools && tools !== frontmatter(was, "allowed-tools")) add("high", "allowed-tools", rel, `allowed-tools: ${tools}`);
      const license = frontmatter(now, "license");
      if (was && license !== frontmatter(was, "license")) add("medium", "license-changed", rel, `license: ${license ?? "—"}`);
    }
    const old = lines(was);
    const seen = new Set();
    for (const line of lines(now)) {
      if (old.has(line)) continue;
      for (const [reason, level, rx] of LINES) {
        if (rx.test(line) && !seen.has(`${reason}\0${line}`)) {
          seen.add(`${reason}\0${line}`);
          add(level, reason, rel, line);
        }
      }
    }
  }
  return risks.sort((a, b) => (a.level === b.level ? 0 : a.level === "high" ? -1 : 1));
}
