const declared = process.env["HOOKNOSTIC_CAPTURE_DECLARE_ENVIRONMENT"] === "1";
const variant = declared ? "declared" : "undeclared";

export default {
  targets: {
    claude: { version: ">=2.1 <3", delivery: "package", output: `./dist/${variant}/claude` },
    codex: { version: ">=0.153 <1", delivery: "package", output: `./dist/${variant}/codex` },
    opencode: { version: ">=1.18 <2", delivery: "package", output: `./dist/${variant}/opencode` },
  },
  components: {
    root: ".",
    targets: ["claude", "codex", "opencode"],
    exclude: ["dist/**"],
    ...(declared ? { mcpEnvironment: { recorder: ["SYNTHETIC_MARKER"] } } : {}),
  },
};
