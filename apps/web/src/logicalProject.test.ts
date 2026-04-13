import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  deriveLogicalProjectKey,
  normalizeWorkspaceRootPath,
  sidebarProjectLogicalKey,
} from "./logicalProject";
import type { Project } from "./types";

function project(
  overrides: Partial<Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity">>,
): Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity"> {
  return {
    environmentId: "env-local" as EnvironmentId,
    id: "proj-default" as ProjectId,
    cwd: "/tmp/ws",
    repositoryIdentity: null,
    ...overrides,
  };
}

describe("normalizeWorkspaceRootPath", () => {
  it("trims and strips trailing slashes", () => {
    expect(normalizeWorkspaceRootPath("  /Users/x/  ")).toBe("/Users/x");
    expect(normalizeWorkspaceRootPath("/Users/x///")).toBe("/Users/x");
  });
});

describe("sidebarProjectLogicalKey", () => {
  it("collapses distinct project ids at the same home path", () => {
    const home = "/Users/test";
    const a = project({ id: "p-a" as ProjectId, cwd: `${home}/` });
    const b = project({ id: "p-b" as ProjectId, cwd: home });
    expect(sidebarProjectLogicalKey(a, home)).toBe(sidebarProjectLogicalKey(b, home));
    expect(sidebarProjectLogicalKey(a, home)).not.toBe(deriveLogicalProjectKey(a));
  });

  it("falls back to deriveLogicalProjectKey when cwd is not home", () => {
    const p = project({ cwd: "/other/repo" });
    expect(sidebarProjectLogicalKey(p, "/Users/test")).toBe(deriveLogicalProjectKey(p));
  });

  it("returns deriveLogicalProjectKey when homeDir is null", () => {
    const p = project({ cwd: "/Users/test" });
    expect(sidebarProjectLogicalKey(p, null)).toBe(deriveLogicalProjectKey(p));
  });
});
