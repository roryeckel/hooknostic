import { readFile, writeFile, mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
const observations = [];
for (let index = 2; index < process.argv.length; index += 2) {
  const scenario = process.argv[index], root = process.argv[index + 1];
  if (!["remote", "remote-legacy", "project-remote", "package-remote"].includes(scenario) || !root) throw new Error("Provide scenario/root pairs");
  const requests = JSON.parse(await readFile(join(root, "remote.json"), "utf8"));
  const records = (await readFile(join(root, "captured/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).filter(row => row.hook === "mcp");
  observations.push({ scenario, requests, records });
}
const destination = new URL("../../fixtures/opencode/2.0/remote/", import.meta.url);
await mkdir(destination, { recursive: true });
const username = userInfo().username;
await writeFile(new URL("observations.json", destination), JSON.stringify(observations, null, 2).replaceAll(`Users\\\\${username}\\\\`, "Users\\\\user\\\\").replaceAll(`Users/${username}/`, "Users/user/") + "\n");
