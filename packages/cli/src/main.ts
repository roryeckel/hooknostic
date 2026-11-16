// The `hooknostic` command's own entry, which bin.ts imports. Bundled beside
// the programmatic entry (scripts/bundle.mjs) and not exported from it: only
// the command takes over its process; the exported runCli never does.
export { main } from "./cli.js";
