# Publishing & release process

Current status: **npm publication is intentionally deferred.** Nothing is on the
npm registry; the GitHub repo is private. The release workflow exists but is
manually triggered only, so a stray `v*` tag cannot publish anything.

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

## First real publish (when ready) — manual, once

1. `cd packages/sdk && pnpm publish --no-git-checks --access public`
2. `cd packages/cli && pnpm publish --no-git-checks --access public`
   (pnpm, not npm: it rewrites `workspace:*`; also claims both names)

## Enable tag-driven publishing (when ready)

1. Restore the tag trigger in `.github/workflows/release.yml` (see the comment
   at the top of that file).
2. npmjs.com → each package → Settings → Trusted Publisher: GitHub Actions,
   `roryeckel/hooknostic`, workflow filename `release.yml`, environment `npm`,
   allowed action `npm publish`.
3. GitHub repo → Settings → Environments → create `npm`.
4. `git tag v0.1.0 && git push origin v0.1.0`.
5. Verify trustedPublisher/provenance on the npm package pages.

## Going public later (repo)

Flip repo visibility in GitHub settings; add `"provenance": true` to
`publishConfig` in both publishable packages. Attestations begin automatically
with the next tagged release — no workflow changes.

## Notes

- Only `@hooknostic/sdk` and `hooknostic` are ever published (design §14);
  every other workspace package carries `"private": true`.
- The unscoped `hooknostic` CLI can only ever be public on npmjs.org; if a
  private stopgap registry were ever wanted, GitHub Packages supports scoped
  `@hooknostic/*` but not unscoped names.
- Provenance attestations are not generated while the source repo is private;
  they start automatically once it is public.