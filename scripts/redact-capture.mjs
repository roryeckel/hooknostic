// Home-directory redaction for capture records (harness-capture skill):
// replace only the account segment of the capturing machine's own home path
// with `user`. Drive letter, separators, escaping, and every other byte of the
// record stay as captured -- path shape is evidence.
//
// The home path is matched by STRUCTURE, not from a list of spellings: each
// separator matches any run of `\` and `/`, which covers every JSON escape
// depth and mixed separators alike. Case is ignored only for a Windows-style
// home. A match must stand alone (not inside a longer path such as
// `docs/home/jo`) and end where the segment unambiguously ends: a separator, a
// double quote (an escaped one starts with a separator), or the end of the
// text. Anything else after the profile name -- `jonas`, `jo@corp`, `jo smith`,
// `jo's`, `jo,` -- is a near miss: left untouched and reported, so the caller
// refuses to write. Ambiguity costs a manual look, never a rewrite.

const SEP = "[\\\\/]+";
/** What may follow a profile segment that is certainly complete. */
const BOUNDARY = `(?=${SEP}|"|$)`;
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
 * path, and redacting it would change evidence. Real paths are compared
 * case-insensitively only for a Windows home: `/Users/Alice` and
 * `/Users/alice` can be different directories on a case-sensitive filesystem.
 */
export function capturingHomes({ home, temp, realpath }) {
  const fold = (value) => (isWindowsHome(home) ? value.toLowerCase() : value);
  const resolve = (path) => {
    try {
      return realpath(path);
    } catch {
      return undefined;
    }
  };
  const homes = new Set([home]);
  const real = resolve(home);
  if (real !== undefined) homes.add(real);
  const profile = /^(.*?[\\/]Users[\\/][^\\/]+)(?=[\\/])/i.exec(temp)?.[1];
  const resolved = profile === undefined ? undefined : resolve(profile);
  if (profile !== undefined && real !== undefined && resolved !== undefined && fold(resolved) === fold(real)) {
    homes.add(profile);
  }
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
    for (const match of out.matchAll(new RegExp(`${head}[^\\\\/"]+`, flags))) {
      // A profile named like a prefix of `user` (`us`) "continues" into the
      // redacted segment itself; that is the redaction, not a near miss.
      if (
        match[0]
          .split(/[\\/]+/)
          .pop()
          ?.toLowerCase() === "user"
      )
        continue;
      nearMisses.push(match[0]);
    }
  }
  return { text: out, nearMisses };
}

/**
 * Home paths still present in `text`, found independently of `redactHomes` and
 * more strictly: separators are normalised to `/`, then every occurrence of the
 * home path counts, whatever precedes or follows it -- an option value glued to
 * the path (`-oC:/Users/jo`) that redaction skips is caught here, and so is
 * anything redaction reported as a near miss. The backstop errs toward
 * refusing. Path context only: an account name in ordinary text (`node` in
 * `node -e`) is not a home path.
 */
export function unredactedHomes(text, homes) {
  const found = [];
  for (const home of homes) {
    const windows = isWindowsHome(home);
    const fold = (value) => (windows ? value.toLowerCase() : value);
    const normalised = fold(text.replace(/[\\/]+/g, "/"));
    const target = fold(home.replace(/[\\/]+/g, "/").replace(/\/$/, ""));
    if (target.split("/").pop() === "user") continue;
    const parent = target.slice(0, target.lastIndexOf("/") + 1);
    for (let index = normalised.indexOf(target); index !== -1; index = normalised.indexOf(target, index + 1)) {
      // A profile named like a prefix of `user` (`us`) also matches the
      // redacted segment itself; that occurrence is the redaction, not a leak.
      if (/^user(?:[/"]|$)/i.test(normalised.slice(index + parent.length))) continue;
      found.push(home);
    }
  }
  return found;
}
