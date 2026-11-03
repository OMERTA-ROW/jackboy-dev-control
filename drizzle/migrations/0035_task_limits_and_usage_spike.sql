ALTER TABLE public.foundry_schedule ADD COLUMN IF NOT EXISTS spike_limit_per_hour integer NOT NULL DEFAULT 12;
ALTER TABLE public.foundry_schedule ADD COLUMN IF NOT EXISTS spike_reason text;
ALTER TABLE public.foundry_schedule ADD COLUMN IF NOT EXISTS spike_paused_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS foundry_tasks_one_active_per_project ON public.foundry_tasks (project_id) WHERE state IN ('analyzing','patch_prepared','testing','approved','executing','verifying');