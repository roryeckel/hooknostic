import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

import { redactHomes } from "../../scripts/redact-capture.mjs";

const read = async (harness, name, label) => JSON.parse(await readFile(new URL(`./captured/${harness}/${name}@${label}/summary.json`, import.meta.url), "utf8"));
const v1 = [];
const codex = [];
for (const label of ["native-fields-ref", "native-fields-newer"]) {
  for (const name of ["generated", "packaged", "generated-steps", "generated-maxsteps", "packaged-steps", "packaged-maxsteps"]) {
    const s = await read("opencode-v1", name, label);
    assert.equal(s.exit, 0);
    assert.deepEqual(s.playbackErrors, []);
    assert.equal(s.child.requests, 4);
    assert.equal(s.parent.childResultReturned, true);
    for (const [key, value] of Object.entries(s.requestedNative)) assert.equal(s.deliveredNative[key], value);
    v1.push({ version: s.version, case: name, requestedNative: s.requestedNative, deliveredNative: s.deliveredNative && Object.fromEntries(Object.keys(s.requestedNative).map((key) => [key, s.deliveredNative[key]])), exit: s.exit, playbackErrors: s.playbackErrors, parentReceivedResult: s.parent.childResultReturned, childRequests: s.child.requests, turns: s.child.turns.map(({ model, markerInSystem }) => ({ model, markerInSystem })) });
  }
  for (const name of ["direct", "generated-sandbox"]) {
    const s = await read("codex-home", name, label);
    assert.equal(s.exit, 0);
    assert.deepEqual(s.playbackErrors, []);
    assert.equal(s.childWriteLanded, true);
    if (name === "generated-sandbox") assert.equal(s.deliveredNative.sandbox_mode, "read-only");
    assert.ok(s.child.turns.length);
    for (const turn of s.child.turns) assert.equal(turn.sandboxReported, "danger-full-access");
    codex.push({ version: s.version, case: name, agentSandbox: "read-only", parentSandbox: "danger-full-access", requestedNative: s.requestedNative, deliveredSandbox: s.deliveredNative?.sandbox_mode, exit: s.exit, playbackErrors: s.playbackErrors, childWriteLanded: s.childWriteLanded, turns: s.child.turns.map(({ model, markerInSystem, sandboxReported }) => ({ model, markerInSystem, sandboxReported })) });
  }
}
for (const [name, cases] of [["opencode-v1-step-limits", v1], ["codex-agent-native", codex]]) {
  const { text, nearMisses } = redactHomes(JSON.stringify({ provenance: "live-probe", platform: process.platform, date: "2026-10-17", cases }, null, 2) + "\n", [homedir()]);
  assert.deepEqual(nearMisses, []);
  await writeFile(new URL(`./evidence/${name}.json`, import.meta.url), text);
}
console.log(`Promoted ${v1.length} v1 and ${codex.length} Codex native-field observations.`);
