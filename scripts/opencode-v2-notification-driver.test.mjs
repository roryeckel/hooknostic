import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";

import { expect, it, vi } from "vitest";

import { driveNotifications } from "../.capture/opencode-v2/notification-drive.mjs";

it("waits for terminal exit after one interrupt without writing to a closing input pipe", async () => {
  // Constructed transport regression: ConPTY can report exit after its input
  // pipe has closed. The real-host playback still verifies rendering/cleanup.
  const root = await mkdtemp(join(tmpdir(), "hooknostic-notification-exit-"));
  let exited, timer;
  const child = {
    onData: (callback) => callback("hooknostic-server-notification"),
    onExit: (callback) => {
      exited = callback;
    },
    write: vi.fn(() => {
      if (timer) throw Object.assign(new Error("write EAGAIN"), { code: "EAGAIN" });
      timer = setTimeout(() => exited({ exitCode: 0 }), 500);
    }),
    kill: vi.fn(() => exited({ exitCode: 1 })),
  };
  try {
    const trace = join(root, "trace.jsonl");
    await writeFile(trace, JSON.stringify({ phase: "client-received" }) + "\n");
    await driveNotifications({
      executable: "fake",
      root,
      project: root,
      env: { HKN_NOTIFICATION_TRACE: trace },
      pty: { spawn: () => child },
    });
    expect(child.write).toHaveBeenCalledExactlyOnceWith("\x03");
    expect(child.kill).not.toHaveBeenCalled();
  } finally {
    clearTimeout(timer);
    await rm(root, { recursive: true, force: true });
  }
});
