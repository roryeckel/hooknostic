/** The registrations a generated hooknostic-mcp.js embeds as a JSON string literal. */
export const registrations = (module: string): unknown => {
  const literal = /const registrations = JSON\.parse\(("(?:[^"\\]|\\.)*")\);/.exec(module)?.[1];
  if (literal === undefined) throw new Error("generated MCP extension embeds no registrations literal");
  return JSON.parse(JSON.parse(literal) as string);
};
