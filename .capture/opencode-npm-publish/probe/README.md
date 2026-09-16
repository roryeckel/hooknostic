# Probe inputs

`registry/config.yaml` runs verdaccio with anonymous publish and an npmjs uplink
(so `is-number` resolves through the proxy):

```
npx --yes verdaccio@6 --config ./config.yaml --listen 4873
```

`dependency-probe/` is published to it. The npm client refuses to publish
without a token even when the registry accepts anonymous writes, so put a dummy
one in an `.npmrc` beside the package and in every consuming project:

```
registry=http://localhost:4873/
//localhost:4873/:_authToken=probe-anonymous
```

Then, in a throwaway project:

```
export XDG_CONFIG_HOME=<scratch>/xdg XDG_CACHE_HOME=<scratch>/xdg-cache
export npm_config_registry=http://localhost:4873/
opencode plugin hooknostic-oc-npm-probe
HOOKNOSTIC_PROBE_MARKER=<scratch>/marker.json opencode debug config
```

Both XDG variables are required. `OPENCODE_CONFIG_DIR` alone leaks: it moves the
SDK install root but the contributor's own `opencode.json` is still read, and
the package cache still lands in the real `~/.cache/opencode`.

The marker is the evidence; the installer's own output is not. Every positive
dependency result needs the module deleted from
`<XDG_CACHE_HOME>/opencode/packages/<name>@latest/node_modules/` and the probe
re-run, or it establishes nothing.

To re-check the update behaviour, publish a second version with a distinguishing
field in `index.js`, then compare re-running, `opencode plugin <name> --force`,
and deleting the cached package root.
