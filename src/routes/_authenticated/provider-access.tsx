import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/AppShell";
import {
  decideProviderPermission,
  getProviderPermissionDashboard,
  requestProviderPermission,
} from "@/lib/provider-permissions.functions";
import { GITHUB_PERMISSION_CATALOG, permissionLevel } from "@/lib/provider-permissions";
import { useStepUp } from "@/lib/step-up-client";

export const Route = createFileRoute("/_authenticated/provider-access")({
  head: () => ({
    meta: [
      { title: "Provider access — Jackboy" },
      {
        name: "description",
        content: "Review and request provider permissions with owner approval and audit history.",
      },
    ],
  }),
  component: ProviderAccess,
});

type Dashboard = Awaited<ReturnType<typeof getProviderPermissionDashboard>>;

function ProviderAccess() {
  const load = useServerFn(getProviderPermissionDashboard);
  const request = useServerFn(requestProviderPermission);
  const decide = useServerFn(decideProviderPermission);
  const stepUp = useStepUp();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [account, setAccount] = useState("");
  const [permission, setPermission] = useState<string>(GITHUB_PERMISSION_CATALOG[0].key);
  const [access, setAccess] = useState<"read" | "write">("write");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setDashboard(await load());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load provider access.");
    }
  }, [load]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedCatalog =
    GITHUB_PERMISSION_CATALOG.find((item) => item.key === permission) ??
    GITHUB_PERMISSION_CATALOG[0];
  const currentAccess = useMemo(() => {
    const install = dashboard?.installations.find((item) => item.account === account);
    return permissionLevel(install?.permissions[permission]);
  }, [account, dashboard, permission]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request could not be completed.");
    } finally {
      setBusy(false);
    }
  };

  const submitRequest = () =>
    run(async () => {
      if (!account) throw new Error("Select an active GitHub App installation.");
      const result = await request({ data: { account, permission, access, reason } });
      setMessage(
        `Permission request ${result.requestId} was recorded. No permission has been changed.`,
      );
      setReason("");
      await refresh();
    });

  const decideRequest = (requestId: string, decision: "approve" | "deny") =>
    run(async () => {
      const grantId =
        decision === "approve"
          ? await stepUp("privilege_escalation", `provider_permission:${requestId}`)
          : undefined;
      await decide({ data: { requestId, decision, grantId } });
      setMessage(
        decision === "approve"
          ? "Approved. Use GitHub's official settings page to review and apply the requested permission; Jackboy will verify the provider-reported result."
          : "Permission request denied and recorded.",
      );
      await refresh();
    });

  const requests = useMemo(() => {
    if (!dashboard) return [];
    return dashboard.events
      .filter((event) => event.event === "requested")
      .map((event) => {
        const history = dashboard.events
          .filter((row) => row.request_id === event.request_id)
          .sort((a, b) => a.created_at.localeCompare(b.created_at));
        const decision = history.find((row) => row.event === "approved" || row.event === "denied");
        const applied = history.find((row) => row.event === "applied");
        return { event, decision, applied, pending: !decision };
      });
  }, [dashboard]);

  useEffect(() => {
    const supported = selectedCatalog.levels as readonly string[];
    if (!supported.includes(access)) setAccess(supported.includes("read") ? "read" : "write");
  }, [access, selectedCatalog]);

  useEffect(() => {
    if (!account && dashboard?.installations[0]) setAccount(dashboard.installations[0].account);
  }, [account, dashboard]);

  return (
    <>
      <PageHeader
        title="Provider access"
        subtitle="Review live GitHub App permissions, request only scoped increases, and record approval and provider-reported changes."
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

      <section className="panel mb-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">GitHub App permissions</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {dashboard?.configured
                ? `App ${dashboard.appSlug ?? "Jackboy"}${dashboard.appOwner ? ` · owned by ${dashboard.appOwner}` : ""}. Permission snapshots are read from live installations.`
                : "No GitHub App is configured. Create and install the app through the existing GitHub setup flow first."}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            Refresh from GitHub
          </Button>
        </div>
        {dashboard?.installations.length ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {dashboard.installations.map((install) => (
              <article key={install.account} className="rounded-md border border-border p-3">
                <h3 className="font-medium">
                  {install.account}{" "}
                  <span className="text-xs text-muted-foreground">({install.accountType})</span>
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Verified{" "}
                  {install.verifiedAt ? new Date(install.verifiedAt).toLocaleString() : "not yet"}
                </p>
                <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  {Object.entries(install.permissions).map(([key, value]) => (
                    <li key={key}>
                      <span className="text-muted-foreground">
                        {dashboard.catalog.find((item) => item.key === key)?.label ?? key}:
                      </span>{" "}
                      {permissionLevel(value)}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            No active installation permission snapshot is available.
          </p>
        )}
      </section>

      <section className="panel mb-5 p-5">
        <h2 className="text-lg font-semibold">Request a permission increase</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Requests are audit-logged. Owner/admin approval requires a passkey. Applying the change
          happens only in GitHub; Jackboy never grants itself access.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            Installation account
            <select
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">Select installation</option>
              {dashboard?.installations.map((item) => (
                <option key={item.account} value={item.account}>
                  {item.account}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Permission
            <select
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2"
              value={permission}
              onChange={(e) => setPermission(e.target.value)}
            >
              {dashboard?.catalog.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label} (currently{" "}
                  {permissionLevel(
                    dashboard.installations.find((i) => i.account === account)?.permissions[
                      item.key
                    ],
                  )}
                  )
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Requested access
            <select
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2"
              value={access}
              onChange={(e) => setAccess(e.target.value as "read" | "write")}
            >
              {selectedCatalog.levels.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Reason
            <input
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain the task that requires this scope"
            />
          </label>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Current access for {permission}: {currentAccess}. Available request scopes are a bounded
          catalog, not a provider grant.
        </p>
        <Button
          className="mt-3"
          disabled={busy || !dashboard?.configured || !account || reason.trim().length < 8}
          onClick={() => void submitRequest()}
        >
          Record permission request
        </Button>
      </section>

      <section className="panel mb-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Request ledger</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Provider changes are verified on refresh and remain visible in the append-only audit
              ledger.
            </p>
          </div>
          <a
            className="text-sm text-electric underline"
            href={dashboard?.settingsUrl ?? "https://github.com/settings/apps"}
            target="_blank"
            rel="noreferrer"
          >
            Open GitHub App settings
          </a>
        </div>
        <div className="mt-4 space-y-3">
          {requests.length ? (
            requests.map(({ event, decision, applied, pending }) => (
              <article key={event.request_id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">
                      {event.permission}: {event.before_access ?? "none"} → {event.after_access}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {event.target} · requested {new Date(event.created_at).toLocaleString()} ·{" "}
                      {event.reason}
                    </p>
                    <p className="mt-1 text-xs">
                      Status:{" "}
                      {applied
                        ? "Applied and verified"
                        : (decision?.event ?? "Pending owner/admin approval")}
                    </p>
                  </div>
                  {pending && (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void decideRequest(event.request_id!, "approve")}
                      >
                        Approve with passkey
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void decideRequest(event.request_id!, "deny")}
                      >
                        Deny
                      </Button>
                    </div>
                  )}
                </div>
              </article>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No permission requests recorded.</p>
          )}
        </div>
      </section>

      <section className="panel p-5">
        <h2 className="text-lg font-semibold">Observed permission changes</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {dashboard?.events
            .filter((event) => event.event === "changed")
            .map((event) => (
              <li key={event.event_id} className="border-t border-border pt-2">
                {event.target} · {event.permission}: {event.before_access ?? "none"} →{" "}
                {event.after_access} · {new Date(event.created_at).toLocaleString()}
              </li>
            ))}
          {!dashboard?.events.some((event) => event.event === "changed") && (
            <li className="text-muted-foreground">No permission changes have been observed yet.</li>
          )}
        </ul>
      </section>
    </>
  );
}
