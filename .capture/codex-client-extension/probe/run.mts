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
const checked = async (command: string, args: string[]) => {
  const result = await runProcess(command, args, { cwd: project, env: environment, timeoutMs: 120_000 });
  if (result.code !== 0) throw new Error(`${command} exited ${result.code}\n${result.stdout}\n${result.stderr}`);
  return result;
};

try {
  await checked("codex", ["plugin", "marketplace", "add", here]);
  await checked("codex", ["plugin", "add", "inline-hooks@hooknostic-extensions-probe"]);
  await checked("codex", ["plugin", "add", "native-hooks-control@hooknostic-extensions-probe"]);

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

  const inlineRoot = join(
    codexHome,
    "plugins/cache/hooknostic-extensions-probe/inline-hooks/1.0.0",
  );
  const nativeRoot = join(
    codexHome,
    "plugins/cache/hooknostic-extensions-probe/native-hooks-control/1.0.0",
  );
  const marker = async (path: string) => {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const inline = await marker(join(inlineRoot, "inline-hooks-fired.json"));
  const native = await marker(join(nativeRoot, "native-hooks-fired.json"));
  if (native === null) throw new Error(`native hook control did not fire\n${sessionOutput}`);
  process.stdout.write(`${JSON.stringify({ version: "0.154.0", inline, native }, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
