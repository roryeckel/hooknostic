# ADR-0010: Capability coverage policy and the scenario registry

Date: 2026-08-31
Status: Accepted

## Context

The capability profiles rate 71 cells across three harnesses, but harness-watch's
verification (issue #1) originally replayed only three scripted scenarios
(rewrite / block / fail) — roughly six cells. "The rest works" rested on captured
fixtures replayed through the artifact one payload at a time, not on driven,
end-to-end behavior. A harness update that changed how an honoured channel behaves
in a live session would surface only through that channel's payload fixture
replay — if the *emission* changed but the payload shape stayed the same, nothing
would notice.

"Full coverage" needs a definition that CI can enforce, not aspire to.

## Decision

1. **The scenario registry (`packages/testkit/src/scenarios.ts`) is the coverage
   contract.** Every cell a profile resolves — including explicit `unsupported`
   entries — must be attributed to at least one scenario. The gate
   (`describeScenarioCoverage`) runs in every adapter's suite; adding a cell
   without a scenario fails CI.

2. **Every scenario declares a driver.** Drivers are how the harness session is
   produced: `loopback` (model-free), `pty-approval` (real interactive TTY),
   `mcp-stdio` (in-repo MCP fixture server), `compaction`, `subagent`,
   `opencode-serve`. A driver may be overridden per harness, because the same
   capability reaches through different doors (OpenCode's `permission.request`
   fires headless; Claude's does not).

3. **All supported levels block.** A regression in an `exact`, `emulated`, or
   `approximate` cell stops the scheduled verification and files a deduped
   failure issue. Assertions for non-exact cells are written against their
   documented rationale (e.g. OpenCode `turn.stop.observe` asserts approximate
   surfacing), so "block on any change" does not mean "assert exact semantics".
   A driver that cannot run is reported `inconclusive` in the workflow step
   summary every run — an untestable scenario is never silent, but it is also
   not a contract breach.

4. **Unsupported cells get inverted-watch scenarios**: a channel the adapter
   documents as not working must stay not-working. The watch scenario asserts
   the documented inertness; a change routes humans to the harness-capture skill
   (the adapter's claim needs revisiting, not silently updating).

5. **One drive layer, three evidence consumers.** The same scenario recipe runs
   as `capture` mode (tee, human inspection → candidate fixture), `playback`
   mode (loopback, assertions), and `drift` mode (tee + comparator). The drive
   layer is unified; the evidence classes are not (see `.capture/
   harness-playback/README.md` — constructed procedures never promote to
   captured evidence, and automation never writes fixtures).

6. **Known free-lane limits are recorded, not worked around.** Two cells cannot
   be decided by the scheduled free lanes today, with the blocking mechanism
   documented in the test itself:
   - `agent.start/stop.observe` (Codex): SubagentStart/Stop fire in the spawned
     child session, which does not inherit the parent's hook-trust bypass
     (observed live on 0.151.0; upstream openai/codex#33097). Decisive check
     runs on the manual `force_llm` lane, where hook trust can be persisted.
    - compaction family: the free lane cannot fill the context deterministically
      (shell results are capped ~30k chars; the drive caps turns at 6 against a
      200k-token context). Decisive check runs on the manual `force_llm` lane.

   Codex `tool.after.output.replace` was re-rated `unsupported` on 2026-09-02
   (captured live on 0.151.0: the hook engine strictly rejects
   `updatedMCPToolOutput` from a PostToolUse hook, failing open). Its
   mcp-stdio drive runs as an inverted watch on the scheduled lane — the MCP
   call must dispatch (the scripted namespace-pair emission resolves the
   router's exact `{namespace, name}` lookup, itself a correction of the
   earlier #31354 reading: the flattened-name form was ours to fix, not an
   upstream limitation) and the replacement must never reach the model.

## Consequences

- The coverage gate is a test, not a checklist item; the registry doubles as the
  drift comparator's `expectedVariants` source and the capture skill's target
  list, so a scenario and a fixture cannot quietly diverge.
- Scheduled verification cost grows (playback runtime ~15–20 min per harness)
  but stays free and secret-free; the pty lane is the only new infrastructure
  dependency (`node-pty`, devDep, build-script approved).
- Interactive-only cells (Claude `permission.request.*`) are covered by the pty
  lane, closing the headless blind spot the PermissionRequest fixture's
  doc-derived provenance recorded.
- The `unsupported` inverted-watch keeps "we checked, and it does not work"
  honest: when a harness starts honouring a documented-discard channel, the
  watch fails and the adapter decision is revisited with fresh evidence.