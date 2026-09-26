import { appendFileSync } from "node:fs";
import { definePlugin, hook, replaceOutput } from "@hooknostic/sdk";

const record = (event: unknown) => appendFileSync(process.env.HKN_RESULTS_TRACE!, JSON.stringify(event) + "\n");
export default definePlugin({ name: "result-audit", hooks: [
  hook("tool.error", { id: "errors", run: record }),
  hook("tool.after", { id: "results", capabilities: { "tool.after.output.replace": "required" }, run(event) {
    record(event);
    if (event.tool.nativeName === "probe_rich") return replaceOutput("hooknostic-portable-text");
    if (event.tool.nativeName === "probe_object") return replaceOutput({ portable: "hooknostic-portable-object", count: 2 });
  } }),
] });
