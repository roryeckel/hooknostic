# Probe inputs

`run.mts` installs two hook probes into an isolated `CODEX_HOME`, drives one
real Codex session against the repository's credential-free loopback model
server, and compares marker-file effects:

| Plugin | Purpose | Expected on 0.154.0 |
| --- | --- | --- |
| `inline-hooks` | supported `extensions.com.openai.hooks` route | marker absent |
| `native-hooks-control` | native compatibility-manifest control | marker present |

Run from the repository root:

```sh
node --experimental-strip-types .capture/codex-client-extension/probe/run.mts
```

The older skill probes remain for provenance. They establish conventional
`skills/` discovery, but `custom-path` is not evidence about whether the OpenAI
object is read: official documentation says a portable package's fixed
`skills/` directory is canonical and an inline `skills` value cannot replace
it.
