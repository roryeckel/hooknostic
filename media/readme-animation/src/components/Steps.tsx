import { interpolateColors, useCurrentFrame } from "remotion";

import { SANS } from "../fonts";
import { ramp, SCENES } from "../motion";
import { BRAND, useTheme } from "../theme";
import { CheckIcon } from "./Panel";

const STEPS = [
  { scene: SCENES.source, title: "Write it once" },
  { scene: SCENES.check, title: "Check every target" },
  { scene: SCENES.run, title: "Your hook, run natively" },
] as const;

const CONNECTOR = 64;

/**
 * The three steps across the top, from the first scene to the end of the
 * last: the current one is filled, finished ones are checked, and the
 * connector between two steps fills as the scene changes.
 */
export const Steps = () => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const first = STEPS[0].scene;
  const last = STEPS[STEPS.length - 1]!.scene;
  const end = last.from + last.duration;
  const visible = ramp(frame, first.from, first.from + 12) * (1 - ramp(frame, end - 12, end));

  return (
    <div
      style={{
        position: "absolute",
        top: 46,
        width: "100%",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        transform: "translateY(-50%)",
        fontFamily: SANS,
        opacity: visible,
      }}
    >
      {STEPS.map(({ scene, title }, i) => {
        const next = STEPS[i + 1]?.scene;
        const reached = i === 0 ? 1 : ramp(frame, scene.from, scene.from + 12);
        const done = next === undefined ? 0 : ramp(frame, next.from, next.from + 12);
        const active = reached - done;
        return (
          <div key={title} style={{ display: "flex", alignItems: "center" }}>
            <div
              style={{
                position: "relative",
                width: 28,
                height: 28,
                borderRadius: 14,
                boxSizing: "border-box",
                border: `1.5px solid ${interpolateColors(reached, [0, 1], [theme.border, theme.fg])}`,
                background: interpolateColors(active, [0, 1], [theme.bg, theme.fg]),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                fontWeight: 700,
                color: interpolateColors(active, [0, 1], [theme.muted, theme.bg]),
              }}
            >
              <span style={{ opacity: 1 - done }}>{i + 1}</span>
              <span style={{ position: "absolute", display: "flex", opacity: done }}>
                <CheckIcon color={theme.fg} size={15} />
              </span>
            </div>
            <span
              style={{
                marginLeft: 12,
                fontSize: 20,
                fontWeight: 600,
                color: interpolateColors(active, [0, 1], [theme.muted, theme.fg]),
              }}
            >
              {title}
            </span>
            {next === undefined ? null : (
              <div
                style={{
                  width: CONNECTOR,
                  height: 2,
                  margin: "0 20px",
                  borderRadius: 1,
                  background: theme.border,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: CONNECTOR * ramp(frame, next.from - 6, next.from + 14),
                    height: "100%",
                    background: `linear-gradient(90deg, ${BRAND.join(", ")})`,
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
