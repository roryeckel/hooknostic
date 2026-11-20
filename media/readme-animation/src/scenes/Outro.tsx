import { useCurrentFrame } from "remotion";

import { HARNESSES } from "../facts";
import { MONO, SANS } from "../fonts";
import { ramp } from "../motion";
import { useTheme } from "../theme";

// The README above the animation already shows the logo and name, so the
// outro closes on the promise and the install command instead.
export const Outro = () => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const rise = (start: number) => {
    const p = ramp(frame, start, start + 14);
    return { opacity: p, transform: `translateY(${(1 - p) * 10}px)` };
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: SANS,
      }}
    >
      <div style={{ fontSize: 46, fontWeight: 700, letterSpacing: "-0.02em", color: theme.fg, ...rise(4) }}>
        One source, native on every harness
      </div>
      <div
        style={{
          marginTop: 40,
          padding: "14px 26px",
          borderRadius: 12,
          background: theme.panel,
          border: `1.5px solid ${theme.border}`,
          fontFamily: MONO,
          fontSize: 22,
          color: theme.fg,
          ...rise(16),
        }}
      >
        <span style={{ color: theme.muted }}>$ </span>
        npm install --save-dev hooknostic @hooknostic/sdk
      </div>
      <div style={{ marginTop: 26, fontSize: 20, color: theme.muted, ...rise(28) }}>
        {HARNESSES.map((h) => h.name).join("  ·  ")}
      </div>
    </div>
  );
};
