import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  approveOmniReceipt,
  loadOmniReceiptGrant,
  previewOmniReceipt,
  revokeOmniReceipt,
  sendOmniReceipt,
} from "@/lib/omni-link.functions";
import { useStepUp } from "@/lib/step-up-client";
import { linkExpiresAt } from "@/lib/omni-handoff-auth";

type Preview = Awaited<ReturnType<typeof previewOmniReceipt>>;
type Grant = Awaited<ReturnType<typeof approveOmniReceipt>>;

export function OmniDispatchReview({
  initialJobId = "",
  initialGrantId = "",
  linkVerifiedAt = null,
  onRecheckLink,
}: {
  initialJobId?: string;
  initialGrantId?: string;
  linkVerifiedAt?: string | null;
  onRecheckLink?: () => void;
} = {}) {
  const preview = useServerFn(previewOmniReceipt);
  const approve = useServerFn(approveOmniReceipt);
  const loadGrant = useServerFn(loadOmniReceiptGrant);
  const revoke = useServerFn(revokeOmniReceipt);
  const send = useServerFn(sendOmniReceipt);
  const stepUp = useStepUp();
  const [jobId, setJobId] = useState(initialJobId);
  const [existingGrantId, setExistingGrantId] = useState(initialGrantId);
  const [review, setReview] = useState<Preview | null>(null);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLElement>(null);
  const expiresAt = linkExpiresAt(linkVerifiedAt);
  const linkFresh = expiresAt !== null && Date.parse(expiresAt) > now;
  const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(t);
  }, []);
  // "Review this job" opens straight into the review: scroll here and load the exact job once.
  useEffect(() => {
    root.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (initialJobId && !initialGrantId) void act(async () => setReview(await preview({ data: { jobId: initialJobId } })));
    else if (initialJobId && initialGrantId)
      void act(async () => setGrant(await loadGrant({ data: { jobId: initialJobId, grantId: initialGrantId } })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per opened job
  }, []);

  async function act(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await work();
    } catch (e) {
      const text = e instanceof Error ? e.message : "";
      setError(
        /cancel|abort|NotAllowed|timed out/i.test(text) || !text
          ? "Passkey not completed — nothing was approved."
          : text,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section ref={root} id="omni-review" className="panel mb-4 space-y-3 p-4 text-sm">
      <h2 className="font-semibold">Receive-only handoff review</h2>
      <p>
        One reviewed build or test job can be handed to OMNI for receipt only. Each step re-checks
        OMNI's live link, your project access and whether anything was revoked. No job execution is
        enabled. OMNI needs its own approval too; revoking one does not revoke the other.
      </p>
      {expiresAt ? (
        <p className={linkFresh ? "text-success" : "text-warning"}>
          {linkFresh
            ? `Link verified at ${hm(linkVerifiedAt!)} — approve before ${hm(expiresAt)}.`
            : `Link check from ${hm(linkVerifiedAt!)} has expired (5-minute limit).`}
        </p>
      ) : (
        <p className="text-warning">OMNI's link is not verified right now.</p>
      )}
      {!linkFresh && onRecheckLink && (
        <button type="button" className="rounded border px-3 py-1" disabled={busy} onClick={onRecheckLink}>
          Re-check link
        </button>
      )}
      <details>
      <summary className="cursor-pointer text-xs text-muted-foreground">Advanced: look up by ID</summary>
      <label className="block">
        Job UUID
        <input
          className="ml-2 rounded border bg-background p-1"
          value={jobId}
          onChange={(event) => {
            setJobId(event.target.value);
            setReview(null);
            setGrant(null);
          }}
        />
      </label>
      <button
        className="rounded border px-3 py-1"
        disabled={busy || !jobId}
        onClick={() =>
          void act(async () => {
            setGrant(null);
            setReview(await preview({ data: { jobId } }));
          })
        }
      >
        Review job
      </button>
      <label className="block">
        Existing grant UUID
        <input
          className="ml-2 rounded border bg-background p-1"
          value={existingGrantId}
          onChange={(event) => setExistingGrantId(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          className="rounded border px-3 py-1"
          disabled={busy || !jobId || !existingGrantId}
          onClick={() =>
            void act(async () => {
              setReview(null);
              setGrant(await loadGrant({ data: { jobId, grantId: existingGrantId } }));
            })
          }
        >
          Load current grant
        </button>
        <button
          className="rounded border px-3 py-1"
          disabled={busy || !jobId || !existingGrantId}
          onClick={() =>
            void act(async () => {
              await revoke({ data: { jobId, grantId: existingGrantId } });
              setGrant(null);
              setMessage("Jackboy grant revoked. Revoke the Mothership grant separately.");
            })
          }
        >
          Revoke existing grant
        </button>
      </div>
      </details>
      {review && !grant && (
        <div className="space-y-2">
          <p>
            Job: {review.jobId}
            <br />
            Project: {review.projectId}
            <br />
            Repository: {review.repo}
            <br />
            Kind: {review.kind === "code" ? "Build" : "Test"}
          </p>
          <p>Exact instructions:</p>
          <pre className="whitespace-pre-wrap break-words rounded border p-2">
            {review.instructions}
          </pre>
          <button
            className="rounded border px-3 py-1"
            disabled={busy || !linkFresh}
            title={linkFresh ? undefined : "Re-check the link first"}
            onClick={() =>
              void act(async () => {
                const grantId = await stepUp("omni_dispatch", `omni-job:${review.jobId}`);
                setGrant(
                  await approve({
                    data: {
                      jobId: review.jobId,
                      projectId: review.projectId,
                      repo: review.repo,
                      instructions: review.instructions,
                      grantId,
                    },
                  }),
                );
                setMessage(
                  "Grant issued. Independently approve the same scope in Mothership before dispatch.",
                );
              })
            }
          >
            Approve exact job with passkey
          </button>
        </div>
      )}
      {grant && (
        <div className="space-y-2">
          <p className="break-all">
            Grant: {grant.id}
            <br />
            Owner: {grant.ownerId}
            <br />
            Project: {grant.projectId}
            <br />
            Job: {grant.jobId}
            <br />
            Repository: {grant.repo}
            <br />
            Expiry: {grant.expiresAt}
            <br />
            Payload digest: {grant.payloadDigest}
          </p>
          <p>Instructions: {grant.instructions}</p>
          <div className="flex flex-wrap gap-2">
            {(["submit", "status", "cancel"] as const).map((action) => (
              <button
                key={action}
                className="rounded border px-3 py-1"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const result = await send({
                      data: { jobId: grant.jobId, grantId: grant.id, action, confirm: true },
                    });
                    setMessage(`Verified remote receipt: ${result.status}.`);
                  })
                }
              >
                {action}
              </button>
            ))}
            <button
              className="rounded border px-3 py-1"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await revoke({ data: { jobId: grant.jobId, grantId: grant.id } });
                  setGrant(null);
                  setMessage("Jackboy grant revoked. Revoke the Mothership grant separately.");
                })
              }
            >
              Revoke Jackboy grant
            </button>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded border border-destructive/60 bg-destructive/10 p-2 text-destructive">
          <span className="flex-1">{error}</span>
          <button type="button" className="text-xs underline" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}
      {message && <p role="status" className="text-success">{message}</p>}
    </section>
  );
}
