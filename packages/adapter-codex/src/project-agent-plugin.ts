import { createNativeAgentPluginProjector } from "@hooknostic/agent-plugin";
import type { TargetSpec } from "@hooknostic/core";

/**
 * Codex reads Agent Plugins directly, so its "projection" is the filtered
 * package itself.
 *
 * Measured against `codex-cli` 0.153.2: a package whose only manifest is a root
 * `plugin.json` installs through `codex plugin add`, its `skills/` tree is
 * discovered, and its `mcp.json` servers register with `PLUGIN_ROOT`/
 * `PLUGIN_DATA` bound and `cwd` set to the installed plugin root. None of the
 * translation the Claude projector performs -- manifest relocation, transport
 * renaming, a generated cwd launcher, plugin-root variable substitution -- has
 * any counterpart here.
 *
 * Two rules that shape what this may emit, both A/B tested on that version:
 *
 * - **`$schema` is the discriminator.** A root `plugin.json` without the Agent
 *   Plugins 1.0 schema URL is not recognised at all: Codex fails the install
 *   with `missing plugin.json`, and an `mcp.json` without its own schema URL is
 *   silently ignored while the plugin still installs. The loader already
 *   requires both, so a hooknostic-built package satisfies this by
 *   construction; do not relax that without re-probing Codex.
 * - **A valid root manifest outranks the namespaced ones.** With a root
 *   `plugin.json` present, Codex used it over both `.codex-plugin/plugin.json`
 *   and `.claude-plugin/plugin.json`. (Codex does read `.claude-plugin/` when it
 *   is the only manifest, which is why a Claude-projected artifact appears to
 *   install here -- it carries Claude-specific MCP rewrites and must not be
 *   reused for Codex.)
 *
 * **Hooks cannot ride along, and not because Codex lacks the feature.** An
 * installed plugin's hook does run on 0.153.2, but only from a native
 * `.codex-plugin/plugin.json` `hooks` key -- and a valid root `plugin.json`
 * outranks that manifest, so declaring both loads the package and silently
 * ignores its hooks. There is no convention fall-back either: a portable
 * package with a hooks document at `hooks.json` or `hooks/hooks.json` fires
 * nothing (`.capture/codex-plugin-hooks`). Hence `deliversHooks: false` --
 * a package is a package or a hook carrier, never both. A globally installed
 * package therefore has no hooks at all, since `.codex/hooks.json` resolves
 * against the session's project directory.
 *
 * No client-extension namespace is declared. Agent Plugins 1.0 registers none,
 * and Codex consumes none: all 62 plugins in its bundled marketplace express
 * Codex-specific data as top-level fields of a native `.codex-plugin/plugin.json`
 * rather than through the portable `extensions` map. Declaring an invented
 * namespace would make `agent-plugin.client-extension.files` discoverable
 * against something nothing reads.
 */
export const codexAgentPluginProjector = createNativeAgentPluginProjector<TargetSpec>({
  profiles: [
    {
      range: ">=0.148 <1",
      components: {
        "agent-plugin.manifest": {
          level: "exact",
          rationale:
            "The portable root plugin.json is read unmodified, and outranks .codex-plugin/ and .claude-plugin/ when present.",
        },
        "agent-plugin.skills": { level: "exact" },
        "agent-plugin.mcp.stdio": { level: "exact" },
        "agent-plugin.mcp.streamable-http": {
          level: "approximate",
          rationale:
            "The server registers and its url is preserved, but declared headers are dropped: Codex models remote auth as bearer_token_env_var, not as literal headers, so a server authenticated by an Authorization header registers unauthenticated.",
        },
        "agent-plugin.mcp.sse": {
          level: "unsupported",
          rationale:
            "An sse server in a projected mcp.json did not register at all, while a streamable-http server in the same file did.",
        },
        "agent-plugin.client-extension.files": {
          level: "unsupported",
          rationale:
            "Codex reads no portable client-extension namespace; its native .codex-plugin/ directory is not one, and none of its bundled plugins use the extensions map.",
        },
        "agent-plugin.runtime-package": {
          level: "unsupported",
          rationale:
            "Not probed. Codex's installer was only observed copying package content; whether it runs a locked npm install like Claude's marketplace is unestablished.",
        },
      },
      source: {
        date: "2026-09-07",
        validatedOn: [
          {
            version: "0.153.2",
            date: "2026-09-07",
            method: "live-probe",
            artifact: ".capture/codex-agent-plugin",
            what: "A package with a root plugin.json, a skills/ tree and no .codex-plugin/ installed through `codex plugin add`; the version came from the portable manifest and the skill was cached intact.",
          },
          {
            version: "0.153.2",
            date: "2026-09-07",
            method: "live-probe",
            artifact: ".capture/codex-agent-plugin",
            what: "A portable mcp.json registered its stdio server, with PLUGIN_ROOT and PLUGIN_DATA bound and cwd set to the installed plugin root.",
          },
          {
            version: "0.153.2",
            date: "2026-09-07",
            method: "live-probe",
            artifact: ".capture/codex-agent-plugin",
            what: "Transport coverage from one mcp.json declaring both: the streamable-http server registered as transport streamable_http with its url, its Authorization header dropped (http_headers empty, and the header text survived only in the copied mcp.json); the sse server did not register.",
          },
          {
            version: "0.153.2",
            date: "2026-09-07",
            method: "live-probe",
            artifact: ".capture/codex-agent-plugin",
            what: "$schema is required on both files: without it on plugin.json the install fails with `missing plugin.json`; without it on mcp.json the servers are silently not registered.",
          },
          {
            version: "0.153.2",
            date: "2026-09-07",
            method: "live-probe",
            artifact: ".capture/codex-agent-plugin",
            what: "Manifest precedence: a valid root plugin.json was used over both .codex-plugin/plugin.json and .claude-plugin/plugin.json; a .claude-plugin/-only package still installs.",
          },
          {
            version: "0.153.2",
            date: "2026-09-07",
            method: "live-probe",
            artifact: ".capture/codex-agent-plugin",
            what: "`codex plugin add` copies the plugin source directory wholesale: a junk directory and a stray README both landed in the install cache, which is why the filtered package is the value this projector adds.",
          },
          {
            version: "0.153.2",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/codex-plugin-hooks",
            what: "Plugin hooks run, but only from a native .codex-plugin/ manifest: a package declaring both manifests loaded its skill and ignored its hook, and a portable package with hooks at hooks.json or hooks/hooks.json fired nothing. Installation is user-level -- marketplace and plugin entries land in ~/.codex/config.toml and the skill is visible from unrelated directories.",
          },
        ],
        notes: [
          "Marketplace roots expose plugins through <root>/.agents/plugins/marketplace.json.",
          "Windows only; not probed on Linux or macOS.",
        ],
      },
    },
  ],
});
