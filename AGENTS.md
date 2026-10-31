<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Jackboy rules
- App state (mode, opt-ins, suggestions, logs) lives in `src/lib/jackboy-store.ts` (localStorage) until accounts exist — no backend is enabled yet.
- Layout/code changes are only proposed as suggestions and applied via `resolveSuggestion` after explicit approval, which writes to the log.
- Shared shell/navigation is `src/components/AppShell.tsx`, rendered from `__root.tsx`.
- Technology Discovery lives in `src/lib/discovery.ts` (source registry, dedupe, ranking, local state) and `src/routes/discovery.tsx`; it is opt-in and uses demo data until a backend can fetch public APIs/RSS on a schedule. Facts and AI hypotheses must stay visually separated.
