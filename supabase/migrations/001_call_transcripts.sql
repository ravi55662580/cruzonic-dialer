-- =====================================================================
-- 001_call_transcripts — Phase 1 of live call coaching
--
-- Stores transcribed chunks produced by the stream-bridge. The dialer
-- UI subscribes via Supabase Realtime filtered by call_sid.
--
-- Run this in the Supabase SQL editor (or `supabase db push`) before
-- deploying the bridge.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.call_transcripts (
    id          BIGSERIAL PRIMARY KEY,
    call_sid    TEXT NOT NULL,
    speaker     TEXT NOT NULL CHECK (speaker IN ('agent', 'customer', 'unknown')),
    text        TEXT NOT NULL,
    is_final    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS call_transcripts_call_sid_idx
    ON public.call_transcripts (call_sid, created_at);

-- Enable Realtime for this table so the dialer can subscribe to inserts.
-- (`supabase_realtime` is the default publication Supabase ships with.)
ALTER PUBLICATION supabase_realtime ADD TABLE public.call_transcripts;

-- =====================================================================
-- RLS
-- =====================================================================
-- The bridge inserts via the service role key, which always bypasses RLS,
-- so writes don't need a policy. We do want a read policy so that agents
-- can read their own call's transcripts from the browser using the anon
-- key — but at the moment we have no DB-level mapping from call_sid →
-- agent (only call_logs has agent_id, and it may be inserted after the
-- transcript starts streaming).
--
-- For Phase 1 we expose read access to all authenticated users. Tighten
-- this in Phase 2 once we have a proper call → agent join.
-- =====================================================================

ALTER TABLE public.call_transcripts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated can read transcripts" ON public.call_transcripts;
CREATE POLICY "authenticated can read transcripts"
    ON public.call_transcripts
    FOR SELECT
    TO authenticated
    USING (true);

-- (No INSERT / UPDATE / DELETE policy — only the service role writes.)
