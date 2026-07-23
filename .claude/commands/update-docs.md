---
description: Update BOTH the website docs (docs-site) and the agent docs (CLAUDE.md + doc/) to reflect the current code, then build & deploy the site.
argument-hint: "[optional area or git range, e.g. 'recorder' or 'HEAD~3..HEAD']"
---

You are updating **all** SATE Companion documentation to match the current code. There are two
doc surfaces, with different rules — keep them consistent with each other and with the code.

- **Website docs** (`docs-site/docs/`) — *how it works*, for engineers. Rules:
  **no code line numbers** (they churn on every edit — keep file/function names instead),
  **no emoji**, every version **reflects real code**, deployed to `sate-docs.pages.dev`.
- **Agent docs** (`CLAUDE.md` + `doc/01..09`) — the **line-precise, code-anchored** detail for
  agents. This is where exact functions/files/behaviors live.

## Procedure

1. **Find what changed.** Run `git log --oneline -15` and `git status`/`git diff` (working tree).
   If `$ARGUMENTS` names an area (recorder/pendant/app/web/backend/hwtest/cli) or a git range,
   focus there. List the components touched.

2. **Enforce the version rule.** ANY firmware change must bump `FIRMWARE_VERSION`:
   recorder `SATE_Recorder/SATE_Recorder.ino`, pendant `SATE_Pendant/SATE_Pendant.ino`.
   If a firmware file changed but the version didn't, **bump it (patch)** before continuing.

3. **Update the website docs** for each change:
   - the relevant guide/reference/operations page (describe the new behavior — no line numbers),
   - `docs-site/docs/changelog.md` (a new version row for the component),
   - current-version **badges + version matrix** (intro.md, getting-started.md, the component
     guide badge) — only the "current" references, not historical "since ≥X" notes.

4. **Update the agent docs**: the matching `CLAUDE.md` section(s) and `doc/0N-*.md`, with the
   line-precise detail (functions, files, gotchas).

5. **Verify consistency** (read from source, don't assume):
   - versions in docs == code: `grep FIRMWARE_VERSION SATE_Recorder/*.ino SATE_Pendant/*.ino`,
     `react_app_sate-ui_update/package.json`, `package.json`, device-api `vNN` comment.
   - if app/web/api changed, update `monitoring/index.html` `STATIC_VERSIONS` too.
   - no emoji left: `grep -rlP '[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}]' docs-site/docs` → empty.
   - no line-number spans left: `grep -rlP '\x60:\d' docs-site/docs` → only intended (none).

6. **Build & deploy the website docs:**
   `cd docs-site && npm run build` (must succeed, warnings only) then
   `npm run deploy:cf`. Report the deployment URL.

7. **Report** a concise list of every doc file changed (website + agent) and the deploy URL.

Constraints: be surgical — touch only what the code changes require. **Do not alter the Plaud
device-lock safety wording** in `docs-site/docs/guides/plaud.md` or `CLAUDE.md` RULE #1.
Commit only if the user asks.
