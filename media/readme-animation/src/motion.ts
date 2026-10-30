import type { EasingFunction } from "remotion";
import { Easing, interpolate } from "remotion";

export const FPS = 30;
export const WIDTH = 1280;
export const HEIGHT = 640;

// Animations always run at their authored speed. HOLD stretches only the
// pauses in which a finished beat stays on screen to be read, so the reading
// pace is tuned in one place without slowing any motion.
export const HOLD = 1.4;
const hold = (frames: number) => Math.round(frames * HOLD);

// The timeline, in frames. Each beat starts once the previous beat's animation
// has finished and its hold has elapsed. Neighbouring scenes overlap so each
// exit cross-fades into the next entrance.
const OVERLAP = 8;
const EXIT = 12;

// The README shows the logo and name right above the animation, so there is no
// intro: a few empty frames, then the first step.
const LEAD = 8;

// Write it once: the code is revealed by frame 34; each beat's highlight and
// caption take 16 frames, then hold for about 4 s.
export const sourceBeatAt = (beat: number) => 34 + beat * (16 + hold(86));

// Check: the hook's own grades and caption have landed by frame 58; the other
// columns take 36 frames from the second beat.
export const CHECK_BEAT_TWO = 58 + hold(86);

// Run: the rewrite has landed by frame 68; clearing, retyping and blocking take
// 36 frames from RUN_CLEAR.
export const RUN_CLEAR = 68 + hold(56);

const source = { from: LEAD, duration: sourceBeatAt(3) + EXIT };
const check = {
  from: source.from + source.duration - OVERLAP,
  duration: CHECK_BEAT_TWO + 36 + hold(96) + EXIT,
};
const run = { from: check.from + check.duration - OVERLAP, duration: RUN_CLEAR + 36 + hold(68) + EXIT };
// Outro: the headline, install command and harness list have risen by frame 42.
const outro = { from: run.from + run.duration - OVERLAP, duration: 42 + hold(40) + 18 };

export const SCENES = { source, check, run, outro } as const;

// The whole frame fades out at the end so the last frame matches the empty
// first one.
export const DURATION = outro.from + outro.duration;
export const FADE_OUT = [DURATION - 18, DURATION] as const;

const EASE = Easing.bezier(0.2, 0.8, 0.2, 1);
export const EASE_IN_OUT = Easing.inOut(Easing.cubic);

/** 0 before `start`, 1 after `end`, eased in between. */
export const ramp = (frame: number, start: number, end: number, easing: EasingFunction = EASE) =>
  interpolate(frame, [start, end], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing });

export const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

/** Entrance over the first frames of a scene, exit over its last. */
export const sceneVisibility = (frame: number, duration: number, fade = EXIT) =>
  ramp(frame, 0, fade) * (1 - ramp(frame, duration - fade, duration));

/** The first `progress` (0-1) of `text`, for typed-in commands. */
export const typed = (text: string, progress: number) => text.slice(0, Math.round(text.length * progress));
