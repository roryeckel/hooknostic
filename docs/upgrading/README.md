# Upgrading

Hooknostic is pre-1.0: any minor release may contain breaking changes. Each
release's notes include an "Upgrading" section with the steps for that release.
Changes that need more than a few lines get a guide here.

When upgrading:

- Keep `@hooknostic/sdk`, `@hooknostic/agent-plugin`, and the `hooknostic` CLI
  on the same release. `check`, `build`, `sync` and `verify` warn HN110 when
  the CLI and the project's SDK are on different releases, including beside
  a configuration that fails to load. Upgrade them in one command, adding
  `@hooknostic/agent-plugin@latest` if you depend on it:

  ```sh
  npm install --save-dev @hooknostic/sdk@latest hooknostic@latest
  ```

  With pnpm, run `pnpm add -D @hooknostic/sdk@latest hooknostic@latest`, adding
  `--allow-build=esbuild` if the project has not
  [allowed esbuild's install script](../getting-started.md#1-install-the-authoring-and-cli-packages)
  yet. If your project imports the SDK or `@hooknostic/agent-plugin` at
  runtime, upgrade those with `--save` (pnpm: without `-D`) instead, so they
  stay regular dependencies. Both package managers save a `^` range; if your
  project pins exact versions, add `--save-exact`.
- Rebuild packages or re-sync projects with the new CLI to regenerate owned
  output.
- Read the release notes' upgrading section, then any guide below for the
  releases you are crossing.

| Guide | Release | Who is affected |
| --- | --- | --- |
| [Zod 4 schemas](zod-4.md) | 0.12.0 | SDK consumers who compose exported schemas, annotate Zod types, or handle `ZodError` |
| [Schemas subpath](sdk-schemas-subpath.md) | 0.13.0 | SDK consumers who import runtime schemas from `@hooknostic/sdk` |
