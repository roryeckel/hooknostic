# Decision 0017 — Package materialization is provider-owned and component-neutral

**Status:** Accepted — 2026-09-16; amended — 2026-09-18 · Referenced from code and docs as **ADR-0017** · Complements [ADR-0012](0012-claude-plugin-runtime-dependencies.md)

**In short:** An Agent Plugin build may opt into a trusted, author-supplied Node
provider that materializes an opaque package tree. Hooknostic owns containment,
execution, placement, collision detection, and generic native-object screening. It
contains no registry of ecosystems or package-manager policy.

## Context

Some portable packages need generated content that should be committed into every
native package projection: dependency trees are one example, but the need is not
specific to MCP or to any language. Treating each package manager as a Hooknostic
feature would put ecosystem lockfile grammars, installer flags, and metadata rewriting
inside the compiler. That policy changes independently of harness projection and cannot
be complete: every new language would require a core release.

The earlier form of this decision attempted exactly that for one ecosystem. Although it
could make one installer output reproducible, it coupled the package projection model to
one language and implied that Hooknostic could classify arbitrary MCP runtime
dependencies. It cannot. A server command does not reveal its transitive runtime
requirements.

There are still important invariants Hooknostic can enforce without knowing an
ecosystem:

- source inputs remain inside the Agent Plugin root;
- provider commands run without a shell and receive a fresh staging directory for output;
- destinations and produced paths cannot escape a projected package;
- materialized files cannot overwrite source or generated package files; and
- a build-once artifact must not accidentally contain a native object for one host.

## Decision

`components.materialize` is a list of explicit package-materialization declarations.
Each declaration supplies a trusted `PackageMaterializer` object imported by
`hooknostic.config.ts`, a map of named package-relative input files, and an `into`
destination relative to the projected plugin root. Hooknostic ships no built-in
providers.

The provider API has three operations:

- optional `validate(context)` checks provider-owned input semantics;
- `plan({ ...context, outputDir })` returns one executable and argument vector; and
- optional `postprocess(files, context)` validates or normalizes the produced opaque
  tree in memory.

Providers own all ecosystem knowledge: lockfile parsing, installer flags, network and
cache behavior, generated-file removal, metadata repair, and any stronger portability
rule. A provider is trusted build code, just like the TypeScript configuration that
imports it. Hooknostic never discovers or selects a provider from package data.

Core owns the boundary around that code:

1. Every declared input is a strict POSIX path to a regular file whose real path stays
   inside `components.root`. Providers receive its declared path, canonical absolute
   path, and bytes.
2. The `into` value accepts a leading `./` and one trailing `/`, canonicalizing both
   away. Absolute and drive-qualified paths, backslashes, colons, control characters,
   empty segments, and `.` or `..` segments fail with HN501 before any provider method
   or external command runs. Duplicate destinations compare the canonical value.
3. Core creates a fresh output directory and invokes the returned command and arguments
   directly, never through a shell. Missing commands, nonzero exits, and provider
   exceptions are HN501 build failures.
4. Core inventories only regular files. Symlinks, escaping or duplicate provider paths,
   source-file collisions, generated-file collisions, and collisions between providers
   fail the projection.
5. Core examines bytes for ELF, Mach-O, universal Mach-O, and PE object formats. A match
   is rejected because an ADR-0006 artifact is built once and installed elsewhere.
   Filename extensions and ecosystem metadata are not generic evidence; providers must
   enforce any additional restrictions their output format requires.

Materialization runs once per build or check after capability and layout analysis
succeeds. The resulting bytes are reused by every selected package projector, which
places them relative to its own plugin root. Project delivery has no package to receive
the tree, so a configuration must select at least one package-delivery component target.
Narrowing a mixed build to project-only targets skips materialization. Doctor deliberately
skips materializer providers while retaining generic declaration and input validation.

`components.runtimePackage` is intentionally separate. It is the existing
harness-owned npm installation contract from ADR-0012, not a materializer alias, and
Hooknostic still does not perform that npm install.

MCP command reporting is also separate. For each stdio declaration Hooknostic reports
whether a `./` command comes from the package or direct project source, or whether a
bare command is looked up on `PATH`. `doctor` may probe a bare command on the current
machine, but the probe is advisory because the generated launcher can use a different
working directory; it does not change the exit status. Hooknostic does not parse
shebangs or claim to discover interpreters, dynamic libraries, daemons, or transitive
runtime dependencies. Remote servers have no command to report.

## Consequences

- Adding support for an ecosystem does not change Hooknostic. Authors or separate
  packages can publish typed providers on their own release cadence.
- Materialization is an explicit scope exception to “projection is not dependency
  installation.” It runs only when configuration imports a provider and declares it;
  there is no implicit install, provider lookup, or runtime service.
- Reproducibility beyond the generic boundary is the provider's responsibility. A
  provider that invokes a nondeterministic installer produces nondeterministic artifacts,
  which committed-output drift will expose but Hooknostic cannot prevent in general.
- Generic native-object screening deliberately does not infer meaning from names such as
  `.so` or from ecosystem metadata. This avoids language coupling and false claims, while
  providers remain free to fail closed more aggressively.
- A materialized tree enlarges every selected package output. ADR-0006's committed
  artifact comparison makes that change reviewable.
