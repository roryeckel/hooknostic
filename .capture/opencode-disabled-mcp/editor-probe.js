// What does a v2 server plugin's `ctx.mcp.transform` editor report for a host layer's entry?
import { appendFileSync } from "node:fs";

const record = (value) => appendFileSync(process.env.HKN_EDITOR_TRACE, JSON.stringify(value) + "\n", "utf8");
const describe = (value) => {
  const own = Object.getOwnPropertyNames(value ?? {});
  const proto = Object.getPrototypeOf(value ?? {});
  const inherited =
    proto && proto !== Object.prototype ? Object.getOwnPropertyNames(proto).filter((key) => key !== "constructor") : [];
  return { type: typeof value, own, inherited, keys: Object.keys(value ?? {}) };
};
// The guard in the emitted module reads the value synchronously, so whether the
// return is a thenable is part of the shape being captured.
const safe = (fn) => {
  try {
    const value = fn();
    return {
      ok: true,
      absent: value === undefined,
      thenable: typeof value?.then === "function",
      value: JSON.parse(JSON.stringify(value ?? null)),
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
};

const names = ["remoteEnabled", "remoteDisabled", "localEnabled", "localDisabled", "absent"];

export default {
  id: "hkn.disabled-mcp-probe",
  async setup(ctx) {
    record({ phase: "setup", mcp: describe(ctx.mcp) });
    await ctx.mcp.transform((editor) => {
      record({ phase: "editor", editor: describe(editor) });
      record({ phase: "get", reads: Object.fromEntries(names.map((name) => [name, safe(() => editor.get(name))])) });
      record({ phase: "list", read: safe(() => editor.list()) });
      // A replacement of an inherited disabled name: does `list` agree with `get` afterwards?
      editor.set("remoteDisabled", { type: "remote", url: "http://127.0.0.1:9/replacement", disabled: false });
      record({ phase: "after-set-get", read: safe(() => editor.get("remoteDisabled")) });
      record({ phase: "after-set-list", read: safe(() => editor.list()) });
    });
  },
};
