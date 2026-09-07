# ADR-0014: Owner 2FA bootstrap, followed by direct OIDC releases

Status: accepted

npm requires existing packages for trusted and staged publishing. The first
publication therefore cannot use the repository's routine OIDC release path.

The protected release workflow has a `bootstrap` mode that only attaches built,
tested, pnpm-packed tarballs and checksums to the human-published GitHub Release.
The owner verifies those exact assets and publishes them interactively with 2FA.
This is the sole local-publication exception, and never applies to agents.
Bootstrap versions do not claim npm provenance; subsequent OIDC releases do.

After all three packages exist, the owner configures direct OIDC permission and
switches the environment to `oidc`, its normal default. No bypass token or npm
secret enters the workflow. Staged publication is not introduced: the existing
GitHub Release decision remains the routine publication gate.

The precise prerequisites, commands, and recovery sequence live in
[releases.md](../releases.md), including links to npm's current requirements.
