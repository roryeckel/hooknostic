# Importing SDK schemas from `@hooknostic/sdk/schemas`

The SDK's runtime Zod schemas have moved from the `@hooknostic/sdk` root to the
`@hooknostic/sdk/schemas` subpath, the only SDK entry that needs its `zod`
peer. Hooks and configuration no longer import Zod: the root entry never loads
it, at runtime or in its type declarations. This is an explicit SDK breaking
change in 0.13.0 ([ADR-0040](../decisions/0040-sdk-schemas-subpath.md)).

## Who is affected

You are affected if your code imports any of these from `@hooknostic/sdk`:

`hookEventNameSchema`, `capabilityIdSchema`, `supportLevelSchema`,
`requirementLevelSchema`, `toolKindSchema`, `shellDialectSchema`,
`eventFieldIdSchema`, `toolInvocationSchema`, `baseHookEventSchema`,
`jsonValueSchema`, `effectSchema`, `compatibilityPolicySchema`,
`runtimePolicySchema`, `targetConfigSchema`, `hooknosticConfigSchema`,
`targetScopeSchema`, `toolMatchSchema`, `hookDefinitionSchema`,
`pluginSpecSchema`, `runtimeDiagnosticCodeSchema`, `handlerErrorSchema`,
`hookResultSchema`.

Nothing else moves. `definePlugin`, `hook`, `defineConfig`, the effect helpers,
`RUNTIME_DIAGNOSTIC_CODES`, and every type, including `HookResult`,
`HandlerError` and `PluginSpec`, stay at the root unchanged.

## Update schema imports

Before:

```ts
import * as z from "zod/v4";
import { effectSchema, toolInvocationSchema } from "@hooknostic/sdk";
```

After:

```ts
import * as z from "zod/v4";
import { effectSchema, toolInvocationSchema } from "@hooknostic/sdk/schemas";
```

The schemas are the same Zod 4 Classic objects, with the same behaviour and
inferred types, and they compose with your own V4 schemas as before. The
subpath is an export-map entry, so TypeScript needs the export-aware module
resolution (`node16`, `nodenext` or `bundler`) that the root entry already
requires.

A hook or configuration that still imports a schema from the root fails to
load with HN501. Its remediation names the imports to write instead. For hooks
that start with the "Before" lines above, `hooknostic check` prints (the
project's path shortened to `my-project`):

```text
HN501 invalid configuration [error]

  my-project/hooks.ts

  failed to load entry my-project/hooks.ts: Build failed with 2 errors:
hooks.ts:2:9: ERROR: No matching export in "node_modules/@hooknostic/sdk/dist/index.js" for import "effectSchema"
hooks.ts:2:23: ERROR: No matching export in "node_modules/@hooknostic/sdk/dist/index.js" for import "toolInvocationSchema"

  Remediation: the SDK's schemas moved from @hooknostic/sdk to @hooknostic/sdk/schemas in 0.13.0: import { effectSchema, toolInvocationSchema } from "@hooknostic/sdk/schemas" instead. See https://github.com/roryeckel/hooknostic/blob/master/docs/upgrading/sdk-schemas-subpath.md.
```

One change ships in the same release, 0.13.0. Zod 4 used to drop a
`__proto__` name without a diagnostic. `hooknosticConfigSchema` now rejects
it in four fields: as a target name and as a name in `components.excludeFor`,
`components.mcpOverrides` and a materializer's `inputs`. In
`components.mcpOverrides.<target>.servers` it now keeps a server named
`__proto__`, as `components.mcpEnvironment` already did. To see that name, those
five fields now validate through a transform that inspects the raw input, which
makes them `ZodPipe`s like `components.mcpEnvironment`. If your code does more
with the schema than parse with it:

- Each of those fields is a `ZodPipe` of `z.unknown()` into a transform
  (inside `ZodOptional` where the field is optional), no longer a `ZodRecord`.
  `keyType` and `valueType` are `undefined` on them, so
  `hooknosticConfigSchema.shape.targets.valueType` no longer reaches the target
  schema; import `targetConfigSchema` instead.
- `z.input<typeof hooknosticConfigSchema>` types those fields as `unknown`.
- `z.toJSONSchema` already refused the configuration schema by default, because
  of `mcpEnvironment`. With `unrepresentable: "any"`, those fields now come out
  as `{}` rather than as object schemas.
- `z.encode` and `z.safeEncode` no longer work with `hooknosticConfigSchema`.
  `targets` is required and is now a one-way transform, so encoding any
  configuration throws `ZodEncodeError` ("Encountered unidirectional transform
  during encode"). Before, it worked when `components.mcpEnvironment` was
  absent.
- Per-call parse options such as `error` and `reportInput` still reach issues
  inside those fields, and now also reach issues inside
  `components.mcpEnvironment`, which kept its own messages before. There is one
  exception: the explanation Zod nests inside an
  `invalid_key` issue, for a name that fails its own schema such as an empty
  target name. That explanation keeps the message from the schema's or
  `z.config()`'s error map and omits `input`.

The output types, `HooknosticConfig` and the other types you write
configuration with are unchanged. Whether a configuration parses changes only
where `__proto__` is involved: an own `__proto__` name, or a record whose
prototype was replaced, for example by an object literal entry written as
`__proto__: {...}`.

## Zod is needed only where you import the schemas

Code that imports `@hooknostic/sdk/schemas` needs `zod@^4.6.7` installed beside
the SDK:

```sh
npm install --save-dev @hooknostic/sdk hooknostic zod@^4.6.7
# or
pnpm add -D --allow-build=esbuild @hooknostic/sdk hooknostic zod@^4.6.7
```

A project that only authors hooks and configuration needs just the SDK and the
CLI:

```sh
npm install --save-dev @hooknostic/sdk hooknostic
# or
pnpm add -D --allow-build=esbuild @hooknostic/sdk hooknostic
```

The SDK's `zod` peer is still required. Installed with the CLI, as above, it
is satisfied by the Zod the CLI depends on, under npm, pnpm (strict peers and
auto-install off included) and Yarn. Yarn still reports YN0002 when the
project doesn't list `zod`. Hooks and configuration never import it.

Installed without the CLI, the SDK gets Zod from npm and from pnpm's defaults.
pnpm with `strict-peer-dependencies` on and `auto-install-peers` off fails that
SDK-only install until `zod` is listed, as before, and Yarn adds no Zod. Where
no Zod is reachable, as in such an SDK-only install, importing
`@hooknostic/sdk/schemas` fails with Node's `Cannot find package 'zod'` error
until the project lists `zod`. Yarn Plug'n'Play never lets the SDK reach the
CLI's copy, so there the import fails ("tried to access zod (a peer
dependency) but it isn't provided by your application") even with the CLI
installed, until the project lists `zod`.

Keep the project's Zod at `^4.6.7` or a newer 4.x release. npm refuses a
release outside that range, such as `zod@3`, with `ERESOLVE`. Don't retry
with `--force`: npm then loops instead of installing. `--legacy-peer-deps`
installs Zod 3, but the SDK then reaches it, and a configuration or hook that
imports `@hooknostic/sdk/schemas` fails to load with HN501
(`Could not resolve "zod/v4"`). If your own code needs Zod 3, install it under
an npm alias beside the SDK's Zod 4 and import it as `zod3`:

```sh
npm install --save-dev zod3@npm:zod@3
```

The SDK keeps Zod 4, and a build bundles each copy where it is imported.

## Rebuild generated artifacts

Generated runtimes still validate handler effects with Zod. A build uses the
Zod your SDK reaches only when it satisfies the SDK's `zod` peer range
(`^4.6.7`). The artifact then carries one copy, shared with any hook code that
imports Zod. Otherwise the SDK's schemas use the `hooknostic` CLI's own Zod,
in one of two cases:

- The SDK reaches no Zod. The build says nothing. npm and pnpm install a Zod
  for the SDK's required peer, so with them this is rare. Under Yarn
  Plug'n'Play the SDK never reaches the CLI's copy, so a project that lists no
  `zod` builds its hooks this way, but a configuration or hook that imports
  `@hooknostic/sdk/schemas` fails to load with HN501 until the project lists
  `zod@^4.6.7`.
- The SDK reaches a Zod outside the range: one too old to provide `zod/v4`
  (3.24 and earlier), or a Zod 3 pulled in by another dependency. The build
  still succeeds, with an HN109 warning that names the version found and the
  copy bundled instead. Your own code that imports `zod` keeps your
  project's copy, so the artifact then carries two. Install a Zod in the
  range to share one.

Under Yarn Plug'n'Play, install `hooknostic` as a devDependency and run it
through Yarn (`yarn hooknostic`), which loads the project's PnP runtime, or
start a CLI installed elsewhere under that runtime from the project directory
with `node -r ./.pnp.cjs <dir>/hooknostic/bin/hooknostic.mjs`
([getting started](../getting-started.md) shows it for a global install).
`npx`, a globally installed `hooknostic` run directly and `pnpm dlx` run
without that runtime, and the build fails with HN504. `yarn dlx` is
unsupported: it fails with HN504 when the build needs Hooknostic's own Zod,
because its install is not in the project's PnP manifest, and on Linux with
Node 22, sharing Yarn's global cache with the project, it fails with HN501
("controlled by multiple pnpapi instances") whatever the Zod version.
[ADR-0041](../decisions/0041-yarn-pnp-runtime.md) records the decision.

Keep the SDK and CLI on the same Hooknostic release: an older CLI cannot bundle
against this SDK. From 0.13.0, a CLI that builds against an SDK from another
release warns HN110. Under `yarn dlx` in a Plug'n'Play project, HN110
stays silent: checking the project's SDK there would load the project's PnP
runtime beside dlx's and break the build. Run `yarn hooknostic`, or the
`node -r` form above, to get the check. Rebuild or re-sync with the new CLI
to regenerate owned output. Artifact bytes change even when your sources do
not.

To upgrade the SDK and CLI together, use the command in [Upgrading](README.md).
