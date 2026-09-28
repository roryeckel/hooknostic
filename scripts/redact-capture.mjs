// Home-directory redaction for capture records (harness-capture skill):
// replace only the account segment of the capturing machine's own home path
// with `user`. Drive letter, separators, escaping, and every other byte of the
// record stay as captured -- path shape is evidence, and so is everything that
// merely looks like a path. Matching `Users/<anything>` instead would rewrite
// non-home text and could swallow code after a quoted path.

/** Characters that can continue a path segment or a name. */
const NAME_CHAR = "[\\w.~-]";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The spellings a home path takes in a JSON record: raw, JSON-escaped once,
 * JSON-escaped twice (a path inside JavaScript source inside JSON), and with
 * forward slashes.
 */
export function homeSpellings(home) {
  return [
    ...new Set([home, home.replaceAll("\\", "\\\\"), home.replaceAll("\\", "\\\\\\\\"), home.replaceAll("\\", "/")]),
  ];
}

/**
 * Replace the account segment of each home path in `text` with `user`. A match
 * must end where the path segment ends, so `C:\Users\jo` never rewrites
 * `C:\Users\jonas`. Case-insensitive because Windows paths are; the matched
 * text keeps its own spelling up to the replaced segment.
 */
export function redactHomes(text, homes) {
  let out = text;
  for (const home of homes) {
    const segment = home.split(/[\\/]/).pop();
    if (!segment || segment.toLowerCase() === "user") continue;
    for (const form of homeSpellings(home)) {
      const kept = form.length - segment.length;
      const pattern = new RegExp(`${escapeRegExp(form)}(?!${NAME_CHAR})`, "gi");
      out = out.replace(pattern, (match) => `${match.slice(0, kept)}user`);
    }
  }
  return out;
}

/**
 * The names that still appear in `text` as whole words, in or out of a path.
 * Whole words only, so a name that is part of ordinary record text (`cod` in
 * `codexVersion`) does not reject a clean record. Single characters are
 * skipped: they would match a drive letter.
 */
export function leakedNames(text, names) {
  return [...new Set(names)]
    .filter((name) => name.length >= 2 && name.toLowerCase() !== "user")
    .filter((name) => new RegExp(`(?<!${NAME_CHAR})${escapeRegExp(name)}(?!${NAME_CHAR})`, "i").test(text));
}
