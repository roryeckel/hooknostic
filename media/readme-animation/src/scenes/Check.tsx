import { useCurrentFrame } from "remotion";

import { Caption } from "../components/Caption";
import type { Level } from "../facts";
import { CAPABILITIES, HARNESSES, HOOK_NEEDS, meetsMinimum } from "../facts";
import { MONO, SANS } from "../fonts";
import { CHECK_BEAT_TWO, ramp, SCENES, sceneVisibility, typed } from "../motion";
import { tint, useTheme } from "../theme";

const MATRIX = { name: 230, column: 150, top: 120, header: 70, row: 54 };
const LEFT = (1280 - MATRIX.name - CAPABILITIES.length * MATRIX.column) / 2;

// Beat one grades only what the hook declared; beat two adds the rest.
const beatStart = (id: string) => (HOOK_NEEDS[id] === undefined ? CHECK_BEAT_TWO + 6 : 30);

const Badge = ({ level, shown }: { level: Level; shown: number }) => {
  const theme = useTheme();
  const color = theme.levels[level];
  return (
    <div
      style={{
        width: 130,
        height: 34,
        borderRadius: 17,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        fontFamily: SANS,
        fontSize: 16,
        fontWeight: 600,
        color,
        background: tint(color, 0.13),
        border: `1.5px solid ${tint(color, 0.4)}`,
        opacity: shown,
        transform: `scale(${0.6 + 0.4 * shown})`,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 4, background: color }} />
      {level}
    </div>
  );
};

export const Check = () => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const { duration } = SCENES.check;

  const required = CAPABILITIES.filter((id) => HOOK_NEEDS[id] === "required");
  const passing = HARNESSES.filter((h) => required.every((id) => meetsMinimum(h.grades[id] ?? "unsupported")));
  const rowY = (r: number) => MATRIX.top + MATRIX.header + r * MATRIX.row;
  const columnX = (c: number) => LEFT + MATRIX.name + c * MATRIX.column;
  // Once the second beat starts, the hook's own columns step back.
  const recede = (id: string) =>
    HOOK_NEEDS[id] === undefined ? 1 : 1 - 0.5 * ramp(frame, CHECK_BEAT_TWO, CHECK_BEAT_TWO + 12);

  return (
    <div style={{ position: "absolute", inset: 0, opacity: sceneVisibility(frame, duration) }}>
      <div
        style={{
          position: "absolute",
          left: LEFT,
          top: MATRIX.top + MATRIX.header - 40,
          fontFamily: MONO,
          fontSize: 19,
          color: theme.fg,
        }}
      >
        <span style={{ color: theme.muted }}>$ </span>
        {typed("hooknostic check", ramp(frame, 4, 22))}
      </div>

      {CAPABILITIES.map((id, c) => {
        // <event>.<capability>; both events shown are two segments long.
        const dot = id.indexOf(".", id.indexOf(".") + 1);
        const start = beatStart(id) - 6;
        return (
          <div
            key={id}
            style={{
              position: "absolute",
              left: columnX(c),
              top: MATRIX.top,
              width: MATRIX.column,
              height: MATRIX.header,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "flex-end",
              paddingBottom: 12,
              fontFamily: MONO,
              opacity: ramp(frame, start, start + 12) * recede(id),
            }}
          >
            <span style={{ fontSize: 15, color: theme.muted }}>{id.slice(0, dot + 1)}</span>
            <span style={{ fontSize: 17, fontWeight: 700, color: theme.fg }}>{id.slice(dot + 1)}</span>
          </div>
        );
      })}

      {HARNESSES.map((h, r) => {
        const shown = ramp(frame, 10 + r * 3, 22 + r * 3);
        return (
          <div key={h.name}>
            <div
              style={{
                position: "absolute",
                left: LEFT,
                top: rowY(r),
                width: MATRIX.name + CAPABILITIES.length * MATRIX.column,
                height: MATRIX.row,
                display: "flex",
                alignItems: "center",
                borderTop: `1px solid ${tint(theme.border, 0.7)}`,
                fontFamily: SANS,
                fontSize: 19,
                fontWeight: 600,
                color: theme.fg,
                opacity: shown,
              }}
            >
              {h.name}
            </div>
            {CAPABILITIES.map((id, c) => {
              const start = beatStart(id) + c * 4 + r * 2;
              return (
                <div
                  key={id}
                  style={{
                    position: "absolute",
                    left: columnX(c),
                    top: rowY(r),
                    width: MATRIX.column,
                    height: MATRIX.row,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: recede(id),
                  }}
                >
                  <Badge level={h.grades[id] ?? "unsupported"} shown={ramp(frame, start, start + 8)} />
                </div>
              );
            })}
          </div>
        );
      })}

      <Caption
        beats={[
          {
            from: 46,
            to: CHECK_BEAT_TWO,
            text:
              passing.length === HARNESSES.length
                ? `Everything this hook needs is supported on all ${HARNESSES.length} harnesses`
                : `This hook's requirements are met on ${passing.length} of ${HARNESSES.length} harnesses`,
          },
          {
            from: CHECK_BEAT_TWO + 12,
            to: duration,
            text: "Other capabilities differ, and every shortfall is graded and reported",
          },
        ]}
      />
    </div>
  );
};
