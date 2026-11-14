import { useCurrentFrame } from "remotion";

import { Caption } from "../components/Caption";
import { Code, LINE_HEIGHT } from "../components/Code";
import { Panel } from "../components/Panel";
import { ramp, SCENES, sceneVisibility, sourceBeatAt } from "../motion";

// The README's portable hook (examples/rewrite-shell/src), wrapped to fit.
const HOOK = [
  'hook("tool.before", {',
  '  match: { kind: "shell" },',
  '  capabilities: { block: "required", "input.replace": "optional" },',
  "  run({ tool }, ctx) {",
  "    const command = tool.shell?.command;",
  "    if (command === undefined)",
  "      return block(`Unrecognized ${tool.nativeName} input`);",
  '    if (command.includes("rm -rf /"))',
  '      return block("Refusing destructive root deletion");',
  '    if (ctx.capabilities.has("input.replace") &&',
  '        command.startsWith("npm "))',
  '      return updateShell({ command: command.replace(/^npm /, "pnpm ") });',
  "  },",
  "});",
];

// One highlighted region and one sentence per beat.
const BEATS = [
  { at: sourceBeatAt(0), lines: [1, 1], text: "Match every shell tool, whatever each harness calls it" },
  { at: sourceBeatAt(1), lines: [2, 2], text: "Declare what the hook needs: blocking required, rewriting optional" },
  { at: sourceBeatAt(2), lines: [4, 11], text: "Block destructive commands; rewrite npm to pnpm where supported" },
] as const;

const CARD_WIDTH = 800;

export const Source = () => {
  const frame = useCurrentFrame();
  const { duration } = SCENES.source;
  const beatIndex = BEATS.findLastIndex((beat) => frame >= beat.at);
  const beat = BEATS[beatIndex];

  return (
    <div style={{ position: "absolute", inset: 0, opacity: sceneVisibility(frame, duration) }}>
      <Panel
        title="src/hooks.ts"
        style={{
          left: (1280 - CARD_WIDTH) / 2,
          top: 92,
          width: CARD_WIDTH,
          height: 40 + HOOK.length * LINE_HEIGHT + 40,
          transform: `translateY(${(1 - ramp(frame, 0, 16)) * 24}px)`,
        }}
      >
        <div style={{ padding: "20px 28px" }}>
          <Code
            lines={HOOK}
            reveal={(i) => ramp(frame, 4 + i * 2, 12 + i * 2)}
            {...(beat === undefined ? {} : { focus: beat.lines })}
            focusStrength={beat === undefined ? 0 : ramp(frame, beat.at, beat.at + 10)}
          />
        </div>
      </Panel>
      <Caption beats={BEATS.map((b, i) => ({ from: b.at + 4, to: BEATS[i + 1]?.at ?? duration, text: b.text }))} />
    </div>
  );
};
