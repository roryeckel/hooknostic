// usage: node summarize.mjs <outcome.json>...
// One timeline per run (instances as I0, I1; sessions as PARENT, CHILD, S<n>),
// then session.get latency over every run given.
import { readFileSync } from "node:fs";

const latency = [];
for (const file of process.argv.slice(2)) {
  const o = JSON.parse(readFileSync(file, "utf8"));
  const ids = new Map();
  const s = (x) => {
    if (typeof x !== "string") return x;
    if (x === o.parent) return "PARENT";
    if (x === o.child) return "CHILD";
    if (!ids.has(x)) ids.set(x, `S${ids.size}`);
    return ids.get(x);
  };
  const where = (path) => (typeof path !== "string" ? "" : path.endsWith("other") ? "other" : path.endsWith("project") ? "project" : path);
  console.log(`== ${file}\n${o.scenario} ok=${o.ok} delay=${o.childDelay} ${o.error?.split("\n")[0] ?? ""}`);
  for (const c of o.created ?? []) console.log(`created ${s(c.id)} parentID=${s(c.parentID) ?? "-"} location=${where(c.location)}`);
  const instances = new Map();
  for (const r of o.records) {
    if (!instances.has(r.inst)) instances.set(r.inst, `I${instances.size}`);
    const i = instances.get(r.inst);
    if (r.kind === "setup") console.log(`${r.t}\t${i}\tsetup ${where(r.dir)} get=${r.get}`);
    else if (r.kind === "get") {
      if (r.ok) latency.push(r.ms);
      console.log(
        `${r.t}\t${i}\tget ${r.label} ${s(r.sessionID)} ${r.ms}ms ok=${r.ok}${r.ok ? ` parent=${s(r.parentID) ?? "-"} agent=${r.agent ?? "-"} loc=${where(r.loc)}` : ` ${r.name}`}`,
      );
    } else if (r.kind === "event")
      console.log(`${r.t}\t${i}\tevent ${r.type} ${s(r.sessionID)}${r.parentID ? ` parent=${s(r.parentID)}` : ""} loc=${where(r.loc)}`);
    else console.log(`${r.t}\t${i}\t${r.kind} ${s(r.sessionID) ?? ""} ${r.tool ?? ""} ${r.status ?? ""}`);
  }
  for (const step of o.steps) console.log(`step ${step.s}`);
}
latency.sort((a, b) => a - b);
if (latency.length)
  console.log(
    `session.get ok: n=${latency.length} median=${latency[Math.floor(latency.length / 2)]} ms p95=${latency[Math.floor(latency.length * 0.95)]} ms max=${latency.at(-1)} ms`,
  );
