# Does Codex read a portable client-extension namespace?

## Question

`agent-plugin.client-extension.files` is `unsupported` on Codex, and the
rationale asserted that "Codex reads no portable client-extension namespace".
`.capture/codex-agent-plugin` was more careful and listed the same thing under
**Not established**, reasoning only that Agent Plugins 1.0 registers no
namespace and that none of Codex's bundled plugins use the `extensions` map.

OpenAI's plugin documentation now registers one explicitly:

> "Put OpenAI-specific presentation, registered MCP server mappings, and hook
> settings under `extensions.com.openai` in root `plugin.json`. Existing
> `.codex-plugin/plugin.json` files remain supported as a compatibility
> fallback."

So the rationale asserts, as a property of the harness, something a vendor
document contradicts. This probe settles which is true of the shipped binary.

## Evidence class

`live-probe`. `codex-cli` **0.154.0**, **2026-09-16**, native Windows, under an
isolated `CODEX_HOME`. No model was called: discovery is observed through
`codex debug prompt-input`, which renders the model-visible input as JSON
without starting a session. The contributor's own `~/.codex/config.toml` was
hashed before and after and is unchanged.

## Method

Four plugins in one local marketplace, differing **only** in how the skills
directory is named. Each ships one skill carrying a unique marker; the marker is
then looked for in the rendered prompt input. A skill that is discovered reaches
the model, so this is an effect, not a log line.

The design is the point. Declaring a path and then finding the skill proves
nothing on its own, because the path might be conventional — so one plugin
declares nothing, and one declares a **non-conventional** path that only the
extensions map could supply.

| Plugin | How skills are named | Discovered |
| --- | --- | --- |
| `control-native` | `.codex-plugin/plugin.json` → `"skills": "./skills/"` (what Hooknostic emits) | **yes** |
| `probe-extensions` | root `plugin.json` → `extensions."com.openai".skills = "./skills/"` | yes |
| `no-declaration` | nothing at all; a `skills/` directory is simply present | **yes** |
| `custom-path` | `extensions."com.openai".skills = "./custom-skills/"`, no `skills/` directory | **no** |

## Observations

**`skills/` is discovered by convention.** `no-declaration` declares no skills
anywhere — no native manifest, no `skills` field, no extensions map — and its
skill still reaches the model. That result explains `probe-extensions` entirely:
its skill was found because it sat at the conventional path, not because
anything read the namespace.

**`extensions."com.openai"` is not read.** `custom-path` names
`./custom-skills/` in the map and ships no conventional directory, and its skill
does not reach the model. Convention cannot explain that row, and the map does
not rescue it. This is the negative the other three rows needed.

So on 0.154.0 the capability rating is right and its stated reason was wrong:
not "Codex reads no portable namespace" as a property of the harness, but "the
namespace the vendor documents is not honoured by the shipped binary, at least
for the one key that can be observed without a model".

## Consequences

- `agent-plugin.client-extension.files` stays `unsupported`, with a rationale
  that says what was measured, names the version, and records that the
  documentation says otherwise. A future release may make this false, which is
  exactly why the version belongs in the sentence.
- Hooknostic's native-manifest form is what the ecosystem actually ships.
  All 180 plugins in Codex's bundled marketplace carry a `.codex-plugin/plugin.json`
  and **none** carries a root `plugin.json` or an `extensions."com.openai"`
  object — so the documented "preferred" form is, for now, used by nothing.
- Only the `skills` key was probed. Whether `mcpServers` or `hooks` inside the
  map are read is **not established**, and neither is any other namespace.

## Not established

- The other keys the documentation places in the map (`mcpServers`, `hooks`,
  presentation). Each needs its own observable; `skills` was chosen because
  `codex debug prompt-input` shows the result without a model.
- Whether a root `plugin.json` and a `.codex-plugin/plugin.json` that disagree
  resolve the way the documentation describes. `.capture/codex-agent-plugin`
  establishes that a valid root manifest outranks the namespaced ones; the
  documentation's account of `extensions."com.openai"` replacing the overlay
  wholesale is untested.
- Linux and macOS. Windows only.
