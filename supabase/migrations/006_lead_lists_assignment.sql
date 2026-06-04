-- =====================================================================
-- 006 — Admin-assignable power-dial lists
--
-- Lets admins upload a CSV and assign it to one specific agent. The agent
-- (and only that agent) can see the list in their dialer.
--
-- This migration is idempotent. If lead_lists / leads already exist from
-- an earlier setup, only the missing columns + policies get added.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.lead_lists (
    id              BIGSERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    /* Owner: NULL = visible to everyone (legacy/global list). Otherwise the
       profiles.id of the agent who can see it. */
    agent_id        UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    /* Free-form notes from the admin (optional). */
    notes           TEXT,
    lead_count      INTEGER NOT NULL DEFAULT 0,
    /* Who uploaded it. */
    created_by      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safety net: add columns if the table existed in a leaner form
ALTER TABLE public.lead_lists
    ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.lead_lists
    ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE public.lead_lists
    ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lead_lists_agent_id_idx
    ON public.lead_lists (agent_id);

CREATE TABLE IF NOT EXISTS public.leads (
    id              BIGSERIAL PRIMARY KEY,
    list_id         BIGINT REFERENCES public.lead_lists(id) ON DELETE CASCADE,
    phone           TEXT NOT NULL,
    first_name      TEXT,
    last_name       TEXT,
    company         TEXT,
    email           TEXT,
    city            TEXT,
    state           TEXT,
    custom1         TEXT,
    custom2         TEXT,
    custom3         TEXT,
    /* Free-form extra columns from CSV (keys the admin saw fit to keep). */
    extra           JSONB DEFAULT '{}'::jsonb,
    status          TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'called', 'contacted', 'callback', 'dnc', 'completed')),
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.leads
    ADD COLUMN IF NOT EXISTS extra JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS leads_list_id_idx
    ON public.leads (list_id);

-- ─── RLS ───────────────────────────────────────────────────────────
ALTER TABLE public.lead_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

-- Agents see lists assigned to them OR unassigned (NULL).
DROP POLICY IF EXISTS "agents read own lead_lists" ON public.lead_lists;
CREATE POLICY "agents read own lead_lists"
    ON public.lead_lists
    FOR SELECT
    TO authenticated
    USING (agent_id IS NULL OR agent_id = auth.uid());

-- Agents see leads in any lead_list they can see.
DROP POLICY IF EXISTS "agents read own leads" ON public.leads;
CREATE POLICY "agents read own leads"
    ON public.leads
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.lead_lists ll
            WHERE ll.id = leads.list_id
              AND (ll.agent_id IS NULL OR ll.agent_id = auth.uid())
        )
    );

-- Agents can update lead status / notes for leads in lists they own.
DROP POLICY IF EXISTS "agents update own leads" ON public.leads;
CREATE POLICY "agents update own leads"
    ON public.leads
    FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.lead_lists ll
            WHERE ll.id = leads.list_id
              AND (ll.agent_id IS NULL OR ll.agent_id = auth.uid())
        )
    );

-- Writes (insert lists/leads, delete) flow through the service role,
-- which always bypasses RLS — no INSERT/DELETE policies needed.
