# Security policy

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub's
[security advisory form](https://github.com/roryeckel/hooknostic/security/advisories/new),
which is visible only to the maintainer. If you would rather not use GitHub, or
do not have an account, email **hooknostic@2labz.com** instead.

Include the Hooknostic version, the harness and its exact version (the output of
`hooknostic doctor` covers both), and enough detail to reproduce. If you have a
generated artifact or a hook payload that demonstrates the problem, attach it.

This is a single-maintainer project, so please allow a reasonable window for a
reply before disclosing. You will get an acknowledgement of what was received and
whether it is being treated as a vulnerability.

## Supported versions

Before 1.0, only the latest published version is supported. Fixes ship in a new
release rather than as patches to older ones.

## What Hooknostic is responsible for

Hooknostic generates code that runs inside a coding agent's trust boundary, on
the developer's machine, with that developer's permissions. It is a **compiler**
for that code — not a sandbox and not a security boundary. That line determines
what counts as a vulnerability here.

**In scope** — report these:

- A generated artifact that writes outside the target's declared output
  directory, or that a build stages or commits outside it.
- A shim that turns a hook's deny into an allow, drops a block, or otherwise
  reports an effect the dispatcher did not produce. A guard that fails *open*
  when it should fail closed is the highest-severity class this project has.
- Tool input rewriting that produces a command other than the one the hook
  asked for — a codec that mis-encodes, drops a sibling field, or lands a
  rewrite under the wrong key.
- A capability reported as supported when the generated artifact cannot actually
  deliver it, where a hook author would reasonably rely on it for a security
  decision.
- Prototype pollution, injection, or unsafe deserialisation reachable from a
  harness payload, a tool name, or a config value.
- A dependency vulnerability that is genuinely reachable through shipped code
  (the SDK, the CLI, or a generated artifact).

**Out of scope** — these are working as designed:

- A hook *you* wrote doing something dangerous. Hooknostic runs your code; it
  does not judge it.
- Anything about a harness's own trust, approval, or sandbox model. Hooknostic
  never modifies trust state on your behalf — Codex's per-hook trust, for
  example, still requires your interactive approval, and that is deliberate.
- A harness bug that Hooknostic accurately reports. If `hooknostic inspect`
  states the limitation, the report belongs with that harness's maintainers, and
  we will help you word it.
- Installing a generated artifact from a source you do not trust. Installation is
  a deliberate manual step precisely so that it is your decision.
- Reports from automated scanners with no demonstrated reachable path.

## Hardening you can rely on

- Builds are reproducible from the version ranges in your config, never from
  whatever happens to be installed locally.
- Builds are atomic: nothing is written until every selected target passes.
- Artifact paths are validated before staging — relative, POSIX, no `..`, no
  absolute paths.
- Routine npm publication uses GitHub Actions Trusted Publishing, without an npm
  token secret. The first-package bootstrap is performed by the owner with interactive
  2FA from verified CI-built tarballs; it is intentionally unattested. See
  [the release runbook](docs/releases.md#first-public-release--one-time-owner-bootstrap).
