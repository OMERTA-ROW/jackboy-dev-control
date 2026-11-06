import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  approveOmniReceipt,
  loadOmniReceiptGrant,
  previewOmniReceipt,
  revokeOmniReceipt,
  sendOmniReceipt,
} from "@/lib/omni-link.functions";
import { useStepUp } from "@/lib/step-up-client";

type Preview = Awaited<ReturnType<typeof previewOmniReceipt>>;
type Grant = Awaited<ReturnType<typeof approveOmniReceipt>>;

export function OmniDispatchReview() {
  const preview = useServerFn(previewOmniReceipt);
  const approve = useServerFn(approveOmniReceipt);
  const loadGrant = useServerFn(loadOmniReceiptGrant);
  const revoke = useServerFn(revokeOmniReceipt);
  const send = useServerFn(sendOmniReceipt);
  const stepUp = useStepUp();
  const [jobId, setJobId] = useState("");
  const [existingGrantId, setExistingGrantId] = useState("");
  const [review, setReview] = useState<Preview | null>(null);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function act(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request not confirmed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel mb-4 space-y-3 p-4 text-sm">
      <h2 className="font-semibold">Receive-only dispatch review</h2>
      <p>
        Only one reviewed test job can be quarantined. No job execution is enabled. Both services
        need separate grants; revoking one does not revoke the other.
      </p>
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
      {review && !grant && (
        <div className="space-y-2">
          <p>
            Job: {review.jobId}
            <br />
            Project: {review.projectId}
            <br />
            Repository: {review.repo}
            <br />
            Kind: {review.kind}
          </p>
          <p>Exact instructions:</p>
          <pre className="whitespace-pre-wrap break-words rounded border p-2">
            {review.instructions}
          </pre>
          <button
            className="rounded border px-3 py-1"
            disabled={busy}
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
      {message && <p role="status">{message}</p>}
    </section>
  );
}
