/** One produced file that cannot be committed into a build-once artifact. */
export interface PortabilityProblem {
  path: string;
  reason: string;
}

/** The native executable format declared by a file's bytes, if unambiguous. */
export function nativeObjectFormat(contents: Uint8Array): string | undefined {
  const bytes = Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength);
  if (bytes.length >= 4) {
    if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
      return "an ELF object";
    }
    const magic = bytes.readUInt32BE(0);
    if (magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xcffaedfe) {
      return "a Mach-O object";
    }
    // Universal Mach-O shares its leading magic with other formats. Recognize
    // it only when its architecture table is structurally present and points
    // inside this file; an ambiguous prefix is not evidence of native code.
    if (magic === 0xcafebabe || magic === 0xbebafeca) {
      const littleEndian = magic === 0xbebafeca;
      const architectures = littleEndian ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4);
      const headerSize = 8 + architectures * 20;
      if (architectures > 0 && architectures <= 64 && headerSize <= bytes.length) {
        let valid = true;
        for (let index = 0; index < architectures; index += 1) {
          const offsetAt = 8 + index * 20 + 8;
          const sizeAt = offsetAt + 4;
          const offset = littleEndian ? bytes.readUInt32LE(offsetAt) : bytes.readUInt32BE(offsetAt);
          const size = littleEndian ? bytes.readUInt32LE(sizeAt) : bytes.readUInt32BE(sizeAt);
          if (size === 0 || offset < headerSize || offset + size > bytes.length) valid = false;
        }
        if (valid) return "a universal Mach-O object";
      }
    }
  }
  if (bytes.length >= 0x40 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const offset = bytes.readUInt32LE(0x3c);
    if (
      offset + 4 <= bytes.length &&
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x45 &&
      bytes[offset + 2] === 0x00 &&
      bytes[offset + 3] === 0x00
    ) {
      return "a Windows PE object";
    }
  }
  return undefined;
}

/** Screen provider output for actual native executable bytes; ecosystem metadata remains provider-owned. */
export function verifyPortableTree(files: readonly { path: string; contents: Uint8Array }[]): PortabilityProblem[] {
  return files.flatMap((file) => {
    const format = nativeObjectFormat(file.contents);
    return format === undefined ? [] : [{ path: file.path, reason: `${format}, which is built for one platform` }];
  });
}
