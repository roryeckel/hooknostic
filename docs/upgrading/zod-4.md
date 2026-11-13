# Migrating SDK consumers to Zod 4

The SDK now exports native Zod 4 Classic schemas and requires `zod: ^4.6.7`
as a peer dependency. This is an explicit SDK breaking change. It replaces the
Zod 3 schema API exported by earlier releases, including when those schemas
were composed with a consumer's own Zod 3 instance. The package version is
selected separately through the [release workflow](../releases.md).

## Upgrade and compose schemas

Install the SDK release containing this migration and upgrade your Zod peer:

```sh
pnpm add -D @hooknostic/sdk hooknostic zod@^4.6.7
```

Use regular dependencies instead if your application imports the SDK at runtime.
Keep the SDK and CLI on the same Hooknostic release. Refresh your lockfile and
rebuild generated Hooknostic artifacts with that CLI.

Before, with Zod 3:

```ts
import { z } from "zod/v3";
import { toolInvocationSchema } from "@hooknostic/sdk";

const schema = z.object({
  tool: toolInvocationSchema.extend({ label: z.string() }),
});
```

After:

```ts
import * as z from "zod/v4";
import { toolInvocationSchema } from "@hooknostic/sdk";

const schema = z.object({
  tool: toolInvocationSchema.extend({ label: z.string() }),
});
```

The namespace import above lets bundlers discard unused V4 exports. The root
`zod` entry also works when the installed package is V4. Compose SDK
schemas with V4 schemas throughout; a V3 schema is not interchangeable with a
V4 schema. Exported SDK objects provide the Classic API, such as `.extend()`.
Replace V3-specific schema annotations with V4 types, for example `z.ZodType`.
Consumers that accept either Classic or Mini schemas can use the base types
from `zod/v4/core`; SDK exports themselves are Classic schemas.

## Update error handling

Import `ZodError` from `zod/v4` and read `.issues`. V4 removes the `.errors`
alias. Issue codes and fields can differ; for example an `invalid_type` issue
no longer provides V3's `received` field. Avoid comparing complete error
messages or depending on V3-only issue types.

```ts
const result = schema.safeParse(value);
if (!result.success) {
  for (const issue of result.error.issues) {
    console.error(issue.path, issue.code, issue.message);
  }
}
```

`HookResult.errors` remains the Hooknostic handler-error array. It is unrelated
to the removed Zod error alias and keeps its existing name and structure.

## Check validation boundaries

Hooknostic event names, effects, capability IDs and `schemaVersion: 1` stay the
same. Capability declarations remain partial maps: declaring one capability
does not require listing every registered capability. Strict canonical objects
still reject unknown keys, and the base event envelope still allows extra
event-specific fields. MCP environment entries named `__proto__` remain
validated and preserved as own data properties.

V4 changes some validation and inference behavior:

- The `input` key of `toolInvocationSchema` and the `raw` key of
  `baseHookEventSchema` are required. Explicit `undefined` remains valid for
  these unknown-valued fields; omitting the key fails validation. Supply the
  original payload, or explicitly `undefined` when constructing an event.
- Integer schemas now reject unsafe integers. This also applies to character
  limits; timeout fields retain their existing stricter Node timer ceiling.
- Symbol-keyed entries in authored maps are rejected with diagnostics instead
  of being silently ignored. Use string target names and registered capability IDs.
- Invalid replacement payloads still fail JSON validation. A hostile proxy
  that previously made Zod throw during inspection can now produce an ordinary
  unsuccessful `safeParse` result. Keep exception handling for other proxy traps.

Run your TypeScript build and tests after updating annotations, schema
composition and error handlers. The repository checks an actual packed SDK
consumer at the supported V4 peer floor in CI. See the
[upstream migration guide](https://zod.dev/v4/changelog) for changes to any Zod
APIs your own schemas use.

## Security floor

The minimum V4 peer is 4.6.7. The repository no longer resolves Zod 3.25.76,
whose distribution also contains the affected V4 parser described in
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
Upgrading Hooknostic does not update unrelated copies of Zod in a consumer's
dependency graph; audit those separately.
