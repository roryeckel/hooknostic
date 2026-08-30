# Publishing & packaging

Current status: **npm publication is intentionally deferred.** Nothing is on the
npm registry; the GitHub repo is private, and `packages/{sdk,cli}` carry
`"private": true` as an executable never-publish guard. The release protocol --
the three-stage pipeline, its gates, and every recovery path -- lives in
[releases.md](./releases.md); this page keeps the packaging story.

## Testing without publishing (the everyday flow)

Both publishable packages can be packed into tarballs and consumed exactly as a
registry install would be — no exposure at all:

```powershell
pnpm build   # or rely on the test suite's pretest, which bundles both packages

# pack both tarballs into a scratch dir
$dst = "$env:TEMP\hooknostic-live"
New-Item -ItemType Directory -Force $dst | Out-Null
pnpm --filter @hooknostic/sdk exec pnpm pack --pack-destination $dst
pnpm --filter hooknostic exec pnpm pack --pack-destination $dst

# consume them like a registry user
mkdir $dst\demo; cd $dst\demo
npm init -y
npm install ..\hooknostic-sdk-0.1.0.tgz ..\hooknostic-0.1.0.tgz
node node_modules\hooknostic\bin\hooknostic.mjs --help
```

Then author `hooknostic.config.ts` + `src/hooks.ts` (see `examples/`) and run
`node node_modules\hooknostic\bin\hooknostic.mjs build`. This exercises the exact
bytes npm would ship — including the pnpm `workspace:*` → real-version rewrite,
which `npm pack` does NOT do (`npm pack` would produce broken tarballs; always
pack with `pnpm pack`).

`packages/cli/src/package.test.ts` additionally simulates the install story
offline on every test run.

## Releasing

See [releases.md](./releases.md). Publication happens only through
`.github/workflows/release-publish.yml`, fired by a human publishing a draft
release; the first public release's one-time bootstrap steps (npm Trusted
Publisher against that workflow filename, the `npm` environment, removing the
`private` guards in the release PR) are listed there.

## Notes

- Only `@hooknostic/sdk` and `hooknostic` are ever published (design §14);
  every other workspace package carries `"private": true`.
- The unscoped `hooknostic` CLI can only ever be public on npmjs.org; if a
  private stopgap registry were ever wanted, GitHub Packages supports scoped
  `@hooknostic/*` but not unscoped names.
- Provenance attestations are not generated while the source repo is private;
  they start automatically once it is public.