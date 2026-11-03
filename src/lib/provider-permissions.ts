export const GITHUB_PERMISSION_CATALOG = [
  { key: "actions", label: "Actions", levels: ["read", "write"] },
  { key: "administration", label: "Administration", levels: ["read", "write"] },
  { key: "checks", label: "Checks", levels: ["read", "write"] },
  { key: "contents", label: "Contents", levels: ["read", "write"] },
  { key: "deployments", label: "Deployments", levels: ["read", "write"] },
  { key: "issues", label: "Issues", levels: ["read", "write"] },
  { key: "pull_requests", label: "Pull requests", levels: ["read", "write"] },
  { key: "workflows", label: "Workflows", levels: ["write"] },
] as const;

export type GitHubPermission = (typeof GITHUB_PERMISSION_CATALOG)[number]["key"];
export type PermissionLevel = "none" | "read" | "write";

const LEVEL_RANK: Record<PermissionLevel, number> = { none: 0, read: 1, write: 2 };

export function permissionLevel(value: unknown): PermissionLevel {
  return value === "read" || value === "write" ? value : "none";
}

export function permissionIncrease(current: unknown, requested: PermissionLevel): boolean {
  return LEVEL_RANK[requested] > LEVEL_RANK[permissionLevel(current)];
}

export function permissionAtLeast(current: unknown, requested: unknown): boolean {
  return LEVEL_RANK[permissionLevel(current)] >= LEVEL_RANK[permissionLevel(requested)];
}

export function isGitHubPermission(value: string): value is GitHubPermission {
  return GITHUB_PERMISSION_CATALOG.some((permission) => permission.key === value);
}
