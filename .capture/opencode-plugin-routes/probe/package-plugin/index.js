import { writeFileSync } from "node:fs";
const MARKER = "D:/tmp/oc-pkg-probe/marker-npm-plugin.txt";
export const PkgProbe = async () => {
  let dep;
  try {
    const m = await import("is-number");
    dep = `is-number=resolved:${String((m.default ?? m)(42))}`;
  } catch (error) {
    dep = `is-number=failed:${error.code ?? error.name}`;
  }
  writeFileSync(MARKER, [dep, `loadedFrom=${import.meta.url}`].join("\n") + "\n");
  return {};
};
