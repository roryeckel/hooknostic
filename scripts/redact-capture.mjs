// Home-directory redaction for capture records (harness-capture skill):
// replace only the account segment of the capturing machine's own home path
// with `user`. Drive letter, separators, escaping, and every other byte of the
// record stay as captured -- path shape is evidence.
//
// The home path is matched by STRUCTURE, not from a list of spellings: each
// separator matches any run of `\` and `/`, which covers every JSON escape
// depth and mixed separators alike. Case is ignored only for a Windows-style
// home. A match must stand alone (not inside a longer path such as
// `docs/home/jo`) and end at a segment boundary. Anything else that extends the
// home's profile folder (`jo@corp`, `jonas`) is a near miss: left untouched and
// reported, so the caller can refuse to write rather than guess.

const SEP = "[\\\\/]+";
/** What may follow a complete path segment. */
const BOUNDARY = `(?=${SEP}|["'\\s]|$)`;
/** What may precede the start of a home path that is not inside a longer one. */
const START = "(?<![\\w.~-])";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isWindowsHome = (home) => /^[A-Za-z]:[\\/]/.test(home);

function homeParts(home) {
  const parts = home.split(/[\\/]+/).filter(Boolean);
  const segment = parts.pop();
  if (!segment) return undefined;
  const leading = /^[\\/]/.test(home) ? SEP : "";
  return { prefix: `${leading}${parts.map(escapeRegExp).join(SEP)}${SEP}`, segment };
}

/**
 * The spellings of the capturing home to redact: the home, its real path, and
 * the profile directory `temp` sits under -- which Windows may spell with an 8.3
 * name -- but only when that resolves to the home itself. A temp directory
 * relocated under another profile (`C:\Users\Public\Temp`) is someone else's
 * path, and redacting it would change evidence.
 */
export function capturingHomes({ home, temp, realpath }) {
  const resolve = (path) => {
    try {
      return realpath(path).toLowerCase();
    } catch {
      return undefined;
    }
  };
  const homes = new Set([home]);
  const real = resolve(home);
  if (real !== undefined) homes.add(realpath(home));
  const profile = /^(.*?[\\/]Users[\\/][^\\/]+)(?=[\\/])/i.exec(temp)?.[1];
  if (profile !== undefined && real !== undefined && resolve(profile) === real) homes.add(profile);
  return [...homes];
}

/**
 * Redact each home path in `text`. Returns the redacted text and the near
 * misses: home-prefixed paths whose profile segment continues past the home's.
 */
export function redactHomes(text, homes) {
  let out = text;
  const nearMisses = [];
  for (const home of homes) {
    const parts = homeParts(home);
    if (!parts || parts.segment.toLowerCase() === "user") continue;
    const flags = isWindowsHome(home) ? "gi" : "g";
    const head = `${START}(${parts.prefix})${escapeRegExp(parts.segment)}`;
    out = out.replace(new RegExp(`${head}${BOUNDARY}`, flags), (_match, prefix) => `${prefix}user`);
    for (const match of out.matchAll(new RegExp(`${head}[^\\\\/"'\\s]+`, flags))) nearMisses.push(match[0]);
  }
  return { text: out, nearMisses };
}

/**
 * Home paths still present in `text`, found independently of `redactHomes`:
 * separators are normalised to `/`, then the home path is searched for as a
 * whole path. Path context only -- an account name in ordinary text (`node`
 * in `node -e`) is not a home path.
 */
export function unredactedHomes(text, homes) {
  const found = [];
  for (const home of homes) {
    const windows = isWindowsHome(home);
    const fold = (value) => (windows ? value.toLowerCase() : value);
    const normalised = fold(text.replace(/[\\/]+/g, "/"));
    const target = fold(home.replace(/[\\/]+/g, "/").replace(/\/$/, ""));
    if (target.split("/").pop() === "user") continue;
    let index = normalised.indexOf(target);
    while (index !== -1) {
      const before = normalised[index - 1];
      const after = normalised[index + target.length];
      const standalone = before === undefined || !/[\w.~-]/.test(before);
      const complete = after === undefined || /[/"'\s]/.test(after);
      if (standalone && complete) found.push(home);
      index = normalised.indexOf(target, index + 1);
    }
  }
  return found;
}
