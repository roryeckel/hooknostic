/**
 * Structural view of a schema validation issue: what the SDK's Zod 4 schemas
 * report, without core importing Zod. `issues` holds the nested explanation
 * behind a record key (or map element) that failed its own schema.
 */
export interface SchemaIssue {
  readonly code?: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly issues?: readonly SchemaIssue[];
}

/** Dotted issue path; symbol keys render as `Symbol(description)`, never throw. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.map(String).join(".") || "<root>";
}

/**
 * The message worth showing for one issue. Zod 4 reports a record key that
 * fails its key schema as a generic "Invalid key in record" and keeps the
 * explanation -- the accepted capability ids, a minimum length -- nested, so
 * surface the nested messages instead.
 */
export function formatIssueMessage(issue: SchemaIssue): string {
  if ((issue.code === "invalid_key" || issue.code === "invalid_element") && issue.issues?.length) {
    return issue.issues.map(formatIssueMessage).join("; ");
  }
  return issue.message;
}

/** `path: message` for one issue. */
export function formatSchemaIssue(issue: SchemaIssue): string {
  return `${formatIssuePath(issue.path)}: ${formatIssueMessage(issue)}`;
}
