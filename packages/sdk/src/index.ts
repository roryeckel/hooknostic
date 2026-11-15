/** Canonical serialized-schema version (events/effects/build report). */
export const CANONICAL_SCHEMA_VERSION = 1 as const;

// The root entry never loads Zod, at runtime or in its declarations, so hook
// and config authors need no Zod install (ADR-0040). The Zod schemas are the
// `@hooknostic/sdk/schemas` entry (./schemas.js); do not re-export them here.
export * from "./capabilities.js";
export * from "./config.js";
export * from "./effects.js";
export * from "./events.js";
export * from "./fields.js";
export * from "./hook.js";
export * from "./json.js";
export * from "./plugin.js";
export * from "./process.js";
export * from "./result.js";
export * from "./support.js";
export * from "./tools.js";
