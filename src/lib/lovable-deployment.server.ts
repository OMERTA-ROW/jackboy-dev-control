import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  buildVerification,
  LOVABLE_API_VERSION,
  parseLovableProjectId,
  type DeploymentCheck,
} from "./lovable-deployment";
import { parseRepo } from "./repo-workspace";
import { logSiteStrict } from "./site-log.server";

type LovableProject = {
  id: string;
  name?: string;
  is_published: boolean;
  latest_commit_sha: string | null;
  preview_url: string | null;
  publish_audience?: string | null;
};

type LovableDeployment = {
  id: string;
  status: string;
  url: string | null;
  error_message: string | null;
  error_class?: string | null;
};

type RegisteredProject = {
  id: string;
  name: string;
  lovable_project_ref: string | null;
  repo_url: string | null;
};

function apiKey(): string | null {
  return process.env["LOVABLE_DEPLOY_API_KEY"] ?? null;
}

async function lovable<T>(path: string, init?: RequestInit): Promise<T> {
  const key = apiKey();
  if (!key)
    throw new Error(
      "LOVABLE_DEPLOY_API_KEY is not configured. Add a dedicated Lovable management API key in backend secrets; do not reuse LOVABLE_API_KEY.",
    );
  const response = await fetch(`https://api.lovable.dev/v1${path}`, {
    ...init,
    signal: AbortSignal.timeout(12_000),
    headers: {
      Accept: "application/json",
      "Lovable-API-Key": key,
      "Lovable-Version": LOVABLE_API_VERSION,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const requestId = response.headers.get("x-request-id");
    throw new Error(
      `Lovable API returned HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}.`,
    );
  }
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

async function registeredProjects(): Promise<RegisteredProject[]> {
  const { data, error } = await supabaseAdmin
    .from("agent_projects")
    .select("id,name,lovable_project_ref,repo_url")
    .order("name");
  if (error) throw new Error(`Could not read the registered project inventory: ${error.message}`);
  return data ?? [];
}

async function projectBuildCheck(
  repoUrl: string | null,
  commitSha: string | null,
): Promise<DeploymentCheck | null> {
  const raw =
    repoUrl?.match(/github\.com\/([^/?#]+\/[^/?#]+)/i)?.[1]?.replace(/\.git$/i, "") ?? repoUrl;
  const repo = parseRepo(raw);
  if (!repo || !commitSha) return null;

  const { githubTokenFor } = await import("./github-app.server");
  const auth = await githubTokenFor(`${repo.owner}/${repo.repo}`);
  if (!auth)
    return {
      workflowsConfigured: 0,
      runs: [],
      error: "GitHub App access is not available for the linked repository.",
    };

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${auth.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Jackboy",
  };
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`,
    {
      headers,
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok)
    return {
      workflowsConfigured: 0,
      runs: [],
      error: `Cannot read the linked GitHub repository (HTTP ${response.status}).`,
    };
  const repository = (await response.json()) as { default_branch?: string };
  if (!repository.default_branch)
    return { workflowsConfigured: 0, runs: [], error: "GitHub did not report a default branch." };

  const { checks } = await import("./repo-workspace.server");
  const checked = await checks(
    { ...repo, base: repository.default_branch, full: `${repo.owner}/${repo.repo}` },
    repository.default_branch,
  );
  return checked as DeploymentCheck;
}

async function projectById(
  projectId: string,
): Promise<{ project: RegisteredProject; lovableId: string }> {
  const projects = await registeredProjects();
  const project = projects.find(
    (item) => parseLovableProjectId(item.lovable_project_ref) === projectId,
  );
  if (!project)
    throw new Error("This Lovable project is not in Jackboy's registered project inventory.");
  const lovableId = parseLovableProjectId(project.lovable_project_ref);
  if (!lovableId)
    throw new Error("The registered project does not have a valid Lovable project reference.");
  return { project, lovableId };
}

export async function getDeploymentDashboard() {
  const projects = await registeredProjects();
  const configured = Boolean(apiKey());
  const items = [];
  for (const project of projects) {
    const lovableId = parseLovableProjectId(project.lovable_project_ref);
    if (!lovableId) continue;
    if (!configured) {
      items.push({
        id: lovableId,
        registeredProjectId: project.id,
        name: project.name,
        repoUrl: project.repo_url,
        error: "LOVABLE_DEPLOY_API_KEY is missing.",
        deployment: null,
        build: { verified: false, message: "Provider connection required." },
      });
      continue;
    }
    try {
      const current = await lovable<LovableProject>(`/projects/${encodeURIComponent(lovableId)}`);
      const checks = await projectBuildCheck(project.repo_url, current.latest_commit_sha);
      items.push({
        id: lovableId,
        registeredProjectId: project.id,
        name: current.name ?? project.name,
        repoUrl: project.repo_url,
        error: null,
        deployment: {
          published: current.is_published,
          latestCommitSha: current.latest_commit_sha,
          previewUrl: current.preview_url,
          audience: current.publish_audience ?? null,
        },
        build: buildVerification(checks, current.latest_commit_sha),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Lovable project status could not be read.";
      items.push({
        id: lovableId,
        registeredProjectId: project.id,
        name: project.name,
        repoUrl: project.repo_url,
        error: message,
        deployment: null,
        build: {
          verified: false,
          message: "Build status unavailable until provider status is readable.",
        },
      });
    }
  }
  const { data: history, error: historyError } = await supabaseAdmin
    .from("site_log")
    .select("at,action,summary,status,commit_sha,detail")
    .in("category", ["deployment", "rollback"])
    .order("at", { ascending: false })
    .limit(50);
  if (historyError) throw new Error(`Could not read deployment history: ${historyError.message}`);
  return {
    configured,
    setup:
      "Requires a Lovable Business or Enterprise workspace and a dedicated API key with projects:read and projects:write scopes.",
    projects: items,
    history: history ?? [],
    rollback:
      "Lovable's documented API has no version rollback operation. Restore a prior version in Lovable's project history, then verify and publish that version here.",
  };
}

export async function publishLovableProject(input: {
  projectId: string;
  commitSha: string;
  grantId: string;
  actor: string;
}) {
  const { project, lovableId } = await projectById(input.projectId);
  const target = `lovable:${lovableId}:${input.commitSha}`;
  await (
    await import("./passkey.server")
  ).consumeGrant(input.grantId, input.actor, "production_deploy", target);
  const current = await lovable<LovableProject>(`/projects/${encodeURIComponent(lovableId)}`);
  if (
    !current.latest_commit_sha ||
    current.latest_commit_sha.toLowerCase() !== input.commitSha.toLowerCase()
  ) {
    throw new Error(
      "The Lovable project commit changed after approval. Refresh, verify the new commit, and approve again.",
    );
  }
  const build = buildVerification(
    await projectBuildCheck(project.repo_url, current.latest_commit_sha),
    current.latest_commit_sha,
  );
  if (!build.verified) throw new Error(`Production deployment is blocked: ${build.message}`);
  await logSiteStrict({
    actor: input.actor,
    action: "production_deploy_approved",
    category: "approval",
    status: "ok",
    summary: `Owner approved Lovable production publishing for ${project.name} at ${input.commitSha}.`,
    commit_sha: input.commitSha,
    detail: { projectId: lovableId },
  });
  let deployment: LovableDeployment;
  try {
    deployment = await lovable<LovableDeployment>(
      `/projects/${encodeURIComponent(lovableId)}/publish`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
  } catch (error) {
    await logSiteStrict({
      actor: input.actor,
      action: "lovable_deployment_failed",
      category: "deployment",
      status: "failed",
      summary: `Lovable did not accept production publishing for ${project.name}.`,
      commit_sha: input.commitSha,
      detail: {
        projectId: lovableId,
        error: error instanceof Error ? error.message : "Provider request failed.",
      },
    });
    throw error;
  }
  await logSiteStrict({
    actor: input.actor,
    action: "lovable_deployment_started",
    category: "deployment",
    status: "pending",
    summary: `Lovable accepted production deployment ${deployment.id} for ${project.name}.`,
    commit_sha: input.commitSha,
    detail: { projectId: lovableId, deploymentId: deployment.id },
  });
  return { projectId: lovableId, deployment };
}

export async function getLovableDeploymentStatus(
  projectId: string,
  deploymentId: string,
  actor: string,
) {
  const { lovableId } = await projectById(projectId);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(deploymentId))
    throw new Error("Invalid Lovable deployment ID.");
  const deployment = await lovable<LovableDeployment>(
    `/projects/${encodeURIComponent(lovableId)}/publish/${encodeURIComponent(deploymentId)}`,
  );
  if (deployment.status !== "running") {
    const { data: existing, error } = await supabaseAdmin
      .from("site_log")
      .select("id")
      .eq("category", "deployment")
      .eq("action", "lovable_deployment_finished")
      .contains("detail", { deploymentId })
      .limit(1);
    if (error) throw new Error(`Could not check deployment audit status: ${error.message}`);
    if (!existing?.length) {
      const outcome = deployment.error_message ? "failed" : deployment.url ? "ok" : "blocked";
      await logSiteStrict({
        actor,
        action: "lovable_deployment_finished",
        category: "deployment",
        status: outcome,
        summary: `Lovable deployment ${deployment.id} finished with provider status ${deployment.status}.`,
        detail: {
          projectId: lovableId,
          deploymentId,
          providerStatus: deployment.status,
          errorClass: deployment.error_class ?? null,
        },
      });
    }
  }
  return deployment;
}

export async function logLovableRollbackRequest(projectId: string, actor: string) {
  const { project, lovableId } = await projectById(projectId);
  await logSiteStrict({
    actor,
    action: "lovable_manual_rollback_requested",
    category: "rollback",
    status: "pending",
    summary: `Manual rollback requested for ${project.name}; restore a prior version in Lovable before republishing.`,
    detail: { projectId: lovableId, providerRollbackApi: false },
  });
  return { url: `https://lovable.dev/projects/${encodeURIComponent(lovableId)}`, automatic: false };
}
