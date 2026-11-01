ALTER TABLE public.owner_projects ADD COLUMN IF NOT EXISTS dev_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.owner_projects ADD COLUMN IF NOT EXISTS dev_priority integer NOT NULL DEFAULT 100;
COMMENT ON COLUMN public.owner_projects.dev_enabled IS 'Owner explicitly activated background development/maintenance for this project. Inventory presence never implies this.';