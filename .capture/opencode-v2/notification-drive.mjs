import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function driveNotifications({ executable, root, project, env, pty }) {
  const { spawn } = pty ?? createRequire(new URL("../../packages/cli/package.json", import.meta.url))("node-pty");
  const child = spawn(executable, ["--standalone", "--auto"], { cwd: project, env, cols: 120, rows: 35, name: "xterm-256color" });
  let transcript = "", exited = false;
  child.onData(chunk => { transcript += chunk; });
  const done = new Promise(resolve => child.onExit(event => { exited = true; resolve(event); }));
  try {
    for (let i = 0; i < 120; i++) {
      if (transcript.includes("hooknostic-server-notification")) break;
      if (exited) throw new Error("TUI exited before rendering the notification");
      await delay(100);
    }
    await writeFile(join(root, "terminal.txt"), transcript);
    const records = (await readFile(env.HKN_NOTIFICATION_TRACE, "utf8")).trim().split("\n").map(JSON.parse);
    if (!transcript.includes("hooknostic-server-notification") || !records.some(row => row.phase === "client-received") || records.some(row => row.phase === "error"))
      throw new Error("Server notification was not rendered: " + JSON.stringify(records));
    child.write("\x03");
    // ConPTY delays its exit event while flushing output. A second interrupt
    // can hit its already-closing input pipe and emit an unhandled EAGAIN.
    await Promise.race([done, delay(3000)]);
  } finally {
    if (!exited) child.kill();
    await done;
  }
}
