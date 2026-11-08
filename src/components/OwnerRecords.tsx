import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Upload } from "lucide-react";
import { importDeviceRecords, listOwnerRecords } from "@/lib/owner-records.functions";
import { DEVICE_HANDOFF_KEY, DEVICE_JAX_KEY, parseDeviceList, pendingDeviceIds } from "@/lib/owner-records";

export type OwnerRecords = Awaited<ReturnType<typeof listOwnerRecords>>;

/** Saved OMNI handoffs + JAX drafts for the signed-in owner, re-read on focus. */
export function useOwnerRecords() {
  const load = useServerFn(listOwnerRecords);
  const [data, setData] = useState<OwnerRecords | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [load]);
  useEffect(() => {
    void refresh();
    const onFocus = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  }, [refresh]);
  return { data, error, loading, refresh, setData };
}

function readDevice() {
  if (typeof window === "undefined") return { handoffs: [] as unknown[], manifests: [] as unknown[] };
  return {
    handoffs: parseDeviceList(window.localStorage.getItem(DEVICE_HANDOFF_KEY), "handoffs"),
    manifests: parseDeviceList(window.localStorage.getItem(DEVICE_JAX_KEY), "manifests"),
  };
}

/** One-press import of OMNI handoffs and JAX drafts saved only in this browser. Shown only when
 * this browser holds records the account doesn't have yet. The browser copy is never changed. */
export function DeviceRecordsImport({ records, onImported }: { records: OwnerRecords | null; onImported: () => Promise<void> }) {
  const run = useServerFn(importDeviceRecords);
  const [device, setDevice] = useState<{ handoffs: unknown[]; manifests: unknown[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  useEffect(() => setDevice(readDevice()), [records]);
  if (!device || !records) return null;
  const pendingH = pendingDeviceIds(device.handoffs, records.handoffSourceIds).length;
  const pendingM = pendingDeviceIds(device.manifests, records.manifestSourceIds).length;
  if (!pendingH && !pendingM && !result) return null;
  const press = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await run({ data: device });
      const invalid = r.handoffs.invalid.length + r.manifests.invalid.length;
      const already = r.handoffs.alreadySaved + r.manifests.alreadySaved;
      setResult({
        tone: invalid ? "warn" : "ok",
        text: `Saved ${r.handoffs.added} handoff(s) and ${r.manifests.added} JAX draft(s) to your account.${already ? ` ${already} were already saved.` : ""}${invalid ? ` ${invalid} couldn't be read and were skipped (listed in the Site Log).` : ""} This browser's copy was left as it was.`,
      });
      await onImported();
    } catch (e) {
      setResult({ tone: "error", text: `Import failed — nothing was changed. ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel mb-6 border-warning/40 p-4" aria-label="Records saved only on this device">
      {pendingH || pendingM ? (
        <>
          <h2 className="text-sm font-semibold text-silver">Records saved only in this browser</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            This browser holds {pendingH} OMNI handoff(s) and {pendingM} JAX draft(s) that aren't in your account yet.
            Import copies them to your account so they show on every device. Running it again never adds duplicates.
          </p>
          <button
            onClick={press}
            disabled={busy}
            className="mt-3 inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5" />
            {busy ? "Importing…" : "Import to my account"}
          </button>
        </>
      ) : null}
      {result && (
        <p role="status" className={`mt-2 text-sm ${result.tone === "error" ? "text-destructive" : result.tone === "warn" ? "text-warning" : "text-success"}`}>
          {result.text}
        </p>
      )}
    </section>
  );
}
