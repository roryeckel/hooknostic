import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  addContext,
  ALL_CAPABILITY_IDS,
  block,
  blockContinuation,
  capabilitiesForEvent,
  capabilityForEffect,
  findNonJsonPath,
  hook,
  HOOK_EVENT_NAMES,
  isJsonValue,
  isTerminalEffect,
  leastCapable,
  meetsMinimum,
  notify,
  observeCapability,
  preventStop,
  replaceInput,
  replaceOutput,
  requestApproval,
  updateShell,
} from "./index.js";
import {
  baseHookEventSchema,
  effectSchema,
  hooknosticConfigSchema,
  pluginSpecSchema,
  toolInvocationSchema,
} from "./schemas.js";

describe("support levels", () => {
  it("orders exact > emulated > approximate > unsupported", () => {
    expect(meetsMinimum("exact", "emulated")).toBe(true);
    expect(meetsMinimum("emulated", "emulated")).toBe(true);
    expect(meetsMinimum("approximate", "emulated")).toBe(false);
    expect(meetsMinimum("unsupported", "approximate")).toBe(false);
    expect(leastCapable("exact", "approximate")).toBe("approximate");
    expect(leastCapable("unsupported", "emulated")).toBe("unsupported");
  });
});

describe("capability registry", () => {
  it("has an observe capability for every normalized event", () => {
    for (const event of HOOK_EVENT_NAMES) {
      expect(observeCapability(event)).toBe(`${event}.observe`);
    }
  });

  it("scopes every registered capability to a normalized event", () => {
    for (const id of ALL_CAPABILITY_IDS) {
      const owner = HOOK_EVENT_NAMES.find((e) => id.startsWith(`${e}.`));
      expect(owner, `capability ${id} has no owning event`).toBeDefined();
    }
  });

  it("lists capabilities per event", () => {
    expect(capabilitiesForEvent("turn.stop")).toEqual(["turn.stop.observe", "turn.stop.prevent", "turn.stop.notify"]);
    expect(capabilitiesForEvent("session.start")).toEqual([
      "session.start.observe",
      "session.start.context.add",
      "session.start.notify",
    ]);
    expect(capabilitiesForEvent("agent.stop")).toEqual([
      "agent.stop.observe",
      "agent.stop.prevent",
      "agent.stop.notify",
    ]);
    expect(capabilitiesForEvent("tool.before")).toEqual([
      "tool.before.observe",
      "tool.before.block",
      "tool.before.requestApproval",
      "tool.before.input.replace",
      "tool.before.context.add",
    ]);
  });
});

describe("effect → capability mapping", () => {
  it("maps every helper to its event-scoped capability", () => {
    expect(capabilityForEffect("tool.before", "block")).toBe("tool.before.block");
    expect(capabilityForEffect("tool.before", "replaceInput")).toBe("tool.before.input.replace");
    expect(capabilityForEffect("tool.before", "updateShell")).toBe("tool.before.input.replace");
    expect(capabilityForEffect("tool.before", "requestApproval")).toBe("tool.before.requestApproval");
    expect(capabilityForEffect("tool.after", "replaceOutput")).toBe("tool.after.output.replace");
    expect(capabilityForEffect("tool.after", "blockContinuation")).toBe("tool.after.blockContinuation");
    expect(capabilityForEffect("session.start", "addContext")).toBe("session.start.context.add");
    expect(capabilityForEffect("turn.stop", "preventStop")).toBe("turn.stop.prevent");
    expect(capabilityForEffect("agent.stop", "preventStop")).toBe("agent.stop.prevent");
    expect(capabilityForEffect("turn.stop", "notify")).toBe("turn.stop.notify");
    expect(capabilityForEffect("session.start", "notify")).toBe("session.start.notify");
    expect(capabilityForEffect("agent.stop", "notify")).toBe("agent.stop.notify");
  });

  it("returns undefined for structurally impossible effects", () => {
    expect(capabilityForEffect("session.end", "block")).toBeUndefined();
    expect(capabilityForEffect("tool.before", "replaceOutput")).toBeUndefined();
    expect(capabilityForEffect("tool.after", "replaceInput")).toBeUndefined();
    expect(capabilityForEffect("tool.after", "updateShell")).toBeUndefined();
    expect(capabilityForEffect("session.start", "preventStop")).toBeUndefined();
    // notify is scoped to the stop events and session.start (ADR-0036); no
    // other event has a user-visible channel that does not also change control
    // flow.
    expect(capabilityForEffect("tool.before", "notify")).toBeUndefined();
    expect(capabilityForEffect("session.end", "notify")).toBeUndefined();
  });

  it("classifies terminal effects per ADR-0005", () => {
    expect(isTerminalEffect(block("x"))).toBe(true);
    expect(isTerminalEffect(updateShell({ command: "x" }))).toBe(false);
    expect(isTerminalEffect(requestApproval())).toBe(true);
    expect(isTerminalEffect(preventStop())).toBe(true);
    expect(isTerminalEffect(blockContinuation("x"))).toBe(true);
    expect(isTerminalEffect(replaceInput({}))).toBe(false);
    expect(isTerminalEffect(replaceOutput({}))).toBe(false);
    expect(isTerminalEffect(addContext("x"))).toBe(false);
    expect(isTerminalEffect(notify("x"))).toBe(false);
  });

  it("does not treat a prototype-chain key as terminal", () => {
    // isTerminalEffect is public API and reachable with an unvalidated object;
    // a bare table lookup would return a truthy function here.
    expect(isTerminalEffect({ kind: "toString" } as never)).toBe(false);
  });
});

describe("canonical schemas", () => {
  const envelope = {
    schemaVersion: 1,
    event: "tool.before",
    harness: { id: "claude", version: "2.1.238", nativeEvent: "PreToolUse" },
    session: { id: "s-1", cwd: "C:/repo" },
    correlation: { toolCallId: "toolu_1" },
    raw: { anything: true, extra_vendor_field: [1, 2, 3] },
  };

  it("validates both normalized tool views and rejects fields outside them", () => {
    const tool = {
      kind: "file.edit",
      nativeName: "apply_patch",
      input: { command: "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch" },
      file: { paths: ["a.txt"], patchKey: "command" },
    };
    expect(toolInvocationSchema.parse(tool)).toEqual(tool);
    expect(() => toolInvocationSchema.parse({ ...tool, file: { ...tool.file, resolved: "/abs/a.txt" } })).toThrow();
  });

  it("validates a shell view's dialect against the registered families", () => {
    // The schema is strict: a dialect the type declares but this twin omitted
    // would reject every event an adapter decodes with one.
    const tool = {
      kind: "shell",
      nativeName: "PowerShell",
      input: { command: "ls" },
      shell: { command: "ls", commandKey: "command", dialect: "powershell" },
    };
    expect(toolInvocationSchema.parse(tool)).toEqual(tool);
    for (const dialect of ["bash", "pwsh", ""]) {
      expect(() => toolInvocationSchema.parse({ ...tool, shell: { ...tool.shell, dialect } })).toThrow();
    }
  });

  it("validates a canonical event envelope and passes through event payload fields", () => {
    const parsed = baseHookEventSchema.parse({
      ...envelope,
      tool: { kind: "shell", nativeName: "Bash", input: { command: "ls" } },
    });
    expect((parsed as Record<string, unknown>).tool).toBeDefined();
  });

  it("rejects a wrong schema version and unknown envelope sub-fields", () => {
    expect(() => baseHookEventSchema.parse({ ...envelope, schemaVersion: 2 })).toThrow();
    expect(() =>
      baseHookEventSchema.parse({
        ...envelope,
        harness: { ...envelope.harness, invented: true },
      }),
    ).toThrow();
  });

  it("validates effects strictly", () => {
    expect(effectSchema.parse(block("no"))).toEqual({ kind: "block", reason: "no" });
    expect(() => effectSchema.parse({ kind: "block" })).toThrow();
    expect(() => effectSchema.parse({ kind: "allow" })).toThrow();
    expect(() => effectSchema.parse({ kind: "block", reason: "x", extra: 1 })).toThrow();
    expect(effectSchema.parse(updateShell({ command: "pnpm i" }))).toEqual({
      kind: "updateShell",
      command: "pnpm i",
    });
    expect(() => effectSchema.parse({ kind: "updateShell" })).toThrow();
    expect(() => effectSchema.parse({ kind: "updateShell", command: "x", cwd: "y" })).toThrow();
    expect(effectSchema.parse(notify("hi"))).toEqual({ kind: "notify", message: "hi" });
    expect(() => effectSchema.parse({ kind: "notify" })).toThrow();
    // An empty user-facing notification is definitionally a bug, so it is
    // rejected rather than emitted as a blank line.
    expect(() => effectSchema.parse({ kind: "notify", message: "" })).toThrow();
    expect(() => effectSchema.parse({ kind: "notify", message: "x", extra: 1 })).toThrow();
  });

  it("validates config and rejects unknown keys", () => {
    const config = {
      entry: "./src/hooks.ts",
      compatibility: { minimum: "emulated", onBelowMinimum: "error" },
      targets: {
        claude: { version: ">=2.1 <3", delivery: "package", output: "./dist/claude" },
      },
    };
    expect(hooknosticConfigSchema.parse(config).entry).toBe("./src/hooks.ts");
    // An npm coordinate the Agent Plugins name grammar cannot spell.
    expect(
      hooknosticConfigSchema.parse({
        ...config,
        targets: { ...config.targets, claude: { ...config.targets.claude, npmName: "@scope/name" } },
      }).targets.claude!.npmName,
    ).toBe("@scope/name");
    // Project delivery writes into a live repository: there is no package for a
    // coordinate to name, so accepting it would be accepting a promise.
    expect(() =>
      hooknosticConfigSchema.parse({
        entry: "./src/hooks.ts",
        project: { root: "." },
        targets: { claude: { version: ">=2.1 <3", delivery: "project", output: "./dist", npmName: "@scope/name" } },
      }),
    ).toThrow(/npmName requires package delivery/);
    expect(() => hooknosticConfigSchema.parse({ ...config, daemon: true })).toThrow();
    expect(() =>
      hooknosticConfigSchema.parse({
        ...config,
        targets: { claude: { version: ">=2.1 <3", mode: "service", output: "./x" } },
      }),
    ).toThrow();
  });

  it("preserves prototype-key MCP environment server names without polluting the output", () => {
    const mcpEnvironment = Object.fromEntries([
      ["__proto__", ["PROTOTYPE_TOKEN"]],
      ["constructor", ["CONSTRUCTOR_TOKEN"]],
      ["ordinary", ["ORDINARY_TOKEN"]],
    ]);
    const parsed = hooknosticConfigSchema.parse({
      components: { root: ".", mcpEnvironment },
      targets: { codex: { version: ">=0.148 <1", delivery: "package", output: "./dist/codex" } },
    });
    const environment = parsed.components!.mcpEnvironment!;

    expect(Object.getPrototypeOf(environment)).toBe(Object.prototype);
    for (const name of ["__proto__", "constructor", "ordinary"]) expect(Object.hasOwn(environment, name)).toBe(true);
    expect(environment["__proto__"]).toEqual(["PROTOTYPE_TOKEN"]);
    expect(environment["constructor"]).toEqual(["CONSTRUCTOR_TOKEN"]);
    expect(environment["ordinary"]).toEqual(["ORDINARY_TOKEN"]);
  });

  it("still validates an MCP environment value under a prototype-key server name", () => {
    const result = hooknosticConfigSchema.safeParse({
      components: { root: ".", mcpEnvironment: Object.fromEntries([["__proto__", [""]]]) },
      targets: { codex: { version: ">=0.148 <1", delivery: "package", output: "./dist/codex" } },
    });

    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
        "components",
        "mcpEnvironment",
        "__proto__",
        0,
      ]);
  });

  describe("__proto__ as a user-chosen name (#198)", () => {
    const PROTOTYPE_KEY_MESSAGE =
      '"__proto__" cannot be used as a name: JavaScript treats it as an object\'s prototype, not an ordinary key';
    const packageTarget = { version: ">=2.1 <3", delivery: "package" as const, output: "./dist/claude" };
    const projectTarget = { version: ">=1 <2", delivery: "project" as const, output: "./dist/client" };
    const provider = { id: "fixture", plan: () => ({ command: "fixture", args: [] }) };
    // An own `__proto__` key. Object.fromEntries defines it; an object literal
    // entry spelled `__proto__: value` would set the prototype instead.
    const ownProto = (value: unknown) => Object.fromEntries([["__proto__", value]]);
    const pathsAndMessages = (result: ReturnType<typeof hooknosticConfigSchema.safeParse>) =>
      result.success ? [] : result.error.issues.map(({ path, message }) => ({ path, message }));

    it.each([
      {
        record: "targets",
        config: { entry: "./src/hooks.ts", targets: ownProto(packageTarget) },
        path: ["targets", "__proto__"],
      },
      {
        record: "components.mcpOverrides",
        config: {
          project: { root: "." },
          components: { mcp: "./mcp.json", mcpOverrides: ownProto({ startupTimeoutMs: 1_000 }) },
          targets: { client: projectTarget },
        },
        path: ["components", "mcpOverrides", "__proto__"],
      },
      {
        record: "components.excludeFor",
        config: { components: { root: ".", excludeFor: ownProto(["x/**"]) }, targets: { claude: packageTarget } },
        path: ["components", "excludeFor", "__proto__"],
      },
      {
        record: "components.materialize[].inputs",
        config: {
          components: { root: ".", materialize: [{ provider, inputs: ownProto("lock.json"), into: "generated" }] },
          targets: { claude: packageTarget },
        },
        path: ["components", "materialize", 0, "inputs", "__proto__"],
      },
    ])("rejects a $record entry named __proto__", ({ config, path }) => {
      expect(pathsAndMessages(hooknosticConfigSchema.safeParse(config))).toEqual([
        { path, message: PROTOTYPE_KEY_MESSAGE },
      ]);
    });

    it("rejects the issue's lone __proto__ target instead of parsing it as no targets", () => {
      const result = hooknosticConfigSchema.safeParse({
        entry: "./src/hooks.ts",
        targets: { ["__proto__"]: { adapter: "claude", version: ">=2.1 <3", delivery: "project", output: "./out" } },
      });

      expect(pathsAndMessages(result)).toEqual([{ path: ["targets", "__proto__"], message: PROTOTYPE_KEY_MESSAGE }]);
    });

    it("still reports the other entries' problems in the same record", () => {
      const targets = Object.fromEntries([
        ["__proto__", packageTarget],
        ["", packageTarget],
        ["claude", { ...packageTarget, version: "" }],
      ]);
      const result = hooknosticConfigSchema.safeParse({ entry: "./src/hooks.ts", targets });

      expect(result.success).toBe(false);
      const paths = result.success ? [] : result.error.issues.map((issue) => issue.path);
      expect(paths).toContainEqual(["targets", "__proto__"]);
      expect(paths).toContainEqual(["targets", ""]);
      expect(paths).toContainEqual(["targets", "claude", "version"]);
    });

    it("keeps config-level issues beside an issue inside a named record", () => {
      const result = hooknosticConfigSchema.safeParse({ targets: { claude: { ...packageTarget, version: "" } } });

      expect(pathsAndMessages(result)).toEqual([
        { path: ["targets", "claude", "version"], message: expect.stringContaining("Too small") },
        { path: [], message: "at least one of entry or components is required" },
      ]);
    });

    it("still stops config-level checks after an aborting issue inside a named record", () => {
      // A wrong-typed value aborts in Zod 4, so master never ran the
      // config-level checks for this input. This pins that the record's raw
      // issues keep their own `continue` flags, unlike the too_small issue
      // above, which never aborts; it also fails if a Zod release changes
      // these semantics underneath `_zod.run`.
      const result = hooknosticConfigSchema.safeParse({ targets: { claude: { ...packageTarget, adapter: 5 } } });

      expect(pathsAndMessages(result)).toEqual([
        { path: ["targets", "claude", "adapter"], message: expect.stringContaining("expected string") },
      ]);
    });

    it("keeps config-level issues beside the __proto__ name issue", () => {
      const result = hooknosticConfigSchema.safeParse({ targets: ownProto(packageTarget) });

      expect(pathsAndMessages(result)).toEqual([
        { path: ["targets", "__proto__"], message: PROTOTYPE_KEY_MESSAGE },
        { path: [], message: "at least one of entry or components is required" },
      ]);
    });

    it("applies per-call parse options to issues inside a named record", () => {
      const result = hooknosticConfigSchema.safeParse(
        { entry: "./src/hooks.ts", targets: { claude: { ...packageTarget, version: "" } } },
        { error: () => "per-call message", reportInput: true },
      );

      expect(pathsAndMessages(result)).toEqual([
        { path: ["targets", "claude", "version"], message: "per-call message" },
      ]);
      if (!result.success) expect(result.error.issues[0]).toHaveProperty("input", "");
    });

    describe("a Proxy whose traps throw while __proto__ is looked for", () => {
      const throwsOnPrototype = <T extends object>(target: T) =>
        new Proxy(target, {
          getPrototypeOf() {
            throw new Error("getPrototypeOf trap");
          },
        });
      const throwsOnProtoDescriptor = <T extends object>(target: T) =>
        new Proxy(target, {
          getOwnPropertyDescriptor(object, property) {
            if (property === "__proto__") throw new Error("getOwnPropertyDescriptor trap");
            return Reflect.getOwnPropertyDescriptor(object, property);
          },
        });

      it.each([
        { trap: "getPrototypeOf", wrap: throwsOnPrototype },
        { trap: "getOwnPropertyDescriptor for __proto__", wrap: throwsOnProtoDescriptor },
      ])("leaves the record's own result standing: $trap", ({ wrap }) => {
        const accepted = hooknosticConfigSchema.safeParse({
          entry: "./src/hooks.ts",
          targets: wrap({ claude: packageTarget }),
        });
        expect(accepted.success).toBe(true);
        if (accepted.success) expect(accepted.data.targets).toEqual({ claude: packageTarget });

        const rejected = hooknosticConfigSchema.safeParse({
          entry: "./src/hooks.ts",
          targets: wrap({ claude: { ...packageTarget, version: "" } }),
        });
        expect(pathsAndMessages(rejected)).toEqual([
          { path: ["targets", "claude", "version"], message: expect.stringContaining("Too small") },
        ]);
      });

      it("keeps an MCP environment record's own issues when looking for __proto__ throws", () => {
        const result = hooknosticConfigSchema.safeParse({
          components: { root: ".", mcpEnvironment: throwsOnProtoDescriptor({ server: [""] }) },
          targets: { claude: packageTarget },
        });

        expect(pathsAndMessages(result)).toEqual([
          { path: ["components", "mcpEnvironment", "server", 0], message: expect.stringContaining("Too small") },
        ]);
      });
    });

    it("keeps constructor and prototype as ordinary target and MCP server names", () => {
      const targets = Object.fromEntries([
        ["constructor", { ...packageTarget, adapter: "claude" }],
        ["prototype", { ...packageTarget, adapter: "claude", output: "./dist/other" }],
      ]);
      const parsedTargets = hooknosticConfigSchema.parse({ entry: "./src/hooks.ts", targets }).targets;
      expect(Object.keys(parsedTargets)).toEqual(["constructor", "prototype"]);
      expect(Object.getPrototypeOf(parsedTargets)).toBe(Object.prototype);

      const servers = Object.fromEntries([
        ["constructor", { args: ["one"] }],
        ["prototype", { args: ["two"] }],
      ]);
      const parsedServers = hooknosticConfigSchema.parse({
        project: { root: "." },
        components: { mcp: "./mcp.json", mcpOverrides: { client: { servers } } },
        targets: { client: projectTarget },
      }).components!.mcpOverrides!.client!.servers!;
      expect(Object.hasOwn(parsedServers, "constructor")).toBe(true);
      expect(Object.hasOwn(parsedServers, "prototype")).toBe(true);
      expect(parsedServers["constructor"]).toEqual({ args: ["one"] });
      expect(parsedServers["prototype"]).toEqual({ args: ["two"] });
    });

    it("rejects the object literal spelling, which replaces the record's prototype", () => {
      const literal = hooknosticConfigSchema.safeParse({
        entry: "./src/hooks.ts",
        targets: { __proto__: packageTarget, codex: { ...packageTarget, output: "./dist/codex" } },
      });
      expect(pathsAndMessages(literal)).toEqual([
        { path: ["targets", "__proto__"], message: expect.stringContaining(PROTOTYPE_KEY_MESSAGE) },
      ]);
      if (!literal.success) expect(literal.error.issues[0]!.message).toContain("prototype was replaced");

      // Records that never had a prototype to replace stay accepted.
      const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { claude: packageTarget });
      expect(hooknosticConfigSchema.safeParse({ entry: "./src/hooks.ts", targets: nullPrototype }).success).toBe(true);
      const parsedJson = JSON.parse(`{"claude": ${JSON.stringify(packageTarget)}}`) as unknown;
      expect(hooknosticConfigSchema.safeParse({ entry: "./src/hooks.ts", targets: parsedJson }).success).toBe(true);
      // A value that is not a record keeps only Zod's own diagnostic.
      expect(
        pathsAndMessages(hooknosticConfigSchema.safeParse({ entry: "./src/hooks.ts", targets: [packageTarget] })),
      ).toEqual([{ path: ["targets"], message: expect.stringContaining("expected record") }]);
    });

    it("says the prototype was replaced without assuming an object literal did it", () => {
      const inherited = Object.assign(Object.create({ inherited: packageTarget }) as Record<string, unknown>, {
        claude: packageTarget,
      });
      const result = hooknosticConfigSchema.safeParse({ entry: "./src/hooks.ts", targets: inherited });

      expect(pathsAndMessages(result)).toEqual([
        {
          path: ["targets", "__proto__"],
          message: `${PROTOTYPE_KEY_MESSAGE}; this record's prototype was replaced (for example by an object literal entry written as __proto__: {...}), and a computed ["__proto__"] key is not accepted either, so use a plain object and choose another name`,
        },
      ]);
    });

    it("accepts records and configs from another realm", () => {
      const target = JSON.stringify(packageTarget);
      const foreignTargets = runInNewContext(`({ claude: ${target} })`) as unknown;
      expect(Object.getPrototypeOf(foreignTargets)).not.toBe(Object.prototype);
      expect(hooknosticConfigSchema.safeParse({ entry: "./src/hooks.ts", targets: foreignTargets }).success).toBe(true);

      const foreignConfig = runInNewContext(`({ entry: "./src/hooks.ts", targets: { claude: ${target} } })`) as unknown;
      const parsed = hooknosticConfigSchema.safeParse(foreignConfig);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.targets).toEqual({ claude: packageTarget });

      // Another realm's object literal still replaces the record's prototype.
      const foreignLiteral = runInNewContext(`({ entry: "./src/hooks.ts", targets: { __proto__: ${target} } })`);
      expect(pathsAndMessages(hooknosticConfigSchema.safeParse(foreignLiteral))).toEqual([
        { path: ["targets", "__proto__"], message: expect.stringContaining("prototype was replaced") },
      ]);
    });

    // A project's mcp.json may name a server `__proto__`, so an override for it
    // is kept as an own entry (#206), validated like any other.
    describe("an MCP server override named __proto__", () => {
      const servers = ["components", "mcpOverrides", "client", "servers"];
      const withServers = (record: unknown) => ({
        project: { root: "." },
        components: { mcp: "./mcp.json", mcpOverrides: { client: { servers: record } } },
        targets: { client: projectTarget },
      });

      it("keeps it as an own entry beside the other servers", () => {
        const override = { args: ["serve"], cwd: ".", startupTimeoutMs: 1_000 };
        const result = hooknosticConfigSchema.safeParse(
          withServers(
            Object.fromEntries([
              ["other", { args: [] }],
              ["__proto__", override],
            ]),
          ),
        );

        expect(pathsAndMessages(result)).toEqual([]);
        const parsed = result.success ? result.data.components!.mcpOverrides!.client!.servers! : {};
        expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
        expect(Object.keys(parsed)).toEqual(["other", "__proto__"]);
        expect(Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value).toEqual(override);
        expect(parsed["other"]).toEqual({ args: [] });
      });

      it("validates its value", () => {
        const result = hooknosticConfigSchema.safeParse(withServers(ownProto({ startupTimeoutMs: 0 })));

        expect(pathsAndMessages(result)).toEqual([
          { path: [...servers, "__proto__", "startupTimeoutMs"], message: expect.stringContaining("Too small") },
        ]);
      });

      it("rejects the object literal spelling and names the computed key", () => {
        const result = hooknosticConfigSchema.safeParse(withServers({ __proto__: { args: ["serve"] } }));

        expect(pathsAndMessages(result)).toEqual([
          {
            path: [...servers, "__proto__"],
            message:
              'this record\'s prototype was replaced, for example by an object literal entry written as __proto__: {...}, which sets the prototype instead of adding an entry; to name a server "__proto__", write the key as a computed ["__proto__"] key',
          },
        ]);
      });

      it("reports a bad entry and a bad __proto__ entry together", () => {
        const result = hooknosticConfigSchema.safeParse(
          withServers(
            Object.fromEntries([
              ["x", { startupTimeoutMs: 0 }],
              ["__proto__", { cwd: "" }],
            ]),
          ),
        );

        expect(pathsAndMessages(result)).toEqual([
          { path: [...servers, "x", "startupTimeoutMs"], message: expect.stringContaining("Too small") },
          { path: [...servers, "__proto__", "cwd"], message: expect.stringContaining("Too small") },
        ]);
      });

      it("keeps config-level issues beside an issue inside servers", () => {
        const result = hooknosticConfigSchema.safeParse({
          project: { root: "." },
          components: { mcp: "./mcp.json", mcpOverrides: { pkg: { servers: { x: { startupTimeoutMs: 0 } } } } },
          targets: { pkg: packageTarget },
        });

        expect(pathsAndMessages(result)).toEqual([
          {
            path: ["components", "mcpOverrides", "pkg", "servers", "x", "startupTimeoutMs"],
            message: expect.stringContaining("Too small"),
          },
          {
            path: ["components", "mcpOverrides", "pkg"],
            message: 'MCP override target "pkg" must use project delivery',
          },
        ]);
      });

      it("applies per-call parse options to issues inside servers", () => {
        const result = hooknosticConfigSchema.safeParse(
          withServers(
            Object.fromEntries([
              ["x", { startupTimeoutMs: 0 }],
              ["__proto__", { startupTimeoutMs: 0 }],
            ]),
          ),
          { error: () => "per-call message" },
        );

        expect(pathsAndMessages(result)).toEqual([
          { path: [...servers, "x", "startupTimeoutMs"], message: "per-call message" },
          { path: [...servers, "__proto__", "startupTimeoutMs"], message: "per-call message" },
        ]);
      });
    });

    // mcpEnvironment uses the same checked mode as servers (#206). Its
    // successful own-key behaviour is pinned by the tests above this block.
    describe("an MCP environment entry named __proto__", () => {
      const environment = ["components", "mcpEnvironment"];
      const withEnvironment = (mcpEnvironment: unknown) => ({
        components: { root: ".", mcpEnvironment },
        targets: { claude: packageTarget },
      });

      it("rejects a replaced prototype instead of dropping it", () => {
        const result = hooknosticConfigSchema.safeParse(
          withEnvironment({ __proto__: { inherited: ["TOKEN"] }, other: ["OTHER"] }),
        );

        expect(pathsAndMessages(result)).toEqual([
          { path: [...environment, "__proto__"], message: expect.stringContaining('computed ["__proto__"] key') },
        ]);

        // An array value, the shape an entry takes here, makes the record an
        // array-like Zod already refuses, so only Zod's own issue is reported.
        expect(
          pathsAndMessages(
            hooknosticConfigSchema.safeParse(withEnvironment({ __proto__: ["TOKEN"], other: ["OTHER"] })),
          ),
        ).toEqual([{ path: environment, message: expect.stringContaining("expected record, received Array") }]);
      });

      it("reports a bad entry and a bad __proto__ entry together", () => {
        const result = hooknosticConfigSchema.safeParse(
          withEnvironment(
            Object.fromEntries([
              ["x", [""]],
              ["__proto__", [""]],
            ]),
          ),
        );

        expect(pathsAndMessages(result)).toEqual([
          { path: [...environment, "x", 0], message: expect.stringContaining("Too small") },
          { path: [...environment, "__proto__", 0], message: expect.stringContaining("Too small") },
        ]);
      });

      it("keeps config-level issues beside an issue inside the record", () => {
        const result = hooknosticConfigSchema.safeParse({
          components: { skills: ["./skills"], mcpEnvironment: { x: [""] } },
          targets: { claude: packageTarget },
        });

        expect(pathsAndMessages(result)).toEqual([
          { path: [...environment, "x", 0], message: expect.stringContaining("Too small") },
          { path: environment, message: "components.mcpEnvironment requires components.root" },
        ]);
      });

      it("applies per-call parse options to issues inside the record", () => {
        const result = hooknosticConfigSchema.safeParse(
          withEnvironment(
            Object.fromEntries([
              ["x", [""]],
              ["__proto__", [""]],
            ]),
          ),
          { error: () => "per-call message" },
        );

        expect(pathsAndMessages(result)).toEqual([
          { path: [...environment, "x", 0], message: "per-call message" },
          { path: [...environment, "__proto__", 0], message: "per-call message" },
        ]);
      });
    });
  });

  it("rejects timeouts above Node's maximum timer delay", () => {
    const config = {
      entry: "./src/hooks.ts",
      runtime: { timeoutMs: 2_147_483_648 },
      targets: {
        opencode: { version: ">=1.18 <2", delivery: "project", output: "./dist/opencode" },
      },
    };

    expect(hooknosticConfigSchema.safeParse(config).success).toBe(false);
    expect(
      hooknosticConfigSchema.safeParse({
        ...config,
        runtime: { timeoutMs: 2_147_483_647 },
      }).success,
    ).toBe(true);
  });

  it("accepts only error/warn for components.onInvalid", () => {
    const base = {
      components: { root: ".", targets: ["claude"] },
      targets: { claude: { version: ">=2.1 <3", delivery: "package" as const, output: "./dist/claude" } },
    };
    for (const onInvalid of ["error", "warn"]) {
      expect(hooknosticConfigSchema.safeParse({ ...base, components: { ...base.components, onInvalid } }).success).toBe(
        true,
      );
    }
    expect(
      hooknosticConfigSchema.safeParse({ ...base, components: { ...base.components, onInvalid: "ignore" } }).success,
    ).toBe(false);
  });

  it("accepts a structural package materializer and requires a rooted package-delivery target", () => {
    const provider = { id: "fixture", plan: () => ({ command: "fixture", args: [] }) };
    const projectOnly = {
      project: { root: "." },
      components: {
        root: ".",
        materialize: [{ provider, inputs: { lock: "dependencies.lock" }, into: "generated" }],
      },
      targets: { claude: { version: ">=2.1 <3", delivery: "project" as const, output: "./dist/claude" } },
    };

    expect(() => hooknosticConfigSchema.parse(projectOnly)).toThrow(
      /components\.materialize requires at least one package-delivery component target/,
    );
    expect(
      hooknosticConfigSchema.safeParse({
        ...projectOnly,
        targets: {
          ...projectOnly.targets,
          opencode: { version: ">=1.18 <2", delivery: "package" as const, output: "./dist/opencode" },
        },
      }).success,
    ).toBe(true);

    expect(
      hooknosticConfigSchema.safeParse({
        ...projectOnly,
        components: { skills: ["skills"], materialize: projectOnly.components.materialize },
      }).success,
    ).toBe(false);
    expect(
      hooknosticConfigSchema.safeParse({
        ...projectOnly,
        components: {
          root: ".",
          materialize: [{ provider: { id: "broken" }, inputs: {}, into: "generated" }],
        },
      }).success,
    ).toBe(false);
  });

  it("scopes component delivery invariants to selected targets", () => {
    const entry = "./src/hooks.ts";
    const packageTarget = { version: ">=2.1 <3", delivery: "package" as const, output: "./dist/package" };
    const projectTarget = { version: ">=0.148 <1", delivery: "project" as const, output: "./dist/project" };
    expect(
      hooknosticConfigSchema.safeParse({
        entry,
        components: { root: ".", targets: ["packaged"] },
        targets: { packaged: packageTarget, unrelated: projectTarget },
      }).success,
    ).toBe(true);
    expect(
      hooknosticConfigSchema.safeParse({
        project: { root: "." },
        entry,
        components: { skills: ["./skills"], targets: ["local"] },
        targets: { local: projectTarget, unrelated: packageTarget },
      }).success,
    ).toBe(true);
  });

  it("accepts executable file policy for direct skills and refuses it for a lone MCP source", () => {
    const local = { version: ">=1 <2", delivery: "project" as const, output: "./dist/local" };
    // Skills are a tree, so they can carry a declared mode. A direct MCP
    // source is a single file the loader reads and rewrites -- there is
    // nothing for an entry to name, so the refusal states the two fields that
    // would give it one rather than restating its own condition.
    expect(
      hooknosticConfigSchema.safeParse({
        project: { root: "." },
        entry: "./src/hooks.ts",
        components: { skills: ["./skills"], executableFiles: ["review/bin/tool"], targets: ["local"] },
        targets: { local },
      }).success,
    ).toBe(true);

    const result = hooknosticConfigSchema.safeParse({
      project: { root: "." },
      entry: "./src/hooks.ts",
      components: { mcp: "./mcp.json", executableFiles: ["bin/tool"], targets: ["local"] },
      targets: { local },
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "components.executableFiles requires components.root or components.skills",
      );
  });

  it("validates direct project MCP overrides", () => {
    const target = { version: ">=1 <2", delivery: "project" as const, output: "./dist/client" };
    const base = {
      project: { root: "." },
      components: {
        mcp: "./mcp.json",
        targets: ["client"],
        mcpOverrides: {
          client: {
            startupTimeoutMs: 60_000,
            servers: { serena: { args: ["serve"], cwd: "${PLUGIN_ROOT}/..", startupTimeoutMs: 30_000 } },
          },
        },
      },
      targets: { client: target },
    };
    expect(hooknosticConfigSchema.safeParse(base).success).toBe(true);
    expect(
      hooknosticConfigSchema.safeParse({
        ...base,
        components: { root: ".", mcpOverrides: base.components.mcpOverrides },
      }).success,
    ).toBe(false);
    expect(
      hooknosticConfigSchema.safeParse({
        ...base,
        components: { skills: ["./skills"], mcpOverrides: base.components.mcpOverrides },
      }).success,
    ).toBe(false);
    expect(
      hooknosticConfigSchema.safeParse({
        ...base,
        components: { ...base.components, mcpOverrides: { missing: {} } },
      }).success,
    ).toBe(false);
    expect(
      hooknosticConfigSchema.safeParse({
        ...base,
        components: { ...base.components, mcpOverrides: { client: { startupTimeoutMs: 0 } } },
      }).success,
    ).toBe(false);
  });

  it("validates hookless Agent Plugin projection target invariants", () => {
    const target = { version: ">=2.1 <3", delivery: "package" as const, output: "./dist/claude" };
    expect(
      hooknosticConfigSchema.safeParse({
        components: { root: ".", targets: ["claude"] },
        targets: { claude: target },
      }).success,
    ).toBe(true);
    expect(hooknosticConfigSchema.safeParse({ targets: { claude: target } }).success).toBe(false);
    expect(
      hooknosticConfigSchema.safeParse({
        components: { root: ".", targets: ["missing"] },
        targets: { claude: target },
      }).success,
    ).toBe(false);
    expect(
      hooknosticConfigSchema.safeParse({
        components: { root: ".", targets: ["claude"] },
        targets: { claude: target, codex: { ...target, delivery: "project" as const } },
      }).success,
    ).toBe(false);
  });

  it("validates authored plugin structure", () => {
    const plugin = {
      name: "p",
      hooks: [
        hook("tool.before", {
          id: "h",
          capabilities: { "tool.before.block": "required" },
          async run() {},
        }),
      ],
    };
    expect(pluginSpecSchema.parse(plugin).hooks).toHaveLength(1);
    expect(() =>
      pluginSpecSchema.parse({
        name: "p",
        hooks: [{ event: "tool.before", id: "h", capabilities: {}, run: "not-a-fn" }],
      }),
    ).toThrow();
    expect(() =>
      pluginSpecSchema.parse({
        name: "p",
        hooks: [
          {
            event: "tool.before",
            id: "h",
            capabilities: { "made.up.capability": "required" },
            run: () => undefined,
          },
        ],
      }),
    ).toThrow();
  });
});

describe("effect payload JSON rule", () => {
  const cyclic: Record<string, unknown> = { command: "ls" };
  cyclic["self"] = cyclic;

  it("accepts canonical JSON payloads", () => {
    const input = { command: "ls", args: [1, "a", null, true, { nested: [] }] };
    expect(effectSchema.parse(replaceInput(input))).toEqual({ kind: "replaceInput", input });
    expect(effectSchema.safeParse(replaceOutput("plain text")).success).toBe(true);
    expect(effectSchema.safeParse(replaceOutput(null)).success).toBe(true);
    expect(effectSchema.safeParse(replaceOutput([])).success).toBe(true);
  });

  it("rejects payloads that JSON serialization would drop, throw on, or transform", () => {
    const symbolKey = Symbol("hidden");
    const symbolProperty = { command: "ls", [symbolKey]: "dropped" };
    const nonEnumerableProperty = Object.defineProperty({ command: "ls" }, "hidden", { value: "dropped" });
    const arrayProperty = Object.assign(["ls"], { hidden: "dropped" });
    const cases: [string, unknown][] = [
      ["undefined", undefined],
      ["function", () => 1],
      ["symbol", Symbol("s")],
      ["bigint", 10n],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["Date", new Date(0)],
      ["Map", new Map()],
      ["cycle", cyclic],
      ["nested undefined", { nested: { deep: [undefined] } }],
      ["class instance", new (class Thing {})()],
      [
        "accessor",
        {
          get changesAfterValidation() {
            return 1;
          },
        },
      ],
      ["toJSON", Object.defineProperty({}, "toJSON", { value: () => ({ ok: true }) })],
      ["symbol-keyed property", symbolProperty],
      ["non-enumerable property", nonEnumerableProperty],
      ["non-index array property", arrayProperty],
    ];
    for (const [label, payload] of cases) {
      expect(effectSchema.safeParse(replaceInput(payload)).success, label).toBe(false);
      expect(effectSchema.safeParse(replaceOutput(payload)).success, label).toBe(false);
    }
    const nested = effectSchema.safeParse(replaceOutput({ a: { b: [1, { c: 1n }] } }));
    expect(nested.success).toBe(false);
    if (!nested.success) expect(nested.error.issues[0]?.message).toContain("$.a.b[1].c");
  });

  it("exposes the JSON predicate and the offending path", () => {
    expect(isJsonValue({ ok: [1, "two", null, { deep: true }] })).toBe(true);
    expect(isJsonValue(undefined)).toBe(false);
    expect(findNonJsonPath({ when: new Date(0) })).toBe("$.when");
    expect(findNonJsonPath(cyclic)).toBe("$.self");
    expect(findNonJsonPath([1, [2, [Number.NaN]]])).toBe("$[1][1][0]");
  });

  it("identifies values that throw while being inspected", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("not inspectable");
        },
      },
    );
    expect(findNonJsonPath(hostile)).toBe("$");
    expect(isJsonValue(hostile)).toBe(false);
    expect(effectSchema.safeParse(replaceInput(hostile)).success).toBe(false);
  });
});

it("allows separate family artifacts but rejects duplicate activation in one project", () => {
  const target = { adapter: "fake", version: ">=1 <2", delivery: "project", output: "one" };
  const config = {
    entry: "hooks.ts",
    targets: { first: target, second: { ...target, version: ">=2 <3", output: "two" } },
  };
  expect(hooknosticConfigSchema.safeParse(config).success).toBe(true);
  expect(hooknosticConfigSchema.safeParse({ ...config, project: { root: "." } }).success).toBe(false);
});
