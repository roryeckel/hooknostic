# hooknostic

Compile portable hooks, skills, and MCP servers into native packages or repository
integrations for Claude Code, Codex, GitHub Copilot CLI, OpenCode, and Pi. Agent Plugins 1.0
packages can be projected for Claude, Codex, and Copilot marketplace distribution.
Requires Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`.

In a pnpm project, install with pnpm as [Getting started](https://github.com/roryeckel/hooknostic/blob/master/docs/getting-started.md#1-install-the-authoring-and-cli-packages)
shows (it allows esbuild's install script), and run every `npx hooknostic`
command in this README as `pnpm exec hooknostic`: `pnpm init` names pnpm in
`devEngines`, so npm refuses both `npm install` and `npx` there.

```sh
npm install --save-dev hooknostic @hooknostic/sdk
npx hooknostic --help
npx hooknostic --version
npx hooknostic doctor
npx hooknostic inspect claude
```

After authoring a hook and `hooknostic.config.ts`:

```sh
npx hooknostic check --config ./hooknostic.config.ts
npx hooknostic build --config ./hooknostic.config.ts
```

Under Yarn Plug'n'Play, run these as `yarn hooknostic`, or start a CLI
installed elsewhere under the project's runtime from the project directory:
`node -r ./.pnp.cjs <dir>/hooknostic/bin/hooknostic.mjs`, with that CLI
installed outside any other Yarn Plug'n'Play project. With `npx`, a globally
installed `hooknostic` run directly, or `pnpm dlx`, a build that needs a
package from Yarn's install fails with HN504. `yarn dlx` is unsupported too,
and best effort: at most it builds when the project's Zod is in range, it can
fail in other ways, and it never runs the HN110 check
([ADR-0041](https://github.com/roryeckel/hooknostic/blob/master/docs/decisions/0041-yarn-pnp-runtime.md)).

To test what the hooks decide on a target, pipe portable events (JSON Lines) to
`dispatch`; see [Testing your hooks](https://github.com/roryeckel/hooknostic/blob/master/docs/testing-your-hooks.md):

```sh
npx hooknostic dispatch --config ./hooknostic.config.ts --target claude < events.jsonl
```

Start with the [tutorials](https://github.com/roryeckel/hooknostic/tree/master/docs/tutorials)
and [examples](https://github.com/roryeckel/hooknostic/tree/master/examples).
The [harness support table](https://github.com/roryeckel/hooknostic/blob/master/docs/harness-support.md)
records validated versions and capability limitations.

The package also exports the programmatic CLI API. Generated hook runtimes are
standalone ESM artifacts; embedded license notices travel with them. The CLI's
bundled dependency notices are in `dist/THIRD_PARTY_NOTICES.txt`.
Licensed under Apache-2.0.

For a repository, use `npx hooknostic init --local`, `sync --dry-run`, `sync`, and
`verify`. For distribution, follow the [marketplace tutorial](https://github.com/roryeckel/hooknostic/blob/master/docs/tutorials/04-packaging-with-agent-plugins.md).
See the [configuration and command reference](https://github.com/roryeckel/hooknostic/blob/master/docs/configuration.md)
for component policies, dependency preparation, and build reports.
