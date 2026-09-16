# Probe inputs

Four plugins in one marketplace, differing only in how the skills directory is
named. Run them under an isolated home, from inside a throwaway project:

```
export CODEX_HOME=<scratch>/home
codex plugin marketplace add <this directory>
for p in control-native probe-extensions no-declaration custom-path; do
  codex plugin add "$p@hooknostic-extensions-probe"
done
codex debug prompt-input > prompt.json
```

Then look for each marker in `prompt.json`:

| Marker | Expected on 0.154.0 |
| --- | --- |
| `CONTROL_NATIVE_MARKER` | present — positive control, the form Hooknostic emits |
| `NO_DECLARATION_MARKER` | present — `skills/` is conventional |
| `PROBE_EXTENSIONS_MARKER` | present, but explained by the row above, not by the map |
| `CUSTOM_PATH_MARKER` | **absent** — the decisive negative |

`CUSTOM_PATH_MARKER` is the only row that carries the finding. The other three
exist to stop it being read as a broken package: they establish that the
observation channel works, that conventional discovery happens, and that the
extensions form is not rejected at install time.

`codex debug prompt-input` renders the model-visible input without starting a
session, so no credentials and no spend are involved.
