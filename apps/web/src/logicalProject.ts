import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import type { ScopedProjectRef } from "@t3tools/contracts";
import type { Project } from "./types";

const SIDEBAR_HOME_LOGICAL_PREFIX = "__t3code:sidebar:home:";

export function normalizeWorkspaceRootPath(cwd: string): string {
  return cwd.trim().replace(/[/\\]+$/g, "");
}

export function sidebarProjectLogicalKey(
  project: Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity">,
  homeDir: string | null,
): string {
  if (homeDir !== null && homeDir.trim().length > 0) {
    const h = normalizeWorkspaceRootPath(homeDir);
    const c = normalizeWorkspaceRootPath(project.cwd);
    if (c === h) {
      return `${SIDEBAR_HOME_LOGICAL_PREFIX}${h}`;
    }
  }
  return deriveLogicalProjectKey(project);
}

export function deriveLogicalProjectKey(
  project: Pick<Project, "environmentId" | "id" | "repositoryIdentity">,
): string {
  return (
    project.repositoryIdentity?.canonicalKey ??
    scopedProjectKey(scopeProjectRef(project.environmentId, project.id))
  );
}

export function deriveLogicalProjectKeyFromRef(
  projectRef: ScopedProjectRef,
  project: Pick<Project, "repositoryIdentity"> | null | undefined,
): string {
  return project?.repositoryIdentity?.canonicalKey ?? scopedProjectKey(projectRef);
}
