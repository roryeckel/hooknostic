import { type FileHandle, mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { AdapterRegistry } from "@hooknostic/core";
import { errorMessage } from "@hooknostic/runtime";

import type { CommandIO } from "./check.js";

const fileNoun = (count: number) => (count === 1 ? "file" : "files");
const indent = (paths: string[]) => paths.map((path) => `  ${path}`);

export async function runInit(
  config: string,
  registry: AdapterRegistry,
  io: CommandIO,
  json: boolean,
): Promise<number> {
  const path = resolve(config);
  const root = dirname(path);
  const targets = Object.fromEntries(
    Object.values(registry)
      .filter((a) => a.projectIntegration)
      .map((a) => [
        a.id,
        {
          adapter: a.id,
          version: a.harness.recommendedRange,
          delivery: "project",
          output: `.hooknostic/artifacts/${a.id}`,
        },
      ]),
  );
  const files = [
    [
      path,
      `import { defineConfig } from "@hooknostic/sdk";\nexport default defineConfig(${JSON.stringify({ project: { root: "." }, entry: "./hooks.ts", targets }, null, 2)});\n`,
    ],
    [
      join(root, "hooks.ts"),
      'import { definePlugin } from "@hooknostic/sdk";\nexport default definePlugin({ name: "sample-project", hooks: [] });\n',
    ],
  ];
  const created: string[] = [];
  const unchanged: string[] = [];
  const fail = (message: string): number => {
    if (json)
      io.stdout(
        JSON.stringify({ schemaVersion: 1, command: "init", ok: false, created, unchanged, errors: [message] }),
      );
    else
      io.stderr(
        [
          message,
          ...(created.length > 0 ? ["Created before the failure, left in place:", ...indent(created)] : []),
        ].join("\n"),
      );
    return 2;
  };
  // Check every target before writing anything, so a directory in the way
  // leaves the project untouched (#217). Any other stat error is left for
  // the loop to report as it always has (#208). An existing file is left
  // unchanged without reading it: a --config naming some other file is
  // listed as unchanged, and a race, a dangling symlink or a FIFO counts as
  // unchanged too.
  const present = new Set<string>();
  for (const [file] of files) {
    let isDirectory: boolean;
    try {
      isDirectory = (await stat(file!)).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) {
      return fail(
        file === path
          ? `init failed: cannot create ${file}: it is a directory; --config names the configuration file, such as ${join(file, "hooknostic.config.ts")}`
          : `init failed: cannot create ${file}: it is a directory`,
      );
    }
    present.add(file!);
  }
  for (const [file, contents] of files) {
    if (present.has(file!)) {
      unchanged.push(file!);
      continue;
    }
    let opening = false;
    let handle: FileHandle | undefined;
    try {
      await mkdir(dirname(file!), { recursive: true });
      opening = true;
      handle = await open(file!, "wx");
      try {
        await handle.writeFile(contents!);
      } finally {
        await handle.close();
      }
      created.push(file!);
    } catch (error) {
      // Only open's EEXIST means the file is already there; mkdir's means
      // its directory is a file.
      if (opening && !handle && (error as NodeJS.ErrnoException).code === "EEXIST") {
        unchanged.push(file!);
        continue;
      }
      // This run opened the file, so it may be truncated: remove it. Files
      // fully created earlier stay, and are listed as created.
      if (handle) await unlink(file!).catch(() => {});
      // A path it cannot create, such as one under a file, is the user's
      // mistake, not an unexpected error with a stack (#208).
      return fail(`init failed: cannot create ${file}: ${errorMessage(error)}`);
    }
  }
  if (json) io.stdout(JSON.stringify({ schemaVersion: 1, command: "init", ok: true, created, unchanged }));
  else
    io.stdout(
      [
        ...(created.length > 0
          ? [`Created ${created.length} ${fileNoun(created.length)}:`, ...indent(created)]
          : ["Created no files."]),
        ...(unchanged.length > 0
          ? [`Left ${unchanged.length} existing ${fileNoun(unchanged.length)} unchanged:`, ...indent(unchanged)]
          : []),
        "Install Hooknostic and its SDK with your package manager, then run hooknostic sync.",
      ].join("\n"),
    );
  return 0;
}
