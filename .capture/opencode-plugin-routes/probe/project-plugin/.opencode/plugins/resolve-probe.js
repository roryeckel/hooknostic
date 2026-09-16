import { writeFileSync } from "node:fs";
const MARKER = "D:/tmp/oc-pkg-probe/marker-project-plugin.txt";
const SPECS = ["probe-sibling", "probe-local-only", "is-number", "pure-rand"];
export const ResolveProbe = async () => {
  const lines = [];
  for (const spec of SPECS) {
    try {
      const m = await import(spec);
      lines.push(`${spec.padEnd(18)} resolved ${m.where ?? ""}`);
    } catch (error) {
      lines.push(`${spec.padEnd(18)} failed:${error.code ?? error.name}`);
    }
  }
  writeFileSync(MARKER, lines.join("\n") + "\n");
  return {};
};
