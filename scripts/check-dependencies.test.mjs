import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { checkEngines, checkExtraction, inventory } from "./check-dependencies.mjs";

it("aligns Renovate npm release ages with the explicit pnpm install guard", () => {
  const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
  const config = JSON.parse(readFileSync(new URL("../renovate.json", import.meta.url), "utf8"));
  const ageRule = config.packageRules.find((rule) => rule.matchDatasources?.includes("npm") && rule.minimumReleaseAge);
  expect(workspace).toMatch(/^minimumReleaseAge: 1440$/m);
  expect(ageRule?.minimumReleaseAge).toBe("1 day");
  expect(ageRule?.minimumReleaseAgeBehaviour).toBe("timestamp-required");
  expect(ageRule?.internalChecksFilter).toBe("strict");
});

it("requires every package engine declaration to match the authoritative root", () => {
  const root = { engines: { node: ">=99.1.0" } };
  expect(() => checkEngines({ "package.json": root, "packages/example/package.json": root })).not.toThrow();
  for (const pkg of [{ engines: { node: ">=98" } }, {}]) {
    expect(() => checkEngines({ "package.json": root, "packages/example/package.json": pkg })).toThrow(
      "must agree with root",
    );
  }
  expect(() => checkEngines({ "package.json": {} })).toThrow("Root Node engine");
});

it("checks every maintained category against Renovate extraction, including relocated tooling", () => {
  const expected = inventory();
  const packageFiles = {};
  for (const dep of expected) {
    (packageFiles[dep.manager] ??= []).push({ packageFile: dep.packageFile, deps: [dep] });
  }
  expect(checkExtraction(expected, packageFiles).managers.sort()).toEqual([
    "github-actions",
    "nodenv",
    "npm",
    "pip_requirements",
  ]);
  for (const manager of Object.keys(packageFiles)) {
    const broken = { ...packageFiles, [manager]: [] };
    expect(() => checkExtraction(expected, broken)).toThrow("Missing extracted dependency");
  }
  const broken = { ...packageFiles, npm: packageFiles.npm.filter((file) => file.deps[0].depName !== "pnpm") };
  expect(() => checkExtraction(expected, broken)).toThrow("Missing extracted dependency");
  const missingRuntime = {
    ...packageFiles,
    npm: packageFiles.npm.filter((file) => file.packageFile !== "examples/agent-plugin/runtime/package.json"),
  };
  expect(() => checkExtraction(expected, missingRuntime)).toThrow("Missing extracted dependency");
});

it("rejects extracted evidence, generated manifests, release data and skipped maintained pins", () => {
  const dep = {
    manager: "npm",
    packageFile: "package.json",
    depName: "pnpm",
    currentValue: "99.0.0",
    depType: "packageManager",
  };
  for (const path of [
    "fixtures/test/package.json",
    ".capture/test/package.json",
    "docs/baseline/package.json",
    "examples/agent-plugin/dist/claude/package.json",
  ]) {
    expect(() => checkExtraction([dep], { npm: [{ packageFile: path, deps: [dep] }] })).toThrow(
      "Unexpected extracted file",
    );
  }
  expect(() =>
    checkExtraction([dep], {
      npm: [{ packageFile: "package.json", deps: [{ ...dep, depName: "hooknostic", depType: "version" }] }],
    }),
  ).toThrow("Unexpected extracted dependency");
  expect(() =>
    checkExtraction([dep], { npm: [{ packageFile: "package.json", deps: [{ ...dep, skipReason: "invalid-value" }] }] }),
  ).toThrow("Skipped dependency");
});

it("keeps intentional catalog lines and the manual Node floor outside automatic major migrations", () => {
  const config = JSON.parse(readFileSync(new URL("../renovate.json", import.meta.url), "utf8"));
  const ruleFor = (type) => config.packageRules.find((rule) => rule.matchDepTypes?.includes(type));
  expect(ruleFor("pnpm.catalog.zod3").allowedVersions).toBe(">=3 <4");
  expect(ruleFor("pnpm.catalog.zod4").allowedVersions).toBe(">=4 <5");
  expect(ruleFor("pnpm.catalog.semver-runtime").allowedVersions).toBe(">=7 <8");
  expect(ruleFor("pnpm.catalog.semver-tooling").allowedVersions).toBe(">=7 <8");
  expect(
    config.packageRules.find((rule) => rule.matchFileNames?.includes("examples/agent-plugin/runtime/package.json"))
      .allowedVersions,
  ).toBe(">=4 <5");
  expect(ruleFor("engines").enabled).toBe(false);
  const major = config.packageRules.find((rule) => rule.matchUpdateTypes?.includes("major"));
  expect(major.dependencyDashboardApproval).toBe(true);
  expect(major.groupName).toBeNull();
  expect(config.automerge).toBe(false);
  expect(config.vulnerabilityAlerts.automerge).toBe(false);
});
