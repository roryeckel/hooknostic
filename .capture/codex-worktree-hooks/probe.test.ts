import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runProcess, startModelPlayback } from "../../packages/cli/test/harness-playback.js";

function withoutCredentials(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (/TOKEN|SECRET|PASSWORD|API_KEY|ANTHROPIC|OPENAI|CODEX_HOME|AI_PAT/i.test(name)) delete env[name];
  return env;
}

const toml = (value: string) => `'${value.replaceAll("'", "''")}'`;
const git = (cwd: string, args: string[]) =>
  runProcess("git", ["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", ...args], {
    cwd,
    env: process.env,
    timeoutMs: 30_000,
  });

interface Drive {
  /** Where the linked worktree lives relative to the scratch root. */
  layout: "sibling" | "nested";
  /** Which checkouts carry a labelled `.codex/hooks.json`. */
  hooksIn: readonly ("root" | "worktree")[];
  /** Which checkout Codex runs in. */
  cwd: "root" | "worktree";
  /** Which checkouts get an explicit project trust entry. */
  trusted: readonly ("root" | "worktree")[];
}

// The root checkout is trusted in every drive, as it was in the live session
// this investigates; `worktreeTrusted` adds an explicit entry for the linked
// worktree to separate trust from the hooks-folder choice.
const DRIVES: Record<string, Drive> = {
  worktreeOnly: { layout: "sibling", hooksIn: ["worktree"], cwd: "worktree", trusted: ["root"] },
  both: { layout: "sibling", hooksIn: ["root", "worktree"], cwd: "worktree", trusted: ["root"] },
  worktreeTrusted: { layout: "sibling", hooksIn: ["root", "worktree"], cwd: "worktree", trusted: ["root", "worktree"] },
  nested: { layout: "nested", hooksIn: ["root", "worktree"], cwd: "worktree", trusted: ["root"] },
  rootCheckout: { layout: "sibling", hooksIn: ["root", "worktree"], cwd: "root", trusted: ["root"] },
};

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] as const;

async function drive(spec: Drive) {
  const model = await startModelPlayback("openai-responses", "rewrite");
  const root = await mkdtemp(join(tmpdir(), "hooknostic-codex-worktree-"));
  try {
    const main = join(root, "main");
    const linked = spec.layout === "sibling" ? join(root, "linked") : join(main, ".claude", "worktrees", "linked");
    const home = join(root, "home");
    await mkdir(main, { recursive: true });
    await mkdir(home);
    await git(main, ["init"]);
    // Git would carry a committed .codex into the worktree; keep each
    // checkout's hooks file its own, untracked.
    await writeFile(join(main, ".gitignore"), ".codex/\n.claude/\n");
    await git(main, ["add", ".gitignore"]);
    await git(main, ["commit", "-m", "probe"]);
    const added = await git(main, ["worktree", "add", "--detach", linked]);
    expect(added.code, added.stdout + added.stderr).toBe(0);

    const log = join(root, "dispatch.log").replaceAll("\\", "/");
    const recorder = join(root, "record.mjs").replaceAll("\\", "/");
    await writeFile(
      recorder,
      `import { appendFileSync, readFileSync } from "node:fs";\nconst input = JSON.parse(readFileSync(0, "utf8"));\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ hooksFile: process.argv[2], event: input.hook_event_name, tool_name: input.tool_name }) + "\\n");\n`,
    );
    const checkout = { root: main, worktree: linked };
    for (const label of spec.hooksIn) {
      const hooks = Object.fromEntries(
        EVENTS.map((event) => [
          event,
          [{ hooks: [{ type: "command", command: `node "${recorder}" ${label}`, timeout: 30 }] }],
        ]),
      );
      await mkdir(join(checkout[label], ".codex"), { recursive: true });
      await writeFile(join(checkout[label], ".codex/hooks.json"), JSON.stringify({ hooks }, null, 2));
    }
    await writeFile(
      join(home, "config.toml"),
      [
        'model = "hooknostic-playback"',
        'model_provider = "hooknostic_playback"',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        "[model_providers.hooknostic_playback]",
        'name = "Hooknostic Playback"',
        `base_url = ${toml(`${model.baseUrl}/v1`)}`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "request_max_retries = 0",
        "stream_max_retries = 0",
        ...spec.trusted.flatMap((label) => [`[projects.${toml(checkout[label])}]`, 'trust_level = "trusted"']),
        "",
      ].join("\n"),
    );
    const cwd = checkout[spec.cwd];
    const result = await runProcess("codex", ["exec", "-", "--dangerously-bypass-hook-trust", "--color", "never"], {
      cwd,
      input: "Use the shell tool once to create hooknostic-tool.txt, then stop.",
      timeoutMs: 120_000,
      env: { ...withoutCredentials(), CODEX_HOME: home },
    });
    const dispatched = (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { hooksFile: string; event: string; tool_name?: string });
    return {
      ...spec,
      exitCode: result.code,
      modelErrors: model.errors,
      // The drive is only meaningful if the tool actually ran in the session.
      toolRan: (await readFile(join(cwd, "hooknostic-tool.txt"), "utf8").catch(() => null)) !== null,
      dispatchedBy: Object.fromEntries(
        (["root", "worktree"] as const).map((label) => [
          label,
          [...new Set(dispatched.filter((entry) => entry.hooksFile === label).map((entry) => entry.event))].sort(),
        ]),
      ),
    };
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
}

// What 0.156.1 did (README): a linked worktree's own hooks never ran, and the
// root checkout's ran for every event whenever it had any, whichever checkout
// Codex ran in. A different table on another build is a finding to record,
// not a probe to loosen -- which is why the record is written first.
function expectedDispatch(spec: Drive) {
  return { root: spec.hooksIn.includes("root") ? [...EVENTS].sort() : [], worktree: [] };
}

test("captures which .codex/hooks.json Codex loads in a linked git worktree", async () => {
  const version = await runProcess("codex", ["--version"], { cwd: tmpdir(), env: process.env, timeoutMs: 30_000 });
  const drives: Record<string, Awaited<ReturnType<typeof drive>>> = {};
  for (const [id, spec] of Object.entries(DRIVES)) drives[id] = await drive(spec);
  const observations = {
    codexVersion: version.stdout.trim(),
    platform: process.platform,
    capturedOn: new Date().toLocaleDateString("sv-SE"),
    drives,
  };
  const out = process.env["HOOKNOSTIC_CAPTURE_OUT"] ?? new URL("observations.json", import.meta.url);
  await writeFile(out, JSON.stringify(observations, null, 2) + "\n");
  for (const [id, spec] of Object.entries(DRIVES)) {
    const observed = drives[id]!;
    expect(observed.modelErrors, id).toEqual([]);
    expect(observed.toolRan, `${id}: the scripted shell call never ran, so hook dispatch proves nothing`).toBe(true);
    expect(observed.dispatchedBy, `${id}: which checkout's hooks ran`).toEqual(expectedDispatch(spec));
  }
});
