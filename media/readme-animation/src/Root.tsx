import { Composition } from "remotion";

import { Hero } from "./Hero";
import { DURATION, FPS, HEIGHT, WIDTH } from "./motion";

// One composition per README theme; `pnpm render` writes both GIFs.
export const Root = () => (
  <>
    <Composition
      id="HeroDark"
      component={Hero}
      durationInFrames={DURATION}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={{ theme: "dark" as const }}
    />
    <Composition
      id="HeroLight"
      component={Hero}
      durationInFrames={DURATION}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={{ theme: "light" as const }}
    />
  </>
);
