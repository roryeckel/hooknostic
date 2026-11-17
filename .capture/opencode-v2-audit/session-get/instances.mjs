// #236: what two plugin instances hear across a reload, from probe.mjs runs.
// usage: node instances.mjs <outcome.json>...
// Per run: when each instance was set up and disposed, the watched event ids
// both instances heard and which heard each first, any id the new instance
// heard that the old one had heard before the new one's setup (a replay), any
// event the old one heard after that setup that the new one never heard (a
// subscribe lag), and, with a reload while a child ran, how long after the old
// instance's cleanup the child's completion reached the new one. Totals last.
import { readFileSync } from "node:fs";

const totals = { runs: 0, twoInstances: 0, events: 0, withoutId: 0, shared: 0, oldFirst: 0, newFirst: 0, same: 0, replayed: 0, lagged: 0 };
const gaps = [];
for (const file of process.argv.slice(2)) {
  const o = JSON.parse(readFileSync(file, "utf8"));
  if (!o.ok) {
    console.log(`== ${file}: not ok, skipped (${o.error?.split("\n")[0]})`);
    continue;
  }
  totals.runs++;
  const records = o.records ?? [];
  for (const r of records.filter((r) => r.kind === "event")) {
    totals.events++;
    if (typeof r.id !== "string") totals.withoutId++;
  }
  const instances = [...new Set(records.map((r) => r.inst))];
  const life = instances.map((inst) => ({
    setup: records.find((r) => r.inst === inst && r.kind === "setup")?.t,
    cleanup: records.find((r) => r.inst === inst && r.kind === "cleanup")?.t,
    events: records.filter((r) => r.inst === inst && r.kind === "event"),
  }));
  const role = (id) =>
    id === o.parent ? "parent" : id === o.child ? "child" : id === o.child2 ? "child2" : id === o.fresh ? "fresh" : "other";
  const line = [`== ${file}: ${o.scenario}, ${instances.length} instance(s)`];
  if (instances.length >= 2) {
    totals.twoInstances++;
    const [old, next] = life;
    const heardByOld = new Map(old.events.map((e) => [e.id, e]));
    const heardByNext = new Map(next.events.map((e) => [e.id, e]));
    let oldFirst = 0, newFirst = 0, same = 0;
    for (const [id, e] of heardByNext) {
      const first = heardByOld.get(id);
      if (first === undefined) continue;
      totals.shared++;
      if (first.t < e.t) oldFirst++;
      else if (first.t > e.t) newFirst++;
      else same++;
    }
    const replayed = next.events.filter((e) => heardByOld.get(e.id)?.t < next.setup).length;
    const lagged = old.events.filter(
      (e) => e.t >= next.setup && (old.cleanup === undefined || e.t <= old.cleanup) && !heardByNext.has(e.id),
    ).length;
    Object.assign(totals, {
      oldFirst: totals.oldFirst + oldFirst,
      newFirst: totals.newFirst + newFirst,
      same: totals.same + same,
      replayed: totals.replayed + replayed,
      lagged: totals.lagged + lagged,
    });
    const disposed =
      old.cleanup === undefined
        ? "old instance never disposed"
        : `old instance disposed ${old.cleanup < next.setup ? "before" : `${old.cleanup - next.setup} ms after`} the new one's setup`;
    line.push(`  ${disposed}; shared ids ${oldFirst + newFirst + same} (old first ${oldFirst}, new first ${newFirst}, same ms ${same}); replayed ${replayed}; lagged ${lagged}`);
    const done = (events) =>
      events.find((e) => e.sessionID === o.child && /^session\.execution\.(succeeded|failed)$/.test(e.type));
    const childAtNext = done(next.events.filter((e) => e.t >= next.setup));
    if (o.scenario !== "reload-followup" && old.cleanup !== undefined && childAtNext !== undefined) {
      const gap = childAtNext.t - old.cleanup;
      // Only where the old instance never heard it: there only the new one can report it.
      if (!done(old.events)) gaps.push(gap);
      line.push(`  the child's completion reached the new instance ${gap} ms after the old one's cleanup; the old one ${done(old.events) ? "heard it too" : "never heard it"}`);
    }
    if (o.child2 !== undefined) {
      const heard = life.filter((l) => l.events.some((e) => e.type === "session.created" && e.sessionID === o.child2)).length;
      line.push(`  the new child's session.created reached ${heard} instance(s)`);
    }
  }
  const completions = records.filter((r) => r.kind === "event" && /^session\.execution\./.test(r.type) && r.type !== "session.execution.started");
  line.push(`  completions by id: ${[...new Set(completions.map((r) => `${role(r.sessionID)}`))].join(", ") || "none"}`);
  console.log(line.join("\n"));
}
gaps.sort((a, b) => a - b);
console.log(`\ntotals ${JSON.stringify(totals)}`);
if (gaps.length)
  console.log(
    `a child's completion only the new instance heard: ${gaps.length} runs, ${gaps.filter((gap) => gap > 0).length} of them after the old instance's cleanup, ${gaps[0]}..${gaps.at(-1)} ms`,
  );
