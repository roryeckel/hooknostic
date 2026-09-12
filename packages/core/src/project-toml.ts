import { parseForESLint, getStaticTOMLValue, traverseNodes, type AST } from "toml-eslint-parser";

function ast(text: string): AST.TOMLProgram {
  return parseForESLint(text, { tomlVersion: "1.0" }).ast;
}
type Table = Record<string, unknown>;
const table = (): Table => ({});
function own(target: Table, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}
function tableAt(root: Table, path: readonly (string | number)[]): Table {
  let current: Table | unknown[] = root;
  for (let index = 0; index < path.length; index++) {
    const part = path[index]!;
    const nextPart = path[index + 1];
    let next: unknown;
    if (typeof part === "number") {
      if (!Array.isArray(current)) throw new Error("invalid TOML array-table path");
      next = current[part];
      if (next === undefined) { next = table(); current[part] = next; }
    } else {
      if (Array.isArray(current)) throw new Error("invalid TOML table path");
      next = Object.hasOwn(current, part) ? current[part] : undefined;
      if (next === undefined) { next = typeof nextPart === "number" ? [] : table(); own(current, part, next); }
    }
    if (next === null || typeof next !== "object") throw new Error("invalid TOML table path");
    current = next as Table | unknown[];
  }
  if (Array.isArray(current)) throw new Error("invalid TOML table path");
  return current;
}
function assign(root: Table, path: readonly (string | number)[], value: unknown): void {
  const parent = tableAt(root, path.slice(0, -1));
  own(parent, String(path.at(-1)), value);
}
function content(node: AST.TOMLContentNode): unknown {
  if (node.type === "TOMLValue") return node.value;
  if (node.type === "TOMLArray") return node.elements.map(content);
  const value = table();
  for (const entry of node.body) assign(value, getStaticTOMLValue(entry.key), content(entry.value));
  return value;
}
export function readProjectToml(text: string): Record<string, unknown> {
  const root = table();
  for (const node of ast(text).body[0].body) {
    if (node.type === "TOMLKeyValue") {
      assign(root, getStaticTOMLValue(node.key), content(node.value));
      continue;
    }
    const destination = tableAt(root, node.resolvedKey);
    for (const entry of node.body) assign(destination, getStaticTOMLValue(entry.key), content(entry.value));
  }
  return root;
}
function literal(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return String(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (value !== null && typeof value === "object") return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${literal(item)}`).join(", ")} }`;
  throw new Error("unsupported TOML generated value");
}
const prefix = (parent: readonly (string | number)[], child: readonly (string | number)[]) => parent.length <= child.length && parent.every((part, i) => child[i] === part);

/** Edit only owned syntax ranges; untouched settings and comments keep their bytes. */
export function editProjectToml(text: string, key: string[], value: unknown): string {
  const tree = ast(text);
  const removals: [number, number][] = [];
  let exact: AST.TOMLKeyValue | undefined;
  let container: { node: AST.TOMLInlineTable | AST.TOMLTable | AST.TOMLTopLevelTable; path: (string | number)[] } = { node: tree.body[0], path: [] };
  const visit = (node: AST.TOMLKeyValue, base: (string | number)[]) => {
    const path = [...base, ...getStaticTOMLValue(node.key)];
    if (prefix(key, path)) {
      if (key.length === path.length) exact = node;
      removals.push(node.range);
      return;
    }
    if (prefix(path, key) && node.value.type === "TOMLInlineTable") {
      if (path.length > container.path.length) container = { node: node.value, path };
      for (const entry of node.value.body) visit(entry, path);
    }
  };
  for (const node of tree.body[0].body) {
    if (node.type === "TOMLKeyValue") visit(node, []);
    else {
      if (prefix(key, node.resolvedKey)) {
        if (node.kind === "array") throw new Error("array-table ownership is unsupported");
        const close = tree.tokens.find(token => token.range[0] >= node.key.range[1] && token.value === "]");
        if (!close) throw new Error("missing TOML table delimiter");
        removals.push([node.range[0], close.range[1]]);
        for (const entry of node.body) removals.push(entry.range);
      } else {
        if (prefix(node.resolvedKey, key) && node.resolvedKey.length > container.path.length) container = { node, path: node.resolvedKey };
        for (const entry of node.body) visit(entry, node.resolvedKey);
      }
    }
  }
  if (exact && value !== undefined) return text.slice(0, exact.value.range[0]) + literal(value) + text.slice(exact.value.range[1]);
  // Remove commas adjoining deleted inline entries, retaining one separator
  // between surviving entries even when several dotted keys form one server.
  traverseNodes(tree, { enterNode(node) {
    if (node.type !== "TOMLInlineTable") return;
    const deleted = (entry: AST.TOMLKeyValue) => removals.some(([start, end]) => start <= entry.range[0] && end >= entry.range[1]);
    let previousSurvivor = false;
    for (let i = 0; i < node.body.length; i++) {
      const entry = node.body[i]!;
      if (i > 0) {
        const prior = node.body[i - 1]!;
        const comma = tree.tokens.find(token => token.value === "," && token.range[0] >= prior.range[1] && token.range[1] <= entry.range[0]);
        if (comma && (deleted(entry) || !previousSurvivor)) removals.push(comma.range);
      }
      if (!deleted(entry)) previousSurvivor = true;
    }
  }, leaveNode() {} });
  const edits: { start: number; end: number; value: string }[] = removals.map(([start, end]) => ({ start, end, value: "" }));
  if (value !== undefined) {
    const assignment = `${key.slice(container.path.length).map(part => JSON.stringify(part)).join(".")} = ${literal(value)}`;
    if (container.node.type === "TOMLInlineTable") {
      const position = container.node.range[1] - 1;
      const survivors = container.node.body.filter(node => !removals.some(([start, end]) => start <= node.range[0] && end >= node.range[1]));
      edits.push({ start: position, end: position, value: `${survivors.length ? ", " : " "}${assignment} ` });
    } else {
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      const lineEnd = text.indexOf("\n", container.node.range[1]);
      const position = container.node.type === "TOMLTable" ? (lineEnd === -1 ? text.length : lineEnd + 1) : 0;
      edits.push({ start: position, end: position, value: `${eol}${assignment}${eol}` });
    }
  }
  // Overlapping removals can occur inside a deleted inline value.
  const merged = edits.sort((a, b) => a.start - b.start || b.end - a.end).filter((edit, i, all) => !(edit.end > edit.start && all.slice(0, i).some(prior => prior.start <= edit.start && prior.end >= edit.end && prior.end > prior.start)));
  for (const edit of merged.sort((a, b) => b.start - a.start || b.end - a.end)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  ast(text);
  return text;
}
