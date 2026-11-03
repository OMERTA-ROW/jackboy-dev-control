export const LOVABLE_API_VERSION = "2026-09-11";

export type DeploymentCheck = {
  workflowsConfigured: number;
  runs: { status: string; conclusion: string | null; headSha: string; url: string; name: string }[];
  error?: string;
};

export function parseLovableProjectId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const urlMatch = trimmed.match(
    /^https:\/\/(?:www\.)?lovable\.dev\/projects\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/i,
  );
  const id = urlMatch?.[1] ?? trimmed;
  return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|prj_[A-Za-z0-9]{12,64})$/i.test(
    id,
  )
    ? id
    : null;
}

export function buildVerification(checks: DeploymentCheck | null, commitSha: string | null) {
  if (!commitSha || !/^[0-9a-f]{40}$/i.test(commitSha))
    return { verified: false, message: "Lovable did not report a full commit SHA." };
  if (!checks)
    return { verified: false, message: "Link a GitHub repository to verify this commit." };
  if (checks.error) return { verified: false, message: checks.error };
  if (checks.workflowsConfigured < 1)
    return { verified: false, message: "The linked repository has no GitHub Actions workflows." };
  const exact = checks.runs.filter((run) => run.headSha.toLowerCase() === commitSha.toLowerCase());
  if (!exact.length)
    return {
      verified: false,
      message: "No recent GitHub Actions run matches the exact Lovable commit.",
    };
  if (exact.some((run) => run.status !== "completed" || run.conclusion !== "success")) {
    return {
      verified: false,
      message: "GitHub Actions for this exact commit has not completed successfully.",
    };
  }
  return {
    verified: true,
    message: `${exact.length} successful GitHub Actions run(s) match this exact commit.`,
  };
}

export function lovableDeploymentStatus(isPublished: boolean, status?: string | null) {
  if (status) return status;
  return isPublished ? "published" : "not_published";
}

export type PhysicalControlReadiness = {
  ownershipVerified: boolean;
  providerAuthenticationSupported: boolean;
  explicitAuthorization: boolean;
};

export function physicalControlMayBeEnabled(readiness: PhysicalControlReadiness): boolean {
  return (
    readiness.ownershipVerified &&
    readiness.providerAuthenticationSupported &&
    readiness.explicitAuthorization
  );
}

export const PHYSICAL_CONTROL_STATUS = {
  enabled: false,
  providerConnected: false,
  operationsAvailable: false,
  reason: "No building-management provider is integrated; physical controls are disabled.",
} as const;
