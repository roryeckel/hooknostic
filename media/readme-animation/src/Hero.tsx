import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";

import { Steps } from "./components/Steps";
import { FADE_OUT, ramp, SCENES } from "./motion";
import { Check } from "./scenes/Check";
import { Outro } from "./scenes/Outro";
import { Run } from "./scenes/Run";
import { Source } from "./scenes/Source";
import type { ThemeName } from "./theme";
import { ThemeProvider, THEMES } from "./theme";

export const Hero = ({ theme }: { theme: ThemeName }) => {
  const frame = useCurrentFrame();
  const palette = THEMES[theme];
  return (
    <ThemeProvider value={palette}>
      {/* No ligatures: JetBrains Mono would draw === and -- as single glyphs. */}
      <AbsoluteFill style={{ background: palette.bg, fontVariantLigatures: "none" }}>
        <AbsoluteFill style={{ opacity: 1 - ramp(frame, ...FADE_OUT) }}>
          <Steps />
          <Sequence from={SCENES.source.from} durationInFrames={SCENES.source.duration}>
            <Source />
          </Sequence>
          <Sequence from={SCENES.check.from} durationInFrames={SCENES.check.duration}>
            <Check />
          </Sequence>
          <Sequence from={SCENES.run.from} durationInFrames={SCENES.run.duration}>
            <Run />
          </Sequence>
          <Sequence from={SCENES.outro.from} durationInFrames={SCENES.outro.duration}>
            <Outro />
          </Sequence>
        </AbsoluteFill>
      </AbsoluteFill>
    </ThemeProvider>
  );
};
