# Importing SDK schemas from `@hooknostic/sdk/schemas`

The SDK's runtime Zod schemas have moved from the `@hooknostic/sdk` root to the
`@hooknostic/sdk/schemas` subpath, and `zod` is now an optional peer. Writing
hooks and configuration no longer needs Zod: the root entry never loads it, at
runtime or in its type declarations. This is an explicit SDK breaking change
([ADR-0040](../decisions/0040-sdk-schemas-subpath.md)). The package version is
selected separately through the [release workflow](../releases.md).

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

One change ships in the same release. Zod 4 used to drop a `__proto__` name
without a diagnostic. `hooknosticConfigSchema` now rejects it in four fields:
as a target name and as a name in `components.excludeFor`,
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

## Install Zod only where you import the schemas

Code that imports `@hooknostic/sdk/schemas` needs `zod@^4.6.7` installed beside
the SDK:

```sh
pnpm add -D @hooknostic/sdk hooknostic zod@^4.6.7
```

A project that only authors hooks and configuration needs just the SDK and the
CLI:

```sh
pnpm add -D @hooknostic/sdk hooknostic
```

Because the peer is optional, package managers no longer install Zod for the
SDK. If you added `zod` only to satisfy the SDK, you can remove it. Importing
`@hooknostic/sdk/schemas` without Zod installed fails with Node's
`Cannot find package 'zod'` error.

## Rebuild generated artifacts

Generated runtimes still validate handler effects with Zod. A build uses the
Zod your SDK reaches only when it satisfies the SDK's `zod` peer range
(`^4.6.7`). The artifact then carries one copy, shared with any hook code that
imports Zod. Otherwise the SDK's schemas use the `hooknostic` CLI's own Zod,
in one of two cases:

- Your project has no Zod that the SDK can reach. The build says nothing.
- The SDK reaches a Zod outside the range: one too old to provide `zod/v4`
  (3.24 and earlier), or a Zod 3 pulled in by another dependency. The build
  still succeeds, with an HN109 warning that names the version found and the
  copy bundled instead. Your own code that imports `zod` keeps your
  project's copy, so the artifact then carries two. Install a Zod in the
  range to share one.

Under Yarn Plug'n'Play, install `hooknostic` as a devDependency and run it
through Yarn (`yarn hooknostic`), which loads the project's PnP runtime.
`npx`, a global install and `pnpm dlx` run without it, and the build fails
with HN504. `yarn dlx` fails with HN504 when the build needs Hooknostic's own
Zod, because its install is not in the project's PnP manifest. Supporting
those invocations is tracked in
[#190](https://github.com/roryeckel/hooknostic/issues/190).

Keep the SDK and CLI on the same Hooknostic release: an older CLI cannot bundle
against this SDK. From this release on, a CLI that builds against an SDK from
another release warns HN110. Rebuild or re-sync with the new CLI to regenerate
owned output. Artifact bytes change even when your sources do not.
