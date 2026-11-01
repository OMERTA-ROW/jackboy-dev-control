ALTER TABLE public.owner_projects ALTER COLUMN repair_policy SET DEFAULT 'autopilot';
UPDATE public.owner_projects SET repair_policy = 'autopilot' WHERE repair_policy = 'approve';
COMMENT ON COLUMN public.owner_projects.repair_policy IS 'autopilot = repairs follow Autopilot switches; approve = always queue repairs for owner approval. Demo removals always require approval.';