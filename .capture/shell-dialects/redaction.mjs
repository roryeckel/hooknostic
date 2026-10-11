// The account redaction promote.mjs applies to what it read from raw captures,
// and the check that refuses a record an account can still be read in. What both
// must do is stated in the README, from "The driver records the account it ran
// as". They live apart from promote.mjs, which reads captures and writes records
// as soon as it is loaded, so that scripts/shell-dialects-redaction.test.mjs can
// run them on concrete inputs. A change here is checked there.
//
// One promotion's redaction, for the account it was told to redact. Each
// capture's metadata goes to recordCapture() as it is read; redact() then
// rewrites a value, and published() returns the text it is given or refuses it.
export function createRedaction(account) {
  // The named account, and every account a capture's own metadata records it ran as.
  // None of them may remain in the published text.
  const accounts = new Set([account]);
  // The accounts redacted between path separators wherever they appear: the named
  // one, and a capture's own when it records no home to redact exactly. This rule
  // cannot tell an account's folder from another folder of the same name, so it is
  // kept only for the captures that give nothing better to go on.
  const between = new Set([account]);
  // The home directory a capture's metadata records, which is redacted exactly: its
  // last segment, wherever that path begins a path and whether or not anything follows.
  const homes = new Set();
  const literal = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only an absolute path that ends in a name is taken for a home. Anything else
  // could match text that is not a path, and a drive or the root has no last
  // segment to stand for an account: it would match every path beneath it.
  function recordHome(home) {
    if (typeof home !== "string" || !/^(?:[A-Za-z]:)?[\\/]/.test(home)) return false;
    const name = home.split(/[\\/]+/).filter(Boolean).at(-1);
    if (name === undefined || /^[A-Za-z]:$/.test(name)) return false;
    homes.add(home);
    // Its last segment is the account as the file system spells it, which need not be the login name.
    accounts.add(name);
    return true;
  }
  // The account and home a capture's metadata records. The driver writes a home only beside its account.
  function recordCapture(metadata) {
    if (typeof metadata.account === "string") accounts.add(metadata.account);
    else if (metadata.home !== undefined) throw new Error("The capture's metadata records a home without an account");
    if (!recordHome(metadata.home) && typeof metadata.account === "string") between.add(metadata.account);
  }
  function homePattern(home) {
    const segments = home.split(/[\\/]+/).filter(Boolean);
    const drive = /^[A-Za-z]:/.test(home);
    const unc = /^[\\/]{2}/.test(home);
    // A home that names no drive opens with its own separator: one for a rooted
    // path, two or more for a UNC one. The `//` of a URL is then not the root.
    const opens = drive ? "" : unc ? "[\\\\/]{2,}" : "[\\\\/]";
    const above = opens + segments.slice(0, -1).map((segment) => literal(segment) + "[\\\\/]+").join("");
    // The match begins where a path can begin: not partway through a longer path or
    // name, and for a home that names no drive, not behind a drive letter either.
    // A UNC opening behind any colon is a URL's `//`, or a drive's.
    const begins = drive ? "(?<![A-Za-z0-9])" : "(?<![A-Za-z0-9._~\\\\/-])" + (unc ? "(?<!:)" : "(?<!(?:^|[^A-Za-z0-9])[A-Za-z]:)");
    // It ends as a whole segment: at a separator, a closing quote, or the end. Any
    // other character can continue a folder's name, and a sibling such as `name+x`
    // is someone else's. What is left unmatched, published() refuses.
    const ends = '(?=[\\\\/"]|$)';
    // Windows compares paths without case; a drive letter, a UNC opening or a backslash marks one.
    return new RegExp("(" + begins + above + ")" + literal(segments.at(-1)) + ends, drive || unc || home.includes("\\") ? "gi" : "g");
  }
  function redact(value) {
    if (typeof value === "string") {
      const text = [...homes].reduce((path, home) => path.replace(homePattern(home), "$1user"), value);
      // The transcript folder a harness names after the working directory, for every account.
      const slugged = [...accounts].reduce((path, name) => path
        .replace(new RegExp("--users-" + literal(name) + "-", "gi"), (slug) => slug.slice(0, "--users-".length) + "user-"), text);
      // Without a recorded home, the account between separators. A path that only
      // ends at it is left alone, because an account can share its name with a
      // program, and published() then refuses what remains.
      return [...between].reduce((path, name) => path
        .replace(new RegExp("\\\\" + literal(name) + "\\\\", "gi"), "\\user\\")
        .replaceAll("/" + name + "/", "/user/"), slugged);
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") {
      // Keys as well: a harness can key a map by path. Two keys that redaction
      // made one would drop an entry without a word, so that is refused.
      const entries = Object.entries(value).map(([key, child]) => [redact(key), redact(child)]);
      if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("Two keys became the same key after redaction");
      return Object.fromEntries(entries);
    }
    return value;
  }
  // The promoted text, refused if an account can still be read in it: a home
  // directory under any name but `user`, which catches a capture made as an account
  // nobody named, or a known account left anywhere as a word of its own. As in
  // promote-fixtures.mjs, a home's segment ends at a separator or the closing
  // quote. Refusing is the safe direction: an account that shares its name with a
  // program the capture ran cannot be promoted, and is told so, instead of having
  // that program's path rewritten. The message quotes what was matched.
  function published(text) {
    // One separator or a run of them, taken whole: backslashes double again each time
    // a path sits inside a string inside a string.
    const separator = "(?:\\/|\\\\\\\\)+(?![\\/\\\\])";
    const other = '(?!user(?:[\\/\\\\"]|$))';
    const segment = '[^\\/\\\\"]*';
    const left = new RegExp("\\/home\\/" + other + segment).exec(text)
      ?? new RegExp(separator + "Users" + separator + other + segment, "i").exec(text)
      ?? [...accounts].filter((name) => name.toLowerCase() !== "user")
        .map((name) => new RegExp("(?<![A-Za-z0-9])" + literal(name) + "(?![A-Za-z0-9])", "i").exec(text)).find(Boolean);
    if (left) throw new Error("An account survived redaction (" + left[0] + "); name the capture's account in HKN_CAPTURE_ACCOUNT, or capture as an account whose name nothing else in the record shares");
    return text;
  }
  return { recordCapture, redact, published };
}
