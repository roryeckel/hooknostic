# hooknostic

Compile one TypeScript hook source into native artifacts for Claude Code,
OpenAI Codex CLI, and OpenCode. Requires Node.js 22.13.0 or newer.

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
