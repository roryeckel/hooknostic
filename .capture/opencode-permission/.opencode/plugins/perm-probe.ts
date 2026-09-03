// Permission capture probe, v2. Upstream findings being captured live on
// 1.18.25 (cf. anomalyco/opencode #9229, #7006): the documented
// `permission.ask` plugin hook is NEVER triggered -- the active Permission
// module publishes a `permission.asked` bus event instead. This probe records
// both surfaces so the capture holds the positive and the negative evidence:
//
// - `permission.ask` registrations write to permission-hook-calls.jsonl
//   (expected: empty -- the hook does not fire).
// - every bus event reaches the generic `event` callback; permission events
//   are recorded verbatim to permission-bus.jsonl.
// - in deny mode, the probe answers the ask through the client's reply API
//   (POST /session/{id}/permissions/{permissionID}, response "reject"),
//   recorded to permission-answered.jsonl.
//
// Deliberately a vanilla @opencode-ai/plugin module: the capture scratch
// lives outside the repo, so @hooknostic/sdk does not resolve there, and a
// capture probe must not depend on the library it is capturing evidence
// about.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";

const MODE = process.env["HKN_PERM_MODE"] ?? "observe";
const DIR = process.env["HKN_CAPTURE_DIR"] ?? process.cwd();
const captured = join(DIR, "captured");
mkdirSync(captured, { recursive: true });

const write = (name: string, payload: unknown): void => {
  try {
    appendFileSync(join(captured, name), JSON.stringify(payload) + "\n");
  } catch (error) {
    appendFileSync(join(captured, "probe-errors.jsonl"), JSON.stringify({ at: Date.now(), stage: name, error: String(error) }) + "\n");
  }
};

let answered = false;

export const PermProbe: Plugin = async (ctx) => {
  write("probe-load.jsonl", {
    at: Date.now(),
    mode: MODE,
    directory: ctx.directory,
    clientShape: {
      hasPostPermissions: typeof (ctx.client as Record<string, unknown>)?.["postSessionIdPermissionsPermissionId"],
      hasSessionPostPermissions: typeof (ctx.client as Record<string, unknown>)?.["session"],
    },
  });
  return {
    // Negative-evidence channel: if this ever fires, the upstream defect is
    // fixed and the capture record must be updated.
    "permission.ask": async (input, output) => {
      write("permission-hook-calls.jsonl", { input, outputBefore: structuredClone(output), at: Date.now() });
    },
    event: async (input) => {
      // The generic event hook receives { event: Event } (Hooks type), not the
      // bus event directly.
      const event = (input as { event?: { type?: string; properties?: unknown } }).event;
      const type = event?.type ?? "";
      if (type.startsWith("permission")) {
        write("permission-bus.jsonl", { event, at: Date.now() });
      }
      if (MODE === "deny" && !answered && type === "permission.asked") {
        answered = true;
        const properties = (event?.properties ?? {}) as { id?: string; sessionID?: string };
        try {
          const client = ctx.client as unknown as {
            postSessionIdPermissionsPermissionId: (options: {
              path: { id: string; permissionID: string };
              body: { response: "once" | "always" | "reject" };
            }) => Promise<unknown>;
          };
          const response = await client.postSessionIdPermissionsPermissionId({
            path: { id: String(properties.sessionID), permissionID: String(properties.id) },
            body: { response: "reject" },
          });
          write("permission-answered.jsonl", { id: properties.id, sessionID: properties.sessionID, response: "reject", apiResult: response, at: Date.now() });
        } catch (error) {
          write("permission-answered.jsonl", { id: properties.id, error: String(error), at: Date.now() });
        }
      }
    },
  };
};
export default PermProbe;