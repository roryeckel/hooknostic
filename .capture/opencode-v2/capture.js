import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Probe entrypoint: @opencode/plugin 2.0.17's Plugin.define is identity.
export default {
  id: "hooknostic.capture.v2",
  async setup(ctx) {
    const root = process.env.HKN_CAPTURE_DIR;
    mkdirSync(root, { recursive: true });
    const record = (hook, event) => {
      const seen = new WeakSet();
      appendFileSync(
        join(root, "events.jsonl"),
        JSON.stringify({ hook, directory: ctx.location.directory, event }, (_key, value) => {
          if (typeof value === "bigint") return String(value);
          if (value && typeof value === "object") {
            if (seen.has(value)) return "[circular]";
            seen.add(value);
          }
          return value;
        }) + "\n",
      );
    };
    record("setup", { location: ctx.location });
    const effect = process.env.HKN_PROBE_EFFECT;
    if (effect.startsWith("results")) await ctx.tool.transform(editor => {
      for (const name of ["probe_failure", "probe_rich", "probe_object"]) editor.add({
        name, description: "Offline result boundary probe", options: { codemode: false },
        input: { type: "object", properties: {}, required: [] }, output: {},
        execute: async () => {
          if (name === "probe_failure") throw new Error("hooknostic-thrown-tool-error");
          return { output: { secret: "hooknostic-native-structured" }, metadata: { sentinel: "hooknostic-native-metadata" },
            content: [{ type: "text", text: "hooknostic-native-content" }] };
        },
      });
    });
    if (effect === "remote" || effect === "remote-legacy") await ctx.mcp.transform(editor => {
      for (const name of ["http", "sse"]) editor.set(name, { type: "remote", url: process.env.HKN_REMOTE_ORIGIN + "/" + name,
        headers: { "x-hooknostic": "remote-native" }, timeout: { startup: 10000 }, ...(effect === "remote-legacy" ? { protocol: "legacy" } : {}) });
    });
    if (effect === "components" || effect === "tools" || effect.startsWith("mcp-")) {
      const skillPath = join(ctx.location.directory, "injected/SKILL.md");
      await ctx.skill.transform((editor) =>
        editor.add({
          id: "hooknostic-injected",
          name: "hooknostic-injected",
          description: "Injected probe",
          path: skillPath,
          content: readFileSync(skillPath, "utf8"),
        }),
      );
      await ctx.mcp.transform((editor) =>
        editor.set("hooknostic", {
          type: "local",
          command: [process.env.HKN_NODE_BINARY, join(ctx.location.directory, "server.mjs")],
          cwd: ctx.location.directory,
          timeout: { startup: 10000 },
          protocol: "legacy",
        }),
      );
      if (effect.startsWith("mcp-")) await ctx.tool.transform(editor => editor.add({
        name: "custom_echo",
        options: { namespace: "hooknostic", codemode: true },
        description: "Custom tool in the MCP server namespace",
        input: { type: "object", properties: {}, required: [] },
        output: {},
        execute: async () => ({ output: "hooknostic-custom-output", content: [{ type: "text", text: "hooknostic-custom-output" }] }),
      }));
    }
    for (const hook of ["prompt", "context", "compaction", "generate", "title", "model.request"]) {
      await ctx.session.hook(hook, async (event) => {
        record(hook, event);
        if (
          (effect === "components" || effect === "project-components" || effect.includes("remote") || effect.startsWith("package") || effect.startsWith("mcp-")) &&
          hook === "prompt"
        ) {
          record(
            "skills",
            (await ctx.skill.list()).data.map(({ id, name, path }) => ({ id, name, path })),
          );
          for (let attempt = 0; attempt < 30; attempt++) {
            const servers = await ctx.mcp.list();
            const tools = await ctx.tool.list();
            const ready = effect.includes("remote") ? tools.some(tool => tool.id === "http_hooknostic_echo") : !effect.startsWith("mcp-") || tools.some(tool => tool.id === "hooknostic_hooknostic_echo");
            if (servers.data.every((s) => s.status.status !== "pending") && ready) {
              record("mcp", servers);
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        if (effect === "context" && event.system)
          event.system.push({ type: "text", text: "hooknostic-v2-context-marker" });
        if (effect === "block-prompt" && hook === "prompt") throw new Error("hooknostic-v2-prompt-denied");
      });
    }
    for (const hook of ["execute.before", "execute.after"]) {
      await ctx.tool.hook(hook, async (event) => {
        record(hook, event);
        if (effect.startsWith("mcp-") && hook === "execute.before" && event.tool.includes("hooknostic")) {
          record("tool.registry", (await ctx.tool.list()).filter(tool => tool.id.includes("hooknostic")));
          record("mcp.registry", await ctx.mcp.list());
        }
        if (hook === "execute.before" && effect === "tools" && ["websearch", "subagent"].includes(event.tool))
          throw new Error("hooknostic-boundary-only: external execution intentionally blocked");
        if (hook === "execute.before" && effect === "rewrite")
          event.input.command = "node -e \"require('node:fs').writeFileSync('hooknostic-rewritten.txt','rewritten')\"";
        if (hook === "execute.before" && effect === "block") throw new Error("hooknostic-v2-tool-denied");
        if (hook === "execute.after" && effect === "output" && event.status === "completed")
          event.result.content = "hooknostic-v2-replaced-output";
      });
    }
    await ctx.permission.hook("evaluate", (event) => {
      record("evaluate", event);
      if (effect === "permission" || (effect === "sessions-native-deny" && event.effect === "ask")) {
        event.effect = "deny";
        event.message = "hooknostic-v2-permission-denied";
      }
    });
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) record("event", event);
      } catch (error) {
        if (!controller.signal.aborted) record("subscription.error", String(error));
      }
    })();
    return () => {
      record("cleanup", {});
      controller.abort();
    };
  },
};
