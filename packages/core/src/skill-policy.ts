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

/** Compose native edits once for each shared skill destination, without harness conditionals. */
export function planProjectSkillPolicies(
  source: ProjectComponents,
  root: string,
  targets: readonly ProjectSkillPolicyTarget[],
  options: { onUnsupported: "error" | "warn"; accept?: readonly string[] },
): Map<string, { source: ProjectComponents; selection: SkillPolicySelection<ProjectSkill> }> {
  const sharedDestinations = new Set(
    targets.filter((target) => target.componentsSelected !== false).map((target) => target.destination),
  );
  const declaredSkills = source.skills.filter((skill) => skill.policy?.allowImplicitInvocation !== undefined);
  const readers = targets.filter(
    (target) =>
      target.componentsSelected !== false ||
      (declaredSkills.length > 0 && target.destination !== undefined && sharedDestinations.has(target.destination)),
  );
  const canonical = (path: string) => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  const plans = new Map<string, { source: ProjectComponents; selection: SkillPolicySelection<ProjectSkill> }>();
  for (const target of readers) {
    const inventory: ProjectComponents =
      target.componentsSelected === false ? { origin: source.origin, skills: declaredSkills } : source;
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
      inventory.skills
        .filter((skill) =>
          nativeRoots.some((directory) => {
            const path = relative(canonical(directory), canonical(skill.source));
            return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
          }),
        )
        .map((skill) => skill.name),
    );
    const selection = selectSkillPolicies(inventory.skills, {
      ...options,
      adapter: target.adapter,
      ...(target.support === undefined ? {} : { support: target.support }),
      inPlace,
    });
    plans.set(target.id, { source: { ...inventory, skills: selection.skills }, selection });
  }
  const groups = new Map<string, ProjectSkillPolicyTarget[]>();
  for (const target of readers) {
    const key = target.destination ?? `target:${target.id}`;
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }
  for (const group of groups.values()) {
    const omittedBy = new Map<string, string>();
    for (const target of group) {
      for (const omitted of plans.get(target.id)!.selection.omissions) omittedBy.set(omitted.name, target.id);
    }
    for (const target of group) {
      const plan = plans.get(target.id)!;
      for (const [name, owner] of omittedBy) {
        if (!plan.selection.skills.some((skill) => skill.name === name)) continue;
        const reason = `Skill ${JSON.stringify(name)} was omitted from the shared ${target.destination} directory because target ${JSON.stringify(owner)} cannot apply its invocation policy.`;
        plan.selection.omissions.push({ component: "agent-plugin.skills.invocation-policy", name, reason });
        plan.selection.issues.push({
          severity: options.onUnsupported,
          scope: "projection",
          component: "agent-plugin.skills.invocation-policy",
          message: reason,
        });
      }
      plan.source.skills = plan.selection.skills.filter((skill) => !omittedBy.has(skill.name));
      plan.selection.skills = plan.source.skills;
      for (const name of omittedBy.keys()) plan.selection.applied.delete(name);
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
        const planned = plans.get(target.id)!.source.skills.find((candidate) => candidate.name === skill.name);
        if (planned !== undefined) {
          const index = plans.get(target.id)!.source.skills.indexOf(planned);
          plans.get(target.id)!.source.skills[index] = { ...planned, files };
        }
      }
    }
  }
  return plans;
}
