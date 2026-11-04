// What does the v1 `config` hook receive from a process-level host layer?
import { appendFileSync } from "node:fs";

export default async () => ({
  config: (config) => {
    appendFileSync(
      process.env.HKN_V1_TRACE,
      JSON.stringify({ phase: "config", keys: Object.keys(config), mcp: config.mcp ?? null }) + "\n",
      "utf8",
    );
  },
});
