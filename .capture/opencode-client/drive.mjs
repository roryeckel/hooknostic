// Drive one OpenCode session against a running `opencode serve`, then report
// what the probe observed. `opencode run` cannot be used: it exits at
// session.idle, before a posted turn can start.

const port = process.env["HKN_PORT"] ?? "47331";
const base = `http://127.0.0.1:${port}`;

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

const answered = await fetch(`${base}/session/${session.id}/message`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: { providerID: "ollama-cloud", modelID: "deepseek-v4-flash" },
    parts: [{ type: "text", text: "Say the single word ready, then stop." }],
  }),
});

const body = await answered.json();
console.log(
  JSON.stringify({
    sessionId: session.id,
    status: answered.status,
    assistant: (body.parts ?? []).filter((p) => p.type === "text").map((p) => p.text),
  }),
);

// The probe posts during session.idle, which resolves after this request
// returns. Give the posted turn room to run before the harness reads back.
await new Promise((resolve) => setTimeout(resolve, Number(process.env["HKN_WAIT_MS"] ?? "40000")));
