import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/AppShell";
import {
  getLovableDeploymentDashboard,
  getLovableDeploymentStatus,
  publishLovableProduction,
  requestLovableRollback,
} from "@/lib/lovable-deployment.functions";
import { useStepUp } from "@/lib/step-up-client";

export const Route = createFileRoute("/_authenticated/deployments")({
  head: () => ({
    meta: [
      { title: "Deployments — Jackboy" },
      {
        name: "description",
        content:
          "Review Lovable deployment status, build verification, previews, and owner-approved publishing.",
      },
    ],
  }),
  component: Deployments,
});

type Dashboard = Awaited<ReturnType<typeof getLovableDeploymentDashboard>>;
type DeploymentStatus = Awaited<ReturnType<typeof getLovableDeploymentStatus>>;

function Deployments() {
  const load = useServerFn(getLovableDeploymentDashboard);
  const publish = useServerFn(publishLovableProduction);
  const status = useServerFn(getLovableDeploymentStatus);
  const rollback = useServerFn(requestLovableRollback);
  const stepUp = useStepUp();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [active, setActive] = useState<{ projectId: string; deployment: DeploymentStatus } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [rollbackUrl, setRollbackUrl] = useState("");

  const refresh = useCallback(async () => {
    try {
      setDashboard(await load());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load deployment status.");
    }
  }, [load]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!active || active.deployment.status !== "running") return;
    const timer = window.setTimeout(() => {
      void status({ data: { projectId: active.projectId, deploymentId: active.deployment.id } })
        .then((deployment) => setActive({ projectId: active.projectId, deployment }))
        .catch((e) =>
          setError(e instanceof Error ? e.message : "Could not refresh deployment status."),
        );
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [active, status]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The deployment operation could not be completed.");
    } finally {
      setBusy(false);
    }
  };

  const productionPublish = (project: NonNullable<Dashboard["projects"][number]>) =>
    run(async () => {
      if (!project.deployment?.latestCommitSha || !project.build.verified)
        throw new Error(
          "Publishing is blocked until the current Lovable commit passes exact-SHA GitHub build verification.",
        );
      const approved = window.confirm(
        `Publish ${project.name} to production at ${project.deployment.latestCommitSha}? This uses the current Lovable project state and requires your passkey.`,
      );
      if (!approved) return;
      const grantId = await stepUp(
        "production_deploy",
        `lovable:${project.id}:${project.deployment.latestCommitSha}`,
      );
      const result = await publish({
        data: { projectId: project.id, commitSha: project.deployment.latestCommitSha, grantId },
      });
      setActive({ projectId: result.projectId, deployment: result.deployment });
      setMessage(
        `Lovable accepted deployment ${result.deployment.id}. Jackboy is polling provider status.`,
      );
      await refresh();
    });

  const beginRollback = (projectId: string) =>
    run(async () => {
      const approved = window.confirm(
        "Automatic Lovable rollback is not available. Open this project's Lovable page to restore a prior version manually? Publishing the restored version still requires a passing build check and a separate owner passkey approval.",
      );
      if (!approved) return;
      const result = await rollback({ data: { projectId } });
      setRollbackUrl(result.url);
      setMessage(
        "Rollback handoff recorded. Restore the version in Lovable, then return here to verify and publish it.",
      );
      await refresh();
    });

  return (
    <>
      <PageHeader
        title="Deployments"
        subtitle="Lovable project status, exact-commit build verification, previews, and owner-approved production publishing."
      />
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {message && (
        <p
          role="status"
          className="mb-4 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm"
        >
          {message}
        </p>
      )}
      {rollbackUrl && (
        <p className="mb-4 text-sm">
          <a
            className="text-electric underline"
            href={rollbackUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open the Lovable project history
          </a>
        </p>
      )}

      <section className="panel mb-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Lovable provider connection</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {dashboard?.configured
                ? "Dedicated deployment API key detected; key contents are never returned."
                : "Not connected. " + (dashboard?.setup ?? "Loading provider requirements.")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Configure only the backend secret LOVABLE_DEPLOY_API_KEY; do not reuse
              LOVABLE_API_KEY, which serves the AI gateway.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
      </section>

      {active && (
        <section className="panel mb-5 p-5" aria-live="polite">
          <h2 className="text-lg font-semibold">Current deployment status</h2>
          <p className="mt-2 text-sm">
            Provider status: <strong>{active.deployment.status}</strong> · {active.deployment.id}
          </p>
          {active.deployment.url && (
            <a
              className="mt-2 inline-block text-sm text-electric underline"
              href={active.deployment.url}
              target="_blank"
              rel="noreferrer"
            >
              Open deployed application
            </a>
          )}
          {active.deployment.error_message && (
            <p className="mt-2 text-sm text-destructive">
              {active.deployment.error_class ? `${active.deployment.error_class}: ` : ""}
              {active.deployment.error_message}
            </p>
          )}
        </section>
      )}

      <div className="space-y-4">
        {dashboard?.projects.length
          ? dashboard.projects.map((project) => (
              <article key={project.id} className="panel p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{project.name}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Registered project ID · {project.id} · GitHub repo{" "}
                      {project.repoUrl ?? "not linked"}
                    </p>
                  </div>
                  {project.deployment && (
                    <span
                      className={`rounded-full px-2 py-1 text-xs ${project.deployment.published ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}
                    >
                      {project.deployment.published ? "Published" : "Not published"}
                    </span>
                  )}
                </div>

                {project.error && (
                  <p role="status" className="mt-3 text-sm text-warning">
                    {project.error}
                  </p>
                )}
                {project.deployment && (
                  <>
                    <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-xs text-muted-foreground">Latest Lovable commit</dt>
                        <dd className="font-mono break-all">
                          {project.deployment.latestCommitSha ?? "Not reported"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Publish audience</dt>
                        <dd>{project.deployment.audience ?? "Provider default"}</dd>
                      </div>
                    </dl>
                    <div className="mt-3 rounded-md border border-border p-3">
                      <p className="font-medium">GitHub build verification</p>
                      <p
                        className={`mt-1 text-sm ${project.build.verified ? "text-success" : "text-warning"}`}
                      >
                        {project.build.message}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Must match the full latest Lovable commit SHA. No build evidence means
                        production publishing stays blocked.
                      </p>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {project.deployment.previewUrl && (
                        <a
                          className="inline-flex h-9 items-center rounded-md border border-input px-4 text-sm hover:bg-accent"
                          href={project.deployment.previewUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open latest preview
                        </a>
                      )}
                      <Button
                        disabled={busy || !dashboard?.configured || !project.build.verified}
                        onClick={() => void productionPublish(project)}
                      >
                        Publish to production · owner passkey
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void beginRollback(project.id)}
                      >
                        Manual rollback via Lovable history
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      The preview URL is the provider's latest preview and is not guaranteed to be
                      pinned to this commit. Production publishing rechecks the commit and build
                      immediately before calling Lovable.
                    </p>
                  </>
                )}
              </article>
            ))
          : dashboard && (
              <section className="panel p-5">
                <h2 className="font-semibold">No registered Lovable project references</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Jackboy checks only the existing `agent_projects` inventory. Add a verified
                  Lovable project reference through the existing project-registration workflow;
                  workspace-wide discovery is not requested.
                </p>
              </section>
            )}
      </div>

      <section className="panel mt-5 p-5">
        <h2 className="text-lg font-semibold">Rollback and OMNI boundaries</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {dashboard?.rollback ??
            "Lovable's documented API does not expose a version rollback endpoint."}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          OMNI handoffs continue through Jackboy's existing authenticated, verified queue.
          Production deployment and permission changes are not delegated or dispatched
          automatically; owner approval and audit evidence remain required.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Building-management integration is a disabled future framework only. No physical provider
          is connected and no device operations are available.
        </p>
      </section>

      <section className="panel mt-5 p-5">
        <h2 className="text-lg font-semibold">Deployment and rollback audit history</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {dashboard?.history.map((event) => (
            <li key={`${event.at}-${event.action}`} className="border-t border-border pt-2">
              <span className="font-medium">{event.action}</span> · {event.status} ·{" "}
              {new Date(event.at).toLocaleString()} · {event.summary}
              {event.commit_sha && (
                <span className="block font-mono text-xs text-muted-foreground">
                  {event.commit_sha}
                </span>
              )}
            </li>
          ))}
          {!dashboard?.history.length && (
            <li className="text-muted-foreground">No deployment events recorded.</li>
          )}
        </ul>
      </section>
    </>
  );
}
