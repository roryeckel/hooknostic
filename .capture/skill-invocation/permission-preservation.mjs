// Credential-free native discovery controls for the generated v1 policy callback.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const { runProcess, startModelPlayback, prepareOpenCodePluginDependency, openCodePlaybackConfigHome } =
  await import("../../packages/cli/test/harness-playback.ts");
const { withoutCredentials, writeOpencodeConfig } = await import("../../scripts/drive-capture-session.mjs");
const { skillPermissionSource, opencodeProjectSkillPolicyValidation } =
  await import("../../packages/adapter-opencode/src/skill-policy.ts");
const binary = process.env.HKN_SKILL_HARNESS_BINARY;
if (!binary) throw new Error("Set HKN_SKILL_HARNESS_BINARY to the reference v1 executable");
const versionResult = await runProcess(binary, ["--version"], {
  cwd: process.cwd(), env: withoutCredentials(), timeoutMs: 30000,
});
const version = versionResult.stdout.trim();
if (versionResult.code !== 0 || version !== opencodeProjectSkillPolicyValidation.version)
  throw new Error("Reference binary mismatch");
const out = new URL(`captured/permission-preservation-${Date.now()}/`, import.meta.url);
mkdirSync(out, { recursive: true });
const cases = [];
const inputs = [
  { name: "global-deny", permission: { skill: { control: "allow", review: "ask" }, "*": "deny", read: "allow" }, control: false },
  { name: "global-allow", permission: { skill: "deny", "*": "allow" }, control: true },
  { name: "pattern-map", permission: { skill: { "*": "deny", control: "allow" }, "sk?l*": { control: "deny", "*": "allow" }, "edit*": "deny" }, control: true },
  { name: "optional-tail", permission: { skill: "allow", "skill *": "deny", read: "allow" }, control: false },
];
for (const input of inputs) {
  for (const allowed of [undefined, false, true]) {
    const label = `${input.name}-${allowed ?? "baseline"}`;
    const root = mkdtempSync(join(tmpdir(), "hkn-skill-preservation-"));
    const project = join(root, "project");
    mkdirSync(project);
    for (const name of ["review", "control"]) {
      const dir = join(project, ".agents/skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: PRESERVE_DESCRIPTION_${name} capture control.\n---\nPRESERVE_BODY_${name}\n`);
    }
    const env = { ...withoutCredentials(), HOME: root, USERPROFILE: root, PWD: project,
      XDG_CONFIG_HOME: openCodePlaybackConfigHome(project), XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache") };
    for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_BINARY", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]) delete env[key];
    const git = await runProcess("git", ["init"], { cwd: project, env, timeoutMs: 30000 });
    if (git.code !== 0) throw new Error("Could not initialize isolated project");
    await prepareOpenCodePluginDependency(project, version);
    const server = await startModelPlayback("openai-chat", "rewrite", [{ kind: "text", text: "capture complete" }]);
    let result;
    try {
      writeOpencodeConfig(project, server.baseUrl, "local-playback", "hooknostic-playback");
      const path = join(project, "opencode.json");
      const config = JSON.parse(readFileSync(path, "utf8"));
      config.permission = input.permission;
      writeFileSync(path, JSON.stringify(config, null, 2));
      if (allowed !== undefined) {
        const plugins = join(project, ".opencode/plugins");
        mkdirSync(plugins, { recursive: true });
        const generated = `export default async () => ({ config(config) { ${skillPermissionSource({ review: allowed })} } });\n`;
        writeFileSync(join(plugins, "policy.js"), generated);
        writeFileSync(new URL(`${label}.plugin.js`, out), generated);
      }
      result = await runProcess(binary, ["run", "Reply with done.", "--model", "drift/hooknostic-playback"], { cwd: project, env, timeoutMs: 120000 });
    } finally {
      await server.close();
    }
    const raw = JSON.stringify(server.requests, null, 2);
    writeFileSync(new URL(`${label}.requests.json`, out), raw);
    writeFileSync(new URL(`${label}.stdout.txt`, out), result.stdout);
    writeFileSync(new URL(`${label}.stderr.txt`, out), result.stderr);
    const first = JSON.stringify(server.requests.find(request => request.tools?.length));
    const visible = ["review", "control"].filter(name => first?.includes(`PRESERVE_DESCRIPTION_${name}`));
    const summary = { label, inputPermission: input.permission,
      ...(allowed === undefined ? {} : { allowImplicitInvocation: allowed }),
      capturedAt: new Date().toISOString(), exit: result.code, errors: server.errors,
      requestCount: server.requests.length, descriptionMarkersInInitialRequest: visible,
      rawRequestsSha256: createHash("sha256").update(raw).digest("hex") };
    console.log(JSON.stringify(summary));
    cases.push(summary);
    writeFileSync(new URL("summary.json", out), JSON.stringify(cases, null, 2) + "\n");
    if (result.code !== 0 || server.errors.length || !first) throw new Error(`Inconclusive native run: ${label}`);
    if (visible.includes("control") !== input.control || visible.includes("review") !== (allowed ?? input.control))
      throw new Error(`Unexpected discovery: ${label}`);
  }
}
writeFileSync(new URL("evidence/opencode-v1-permission-preservation.json", import.meta.url), JSON.stringify({
  provenance: "live-probe", harness: "opencode-v1", version, platform: process.platform,
  scope: "Isolated project discovery through the generated callback; credential-free loopback with no model tool calls. No installed-package, forced-loading or command-menu behavior is inferred.",
  extraction: "Description marker presence summarizes the first recorded model request carrying tools. Raw requests and emitted callbacks remain in ignored captured/permission-preservation-*; hashes identify complete requests. Inputs and summaries contain no account paths.",
  cases,
}, null, 2) + "\n");
