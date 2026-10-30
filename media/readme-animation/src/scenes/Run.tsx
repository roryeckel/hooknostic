import { useCurrentFrame } from "remotion";

import { Caption } from "../components/Caption";
import { CheckIcon, CrossIcon, Panel } from "../components/Panel";
import type { Harness } from "../facts";
import { CAPABILITIES, HARNESSES, HOOK_NEEDS, meetsMinimum } from "../facts";
import { MONO, SANS } from "../fonts";
import { ramp, RUN_CLEAR, SCENES, sceneVisibility, typed } from "../motion";
import { tint, useTheme } from "../theme";

const TABLE = { width: 980, top: 104, header: 46, row: 58, columns: [250, 470, 260] };
const LEFT = (1280 - TABLE.width) / 2;

// Local frames for the two beats every row plays in step.
const T = {
  typeNpm: [24, 38],
  strike: [50, 56],
  swap: [56, 64],
  rewritten: [58, 68],
  clear: [RUN_CLEAR, RUN_CLEAR + 6],
  typeRm: [RUN_CLEAR + 6, RUN_CLEAR + 18],
  blocked: [RUN_CLEAR + 26, RUN_CLEAR + 36],
} as const;

// The hook's ctx.capabilities.has("input.replace") branch: without the
// optional capability the command passes through unchanged.
const rewrites = (harness: Harness) => harness.grades["tool.before.input.replace"] !== "unsupported";

const Row = ({ harness, index }: { harness: Harness; index: number }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const at = (span: readonly [number, number]) => ramp(frame, ...span);
  const second = frame >= T.clear[1];
  const npm = typed("npm install", at(T.typeNpm));
  const [nameWidth, inputWidth] = TABLE.columns as [number, number, number];

  const value = second ? (
    typed("rm -rf /", at(T.typeRm))
  ) : rewrites(harness) && frame >= T.swap[0] ? (
    <>
      <span style={{ color: theme.success, fontWeight: 700, opacity: at(T.swap) }}>pnpm</span>
      {" install"}
    </>
  ) : (
    <>
      <span
        style={{
          textDecoration: rewrites(harness) && at(T.strike) > 0.5 ? "line-through" : "none",
          textDecorationColor: theme.danger,
          textDecorationThickness: 2,
        }}
      >
        {npm.slice(0, 3)}
      </span>
      {npm.slice(3)}
    </>
  );

  const result = second ? (
    <span style={{ display: "flex", gap: 8, alignItems: "center", color: theme.danger, opacity: at(T.blocked) }}>
      <CrossIcon color={theme.danger} />
      <b style={{ fontFamily: MONO, fontSize: 17 }}>block(…)</b>
    </span>
  ) : rewrites(harness) ? (
    <span
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        color: theme.success,
        opacity: at(T.rewritten) * (1 - at(T.clear)),
      }}
    >
      <CheckIcon color={theme.success} />
      <b style={{ fontFamily: MONO, fontSize: 17 }}>updateShell(…)</b>
    </span>
  ) : (
    <span style={{ color: theme.muted, opacity: at(T.rewritten) * (1 - at(T.clear)) }}>nothing</span>
  );

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: TABLE.header + index * TABLE.row,
        width: TABLE.width,
        height: TABLE.row,
        display: "flex",
        alignItems: "center",
        borderTop: `1px solid ${tint(theme.border, 0.7)}`,
        background: tint(theme.danger, 0.07 * at(T.blocked)),
        opacity: ramp(frame, 4 + index * 3, 16 + index * 3),
      }}
    >
      <div
        style={{ width: nameWidth, paddingLeft: 28, fontFamily: SANS, fontSize: 19, fontWeight: 600, color: theme.fg }}
      >
        {harness.name}
      </div>
      <div style={{ width: inputWidth, fontFamily: MONO, fontSize: 19, color: theme.syntax.punctuation }}>
        <span style={{ opacity: second ? 1 : 1 - at(T.clear) }}>
          {"{ "}
          <span style={{ color: theme.syntax.property, fontWeight: 700 }}>{`"${harness.commandKey}"`}</span>
          {': "'}
          <span style={{ color: theme.syntax.string }}>{value}</span>
          {'" }'}
        </span>
      </div>
      <div style={{ fontFamily: SANS, fontSize: 18 }}>{result}</div>
    </div>
  );
};

export const Run = () => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const { duration } = SCENES.run;
  // Only targets the check passed are built, so only they get a row.
  const required = CAPABILITIES.filter((id) => HOOK_NEEDS[id] === "required");
  const built = HARNESSES.filter((h) => required.every((id) => meetsMinimum(h.grades[id] ?? "unsupported")));
  const label = { fontFamily: SANS, fontSize: 14, fontWeight: 700, letterSpacing: "0.08em", color: theme.muted };

  return (
    <div style={{ position: "absolute", inset: 0, opacity: sceneVisibility(frame, duration) }}>
      <Panel
        style={{
          left: LEFT,
          top: TABLE.top,
          width: TABLE.width,
          height: TABLE.header + built.length * TABLE.row,
          opacity: ramp(frame, 0, 12),
        }}
      >
        <div style={{ height: TABLE.header, display: "flex", alignItems: "center" }}>
          {["HARNESS", "NATIVE TOOL INPUT", "YOUR HOOK RETURNED"].map((text, i) => (
            <div key={text} style={{ ...label, width: TABLE.columns[i], paddingLeft: i === 0 ? 28 : 0 }}>
              {text}
            </div>
          ))}
        </div>
        {built.map((harness, i) => (
          <Row key={harness.name} harness={harness} index={i} />
        ))}
      </Panel>
      <Caption
        beats={[
          {
            from: 30,
            to: T.clear[0],
            text: built.every(rewrites)
              ? "Your hook rewrites npm to pnpm; hooknostic writes it back natively"
              : "Your hook rewrites npm to pnpm wherever the harness allows it",
          },
          {
            from: T.clear[1] + 6,
            to: duration,
            text: (
              <>
                Your hook blocks <span style={{ fontFamily: MONO }}>rm -rf /</span>; hooknostic delivers it to every
                harness
              </>
            ),
          },
        ]}
      />
    </div>
  );
};
