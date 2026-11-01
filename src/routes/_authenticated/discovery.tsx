import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";

export const Route = createFileRoute("/_authenticated/discovery")({
  head: () => ({
    meta: [
      { title: "Technology Discovery — Jackboy" },
      { name: "description", content: "Technology discovery from lawful public sources, once a live source is connected." },
      { property: "og:title", content: "Technology Discovery — Jackboy" },
      { property: "og:description", content: "Owner-controlled technology discovery." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Discovery,
});

function Discovery() {
  return (
    <>
      <PageHeader title="Technology Discovery" subtitle="Finds new tools, research and prototypes from lawful public sources." />
      <section className="panel p-6 text-sm">
        <p className="font-medium">No discovery sources are connected, so there are no findings to show.</p>
        <p className="mt-2 text-muted-foreground">
          Live web search is available on{" "}
          <Link to="/research" className="text-electric underline">Research</Link> once a search key is configured. Findings will appear here only from real sources, with citations.
        </p>
      </section>
    </>
  );
}
