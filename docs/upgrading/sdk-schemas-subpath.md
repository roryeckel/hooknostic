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

Generated runtimes still validate handler effects with Zod. A build takes Zod
from your project when you have it installed, and otherwise from the
`hooknostic` CLI's own installation. Either way the artifact carries one copy.
Keep the SDK and CLI on the same Hooknostic release: an older CLI cannot bundle
against this SDK. Rebuild or re-sync with the new CLI to regenerate owned
output. Artifact bytes change even when your sources do not.
