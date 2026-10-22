import { describe, expect, it } from "vitest";

import { classifyCopilotTool } from "./toolmap.js";

describe("Copilot tool classification", () => {
  it("pins the dialect for the runtime shell names and withholds it for the PascalCase alias", () => {
    expect(classifyCopilotTool("powershell", { command: "echo x", description: "x" }).shell).toEqual({
      command: "echo x",
      commandKey: "command",
      dialect: "powershell",
    });
    expect(classifyCopilotTool("bash", { command: "echo x", description: "x" }).shell).toEqual({
      command: "echo x",
      commandKey: "command",
      dialect: "posix",
    });
    // Both runtime tools arrive as `Bash` under a PascalCase entry, so the name
    // establishes the command key but not a family.
    const pascal = classifyCopilotTool("Bash", { command: "echo x", description: "x" });
    expect(pascal).toMatchObject({
      kind: "shell",
      shell: { command: "echo x", commandKey: "command" },
    });
    expect(pascal.shell).not.toHaveProperty("dialect");
  });

  it("names the file key `path` for both spellings", () => {
    expect(classifyCopilotTool("view", { path: "/tmp/x" }).file).toEqual({ pathKey: "path", paths: ["/tmp/x"] });
    expect(classifyCopilotTool("create", { path: "/tmp/x", file_text: "x" }).kind).toBe("file.write");
    expect(classifyCopilotTool("edit", { path: "/tmp/x", old_str: "a", new_str: "b" }).kind).toBe("file.edit");
    expect(classifyCopilotTool("Read", { path: "/tmp/x" }).file).toEqual({ pathKey: "path", paths: ["/tmp/x"] });
    expect(classifyCopilotTool("Write", { path: "/tmp/x", file_text: "x" }).kind).toBe("file.write");
    expect(classifyCopilotTool("Edit", { path: "/tmp/x", old_str: "a", new_str: "b" }).kind).toBe("file.edit");
  });

  it("classifies an unknown name with an MCP separator as mcp, without a split", () => {
    const hyphen = classifyCopilotTool("probe-probe_echo", { message: "x" });
    expect(hyphen).toMatchObject({ kind: "mcp", nativeName: "probe-probe_echo", input: { message: "x" } });
    expect(hyphen.mcp).toBeUndefined();
    // permissionRequest spells the same call with a slash.
    expect(classifyCopilotTool("hooknostic_fixture/hooknostic_echo", {}).mcp).toBeUndefined();
    expect(classifyCopilotTool("hooknostic_fixture/hooknostic_echo", {}).kind).toBe("mcp");
    expect(classifyCopilotTool("some_future_native_tool", {}).kind).toBe("other");
  });

  it("keeps search tools kind-only (no file view) and background shells out of the shell table", () => {
    expect(classifyCopilotTool("grep", { pattern: "x" }).file).toBeUndefined();
    expect(classifyCopilotTool("glob", { pattern: "x" }).file).toBeUndefined();
    expect(classifyCopilotTool("list_powershell", {}).kind).toBe("other");
    expect(classifyCopilotTool("read_powershell", { shellId: "1" }).shell).toBeUndefined();
  });
});
