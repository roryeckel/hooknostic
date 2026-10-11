// OpenCode 1.x probe plugin: tees the hooks through which the harness itself may
// state which shell it runs. Loaded beside the tee-capture plugin in a scratch
// project; a vanilla plugin module with no repository imports.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CAPTURE_DIR = process.env["HKN_CAPTURE_DIR"] ?? join(import.meta.dirname, "captured");
mkdirSync(CAPTURE_DIR, { recursive: true });

function tee(hook, record) {
  appendFileSync(join(CAPTURE_DIR, hook + ".jsonl"), JSON.stringify({ hook, ...record }) + "\n", "utf8");
}

// One file in arrival order: the tee plugin writes a file per hook, which loses
// whether the shell was stated before the call it applies to.
function order(hook, subject) {
  appendFileSync(join(CAPTURE_DIR, "shell-report-order.jsonl"), JSON.stringify({ hook, subject }) + "\n", "utf8");
}

export const HooknosticShellReport = async () => ({
  // Only the `shell` key: the resolved configuration also holds provider settings.
  config: async (config) => {
    tee("config", { shell: config?.shell ?? null });
  },
  "tool.definition": async (input, output) => {
    // The whole output for the shell tool, whose description is the statement;
    // the other tools' definitions are not evidence about the shell.
    if (input?.toolID !== "bash") return;
    tee("tool.definition", { input, output });
    order("tool.definition", input.toolID);
  },
  "tool.execute.before": async (input) => {
    order("tool.execute.before", input?.tool);
  },
  "shell.env": async (input, output) => {
    tee("shell.env", { input, output: { envKeys: Object.keys(output?.env ?? {}) } });
    order("shell.env", input?.callID);
  },
});

export default HooknosticShellReport;
