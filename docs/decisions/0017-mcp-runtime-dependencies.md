# Decision 0017 — Package materialization is provider-owned and component-neutral

**Status:** Accepted — 2026-09-16; amended — 2026-09-18 and 2026-09-20 · Referenced from code and docs as **ADR-0017** · Complements [ADR-0012](0012-claude-plugin-runtime-dependencies.md)

**In short:** An Agent Plugin build may opt into a trusted, author-supplied Node
provider that materializes an opaque package tree. Hooknostic owns containment,
execution, placement, and collision detection. Providers own the meaning and
portability of their output; Hooknostic contains no registry of ecosystems, package
formats, or executable signatures.

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
- materialized files cannot overwrite source or generated package files.

Cross-machine portability remains required by ADR-0006, but arbitrary bytes do not
carry enough generic evidence to prove it. A signature list is necessarily incomplete
(native code can be wrapped in archives or new formats) and can also reject opaque data
that merely shares a prefix. The trusted provider knows the ecosystem metadata and
output semantics, so it owns that decision rather than core guessing from bytes.

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
  tree in memory, including provider-specific portability rules.

Providers own all ecosystem knowledge: lockfile parsing, installer flags, network and
cache behavior, generated-file removal, metadata repair, reproducibility, and
portability. A provider is trusted build code, just like the TypeScript configuration
that imports it. Hooknostic never discovers or selects a provider from package data.

Core owns the boundary around that code:

1. Every declared input is a strict POSIX path to a regular file whose real path stays
   inside `components.root`. Providers receive its declared path, canonical absolute
   path, and bytes.
2. The `into` value accepts a leading `./` and one trailing `/`, canonicalizing both
   away. Absolute and drive-qualified paths, backslashes, colons, control characters,
   empty segments, and `.` or `..` segments fail with HN501 before any provider method
   or external command runs. Duplicate destinations compare the canonical value.
3. Core creates a fresh output directory and invokes the returned command and arguments
   directly, never through a shell. Standard output is discarded; standard error is
   drained with a bounded tail retained for failure diagnostics. Missing commands,
   spawn failures, signals, nonzero exits, and provider exceptions are HN501 build
   failures.
4. Core inventories only regular files and assigns canonical mode `0644`, ignoring host
   permission bits as required by ADR-0013. A provider may return mode `0755` from
   `postprocess` for files its ecosystem defines as executable; every other mode fails
   materialization. Symlinks, escaping or duplicate provider paths, source-file
   collisions, generated-file collisions, and collisions between providers fail the
   projection.

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
- Core deliberately makes no portability claim about opaque output bytes. A provider
  must reject host-specific output using the metadata and semantics of its own ecosystem;
  returning a problem from `postprocess` fails materialization before projection.
- Executability is provider-owned metadata, not an observed host property. Providers
  that emit commands or shims mark them `0755` in `postprocess`; all other materialized
  files remain `0644`, so identical inputs produce identical modes on Windows and POSIX.
- A materialized tree enlarges every selected package output. ADR-0006's committed
  artifact comparison makes that change reviewable.
