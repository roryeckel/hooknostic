import { minVersion } from "semver";
import { isMap, parseDocument } from "yaml";

import type {
  AgentPluginComponentSupport,
  AgentPluginDegradation,
  AgentPluginFile,
  AgentPluginIssue,
  AgentPluginPackage,
  AgentPluginProjectionProfile,
  AgentPluginProjector,
  AgentPluginSkill,
  SkillPolicy,
} from "./types.js";

export const SKILL_INVOCATION_POLICY = "agent-plugin.skills.invocation-policy" as const;
export const SKILL_IMPLICIT_INVOCATION_UNENFORCED = "skill-implicit-invocation-unenforced";
export const SKILL_POLICY_IN_PLACE = "skill-policy-in-place";
export const SKILL_POLICY_EVIDENCE = ".capture/skill-invocation";

export const SKILL_POLICY_DEGRADATIONS = [
  {
    id: SKILL_IMPLICIT_INVOCATION_UNENFORCED,
    summary:
      "The declared implicit-invocation policy cannot be applied; the skill is emitted only by explicit acceptance.",
    evidence: SKILL_POLICY_EVIDENCE,
  },
  {
    id: SKILL_POLICY_IN_PLACE,
    summary: "A skill discovered in place is authored input, so Hooknostic cannot own or verify its invocation policy.",
    evidence: SKILL_POLICY_EVIDENCE,
  },
] as const;

export type SkillPolicyValidation = AgentPluginProjectionProfile["source"]["validatedOn"][number];

/** Decline uncaptured older builds, retaining every pre-existing component claim. */
export function skillInvocationPolicyProfiles(
  profiles: readonly AgentPluginProjectionProfile[],
  validation: SkillPolicyValidation,
  rationale: string,
  level: "exact" | "emulated" = "exact",
  additionalValidations: readonly SkillPolicyValidation[] = [],
): AgentPluginProjectionProfile[] {
  return profiles.flatMap((profile) =>
    [false, true].flatMap((supported) => {
      const range = profile.range
        .split("||")
        .map((clause) => `${clause.trim()} ${supported ? ">=" : "<"}${validation.version}`)
        .join(" || ");
      if (minVersion(range) === null) return [];
      const available = supported && profile.components["agent-plugin.skills"]?.level !== "unsupported";
      return [
        {
          ...profile,
          range,
          components: {
            ...profile.components,
            [SKILL_INVOCATION_POLICY]: {
              level: available ? level : "unsupported",
              rationale: available
                ? rationale
                : "No faithful invocation-policy route has been captured for this delivery and version range.",
              degradations: SKILL_POLICY_DEGRADATIONS,
            },
          },
          source: {
            ...profile.source,
            validatedOn: [...profile.source.validatedOn, validation, ...additionalValidations],
          },
        },
      ];
    }),
  );
}

export interface SkillPolicySelection<T> {
  skills: T[];
  issues: AgentPluginIssue[];
  omissions: { component: typeof SKILL_INVOCATION_POLICY; name: string; reason: string }[];
  degradations: AgentPluginDegradation[];
  /** Names whose declared policy will actually be projected. */
  applied: Set<string>;
}

/** A missing gate is omitted unless its exact shortfall is explicitly accepted (ADR-0030). */
export function selectSkillPolicies<T extends { name: string; policy?: SkillPolicy }>(
  skills: readonly T[],
  options: {
    adapter: string;
    support?: AgentPluginComponentSupport;
    onUnsupported: "error" | "warn";
    accept?: readonly string[];
    inPlace?: ReadonlySet<string>;
  },
): SkillPolicySelection<T> {
  const result: SkillPolicySelection<T> = {
    skills: [],
    issues: [],
    omissions: [],
    degradations: [],
    applied: new Set(),
  };
  for (const skill of skills) {
    if (skill.policy?.allowImplicitInvocation === undefined) {
      result.skills.push(skill);
      continue;
    }
    const inPlace = options.inPlace?.has(skill.name) === true;
    const supported = options.support?.level === "exact" || options.support?.level === "emulated";
    if (supported && !inPlace) {
      result.skills.push(skill);
      result.applied.add(skill.name);
      continue;
    }
    const id = inPlace ? SKILL_POLICY_IN_PLACE : SKILL_IMPLICIT_INVOCATION_UNENFORCED;
    const reason = inPlace
      ? `Skill ${JSON.stringify(skill.name)} is discovered in place: move it to a separate source directory such as skills/ so Hooknostic can own and verify its invocation policy.`
      : `Skill ${JSON.stringify(skill.name)} declares allowImplicitInvocation=${skill.policy.allowImplicitInvocation}, but this target cannot project it faithfully. ${options.support?.rationale ?? "No invocation-policy evidence is available."}`;
    if (options.accept?.includes(`${options.adapter}:${id}`)) {
      // The retained declaration is still in the file bytes. Removing only the
      // parsed policy prevents a projector from pretending to apply a gate.
      const { policy: _policy, ...ungated } = skill;
      result.skills.push(ungated as T);
      result.degradations.push({ id, component: SKILL_INVOCATION_POLICY, name: skill.name, reason });
    } else {
      result.issues.push({
        severity: inPlace ? "error" : options.onUnsupported,
        scope: "projection",
        component: SKILL_INVOCATION_POLICY,
        message: `${reason} ${inPlace ? "The authored source is left untouched." : "The skill was omitted."} Accept ${JSON.stringify(`${options.adapter}:${id}`)} explicitly to emit it without a projected gate.`,
      });
      if (!inPlace) result.omissions.push({ component: SKILL_INVOCATION_POLICY, name: skill.name, reason });
    }
  }
  return result;
}

export type SkillPolicyFileProjector = (files: readonly AgentPluginFile[], policy: SkillPolicy) => AgentPluginFile[];

/** Edit a native YAML leaf while retaining the SKILL.md body byte-for-byte. */
export function setSkillPolicyYaml(
  files: readonly AgentPluginFile[],
  path: string,
  key: readonly string[],
  value: boolean | string,
  frontmatter = false,
): AgentPluginFile[] {
  const existing = files.find((file) => file.path === path);
  const text = existing === undefined ? "" : new TextDecoder().decode(existing.contents);
  const match = frontmatter ? /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text) : undefined;
  if (frontmatter && !match) throw new Error(`${path} has no YAML frontmatter`);
  const yaml = match ? match[2]! : text;
  const document = parseDocument(yaml);
  if (document.errors.length) throw new Error(`${path}: ${document.errors[0]!.message}`);
  if (document.contents !== null && !isMap(document.contents)) throw new Error(`${path} must contain a YAML mapping`);
  // Refuse malformed native parents instead of replacing their unrelated data.
  for (let i = 1; i < key.length; i++) {
    const parent = document.getIn(key.slice(0, i), true);
    if (parent !== undefined && !isMap(parent))
      throw new Error(`${path}: ${key.slice(0, i).join(".")} must be a mapping`);
  }
  document.setIn([...key], value);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const written = document.toString({ lineWidth: 0 }).replaceAll("\n", eol);
  const encoder = new TextEncoder();
  const header = encoder.encode(match ? match[1]! + written.replace(/\r?\n$/, "") + match[3]! : written);
  // TextDecoder removes a UTF-8 BOM, but it still occupies source bytes before the body.
  const bomLength =
    existing?.contents[0] === 0xef && existing.contents[1] === 0xbb && existing.contents[2] === 0xbf ? 3 : 0;
  const body = match ? existing!.contents.subarray(bomLength + encoder.encode(match[0]).length) : new Uint8Array();
  const contents = new Uint8Array(header.length + body.length);
  contents.set(header);
  contents.set(body, header.length);
  const file = { path, contents, mode: existing?.mode ?? 0o644 };
  return [...files.filter((candidate) => candidate.path !== path), file].sort((a, b) => a.path.localeCompare(b.path));
}

/** Retain native overlays, then apply canonical portable policy to the final skill files. */
export function withSkillInvocationPolicy<TTarget extends { delivery: "package" | "project" }>(
  projector: AgentPluginProjector<TTarget>,
  adapter: string,
  projectFiles: SkillPolicyFileProjector,
): AgentPluginProjector<TTarget> {
  return {
    ...projector,
    async project(source, context) {
      const selection = selectSkillPolicies(source.skills, {
        adapter,
        onUnsupported: context.onUnsupported,
        ...(context.support[SKILL_INVOCATION_POLICY] === undefined
          ? {}
          : { support: context.support[SKILL_INVOCATION_POLICY] }),
        ...(context.accept === undefined ? {} : { accept: context.accept }),
      });
      const omittedDirectories = selection.omissions.flatMap(({ name }) => [
        `skills/${name}`.toLowerCase(),
        `${projector.namespace}/skills/${name}`.toLowerCase(),
      ]);
      // Packages may be installed on case-insensitive filesystems, where a
      // differently cased overlay would otherwise restore an omitted skill.
      const insideOmittedSkill = (path: string) => {
        const folded = path.toLowerCase();
        return omittedDirectories.some((directory) => folded === directory || folded.startsWith(`${directory}/`));
      };
      const filtered: AgentPluginPackage = {
        ...source,
        skills: selection.skills,
        files: source.files.filter((file) => !insideOmittedSkill(file.path)),
        ...(source.directories === undefined
          ? {}
          : {
              directories: source.directories.filter((path) => !insideOmittedSkill(path)),
            }),
      };
      const plan = await projector.project(filtered, context);
      const omittedOverlays = source.files.filter(
        (file) => file.path.startsWith(`${projector.namespace}/`) && !filtered.files.includes(file),
      ).length;
      if (omittedOverlays > 0) {
        const component = "agent-plugin.client-extension.files";
        const previous = plan.summary.components[component] ?? { discovered: 0, emitted: 0, skipped: 0 };
        plan.summary.components[component] = {
          ...previous,
          discovered: previous.discovered + omittedOverlays,
          skipped: previous.skipped + omittedOverlays,
        };
      }
      for (const skill of selection.skills) {
        if (!selection.applied.has(skill.name)) continue;
        const prefix = `${projector.packageRoot === undefined || projector.packageRoot === "." ? "" : projector.packageRoot + "/"}${skill.directory}/`;
        const files = plan.files
          .filter((file) => file.path.startsWith(prefix))
          .map((file) => ({
            path: file.path.slice(prefix.length),
            contents: typeof file.contents === "string" ? new TextEncoder().encode(file.contents) : file.contents,
            mode: file.mode ?? (file.executable ? 0o755 : 0o644),
          }));
        if (!files.some((file) => file.path === "SKILL.md")) continue;
        try {
          const projected = projectFiles(files, skill.policy!);
          const changed = new Set(
            projected
              .filter((file) => {
                const original = files.find((candidate) => candidate.path === file.path);
                return (
                  original === undefined ||
                  original.contents.length !== file.contents.length ||
                  original.contents.some((byte, index) => byte !== file.contents[index])
                );
              })
              .map((file) => prefix + file.path),
          );
          plan.files = [
            ...plan.files.filter((file) => !file.path.startsWith(prefix)),
            ...projected.map((file) => ({ ...file, path: prefix + file.path })),
          ];
          plan.summary.copiedPaths = plan.summary.copiedPaths.filter((path) => !changed.has(path));
        } catch (error) {
          plan.issues.push({ severity: "error", scope: "skill", path: skill.manifestPath, message: String(error) });
        }
      }
      plan.issues.push(...selection.issues);
      plan.summary.omissions.push(...selection.omissions);
      if (selection.degradations.length > 0)
        plan.summary.degradations = [...(plan.summary.degradations ?? []), ...selection.degradations];
      const delivered = plan.summary.components["agent-plugin.skills"]?.emitted ?? 0;
      if (source.skills.length)
        plan.summary.components["agent-plugin.skills"] = {
          discovered: source.skills.length,
          emitted: delivered,
          skipped: source.skills.length - delivered,
        };
      const declared = source.skills.filter((skill) => skill.policy?.allowImplicitInvocation !== undefined).length;
      if (declared)
        plan.summary.components[SKILL_INVOCATION_POLICY] = {
          discovered: declared,
          emitted: Math.min(selection.applied.size, delivered),
          skipped: declared - Math.min(selection.applied.size, delivered),
        };
      return plan;
    },
  };
}

export function skillPolicyCount(skills: readonly Pick<AgentPluginSkill, "policy">[]): number {
  return skills.filter((skill) => skill.policy?.allowImplicitInvocation !== undefined).length;
}
