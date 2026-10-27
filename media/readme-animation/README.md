# README animation

The [Remotion](https://www.remotion.dev/) source for the animated overview at the
top of the repository README: `docs/assets/hooknostic-hero-dark.gif` and
`docs/assets/hooknostic-hero-light.gif`, selected by the viewer's GitHub theme.

This is its own pnpm root, outside the hooknostic workspace: Remotion and React stay
out of the workspace lockfile, CI installs and Renovate. Its versions change only
when someone re-renders, and every `remotion` / `@remotion/*` package must stay on
the same exact version.

## Harness facts are derived, never typed

Every harness fact on screen comes from `src/facts.json`, which
`scripts/extract-facts.mjs` generates from the same sources as
[docs/harness-support.md](../../docs/harness-support.md):

- names and capability grades from the adapter registry in the built CLI, at each
  harness family's recommended range;
- the shell command's input key (`command`, `cmd`, ...) from one captured
  canonical `tool.before` fixture per family, named in the script's
  `SHELL_FIXTURES` map.

A family without a fixture entry, a fixture that is not a shell `tool.before`
event, or an unknown support level fails the script instead of being guessed. The
animation shows no version ranges. The commands on screen (`npm install`,
`rm -rf /`) are illustrative; only their placement under each harness's key is
captured.

## Re-rendering

Requires the hooknostic workspace to be built first (`pnpm build` at the root).

```sh
pnpm install          # in this directory
pnpm facts            # regenerate src/facts.json from the built adapters
pnpm studio           # preview and scrub in the browser
pnpm render           # write both GIFs into docs/assets
```

`pnpm facts --check` exits non-zero when `src/facts.json` no longer matches the
adapters, which means the committed GIFs are stale. CI does not run it, since
a fix needs a local re-render.

The composition is 1280x640 at 30 fps; `remotion.config.ts` renders the GIF at
15 fps and 960x480. Animations run at their authored speed; `HOLD` in
`src/motion.ts` scales only the pauses in which each finished beat stays on
screen, so reading time is tuned in one place. Keep each GIF under about 3 MB: every re-render adds both
files to the repository history. Review the frames in both themes before
committing, and commit the source and GIFs together.

The first render downloads Chrome Headless Shell, and `src/fonts.ts` fetches Inter
and JetBrains Mono from Google Fonts so text renders the same on every OS.

## License

Remotion is not open source. It is free for individuals and for organizations
with up to three employees; larger for-profit companies need a
[company license](https://www.remotion.dev/license) to use it. The GIFs it
produces carry no restrictions.
