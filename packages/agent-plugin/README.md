# @hooknostic/agent-plugin

Load and validate Agent Plugins 1.0 packages, inventory their files, and consume
native projection contracts. Requires Node.js 22.13.0 or newer.

```sh
npm install @hooknostic/agent-plugin
```

```ts
import { loadAgentPlugin } from "@hooknostic/agent-plugin";

const result = await loadAgentPlugin({ root: "./my-plugin" });
if (!result.package) throw new Error(JSON.stringify(result.issues));
console.log(result.package.manifest.name, result.package.contentDigest);
```

The root must contain a valid `plugin.json`. Inspect `issues` even when loading
succeeds: invalid optional components can be omitted. To retain an executable,
pass `executableFiles: ["bin/tool"]` with the exact included file path; files
default to 0644 and declared executables use 0755 on every build platform.

The loader does not install the package into a harness. Use the `hooknostic`
CLI for native projection. See the [packaging tutorial](https://github.com/roryeckel/hooknostic/blob/master/docs/tutorials/04-packaging-with-agent-plugins.md)
and [project documentation](https://github.com/roryeckel/hooknostic#readme).
Licensed under Apache-2.0.
