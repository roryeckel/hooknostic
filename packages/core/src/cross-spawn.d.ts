declare module "cross-spawn" {
  import type {
    ChildProcess,
    SpawnOptions,
    SpawnSyncOptionsWithStringEncoding,
    SpawnSyncReturns,
  } from "node:child_process";

  interface CrossSpawn {
    (command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
    sync(
      command: string,
      args: readonly string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ): SpawnSyncReturns<string>;
  }

  const spawn: CrossSpawn;
  export default spawn;
}
