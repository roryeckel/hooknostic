# @hooknostic/sdk

Configure portable packages and repository integrations, and author lifecycle hooks
in TypeScript. Compile hooks, skills, and MCP for supported
coding-agent harnesses with the `hooknostic` CLI. Requires Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`.

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

## Runtime schemas

Writing hooks and configuration needs no Zod: the `@hooknostic/sdk` entry never
loads it. The runtime validation schemas live at `@hooknostic/sdk/schemas`, for
tooling that validates Hooknostic objects or composes them with its own
schemas. They are Zod 4 Classic schemas, and importing them needs the SDK's
`zod` peer at `^4.6.7`:

```ts
import * as z from "zod/v4";
import { toolInvocationSchema } from "@hooknostic/sdk/schemas";

const labelled = z.object({ tool: toolInvocationSchema.extend({ label: z.string() }) });
```

## Upgrading

The schemas moved from the package root to `@hooknostic/sdk/schemas`, and Zod 3
schema composition is no longer supported. See the
[upgrading guides](https://github.com/roryeckel/hooknostic/blob/master/docs/upgrading/README.md)
for these and other breaking changes.
