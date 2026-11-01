import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";

export const Route = createFileRoute("/_authenticated/jax")({
  head: () => ({
    meta: [
      { title: "JAX Releases — Jackboy" },
      { name: "description", content: "JAX commercialization and distribution, available after it is authorized and connected." },
      { property: "og:title", content: "JAX Releases — Jackboy" },
      { property: "og:description", content: "Owner-approved release distribution through JAX." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Jax,
});

function Jax() {
  return (
    <>
      <PageHeader title="JAX" subtitle="Commercialization and distribution of owner-approved releases." />
      <section className="panel p-6 text-sm">
        <p className="font-medium">JAX is not connected. There are no releases, sales or revenue to show.</p>
        <p className="mt-2 text-muted-foreground">Nothing is sold or distributed from Jackboy. This page will show real releases and verified payments only after JAX is authorized and connected.</p>
      </section>
    </>
  );
}
