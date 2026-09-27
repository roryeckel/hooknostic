// Explicit promotion of reviewed hook snapshots, never model request schemas.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { register } from "node:module";
import { join } from "node:path";
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const { decodeOpenCodeV2 } = await import("../../packages/adapter-opencode/src/v2/decode.ts");
const { opencodeV2Harness } = await import("../../packages/adapter-opencode/src/v2/harness.ts");
const destination = new URL("../../fixtures/opencode/2.0/", import.meta.url);
const username = userInfo().username;
const redact = text => text.replaceAll(`Users\\\\${username}\\\\`, "Users\\\\user\\\\")
  .replaceAll(`Users/${username}/`, "Users/user/");
const rows = (await readFile(join(process.argv[2], "captured/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
const names = ["write", "read", "edit", "glob", "grep", "shell", "webfetch", "websearch", "subagent", "execute", "skill", "hooknostic_hooknostic_echo"];
for (const name of names) {
  for (const phase of ["before", "after"]) {
    const row = rows.find(row => row.hook === `execute.${phase}` && row.event.tool === name);
    if (!row) {
      if (phase === "after" && ["websearch", "subagent"].includes(name)) continue;
      throw new Error(`Missing captured ${name} ${phase}`);
    }
    const stem = name === "shell" ? "shell-workdir" : name === "hooknostic_hooknostic_echo" ? "mcp-inner" : name;
    const file = `tool-${stem}-${phase}.input.json`;
    await writeFile(new URL(file, destination), redact(JSON.stringify(row, null, 2)) + "\n");
  }
}
for (const file of await readdir(destination)) {
  if (!file.endsWith(".input.json")) continue;
  const input = JSON.parse(await readFile(new URL(file, destination), "utf8"));
  const { raw, ...canonical } = decodeOpenCodeV2(input, { targetId: "opencode", harnessVersion: opencodeV2Harness.referenceVersion });
  await writeFile(new URL(file.replace(".input.", ".canonical."), destination), JSON.stringify(canonical, null, 2) + "\n");
}
