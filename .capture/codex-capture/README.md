# Codex tee-capture template

Committed, path-independent capture project for the Codex CLI hook boundary.
It serves the harness-watch drift lane (plan step 7: `drive-capture-session.mjs`
copies it into a scratch dir and instantiates the hooks template) and manual
captures — the same session shape `.capture/codex/` captured the 0.148
fixtures with, minus the absolute Windows path that made that project
unusable from a fresh checkout.

## Layout

- `capture.mjs` — the tee: appends the hook's stdin JSON to
  `captured/<Event>.jsonl`. Locates `captured/` relative to itself
  (`import.meta.dirname`), so a copied instantiation just works.
- `.codex/hooks.json.template` — Claude-compatible PascalCase hook table
  (the shape codex-cli 0.148 actually loads — see
  `fixtures/codex/0.148/README.md`) with a `${CAPTURE_DIR}` placeholder.
  **Codex hook commands carry no project-dir variable**, so the template must
  be instantiated with the real absolute install path before a session:
  `.codex/hooks.json` is generated and gitignored (root `.gitignore` rule
  mirrors `.capture/codex-output/`).

## Instantiation (what a driver does, or you by hand)

```bash
node -e "
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const dir = process.argv[1];
mkdirSync(dir + '/captured', { recursive: true });
writeFileSync(dir + '/.codex/hooks.json',
  readFileSync(dir + '/.codex/hooks.json.template', 'utf8')
    .replaceAll('\${CAPTURE_DIR}', dir.replaceAll('\\\\', '/')));
" "$(pwd -W 2>/dev/null || pwd)"
```

`captured/` is emptied before each drive; it stays untracked via the existing
`.capture/*/captured/` ignore rule.

## Trust (the gotcha that has each cost a session)

Repo-level `.codex/hooks.json` loads only in **trusted** projects — untrusted
means hooks silently never fire, with no error. A scratch dir is untrusted by
default, so every automated drive must pair the tee with the inline trust
override and the hook-trust bypass, exactly as the playback suite does:

```
codex exec - --dangerously-bypass-hook-trust \
  -c 'projects={"<scratch>"={trust_level="trusted"}}' ...
```

On Windows, `[windows] sandbox = "unelevated"` (or the full-access sandbox
override) is also required or every spawn is policy-rejected — and the harness
may still *report success*. `codex exec` reads its prompt from stdin and hangs
without stdin EOF.

## What the teed payloads are

Native hook-boundary stdin payloads — the same class as
`fixtures/codex/0.148/*.input.json` (**captured** provenance when taken from a
real session with version and date recorded). The comparator
(`scripts/compare-capture-shapes.mjs`) diffs their shapes against those
fixtures; drift routes humans to the harness-capture skill. This project never
upgrades provenance by itself; a README row in the fixtures directory does.

## Smoke (clean-clone verification, 2026-09-02)

Verified from a fresh `git clone` (template committed, scratch dir outside the
repo) against codex-cli 0.152.1 with the loopback playback model and the trust
override from this README: hooks fired (`SessionStart`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`) and the comparator's
verdict was **clean** — captured payload shapes match the committed 0.148
fixtures, i.e. the hook boundary is unchanged between 0.148.0 and 0.152.1 for
the session lifecycle, prompt, and Bash tool events this drive exercises.
The template instantiates path-independently (no absolute repo paths).