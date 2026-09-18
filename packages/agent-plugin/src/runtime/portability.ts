/** One file in a materialized runtime tree that cannot be committed. */
export interface PortabilityProblem {
  path: string;
  /** What was found, in terms an author can act on. */
  reason: string;
}

/**
 * Extensions that only ever name a compiled object for one platform.
 *
 * `.node` is here for the same reason as `.so`: an npm native addon is built
 * against one platform, arch and ABI, and is the npm-side twin of a non-`any`
 * wheel. Versioned suffixes (`libfoo.so.1.2`) are matched separately, since the
 * extension is not the last segment.
 */
const NATIVE_EXTENSIONS = new Set([".so", ".dylib", ".dll", ".pyd", ".node", ".exe", ".a", ".lib", ".obj", ".o"]);

const VERSIONED_SHARED_OBJECT = /\.so(\.\d+)+$/;

/** Java's class-file magic collides with Mach-O's fat magic, and is portable. */
const JVM_EXTENSIONS = new Set([".class", ".jar"]);

/** Metadata retained by every installed wheel. */
const WHEEL_METADATA_PATH = /(?:^|\/)[^/]+\.dist-info\/WHEEL$/i;

/**
 * Why installed wheel metadata does not prove an ABI- and platform-neutral
 * distribution, or `undefined` when every declared tag does.
 *
 * Native-object scanning remains necessary because installers generate files
 * that wheel tags do not describe. The reverse is necessary too: a wheel may
 * be platform-tagged while carrying only Python or data files, whose bytes do
 * not reveal that the installer selected a platform-specific distribution.
 */
function wheelMetadataProblem(contents: Buffer): string | undefined {
  const tags: string[] = [];
  for (const line of contents.toString("utf8").split(/\r?\n/)) {
    const match = /^Tag:\s*(\S+)\s*$/i.exec(line);
    if (match !== null) tags.push(match[1]!);
  }
  if (tags.length === 0) return "wheel metadata declares no Tag records";
  for (const tag of tags) {
    const parts = tag.split("-");
    if (parts.length !== 3 || parts.some((part) => part.length === 0 || !/^[A-Za-z0-9_.]+$/.test(part))) {
      return `wheel metadata declares malformed tag ${JSON.stringify(tag)}`;
    }
    const [, abi, platform] = parts;
    if (abi !== "none" || platform !== "any") {
      return `wheel tag ${JSON.stringify(tag)} is not ABI- and platform-neutral (expected *-none-any)`;
    }
  }
  return undefined;
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * The executable format a file's leading bytes declare, if any.
 *
 * Read rather than inferred, because an extension is a convention and the bytes
 * are the fact: a wheel can ship an extension module with no suffix at all, and
 * a `.py` that is secretly an ELF is a defect worth catching either way.
 */
export function nativeObjectFormat(contents: Buffer, path = ""): string | undefined {
  if (contents.length >= 4) {
    // 0x7F 'E' 'L' 'F'
    if (contents[0] === 0x7f && contents[1] === 0x45 && contents[2] === 0x4c && contents[3] === 0x46) {
      return "an ELF object";
    }
    const magic = contents.readUInt32BE(0);
    // Thin Mach-O, both byte orders and both widths.
    if (magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xcffaedfe) {
      return "a Mach-O object";
    }
    // Universal ("fat") Mach-O shares 0xCAFEBABE with the JVM class format, so
    // the two are told apart by extension rather than by guessing.
    const fat = magic === 0xcafebabe || magic === 0xbebafeca || magic === 0xcafebabf || magic === 0xbfbafeca;
    if (fat && !JVM_EXTENSIONS.has(extensionOf(path))) return "a universal Mach-O object";
  }
  // MZ alone is not enough -- it is two printable characters. A real PE names
  // its header offset at 0x3C and puts "PE\0\0" there, so both are required.
  if (contents.length >= 0x40 && contents[0] === 0x4d && contents[1] === 0x5a) {
    const offset = contents.readUInt32LE(0x3c);
    if (
      offset + 4 <= contents.length &&
      contents[offset] === 0x50 &&
      contents[offset + 1] === 0x45 &&
      contents[offset + 2] === 0x00 &&
      contents[offset + 3] === 0x00
    ) {
      return "a Windows PE object";
    }
  }
  return undefined;
}

/**
 * Whether a materialized runtime tree is safe to commit.
 *
 * This is the rule that makes build-time materialization language-neutral. A
 * Hooknostic artifact is built once and committed (ADR-0006), then installed on
 * whatever machine a consumer has -- so a materialized tree is only admissible
 * when its bytes mean the same thing everywhere. Pure JavaScript does; a
 * `py3-none-any` wheel does; framework-dependent .NET IL does. A native addon,
 * a non-`any` wheel, a `cargo build` output and a self-contained .NET publish
 * do not, and no amount of care at build time makes them.
 *
 * It is checked rather than trusted, and checked over the produced bytes rather
 * than the ecosystem's promises, so it holds for ecosystems nobody has written a
 * provider for yet. That is why Rust and Go are not special cases here: their
 * output IS a native object, so they fail this for the same reason a native
 * wheel does, and the answer for them is a prebuilt binary the author supplies
 * per platform or a runner command -- not a build hooknostic performs.
 */
export function verifyPortableTree(files: readonly { path: string; contents: Buffer }[]): PortabilityProblem[] {
  const problems: PortabilityProblem[] = [];
  for (const file of files) {
    if (WHEEL_METADATA_PATH.test(file.path)) {
      const reason = wheelMetadataProblem(file.contents);
      if (reason !== undefined) problems.push({ path: file.path, reason });
      continue;
    }
    const extension = extensionOf(file.path);
    if (NATIVE_EXTENSIONS.has(extension) || VERSIONED_SHARED_OBJECT.test(file.path.toLowerCase())) {
      problems.push({ path: file.path, reason: `${extension || "a shared object"} is built for one platform` });
      continue;
    }
    const format = nativeObjectFormat(file.contents, file.path);
    if (format !== undefined) problems.push({ path: file.path, reason: `${format}, which is built for one platform` });
  }
  return problems;
}
