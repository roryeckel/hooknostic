// Local stand-in for the real vitest module, used only when
// scripts/drive-capture-session.mjs imports packages/cli/test/harness-playback.ts
// outside the vitest runtime. The playback module references `expect` only in
// its fixture-replay helpers (replayCommandFixtures/replayOpenCodeFixtures),
// which the drift lane never calls; if one ever does, this throws loudly
// instead of asserting nothing.
export const expect = (value, message) => {
  throw new Error(
    `vitest-stub: expect() reached outside the vitest runtime${message === undefined ? "" : `: ${message}`}`,
  );
};
export default { expect };