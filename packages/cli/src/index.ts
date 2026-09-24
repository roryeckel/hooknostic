export { runBuild } from "./build.js";
export type { BuildCommandOptions } from "./build.js";
export { runCheck } from "./check.js";
export type { CheckOptions, CommandIO } from "./check.js";
export { CLI_USAGE, runCli } from "./cli.js";
export { DISPATCH_NATIVE_EVENT, dispatchEvents, runDispatch } from "./dispatch.js";
export type { DispatchCommandOptions, DispatchEventsOptions, DispatchOutcome, DispatchResult } from "./dispatch.js";
export { runDoctor } from "./doctor.js";
export type { DoctorCommandOptions } from "./doctor.js";
export { runInspect } from "./inspect.js";
export type { InspectCommandOptions } from "./inspect.js";
export { defaultAdapterRegistry } from "./registry.js";
/** Used by generated support documentation and programmatic inspection clients. */
export { resolveAgentPluginProjection } from "@hooknostic/core";

export { buildProject, runProject } from "@hooknostic/core";
export type { BuildOptions, BuildResult, ProjectCommandResult } from "@hooknostic/core";
