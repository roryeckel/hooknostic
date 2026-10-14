// The account redaction of .capture/shell-dialects/promote.mjs, run on concrete
// inputs. That directory's README states what it must do, from "The driver
// records the account it ran as"; each case here is one input and the outcome
// that text requires of it or, where it is silent, the outcome the module's own
// comments give. A rule this careful is easy to loosen for one input while
// tightening it for another, so the inputs stay, one test apiece.
import { describe, expect, it } from "vitest";

import { createRedaction } from "../.capture/shell-dialects/redaction.mjs";

/** A promotion that has read one capture's metadata, run by someone whose own account is nowhere in the capture. */
function promotion(metadata, named = "someone-else") {
  const redaction = createRedaction(named);
  redaction.recordCapture(metadata);
  return redaction;
}

/** What a promotion makes of a value: the value redacted, then the record holding it published or refused. */
function outcome(redaction, value) {
  const redacted = redaction.redact(value);
  try {
    return { redacted, published: redaction.published(JSON.stringify(redacted)) };
  } catch (error) {
    return { redacted, refusal: error.message };
  }
}
const published = (value) => ({ redacted: value, published: JSON.stringify(value) });
// A refusal is never a rewrite as well: the value is as it was.
const refused = (value) => ({ redacted: value, refusal: expect.stringMatching(/^An account survived redaction \(/) });

// The two outcomes that are not a rewrite. A string is the exact text the input must become, and be published as.
const LEFT = Symbol("left alone and published");
const REFUSED = Symbol("left alone and refused");
const wanted = (expected) =>
  expected === REFUSED ? "is refused" : expected === LEFT ? "is published as it is" : "becomes " + expected;
function expectOutcome(redaction, text, expected) {
  if (expected === REFUSED) expect(outcome(redaction, text)).toEqual(refused(text));
  else expect(outcome(redaction, text)).toEqual(published(expected === LEFT ? text : expected));
}

// [why the cases exist, [the home a capture records, a text in it, the outcome]]
const recordedHomes = [
  [
    "an ordinary Windows home: alone, going on, in another case, with forward slashes, quoted or doubled inside embedded JSON, in a file URL",
    [
      ["C:\\Users\\name", "C:\\Users\\name", "C:\\Users\\user"],
      ["C:\\Users\\name", "C:\\Users\\name\\AppData", "C:\\Users\\user\\AppData"],
      ["C:\\Users\\name", "c:/users/NAME/x", "c:/users/user/x"],
      ["C:\\Users\\name", '{"cwd":"C:\\\\Users\\\\name\\\\p"}', '{"cwd":"C:\\\\Users\\\\user\\\\p"}'],
      ["C:\\Users\\name", '{"cwd":"C:\\\\Users\\\\name"}', '{"cwd":"C:\\\\Users\\\\user"}'],
      ["C:\\Users\\name", "file:///C:/Users/name/x", "file:///C:/Users/user/x"],
    ],
  ],
  [
    "not this home: a longer name, a dotted sibling, another parent, another drive; a home under another name, or the account as a word, is refused",
    [
      ["C:\\Users\\name", "C:\\Users\\name2\\x", REFUSED],
      ["C:\\Users\\name", "C:\\Users\\name.old\\x", REFUSED],
      ["C:\\Users\\name", "C:\\Other\\name\\x", REFUSED],
      ["C:\\Users\\name", "D:\\Users\\name\\x", REFUSED],
    ],
  ],
  [
    "a home under another root, and one straight under a drive",
    [
      ["D:\\Profiles\\name", "D:\\Profiles\\name", "D:\\Profiles\\user"],
      ["D:\\name", "D:\\name\\x", "D:\\user\\x"],
      ["D:\\name", "D:\\other\\name", REFUSED],
    ],
  ],
  [
    "a sibling whose name only starts like the home's is someone else's folder: never rewritten, and refused wherever the account still reads as a word",
    [
      // A word, to the refusal, runs as far as ASCII letters and digits do: `_` and `é` end it like the rest.
      ...["+", "@", ",", "(", " ", "é", "~", "-", "_", "'", ";", ":"].map((joiner) => [
        "/opt/name",
        "/opt/name" + joiner + "other",
        REFUSED,
      ]),
      // Joined by a letter or a digit it is another word, with no account to read in it.
      ["/opt/name", "/opt/name2other", LEFT],
      ...["+", "@", ",", "(", " ", "é"].map((joiner) => [
        "D:\\Profiles\\name",
        "D:\\Profiles\\name" + joiner + "other\\x",
        REFUSED,
      ]),
      ["C:\\Users\\John", "C:\\Users\\John Smith\\x", REFUSED],
      ["C:\\Users\\John Smith", "C:\\Users\\John Smith\\x", "C:\\Users\\user\\x"],
      ["C:\\Users\\John Smith", "C:\\Users\\John\\x", REFUSED],
    ],
  ],
  [
    "POSIX homes, which are matched with case",
    [
      ["/home/name", "/home/name/.cache", "/home/user/.cache"],
      ["/home/name", "PATH=/usr/bin:/home/name/bin", "PATH=/usr/bin:/home/user/bin"],
      ["/home/name", '{"cwd":"/home/name"}', '{"cwd":"/home/user"}'],
      ["/home/name", "/home/Name/x", REFUSED],
      ["/home/name", "/mnt/home/name/x", REFUSED],
    ],
  ],
  [
    "a real occurrence that is not a whole segment by this rule is left for the refusal",
    [
      ["/home/name", "cd /home/name && ls", REFUSED],
      ["/home/name", "PATH=/home/name:/usr/bin", REFUSED],
      ["/home/name", "file:///home/name/x", REFUSED],
      // Glued to an option's letter, the drive is not where a path begins.
      ["C:\\Users\\name", "-IC:\\Users\\name\\include", REFUSED],
    ],
  ],
  [
    "a URL's host is not the root",
    [
      ["/home/name", "https://home/name", REFUSED],
      ["/home/name", "https://home/name/x", REFUSED],
      ["/opt/name", "https://opt/name/x", REFUSED],
    ],
  ],
  [
    "a single-segment home does not match that segment deeper in a path, or behind a drive",
    [
      ["/root", "/root/.cache", "/user/.cache"],
      ["/root", "/home/root/x", REFUSED],
      ["/root", "C:/root/bin", REFUSED],
      ["/root", "x/root", REFUSED],
      ["/root", "/usr/bin:/root/bin", "/usr/bin:/user/bin"],
      ["/root", "/rootfs/x", LEFT],
    ],
  ],
  [
    "a UNC home in either spelling and any case, and what only resembles it",
    [
      ["\\\\server\\share\\name", "\\\\server\\share\\name\\x", "\\\\server\\share\\user\\x"],
      ["//SERVER/Share/Name", "//server/share/name/x", "//server/share/user/x"],
      ["\\\\server\\share\\name", "C:\\server\\share\\name", REFUSED],
      ["\\\\server\\share\\name", "\\\\other\\server\\share\\name", REFUSED],
    ],
  ],
  [
    "a UNC home is not the host and path of a URL, in either scheme",
    [
      ["\\\\server\\share\\name", "https://server/share/name/x", REFUSED],
      ["\\\\server\\share\\name", "file://server/share/name/x", REFUSED],
    ],
  ],
  [
    "a home that names a drive is redacted inside a URL, which is how a file URL spells it",
    [["C:\\Users\\name", "https://example.com/C:/Users/name/x", "https://example.com/C:/Users/user/x"]],
  ],
  [
    "names with a dot, a space and a regex metacharacter are matched as written",
    [
      ["C:\\Users\\first.last", "C:\\Users\\first.last\\x", "C:\\Users\\user\\x"],
      ["C:\\Users\\first.last", "C:\\Users\\firstXlast\\x", REFUSED],
      ["/home/a+b", "/home/a+b/x", "/home/user/x"],
      ["/home/a+b", "/home/aab/x", REFUSED],
    ],
  ],
  [
    "the account's name inside the folder name a harness derives from a working directory",
    [
      ["/opt/name", "literal --Users-name-file", "literal --Users-user-file"],
      ["C:\\Users\\name", "C--Users-name-AppData-Local-Temp-x", "C--Users-user-AppData-Local-Temp-x"],
    ],
  ],
  [
    "a home folder called User is the placeholder's own word: redacted where it is the home, nothing to hide elsewhere",
    [
      ["/home/User", "/home/User/x", "/home/user/x"],
      ["/home/User", "/other/User/x", LEFT],
      ["C:\\Users\\User", "C:\\Users\\User\\AppData", "C:\\Users\\user\\AppData"],
    ],
  ],
  [
    "any other name left outside its home is refused",
    [
      ["/home/Name", "/other/Name/x", REFUSED],
      ["/home/name", "name@example.com", REFUSED],
    ],
  ],
];

describe("a capture that records its home is redacted by that home exactly", () => {
  for (const [why, cases] of recordedHomes) {
    describe(why, () => {
      for (const [home, text, expected] of cases) {
        it(`home ${home}: ${text} ${wanted(expected)}`, () => {
          // The account recorded beside a home is the one whose home it is: the folder the home ends in.
          expectOutcome(promotion({ account: /[^\\/]+$/.exec(home)[0], home }), text, expected);
        });
      }
    });
  }

  const HOME = "C:\\Users\\name";
  const capture = () => promotion({ account: "name", home: HOME });

  it("redacts the home in values and in keys, throughout a record", () => {
    const record = {
      ends: HOME,
      spelled: "c:/users/NAME/Project",
      listed: [HOME + "\\a", 1, null, true],
      [HOME + "\\project"]: { nested: HOME },
    };
    expect(outcome(capture(), record)).toEqual(
      published({
        ends: "C:\\Users\\user",
        spelled: "c:/users/user/Project",
        listed: ["C:\\Users\\user\\a", 1, null, true],
        "C:\\Users\\user\\project": { nested: "C:\\Users\\user" },
      }),
    );
  });

  it("redacts the home inside embedded JSON, and publishes it with its separators doubled again", () => {
    const embedded = (home) => ({ extra: JSON.stringify({ cwd: home + "\\p", home }) });
    expect(outcome(capture(), embedded(HOME))).toEqual(published(embedded("C:\\Users\\user")));
  });

  it("refuses a record in which redaction made two keys the same", () => {
    expect(() => capture().redact({ [HOME + "\\p"]: 1, "C:\\Users\\user\\p": 2 })).toThrow(
      "Two keys became the same key after redaction",
    );
  });

  for (const [what, text] of [
    ["a sibling folder that starts like the home", HOME + "+other\\x"],
    // The rule for a capture with no home would rewrite this one: another folder of the same name.
    ["the account's name under another parent", "D:\\backup\\name\\x"],
    ["the account's name in a URL", "https://users/name/x"],
    ["the account named in text that is not a path", "owner: name"],
  ]) {
    it(`leaves ${what} alone and refuses the record`, () => {
      expect(outcome(capture(), { extra: text })).toEqual(refused({ extra: text }));
    });
  }

  it("refuses an account named like a program instead of rewriting that program's path", () => {
    const interpreter = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const { redacted, refusal } = outcome(
      promotion({ account: "powershell", home: "C:\\Users\\powershell" }),
      interpreter,
    );
    expect(redacted).toBe(interpreter);
    // The message quotes what was matched.
    expect(refusal).toMatch(/^An account survived redaction \(powershell\)/);
  });
});

describe("a capture that records no usable home is redacted by account", () => {
  it("redacts the account between path separators, in whichever folder has that name", () => {
    const redaction = promotion({ account: "name" });
    expect(outcome(redaction, "C:\\Users\\name\\AppData")).toEqual(published("C:\\Users\\user\\AppData"));
    expect(outcome(redaction, "/home/name/project")).toEqual(published("/home/user/project"));
    // It cannot tell the account's folder from another folder of the same name.
    expect(outcome(redaction, "D:\\backup\\name\\x")).toEqual(published("D:\\backup\\user\\x"));
  });

  it("redacts the account the promotion was told of, for a capture that records none", () => {
    expect(outcome(promotion({}, "hkncapture"), "/home/hkncapture/project")).toEqual(published("/home/user/project"));
  });

  // A home directory under any name but `user` is refused, which is what stops an account nobody named.
  for (const [text, expected] of [
    ["C:\\Users\\name\\AppData", REFUSED],
    ["c:/users/Name/x", REFUSED],
    ["/home/name/project", REFUSED],
    ["/Users/name", REFUSED],
    ["C:\\Users\\username\\x", REFUSED],
    // Embedded JSON, where the separators double again once the record is written.
    [JSON.stringify({ cwd: "C:\\Users\\name\\p" }), REFUSED],
    ["C:\\Users\\user\\AppData", LEFT],
    ["/home/user/project", LEFT],
    ["/Users/user", LEFT],
    ["/usr/bin/bash", LEFT],
  ]) {
    it(`with no account recorded or named: ${text} ${wanted(expected)}`, () => {
      expectOutcome(promotion({}), text, expected);
    });
  }

  for (const [what, account, text] of [
    ["ending a path", "name", "D:\\Profiles\\name"],
    ["starting a relative path", "name", "name/project"],
    ["as a bare value, in another case", "Name", "name"],
  ]) {
    it(`leaves the account ${what} alone and refuses the record`, () => {
      expect(outcome(promotion({ account }), { extra: text })).toEqual(refused({ extra: text }));
    });
  }

  it("does not take a drive for a home", () => {
    const redaction = promotion({ account: "name", home: "C:\\" });
    expect(outcome(redaction, "C:\\Users\\name\\AppData")).toEqual(published("C:\\Users\\user\\AppData"));
    expect(outcome(redaction, "C:\\Windows\\System32\\cmd.exe")).toEqual(published("C:\\Windows\\System32\\cmd.exe"));
  });

  it("does not take the root for a home", () => {
    const redaction = promotion({ account: "name", home: "/" });
    expect(outcome(redaction, "C:\\Users\\name\\AppData")).toEqual(published("C:\\Users\\user\\AppData"));
    expect(outcome(redaction, "/usr/bin/bash")).toEqual(published("/usr/bin/bash"));
  });

  it("does not take a path that is not absolute for a home", () => {
    const redaction = promotion({ account: "name", home: "profiles\\name" });
    // Redacted between separators under any parent, which only a capture with no home is.
    expect(outcome(redaction, "D:\\backup\\name\\x")).toEqual(published("D:\\backup\\user\\x"));
  });
});

describe("what a promotion reads from metadata", () => {
  it("refuses a home recorded without an account", () => {
    expect(() => promotion({ home: "C:\\Users\\name" })).toThrow(
      "The capture's metadata records a home without an account",
    );
  });

  it("knows the folder a home ends in as an account, beside a login name that differs", () => {
    const capture = () => promotion({ account: "login", home: "C:\\Users\\Folder" });
    expect(outcome(capture(), "C--Users-Folder-AppData")).toEqual(published("C--Users-user-AppData"));
    for (const text of ["D:\\backup\\Folder\\x", "owner: login"]) {
      expect(outcome(capture(), text), text).toEqual(refused(text));
    }
  });

  it("redacts every account of the captures it reads, each by its own rule", () => {
    const redaction = createRedaction("someone-else");
    redaction.recordCapture({ account: "first", home: "/home/first" });
    redaction.recordCapture({ account: "second" });
    expect(outcome(redaction, "/home/first/x:/srv/second/y")).toEqual(published("/home/user/x:/srv/user/y"));
    // Only the capture with no home of its own is redacted between separators.
    expect(outcome(redaction, "/srv/first/y")).toEqual(refused("/srv/first/y"));
  });
});
