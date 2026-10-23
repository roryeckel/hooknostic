import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  type AgentPluginComponentSupport,
  type ProjectComponents,
  type ProjectSkill,
  selectSkillPolicies,
  type SkillPolicyFileProjector,
  type SkillPolicySelection,
} from "@hooknostic/agent-plugin";

export interface ProjectSkillPolicyTarget {
  id: string;
  adapter: string;
  destination?: string;
  discoveryDirectories?: readonly string[];
  projectFiles?: SkillPolicyFileProjector;
  support?: AgentPluginComponentSupport;
  componentsSelected?: boolean;
}

export interface ProjectSkillPolicyPlan {
  source: ProjectComponents;
  discovered: ProjectSkill[];
  selection: SkillPolicySelection<ProjectSkill>;
  /** Surviving physical copies this target discovers, including other targets' copies. */
  observed: { destination: string; skill: ProjectSkill; authored?: boolean }[];
  invocationPolicies: Readonly<Record<string, boolean>>;
  omittedFiles: string[];
}

/** Compose policy per physical destination, using every configured discovery reader. */
export function planProjectSkillPolicies(
  source: ProjectComponents,
  root: string,
  targets: readonly ProjectSkillPolicyTarget[],
  options: { onUnsupported: "error" | "warn"; accept?: readonly string[] },
): Map<string, ProjectSkillPolicyPlan> {
  const destinations = [
    ...new Set(
      targets.flatMap((target) =>
        target.componentsSelected !== false && target.destination !== undefined ? [target.destination] : [],
      ),
    ),
  ];
  const declaredSkills = source.skills.filter((skill) => skill.policy?.allowImplicitInvocation !== undefined);
  const canonical = (path: string) => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  const contains = (directory: string, path: string) => {
    const offset = relative(canonical(directory), canonical(path));
    return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`));
  };
  const reads = (target: ProjectSkillPolicyTarget, destination: string) =>
    [target.destination, ...(target.discoveryDirectories ?? [])].some(
      (directory) => directory !== undefined && contains(resolve(root, directory), resolve(root, destination)),
    );
  const plans = new Map<string, ProjectSkillPolicyPlan>();
  const readers: ProjectSkillPolicyTarget[] = [];
  for (const target of targets) {
    let inventory = target.componentsSelected === false ? declaredSkills : source.skills;
    const nativeRoots: string[] = [];
    for (let ancestor = resolve(root); ; ancestor = dirname(ancestor)) {
      for (const directory of [
        ...(target.discoveryDirectories ?? []),
        ...(target.destination === undefined ? [] : [target.destination]),
      ])
        nativeRoots.push(resolve(ancestor, directory));
      if (dirname(ancestor) === ancestor) break;
    }
    const inPlace = new Set(
      inventory
        .filter((skill) =>
          nativeRoots.some(
            (directory) =>
              contains(directory, skill.source) ||
              // A discovery directory may hold a junction or symlink to the
              // skill's real directory, so containment under the root is not
              // enough; resolve the specific child too.
              canonical(resolve(directory, skill.name)) === canonical(skill.source),
          ),
        )
        .map((skill) => skill.name),
    );
    if (
      target.componentsSelected === false &&
      !(declaredSkills.length && (destinations.some((destination) => reads(target, destination)) || inPlace.size))
    )
      continue;
    if (target.componentsSelected === false && !destinations.some((destination) => reads(target, destination)))
      inventory = inventory.filter((skill) => inPlace.has(skill.name));
    readers.push(target);
    const selection = selectSkillPolicies(inventory, {
      ...options,
      adapter: target.adapter,
      ...(target.support === undefined ? {} : { support: target.support }),
      inPlace,
    });
    plans.set(target.id, {
      source: target.componentsSelected === false ? { origin: source.origin, skills: [] } : { ...source, skills: [] },
      discovered: inventory,
      selection,
      observed: selection.skills
        .filter((skill) => inPlace.has(skill.name))
        .map((skill) => ({
          destination: relative(root, dirname(skill.source)).replaceAll("\\", "/"),
          skill,
          authored: true,
        })),
      invocationPolicies: {},
      omittedFiles: [],
    });
  }
  const originalOmissions = new Map(
    readers.map((target) => [target.id, [...plans.get(target.id)!.selection.omissions]]),
  );
  for (const destination of destinations) {
    const group = readers.filter((target) => reads(target, destination));
    const omittedBy = new Map<string, string>();
    for (const target of group) {
      for (const omitted of originalOmissions.get(target.id)!) omittedBy.set(omitted.name, target.id);
    }
    for (const target of group) {
      const plan = plans.get(target.id)!;
      for (const [name, owner] of omittedBy) {
        if (!plan.selection.skills.some((skill) => skill.name === name)) continue;
        const reason = `Skill ${JSON.stringify(name)} was omitted from the shared ${destination} directory because target ${JSON.stringify(owner)} cannot apply its invocation policy.`;
        if (!plan.selection.omissions.some((omission) => omission.name === name)) {
          plan.selection.omissions.push({ component: "agent-plugin.skills.invocation-policy", name, reason });
          plan.selection.issues.push({
            severity: options.onUnsupported,
            scope: "projection",
            component: "agent-plugin.skills.invocation-policy",
            message: reason,
          });
        }
      }
      if (target.componentsSelected !== false && target.destination === destination)
        plan.omittedFiles.push(...[...omittedBy.keys()].map((name) => `${destination}/${name}/SKILL.md`));
    }
    // All readers get identical bytes. Each adapter supplies only its own
    // native edits; the core knows neither their keys nor their semantics.
    for (const skill of source.skills) {
      if (omittedBy.has(skill.name)) continue;
      let files = skill.files;
      for (const target of group) {
        if (plans.get(target.id)!.selection.applied.has(skill.name) && target.projectFiles !== undefined) {
          try {
            files = target.projectFiles(files, skill.policy!);
          } catch (error) {
            plans.get(target.id)!.selection.issues.push({
              severity: "error",
              scope: "skill",
              path: skill.source,
              message: `Cannot project skill invocation policy: ${String(error)}`,
            });
            plans.get(target.id)!.selection.applied.delete(skill.name);
          }
        }
      }
      for (const target of group) {
        const plan = plans.get(target.id)!;
        const planned = plan.selection.skills.find((candidate) => candidate.name === skill.name);
        if (planned !== undefined) {
          const copy = { ...planned, files };
          plan.observed.push({ destination, skill: copy });
          if (target.componentsSelected !== false && target.destination === destination) plan.source.skills.push(copy);
        }
      }
    }
  }
  for (const target of readers) {
    const plan = plans.get(target.id)!;
    // Omission must also account for authored copies outside generated destinations.
    // Reconciliation checks these paths without acquiring ownership or deleting them.
    for (const directory of [target.destination, ...(target.discoveryDirectories ?? [])]) {
      if (directory === undefined) continue;
      for (const { name } of plan.selection.omissions) {
        if (plan.observed.some((copy) => copy.authored && copy.destination === directory && copy.skill.name === name))
          continue;
        plan.omittedFiles.push(`${directory}/${name}/SKILL.md`);
      }
    }
    plan.omittedFiles = [...new Set(plan.omittedFiles)];
    // Adapters without a declared discovery destination retain their existing emission path.
    if (target.componentsSelected !== false && target.destination === undefined)
      plan.source.skills = plan.selection.skills;
    const observed = new Set(plan.observed.map((copy) => copy.skill.name));
    for (const name of plan.selection.applied) if (!observed.has(name)) plan.selection.applied.delete(name);
    plan.invocationPolicies = Object.fromEntries(
      plan.selection.skills.flatMap((skill) =>
        plan.selection.applied.has(skill.name) ? [[skill.name, skill.policy!.allowImplicitInvocation!]] : [],
      ),
    );
  }
  return plans;
}
