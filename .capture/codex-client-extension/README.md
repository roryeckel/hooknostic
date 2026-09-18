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
  effect rather than CLI status text. This class covers whether the inline
  route is consumed and which `hooks` forms the native manifest accepts: the
  single path, a path array, an inline hook document, and an inline-document
  array each ran their markers.
- **Doc-derived:** the inline-object/overlay precedence and the canonical
  portable fields come from the official OpenAI documentation linked above.
  The live binary cannot establish merge precedence for an inline object it
  does not consume.

No model provider or credentials were used. `probe/run.mts` removes API keys
from the child environment, starts the repository's loopback Responses server,
and places plugin state and user state under a temporary directory that it
removes after printing the result.

## Method

Seven plugins are installed from the same local marketplace and enabled in one
Codex session:

| Plugin | Manifest | Hook declaration |
| --- | --- | --- |
| `inline-hooks` | portable root `plugin.json` | `extensions.com.openai.hooks = "./hooks.json"` |
| `native-hooks-control` | `.codex-plugin/plugin.json` | `hooks = "./hooks.json"` |
| `native-hooks-path-array` | `.codex-plugin/plugin.json` | `hooks = ["./hooks-a.json", "./hooks-b.json"]` |
| `native-hooks-inline-object` | `.codex-plugin/plugin.json` | `hooks = { hooks: { UserPromptSubmit: [...] } }` |
| `native-hooks-inline-array` | `.codex-plugin/plugin.json` | `hooks = [{ hooks: ... }, { hooks: ... }]` |
| `native-hooks-undeclared-file` | `.codex-plugin/plugin.json` | none; a root `hooks.json` ships undeclared |
| `native-hooks-inline-beside-file` | `.codex-plugin/plugin.json` | `hooks = { hooks: ... }`, plus an undeclared root `hooks.json` |

Their hook documents and marker scripts are otherwise equivalent; the two
array probes and the inline-beside-file probe write one marker per source, so a
single marker cannot be read as two sources having run. The session runs with
`--dangerously-bypass-hook-trust` against the loopback model server. The native
single-path plugin is the positive control: if it fails, the run says nothing
about the other six. Installation of the five form probes is recorded rather
than required, because a manifest Codex refuses to install would itself be the
observation.

The last two plugins answer a question the projector's output raises. When an
author inlines their `hooks` object, the projector inlines the generated
document beside it, but the generated `hooks.json` file is still emitted at the
package root because core verifies that every hook artifact survives. If Codex
discovered an undeclared root `hooks.json` by convention, the generated hooks
would run twice on that path.

Run from the repository root:

```sh
node --experimental-strip-types .capture/codex-client-extension/probe/run.mts
```

The observed result was:

```json
{
  "version": "0.154.0",
  "installed": {
    "native-hooks-path-array": { "code": 0 },
    "native-hooks-inline-object": { "code": 0 },
    "native-hooks-inline-array": { "code": 0 },
    "native-hooks-undeclared-file": { "code": 0 },
    "native-hooks-inline-beside-file": { "code": 0 }
  },
  "inline": null,
  "native": {
    "fired": true,
    "pluginRoot": "<scratch>/codex-home/plugins/cache/hooknostic-extensions-probe/native-hooks-control/1.0.0"
  },
  "pathArray": {
    "a": { "fired": true, "entry": "a", "pluginRoot": "<scratch>/codex-home/plugins/cache/hooknostic-extensions-probe/native-hooks-path-array/1.0.0" },
    "b": { "fired": true, "entry": "b", "pluginRoot": "<scratch>/codex-home/plugins/cache/hooknostic-extensions-probe/native-hooks-path-array/1.0.0" }
  },
  "inlineObject": {
    "fired": true,
    "pluginRoot": "<scratch>/codex-home/plugins/cache/hooknostic-extensions-probe/native-hooks-inline-object/1.0.0"
  },
  "inlineArray": {
    "a": { "fired": true, "entry": "a", "pluginRoot": "<scratch>/codex-home/plugins/cache/hooknostic-extensions-probe/native-hooks-inline-array/1.0.0" },
    "b": { "fired": true, "entry": "b", "pluginRoot": "<scratch>/codex-home/plugins/cache/hooknostic-extensions-probe/native-hooks-inline-array/1.0.0" }
  },
  "undeclaredFile": null,
  "inlineBesideFile": {
    "inline": { "fired": true, "entry": "inline", "pluginRoot": "<scratch>/codex-home/plugins/cache/hooknostic-extensions-probe/native-hooks-inline-beside-file/1.0.0" },
    "file": null
  }
}
```

Each `installed` entry's `stderr` carried only Codex's warning that it would
not create PATH alias binaries under a temporary `CODEX_HOME`; it is elided
here. `<scratch>` stands for the temporary directory, whose real path carries
the capturing account's home. The `undeclaredFile` and `inlineBesideFile`
fields come from a second run of the same script on 2026-09-17, after the two
plugins were added; every earlier field reproduced.

## Observation

**Codex 0.154.0 does not honour the documented inline `hooks` field.** The
native control fired in the same process, proving plugin hook delivery, trust
bypass, the marker command, and the observation channel all worked. The portable
plugin's marker remained absent.

**The native manifest accepts every documented `hooks` form.** In the same
session the path-array plugin ran both of its documents, the inline-object
plugin ran its document, and the inline-array plugin ran both of its entries.
All three installed without complaint. The forms the projector emits when it
composes an author's declaration with the generated `hooks.json` are therefore
observed on this build, not inferred from the documentation.

**An undeclared root `hooks.json` is inert beside a native manifest.** The
plugin whose manifest had no `hooks` key left its marker absent, and the plugin
declaring an inline hook document beside an undeclared `hooks.json` ran only
the inline marker. Both installed without complaint, and the single-path
control fired in the same session, so the absent markers are the observation
and not a broken run. This extends the 0.153.2 finding that a portable package
fired nothing from `hooks.json` or `hooks/hooks.json`
(`.capture/codex-plugin-hooks`) to the native manifest: Codex runs the hooks
its manifest names, and only those.

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
  projector composes both with the matching path-array or inline-object-array
  form instead of replacing the author's declaration. Both composed forms ran
  their markers on 0.154.0, so the composition rests on the live probe rather
  than on the documentation alone.
- The generated `hooks.json` file the projector still emits when it inlines
  the generated document beside an author's inline object does not make those
  hooks run twice: nothing names it, and an unnamed root `hooks.json` is not
  discovered. The projector's `hooks` composition is `exact` for the inline
  path on the strength of this run, not of an assumption about discovery.
- An authored path that already names the generated document
  (`hooks: "./hooks.json"`, the documentation's own example) is folded into
  the generated entry rather than appended beside it, because the path-array
  probe shows Codex runs every entry of the array.
- `agent-plugin.client-extension.files` remains `exact`: the compiler bridges a
  documented route missing from this CLI build without dropping supported
  settings.

## Not established

- Whether a later Codex release begins consuming `extensions.com.openai`
  directly.
- Live precedence between an inline object and compatibility overlay on a build
  that consumes both. Current precedence is doc-derived.
- Runtime effects of `apps` or `interface`; the projector carries them unchanged.
- Hook forms were exercised on `UserPromptSubmit` with two entries per array.
  Other events and longer arrays are assumed to follow the same reader.
- Whether an undeclared `hooks.json` at any other location (for example
  `hooks/hooks.json`, or under `.codex-plugin/`) is discovered beside a native
  manifest. Only the package root was probed, because that is the path the
  projector emits.
- Whether a path array naming the same document twice runs it twice. The
  path-array probe used two distinct documents; the projector avoids the
  duplicate rather than relying on Codex to collapse it.
- Linux and macOS behavior. Windows only.
