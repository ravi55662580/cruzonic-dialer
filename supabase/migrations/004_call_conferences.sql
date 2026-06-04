-- =====================================================================
-- 004 — Warm-transfer + live-listen via Twilio Conferences
--
-- When an agent clicks "Transfer" or an admin clicks "Listen", the server
-- moves the existing 2-party call into a Twilio Conference and dials a
-- third party into it. We track conference state in these tables so the
-- dialer + admin UIs can show live participant updates via Supabase
-- Realtime.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.call_conferences (
    id                  BIGSERIAL PRIMARY KEY,
    conference_name     TEXT NOT NULL UNIQUE,
    original_call_sid   TEXT NOT NULL,
    /* Who triggered the conference and why. */
    started_by_agent    TEXT,
    purpose             TEXT NOT NULL CHECK (purpose IN ('transfer', 'monitor')),
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS call_conferences_call_sid_idx
    ON public.call_conferences (original_call_sid);

CREATE INDEX IF NOT EXISTS call_conferences_started_at_idx
    ON public.call_conferences (started_at DESC);

CREATE TABLE IF NOT EXISTS public.conference_participants (
    id                  BIGSERIAL PRIMARY KEY,
    conference_name     TEXT NOT NULL,
    call_sid            TEXT NOT NULL,
    /* Free-form label so the UI can show the right pill text. */
    role                TEXT NOT NULL CHECK (role IN ('agent', 'customer', 'transfer-target', 'monitor')),
    display_name        TEXT,
    phone_number        TEXT,
    is_muted            BOOLEAN NOT NULL DEFAULT FALSE,
    joined_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at             TIMESTAMPTZ,
    UNIQUE (conference_name, call_sid)
);

CREATE INDEX IF NOT EXISTS conference_participants_conf_idx
    ON public.conference_participants (conference_name);

-- Realtime so the dialer + admin can subscribe to participant changes.
ALTER PUBLICATION supabase_realtime ADD TABLE public.call_conferences;
ALTER PUBLICATION supabase_realtime ADD TABLE public.conference_participants;

-- RLS — read-only for authenticated users, writes via service role only.
ALTER TABLE public.call_conferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conference_participants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated read call_conferences" ON public.call_conferences;
CREATE POLICY "authenticated read call_conferences"
    ON public.call_conferences
    FOR SELECT
    TO authenticated
    USING (true);

DROP POLICY IF EXISTS "authenticated read conference_participants" ON public.conference_participants;
CREATE POLICY "authenticated read conference_participants"
    ON public.conference_participants
    FOR SELECT
    TO authenticated
    USING (true);
