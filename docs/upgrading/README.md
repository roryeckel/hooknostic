# Upgrading

Hooknostic is pre-1.0: any minor release may contain breaking changes. Each
release's notes include an "Upgrading" section with the steps for that release.
Changes that need more than a few lines get a guide here.

When upgrading:

- Keep `@hooknostic/sdk`, `@hooknostic/agent-plugin`, and the `hooknostic` CLI
  on the same release.
- Rebuild packages or re-sync projects with the new CLI to regenerate owned
  output.
- Read the release notes' upgrading section, then any guide below for the
  releases you are crossing.

| Guide | Release | Who is affected |
| --- | --- | --- |
| [Zod 4 schemas](zod-4.md) | First release after 0.11.0 | SDK consumers who compose exported schemas, annotate Zod types, or handle `ZodError` |
