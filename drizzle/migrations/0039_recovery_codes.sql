-- One-time MFA recovery codes (hash only). NOT YET APPLIED: requires owner approval (shared preview/live database).
create table public.mfa_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  code_hash text not null unique,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create index mfa_recovery_codes_user_idx on public.mfa_recovery_codes(user_id);
grant select on public.mfa_recovery_codes to authenticated;
grant all on public.mfa_recovery_codes to service_role;
alter table public.mfa_recovery_codes enable row level security;
-- Users may only see whether their own codes exist/are used; hashes are written and consumed server-side.
create policy "own recovery code status" on public.mfa_recovery_codes for select to authenticated using (user_id = auth.uid());
