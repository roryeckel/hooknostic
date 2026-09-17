# Probe inputs

`run.mts` installs seven hook probes into an isolated `CODEX_HOME`, drives one
real Codex session against the repository's credential-free loopback model
server, and compares marker-file effects:

| Plugin | Purpose | Observed on 0.154.0 |
| --- | --- | --- |
| `inline-hooks` | supported `extensions.com.openai.hooks` route | marker absent |
| `native-hooks-control` | native compatibility-manifest control | marker present |
| `native-hooks-path-array` | native `hooks` as a two-path array | both markers present |
| `native-hooks-inline-object` | native `hooks` as one inline document | marker present |
| `native-hooks-inline-array` | native `hooks` as a two-document array | both markers present |
| `native-hooks-undeclared-file` | no `hooks` key; root `hooks.json` undeclared | marker absent |
| `native-hooks-inline-beside-file` | inline document beside an undeclared root `hooks.json` | inline marker present, file marker absent |

The five form probes are installed without failing the run, and their
`codex plugin add` exit codes are part of the printed result: a manifest Codex
refused would be an observation, not a broken probe. The version comes from
`codex --version` rather than a literal.

Run from the repository root:

```sh
node --experimental-strip-types .capture/codex-client-extension/probe/run.mts
```

The older skill probes remain for provenance. They establish conventional
`skills/` discovery, but `custom-path` is not evidence about whether the OpenAI
object is read: official documentation says a portable package's fixed
`skills/` directory is canonical and an inline `skills` value cannot replace
it.
