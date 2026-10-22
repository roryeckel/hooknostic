import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { describeAdapterContract, loadFixtureFrom } from "@hooknostic/testkit";

import { copilotHarness } from "./harness.js";
import { copilotAdapter } from "./index.js";

describeAdapterContract(copilotAdapter(), {
  fixturesDir: resolve(import.meta.dirname, "../../../fixtures/copilot/1.0"),
  version: copilotHarness.recommendedRange,
});

describe("Copilot public runtime", () => {
  it("decodes a camelCase payload when the caller supplies the native event hint", async () => {
    const input = loadFixtureFrom(
      resolve(import.meta.dirname, "../../../fixtures/copilot/1.0/session-start.input.json"),
    );
    const event = await copilotAdapter().runtime.decode(input, { targetId: "copilot" }, "sessionStart");
    expect(event.event).toBe("session.start");
    expect(event.harness.nativeEvent).toBe("sessionStart");
  });
});

describe("Copilot detection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports the installed build without letting --version auto-update it", async () => {
    // Stands in for 1.0.101, whose bare --version downloaded and reported 1.0.102.
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-copilot-detect-"));
    try {
      const script = join(dir, "fake-copilot.mjs");
      await writeFile(
        script,
        'console.log(process.argv.includes("--no-auto-update") ? "GitHub Copilot CLI 1.0.101." : "GitHub Copilot CLI 1.0.102.");\n',
      );
      if (process.platform === "win32") {
        await writeFile(join(dir, "copilot.cmd"), `@"${process.execPath}" "${script}" %*\r\n`);
      } else {
        await writeFile(join(dir, "copilot"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
          mode: 0o755,
        });
      }
      vi.stubEnv("PATH", `${dir}${delimiter}${process.env["PATH"] ?? ""}`);
      const detection = await copilotAdapter().detect!();
      expect(detection).toMatchObject({ installed: true, version: "1.0.101" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
