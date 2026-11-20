import type { ReactNode } from "react";
import { useCurrentFrame } from "remotion";

import { SANS } from "../fonts";
import { ramp } from "../motion";
import { useTheme } from "../theme";

export interface Beat {
  /** Scene-local frame the caption starts to appear. */
  from: number;
  /** Scene-local frame it is gone by. */
  to: number;
  text: ReactNode;
}

/** The scene's single line of narration, one beat at a time. */
export const Caption = ({ beats }: { beats: readonly Beat[] }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  return (
    <>
      {beats.map((beat, i) => {
        const enter = ramp(frame, beat.from, beat.from + 12);
        const opacity = enter * (1 - ramp(frame, beat.to - 8, beat.to));
        if (opacity === 0) return null;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: 48,
              right: 48,
              top: 568,
              textAlign: "center",
              fontFamily: SANS,
              fontSize: 27,
              fontWeight: 600,
              color: theme.fg,
              opacity,
              transform: `translateY(${(1 - enter) * 8}px)`,
            }}
          >
            {beat.text}
          </div>
        );
      })}
    </>
  );
};
