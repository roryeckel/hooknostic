import { readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { register } from "node:module";
import { join } from "node:path";
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const { decodeOpenCodeV2 } = await import("../../packages/adapter-opencode/src/v2/decode.ts");
const { opencodeV2Harness } = await import("../../packages/adapter-opencode/src/v2/harness.ts");
const rows = (await readFile(join(process.argv[2], "captured/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
for (const [name, tool] of [["tool-read-error", "read"], ["tool-rich-after", "probe_rich"]]) {
  const row = rows.find(row => row.hook === "execute.after" && row.event.tool === tool);
  if (!row) throw new Error(`Missing ${tool}`);
  const input = JSON.parse(JSON.stringify(row).replaceAll(`Users\\\\${userInfo().username}\\\\`, "Users\\\\user\\\\"));
  const { raw, ...canonical } = decodeOpenCodeV2(input, { targetId: "opencode", harnessVersion: opencodeV2Harness.referenceVersion });
  for (const [suffix, value] of [["input", input], ["canonical", canonical]])
    await writeFile(new URL(`../../fixtures/opencode/2.0/${name}.${suffix}.json`, import.meta.url), JSON.stringify(value, null, 2) + "\n");
}
