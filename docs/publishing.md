# Publishing & packaging

Current status: the repository is public, and v0.2.0 is the first public release.
Its release PR removed the `"private": true` never-publish guard from
`packages/{agent-plugin,sdk,cli}`; the owner publishes that first version from
CI-built tarballs, and later versions publish through trusted publishing. The
release protocol -- the three-stage pipeline, its gates, and every recovery path --
lives in [releases.md](./releases.md); this page keeps the packaging story.

## Testing without publishing (the everyday flow)

All publishable packages can be packed into tarballs and consumed exactly as a
registry install would be — no exposure at all:

```powershell
pnpm build   # or rely on the test suite's pretest

# pack all tarballs into a scratch dir
$dst = "$env:TEMP\hooknostic-live"
New-Item -ItemType Directory -Force $dst | Out-Null
pnpm --filter @hooknostic/sdk exec pnpm pack --pack-destination $dst
pnpm --filter @hooknostic/agent-plugin exec pnpm pack --pack-destination $dst
pnpm --filter hooknostic exec pnpm pack --pack-destination $dst

# consume them like a registry user
mkdir $dst\demo; cd $dst\demo
npm init -y
npm install ..\hooknostic-sdk-0.1.0.tgz ..\hooknostic-agent-plugin-0.1.0.tgz ..\hooknostic-0.1.0.tgz
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

See [releases.md](./releases.md). Routine publication happens through
`.github/workflows/release-publish.yml`, fired by a human publishing a draft
release. The first publication uses CI-built `pnpm pack` tarballs which the
owner verifies and publishes interactively with 2FA. The runbook covers that
narrow exception, the protected `npm` environment, and the transition to OIDC.
Agents never publish.

## Notes

- Only `@hooknostic/agent-plugin`, `@hooknostic/sdk`, and `hooknostic` are published;
  every other workspace package carries `"private": true`.
- The unscoped `hooknostic` CLI can only ever be public on npmjs.org; if a
  private stopgap registry were ever wanted, GitHub Packages supports scoped
  `@hooknostic/*` but not unscoped names.
- Routine OIDC releases from the public repository carry npm provenance. The
  owner's first-package bootstrap is published with `--provenance=false`;
  its CI-built tarballs and checksums remain attached to the GitHub Release.
- Published packages include their own READMEs and license. The CLI also ships
  `dist/THIRD_PARTY_NOTICES.txt`; generated runtimes and MCP launchers embed
  their bundled dependencies' license and notice text.
