# Universal CODE, Jackboy, Razool and Mothership integration contract

Status: **architecture and implementation backlog only**. This file does not activate agents, integrations, monitoring, e-filing, spending or deployments. Related proposal: PR #83 (docs-only); this contract corrects its role boundaries.

## Non-negotiable roles
- **Mothership:** ecosystem oversight, integration health, approvals and audit visibility.
- **OMNI:** orchestration and user-facing Mac/web terminal. Launch universal CODE by typing `omni`; automatically route natural-language requests to capabilities without manual mode selection.
- **CODE:** one universal, owner-authorized task execution engine across isolated concurrent terminal sessions, persistent resumable jobs, domain tools and connector workflows. GitHub development is an optional capability, **not** its defining purpose or a master gate for ordinary tasks.
- **Jackboy:** dedicated software developer and maintainer only: build websites/apps, diagnose, design, code, test, prepare and distribute updates, open PRs, track deployment/verification and continuously improve operational software. Owner reviews and merges PRs; Jackboy does not independently merge or deploy.
- **Razool:** central discovery, verification, knowledge provenance, gap detection, update prioritization and targeted intelligence distribution across counterparts. Broad monitoring of *permitted* public/authorized sources; no claim to see the entire internet.
- **Other counterparts** (including Honeycomb, Hercules, Evolution, JAX): subscribe to relevant verified intelligence/capability events; act only within their own explicit permissions.

## Shared foundation and acceptance criteria
1. Capability registry: supported tools, versions, requirements, connector state, risks and owner authorization. Unknown/unconnected capabilities must be reported honestly.
2. Natural-language planner: infer task intent, combine multiple domain tools, explain plan, execute authorized steps and produce verifiable artifacts/results.
3. Persistent job store: per-project context, multiple concurrent `omni` sessions, durable status, resumption, scheduled work, isolated workspaces, history.
4. Permission engine: scoped, revocable, time/budget-bounded permits; routine authorized steps can run; payments, legal certifications, binding filings, rights transfers and production deployments require explicit appropriate approval. Emergency Stop, audit, safe failures.
5. Counterpart event bus: typed events (intelligence.discovered, intelligence.verified, capability.proposed, capability.available, security.alert, task.completed, update.deployed); source/version/recipient, delivery acknowledgement, deduplication, offline replay and least-privilege access. Notifications never confer authority.
6. Razool intelligence ledger: source URLs, timestamps, verification status, confidence, version/diff, affected counterparts, acknowledgement and knowledge-gap queue; distinguish official guidance from unverified claims. Scheduled prioritized monitoring, not impossible universal surveillance.
7. Universal preflight: platform-specific formatting, metadata, missing documents, licenses/rights, permissions, security and compliance checks; classify ready / corrections / review needed; remediate permitted issues, rerun checks, retain evidence. No guarantee of platform acceptance or legal compliance.
8. Founder-first acceptance: prove on the owner's Mac and connected accounts with end-to-end test evidence before broader rollout. Keep implementation PRs scoped and testable.

## Domain workflows for CODE
- **Records and forms:** navigate official county/agency sources; identify jurisdiction, court, case type, form catalog and rules; assist authorized records requests; reconstruct photographed forms as editable versions; prefer official templates; autofill only verified case data; preserve originals, cite sources, show previews.
- **Court and legal admin:** organize dispositions, police reports, exhibits, docket entries and timelines; compare inconsistencies; source-backed procedural research, deadlines with jurisdiction-specific calculations and uncertainty; court-specific filing categories, format/service/fee checks; assisted authorized e-filing with explicit final approval, receipt capture and separate submitted vs accepted status. No unauthorized legal practice.
- **Music and rights:** composition vs sound recording rights, registrations, songwriter/publisher/master splits, ISRC/ISWC, distribution, PROs, MLC, SoundExchange, sync/licensing submissions, royalty reconciliation, inheritance/estate documentation with verified entitlement. No assumption that a death certificate alone transfers rights.
- **Release and video:** account-specific distributor/VEVO/YouTube workflows, audiovisual rights, Content ID eligibility, metadata, video/audio QC, scheduled releases, promotional clips, platform requirements, monitoring. Billboard charts are not a direct song-registration service; interpret chart intent correctly. TAXI licensing opportunities differ from BMI performing-rights administration.
- **Other work:** podcasts, media editing, nonprofit/business administration, taxes and documents through the same universal planner and appropriate domain connectors.

## Engineering rollout (each phase requires implementation, tests and review)
A. Inventory actual repos, integrations, terminal entrypoint, agent boundaries, existing permissions and safety gates; reconcile PR #83's incorrect assumption that CODE is coding-only.
B. Implement registry, task routing, permits, event schema, audit and counterpart notification acknowledgements with tests.
C. Implement persistent concurrent CODE sessions and one safe end-to-end owner-approved task.
D. Implement Razool ingestion, provenance, verified distribution, gap detection and counterpart update status.
E. Add document/photo-to-form, official-source navigation and legal-admin preflight in a sandbox; test against fixtures before any real filing.
F. Add music/rights/video connectors and preflight, each with real-account authorization and staged verification.
G. Integrate Jackboy software-maintenance PR pipeline and owner review; validate deployed changes and event propagation.

## Definition of done
Each feature must have executable code, tests, permission checks, observable evidence, integration status and rollback/stop behavior. Documentation alone is **not** proof that a capability is operational. Do not merge a proposal expecting functionality to activate.
