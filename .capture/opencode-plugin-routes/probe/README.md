# Probe inputs

`project-plugin/` is copied into a throwaway project as-is. `package-plugin/` is
the local npm package installed with `opencode plugin ./package-plugin`; declare
the plugin in the **root** `opencode.json` (`"plugin": ["./package-plugin"]`),
not through the CLI, which writes a path that does not resolve — see the defect
section in the README one level up.

Both write marker files under `D:/tmp/oc-pkg-probe/`; edit the `MARKER`
constants before reuse. Each positive claim needs its vendored `node_modules`
removed and the probe re-run, or it establishes nothing.
