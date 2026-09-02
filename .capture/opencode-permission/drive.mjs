// Drive one headless opencode session against the loopback playback server.
// The prompt asks the model to run one shell command; whether the permission
// ask fires (and what the hook answered) lands in captured/*.jsonl.

const port = process.env["HKN_PORT"] ?? "47451";
const base = `http://127.0.0.1:${port}`;
const model = process.env["HKN_MODEL"] ?? "playback/hooknostic-playback";
const prompt =
  process.env["HKN_PROMPT"] ??
  "Use the bash tool exactly once to run: mkdir hooknostic-perm-observe. Then stop.";

for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const probe = await fetch(`${base}/app`);
    if (probe.ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const created = await fetch(`${base}/session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
const session = await created.json();
console.log(JSON.stringify({ sessionId: session.id }));

await fetch(`${base}/session/${session.id}/message`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: { providerID: model.split("/")[0], modelID: model.split("/")[1] },
    parts: [{ type: "text", text: prompt }],
  }),
});

await new Promise((resolve) => setTimeout(resolve, Number(process.env["HKN_WAIT_MS"] ?? "25000")));