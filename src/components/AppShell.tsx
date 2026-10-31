import { Link } from "@tanstack/react-router";
import { LayoutGrid, Radar, Code2, ScrollText, Plug, ShieldCheck, Eye } from "lucide-react";
import type { ReactNode } from "react";
import { setState, useJackboy, log } from "@/lib/jackboy-store";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutGrid },
  { to: "/workspace", label: "Inspect", icon: Code2 },
  { to: "/discovery", label: "Discovery", icon: Radar },
  { to: "/activity", label: "Logs & Approvals", icon: ScrollText },
  { to: "/integrations", label: "Integrations", icon: Plug },
  { to: "/access", label: "Access", icon: ShieldCheck },
] as const;

function Hex({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function ModeToggle() {
  const { mode } = useJackboy();
  const set = (m: "classic" | "assist") => {
    if (m === mode) return;
    setState((s) => ({ ...s, mode: m }));
    log("info", `Switched to ${m === "classic" ? "Classic View" : "Jackboy Assist"}.`);
  };
  return (
    <div role="radiogroup" aria-label="View mode" className="inline-flex rounded-md border border-border bg-muted p-0.5 text-xs font-medium">
      {(["classic", "assist"] as const).map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={mode === m}
          onClick={() => set(m)}
          className={`rounded px-3 py-1.5 transition-colors ${mode === m ? (m === "assist" ? "bg-primary text-primary-foreground" : "bg-secondary text-silver") : "text-muted-foreground hover:text-foreground"}`}
        >
          {m === "classic" ? "Classic View" : "Jackboy Assist"}
        </button>
      ))}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen md:flex">
      <aside className="hidden w-60 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col">
        <div className="flex items-center gap-2 px-5 py-5">
          <Hex className="h-7 w-7 text-silver" />
          <div>
            <div className="text-metal font-display text-xl font-bold tracking-wider">JACKBOY</div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">OMNI · Dev Ops</div>
          </div>
        </div>
        <nav aria-label="Main" className="flex flex-col gap-1 px-3">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact: to === "/" }}
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
              activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground border-l-2 border-electric" }}
            >
              <Icon className="h-4 w-4" aria-hidden /> {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto m-3 rounded-md border border-border p-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2 text-silver"><Eye className="h-3.5 w-3.5" /> Read-only mode</div>
          <p className="mt-1">No integrations connected. All data shown is local demo data.</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col pb-20 md:pb-0">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-background/85 px-4 py-3 backdrop-blur md:px-8">
          <div className="flex items-center gap-2 md:hidden">
            <Hex className="h-6 w-6 text-silver" />
            <span className="text-metal font-display text-lg font-bold tracking-wider">JACKBOY</span>
          </div>
          <span className="hidden rounded border border-warning/40 px-2 py-0.5 text-[11px] uppercase tracking-wider text-warning md:inline">Demo data</span>
          <ModeToggle />
        </header>
        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>

      <nav aria-label="Main mobile" className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-6 border-t border-border bg-sidebar md:hidden">
        {NAV.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact: to === "/" }}
            className="flex flex-col items-center gap-1 py-2.5 text-[10px] text-muted-foreground"
            activeProps={{ className: "text-electric" }}
          >
            <Icon className="h-5 w-5" aria-hidden />
            <span className="truncate">{label.split(" ")[0]}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-silver md:text-3xl">{title}</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}

export function GuidanceTip({ children }: { children: ReactNode }) {
  const { mode, guidance } = useJackboy();
  if (mode !== "assist" || !guidance) return null;
  return (
    <div role="note" className="mb-4 flex gap-2 rounded-md border border-electric/40 bg-accent/40 p-3 text-sm text-accent-foreground">
      <Hex className="mt-0.5 h-4 w-4 shrink-0 text-electric" />
      <div>{children}</div>
    </div>
  );
}
