# Does Codex read `extensions.com.openai`?

## Question

OpenAI's plugin documentation assigns presentation, registered app mappings,
and lifecycle hooks to `extensions.com.openai` in a portable root `plugin.json`.
It also says the inline object replaces `.codex-plugin/plugin.json`, while root
identity plus the fixed portable `skills/` and `mcp.json` components remain
canonical:

<https://developers.openai.com/plugins/build/plugins#add-openai-specific-metadata>

Does the shipped Codex CLI implement that documented portable route, or does a
projector still need to carry the OpenAI object into the native compatibility
manifest?

## Evidence classes

- **Live probe:** `codex-cli` **0.154.0**, **2026-09-17**, native Windows,
  isolated `CODEX_HOME`, credential-free loopback model server. A
  `UserPromptSubmit` hook writes a marker file, so the observation is the hook's
  effect rather than CLI status text.
- **Doc-derived:** the inline-object/overlay precedence, canonical portable
  fields, and accepted `hooks` forms come from the official OpenAI documentation
  linked above. The live binary cannot establish merge precedence for an inline
  object it does not consume.

No model provider or credentials were used. `probe/run.mts` removes API keys
from the child environment, starts the repository's loopback Responses server,
and places plugin state and user state under a temporary directory that it
removes after printing the result.

## Method

Two plugins are installed from the same local marketplace and enabled in one
Codex session:

| Plugin | Manifest | Hook declaration |
| --- | --- | --- |
| `inline-hooks` | portable root `plugin.json` | `extensions.com.openai.hooks = "./hooks.json"` |
| `native-hooks-control` | `.codex-plugin/plugin.json` | `hooks = "./hooks.json"` |

Their hook documents and marker scripts are otherwise equivalent. The session
runs with `--dangerously-bypass-hook-trust` against the loopback model server.
The native plugin is the positive control: if it fails, the run says nothing
about the inline object.

Run from the repository root:

```sh
node --experimental-strip-types .capture/codex-client-extension/probe/run.mts
```

The observed result was:

```json
{
  "version": "0.154.0",
  "inline": null,
  "native": {
    "fired": true,
    "pluginRoot": "<scratch>/codex-home/plugins/cache/hooknostic-extensions-probe/native-hooks-control/1.0.0"
  }
}
```

## Observation

**Codex 0.154.0 does not honour the documented inline `hooks` field.** The
native control fired in the same process, proving plugin hook delivery, trust
bypass, the marker command, and the observation channel all worked. The portable
plugin's marker remained absent.

This supersedes the first version of this probe, which used
`extensions.com.openai.skills = "./custom-skills/"` as its negative. That was
not a valid discriminator: the official documentation says portable packages
always discover skills from the fixed `skills/` directory and that an inline
`skills` declaration cannot replace it. The earlier run did establish
conventional `skills/` discovery, but not whether Codex read the OpenAI object.
Those inputs remain in `probe/plugins/` as a record of the corrected method;
they no longer support the namespace conclusion.

## Consequences

- The Codex projector declares `com.openai` and translates the selected OpenAI
  settings into the native manifest that 0.154.0 actually consumes.
- The inline object replaces the compatibility overlay rather than merging with
  it, following the official documented precedence.
- Root identity, portable skills, and portable MCP declarations remain
  canonical. Inline `skills` and `mcpServers` values do not replace them.
- Authored `hooks` survive. When Hooknostic also generates a hook document, the
  projector composes both with the matching documented path-array or
  inline-object-array form instead of replacing the author's declaration.
- `agent-plugin.client-extension.files` remains `exact`: the compiler bridges a
  documented route missing from this CLI build without dropping supported
  settings.

## Not established

- Whether a later Codex release begins consuming `extensions.com.openai`
  directly.
- Live precedence between an inline object and compatibility overlay on a build
  that consumes both. Current precedence is doc-derived.
- Runtime effects of `apps` or `interface`; the projector carries them unchanged.
- Linux and macOS behavior. Windows only.
