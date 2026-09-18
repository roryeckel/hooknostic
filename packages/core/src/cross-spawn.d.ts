declare module "cross-spawn" {
  import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";

  interface CrossSpawn {
    sync(
      command: string,
      args: readonly string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ): SpawnSyncReturns<string>;
  }

  const spawn: CrossSpawn;
  export default spawn;
}
