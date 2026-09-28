# @hooknostic/sdk

Configure portable packages and repository integrations, and author lifecycle hooks
in TypeScript. Compile hooks, skills, and MCP for supported
coding-agent harnesses with the `hooknostic` CLI. Requires Node.js 22.13.0 or newer.

```sh
npm install --save-dev @hooknostic/sdk hooknostic
```

```ts
import { block, definePlugin, hook } from "@hooknostic/sdk";

export default definePlugin({
  name: "protect-shell",
  hooks: [hook("tool.before", {
    id: "guard",
    match: { kind: "shell" },
    capabilities: { block: "required" },
    run({ tool }) {
      const command = tool.shell?.command;
      if (command === undefined) return block(`Unrecognized ${tool.nativeName} input`);
      if (command.includes("rm -rf /")) return block("Review this command before proceeding.");
    },
  })],
});
```

This illustrates a hook, not a comprehensive shell security policy. Configure
targets and compile it using the [getting-started tutorial](https://github.com/roryeckel/hooknostic/blob/master/docs/tutorials/01-your-first-hook.md).
See the [project documentation](https://github.com/roryeckel/hooknostic#readme)
and [harness support](https://github.com/roryeckel/hooknostic/blob/master/docs/harness-support.md)
for the supported events and effects. Licensed under Apache-2.0.

`defineConfig` also selects Agent Plugins 1.0 inputs or direct project components. See the [configuration reference](https://github.com/roryeckel/hooknostic/blob/master/docs/configuration.md). Hookless builds need configuration but no `definePlugin` entry.
