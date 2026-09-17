import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("../../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { runProcess, startModelPlayback } = await import("../../../packages/cli/test/harness-playback.ts");

const here = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "hooknostic-codex-client-extension-"));
const codexHome = join(scratch, "codex-home");
const project = join(scratch, "project");
const userHome = join(scratch, "user-home");
await Promise.all([mkdir(codexHome), mkdir(project), mkdir(userHome)]);

const withoutCredentials = { ...process.env };
for (const name of [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
]) {
  delete withoutCredentials[name];
}
const environment = {
  ...withoutCredentials,
  CODEX_HOME: codexHome,
  HOME: userHome,
  USERPROFILE: userHome,
};
const toml = (value: string) => `'${value.replaceAll("'", "''")}'`;
const run = (command: string, args: string[]) =>
  runProcess(command, args, { cwd: project, env: environment, timeoutMs: 120_000 });
const checked = async (command: string, args: string[]) => {
  const result = await run(command, args);
  if (result.code !== 0) throw new Error(`${command} exited ${result.code}\n${result.stdout}\n${result.stderr}`);
  return result;
};

const MARKETPLACE = "hooknostic-extensions-probe";
const pluginRoot = (name: string) => join(codexHome, "plugins/cache", MARKETPLACE, name, "1.0.0");
const marker = async (path: string) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

// The three `hooks` forms the documentation permits beyond a single path.
// Whether Codex even installs such a manifest is part of the observation, so
// their installation is recorded rather than required.
const FORM_PROBES = ["native-hooks-path-array", "native-hooks-inline-object", "native-hooks-inline-array"] as const;

try {
  const versionOutput = (await checked("codex", ["--version"])).stdout.trim();
  const version = versionOutput.split(/\s+/).at(-1) ?? versionOutput;

  await checked("codex", ["plugin", "marketplace", "add", here]);
  await checked("codex", ["plugin", "add", `inline-hooks@${MARKETPLACE}`]);
  await checked("codex", ["plugin", "add", `native-hooks-control@${MARKETPLACE}`]);
  const installed: Record<string, { code: number | null; stderr: string }> = {};
  for (const name of FORM_PROBES) {
    const result = await run("codex", ["plugin", "add", `${name}@${MARKETPLACE}`]);
    installed[name] = { code: result.code, stderr: result.stderr.trim() };
  }

  const server = await startModelPlayback("openai-responses", "rewrite", [{ kind: "text", text: "done" }]);
  let sessionOutput = "";
  try {
    const session = await checked("codex", [
      "exec",
      "hello",
      "--skip-git-repo-check",
      "--dangerously-bypass-hook-trust",
      "--color",
      "never",
      "-c",
      'model="hooknostic-playback"',
      "-c",
      'model_provider="hooknostic_playback"',
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      'model_providers.hooknostic_playback.name="Hooknostic Playback"',
      "-c",
      `model_providers.hooknostic_playback.base_url=${toml(`${server.baseUrl}/v1`)}`,
      "-c",
      'model_providers.hooknostic_playback.wire_api="responses"',
      "-c",
      "model_providers.hooknostic_playback.requires_openai_auth=false",
      "-c",
      "model_providers.hooknostic_playback.request_max_retries=0",
      "-c",
      "model_providers.hooknostic_playback.stream_max_retries=0",
      "-c",
      `projects={${toml(project)}={trust_level=${toml("trusted")}}}`,
    ]);
    sessionOutput = `${session.stdout}\n${session.stderr}`;
  } finally {
    await server.close();
  }

  const inline = await marker(join(pluginRoot("inline-hooks"), "inline-hooks-fired.json"));
  const native = await marker(join(pluginRoot("native-hooks-control"), "native-hooks-fired.json"));
  if (native === null) throw new Error(`native hook control did not fire\n${sessionOutput}`);
  const pathArray = {
    a: await marker(join(pluginRoot("native-hooks-path-array"), "hooks-a-fired.json")),
    b: await marker(join(pluginRoot("native-hooks-path-array"), "hooks-b-fired.json")),
  };
  const inlineObject = await marker(join(pluginRoot("native-hooks-inline-object"), "inline-object-fired.json"));
  const inlineArray = {
    a: await marker(join(pluginRoot("native-hooks-inline-array"), "hooks-a-fired.json")),
    b: await marker(join(pluginRoot("native-hooks-inline-array"), "hooks-b-fired.json")),
  };
  process.stdout.write(
    `${JSON.stringify({ version, installed, inline, native, pathArray, inlineObject, inlineArray }, null, 2)}\n`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
