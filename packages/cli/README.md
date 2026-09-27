# hooknostic

Compile portable hooks, skills, and MCP servers into native packages or repository
integrations for Claude Code, Codex, and OpenCode. Agent Plugins 1.0 packages can be
projected for Claude and Codex marketplace distribution. Requires Node.js 22.13+.

```sh
npm install --save-dev hooknostic @hooknostic/sdk
npx hooknostic --help
npx hooknostic doctor
npx hooknostic inspect claude
```

After authoring a hook and `hooknostic.config.ts`:

```sh
npx hooknostic check --config ./hooknostic.config.ts
npx hooknostic build --config ./hooknostic.config.ts
```

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
