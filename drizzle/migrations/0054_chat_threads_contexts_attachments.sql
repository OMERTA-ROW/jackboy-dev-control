-- Owner chat: durable conversations, configured agent contexts with stored notes, private attachments.
CREATE TABLE public.chat_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  role text NOT NULL DEFAULT '' CHECK (char_length(role) <= 200),
  kind text NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent','visual_observer')),
  project_id uuid REFERENCES public.owner_projects(id) ON DELETE SET NULL,
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 8000),
  notes_updated_at timestamptz,
  notes_updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_contexts TO authenticated;
GRANT ALL ON public.chat_contexts TO service_role;
ALTER TABLE public.chat_contexts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads chat contexts" ON public.chat_contexts FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));
CREATE POLICY "owner adds chat contexts" ON public.chat_contexts FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'owner'::app_role));
CREATE POLICY "owner edits chat contexts" ON public.chat_contexts FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role)) WITH CHECK (public.has_role(auth.uid(), 'owner'::app_role));
CREATE POLICY "owner removes chat contexts" ON public.chat_contexts FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));

-- Named agents the owner asked for. Notes start empty: nothing is invented; the owner fills them in.
INSERT INTO public.chat_contexts (slug, name, role, kind, project_id)
SELECT 'omni', 'OMNI', 'Build and test engine', 'agent', (SELECT id FROM public.owner_projects WHERE name = 'OMNI internal build' LIMIT 1)
UNION ALL SELECT 'jax', 'JAX', 'Packaging and distribution', 'agent', (SELECT id FROM public.owner_projects WHERE name = 'Jax Data Concierge' LIMIT 1)
UNION ALL SELECT 'razul', 'Razul', 'Research and oversight', 'agent', (SELECT id FROM public.owner_projects WHERE name = 'Razul Centrial Intelligence' LIMIT 1)
UNION ALL SELECT 'iggy', 'Iggy', 'Visual observer', 'visual_observer', NULL::uuid;

CREATE TABLE public.chat_threads (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  mode text NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat','code')),
  title text NOT NULL DEFAULT 'New conversation' CHECK (char_length(title) BETWEEN 1 AND 120),
  context_key text NOT NULL DEFAULT 'jackboy' CHECK (char_length(context_key) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_threads_owner_idx ON public.chat_threads (owner_id, updated_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_threads TO authenticated;
GRANT ALL ON public.chat_threads TO service_role;
ALTER TABLE public.chat_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads own threads" ON public.chat_threads FOR SELECT TO authenticated USING (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role));
CREATE POLICY "owner adds own threads" ON public.chat_threads FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role));
CREATE POLICY "owner edits own threads" ON public.chat_threads FOR UPDATE TO authenticated USING (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role)) WITH CHECK (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role));
CREATE POLICY "owner removes own threads" ON public.chat_threads FOR DELETE TO authenticated USING (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role));

CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.chat_threads(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  ui_id text NOT NULL CHECK (char_length(ui_id) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('user','assistant','system')),
  author text NOT NULL DEFAULT '' CHECK (char_length(author) <= 80),
  context_key text CHECK (context_key IS NULL OR char_length(context_key) <= 80),
  parts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (octet_length(parts::text) <= 300000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 20000),
  content text NOT NULL DEFAULT '' CHECK (char_length(content) <= 40000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, ui_id)
);
CREATE INDEX chat_messages_thread_idx ON public.chat_messages (thread_id, created_at);
CREATE INDEX chat_messages_owner_idx ON public.chat_messages (owner_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_messages TO authenticated;
GRANT ALL ON public.chat_messages TO service_role;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads own messages" ON public.chat_messages FOR SELECT TO authenticated USING (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role));
CREATE POLICY "owner adds own messages" ON public.chat_messages FOR INSERT TO authenticated WITH CHECK (
  owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role)
  AND EXISTS (SELECT 1 FROM public.chat_threads t WHERE t.id = thread_id AND t.owner_id = auth.uid()));
CREATE POLICY "owner edits own messages" ON public.chat_messages FOR UPDATE TO authenticated USING (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role)) WITH CHECK (
  owner_id = auth.uid() AND EXISTS (SELECT 1 FROM public.chat_threads t WHERE t.id = thread_id AND t.owner_id = auth.uid()));
CREATE POLICY "owner removes own messages" ON public.chat_messages FOR DELETE TO authenticated USING (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role));

-- Private attachments: only the owner, only inside their own folder.
CREATE POLICY "owner reads own chat attachments" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'chat-attachments' AND public.has_role(auth.uid(), 'owner'::app_role) AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "owner uploads own chat attachments" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chat-attachments' AND public.has_role(auth.uid(), 'owner'::app_role) AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "owner deletes own chat attachments" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'chat-attachments' AND public.has_role(auth.uid(), 'owner'::app_role) AND (storage.foldername(name))[1] = auth.uid()::text);