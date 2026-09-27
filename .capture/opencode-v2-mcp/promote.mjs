import { mkdir, readFile, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { userInfo } from "node:os";
import { join } from "node:path";
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const { decodeOpenCodeV2 } = await import("../../packages/adapter-opencode/src/v2/decode.ts");
const { opencodeV2Harness } = await import("../../packages/adapter-opencode/src/v2/harness.ts");
const destination = new URL("../../fixtures/opencode/2.0/", import.meta.url);
await mkdir(new URL("mcp-identity/", destination), { recursive: true });
const username = userInfo().username;
const redact = text => text.replaceAll(`Users\\\\${username}\\\\`, "Users\\\\user\\\\")
  .replaceAll(`Users/${username}/`, "Users/user/");
const rows = (await readFile(join(process.argv[2], "captured/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
for (const hook of ["tool.registry", "mcp.registry"]) {
  const row = rows.find(row => row.hook === hook);
  if (!row) throw new Error(`Missing ${hook}`);
  await writeFile(new URL(`mcp-identity/${hook}.json`, destination), redact(JSON.stringify(row, null, 2)) + "\n");
}
for (const phase of ["before", "after"]) {
  const row = rows.find(row => row.hook === `execute.${phase}` && row.event.tool === "hooknostic_custom_echo");
  if (!row) throw new Error(`Missing custom tool ${phase}`);
  const raw = JSON.parse(redact(JSON.stringify(row)));
  const { raw: ignored, ...canonical } = decodeOpenCodeV2(raw, { targetId: "opencode", harnessVersion: opencodeV2Harness.referenceVersion });
  await writeFile(new URL(`tool-custom-namespace-${phase}.input.json`, destination), JSON.stringify(raw, null, 2) + "\n");
  await writeFile(new URL(`tool-custom-namespace-${phase}.canonical.json`, destination), JSON.stringify(canonical, null, 2) + "\n");
}
