# Isolated environment for the egress measurement. No Windows PATH entries.
export HNE="${HNE:-$HOME/hn-egress}"
export PATH=$HNE/tools/bin:${NODE_BIN:-$HOME/.nvm/versions/node/v24.22.3/bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export NPM_CONFIG_USERCONFIG=$HNE/npmrc
export npm_config_prefix=$HNE/tools
unset NODE_OPTIONS
