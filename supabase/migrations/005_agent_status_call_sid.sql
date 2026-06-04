-- =====================================================================
-- 005 — Track active Call SID per agent so admins can monitor live calls
--
-- The agent_status table broadcasts who's on a call. To "listen in" we
-- need the Twilio Call SID, not just the phone number — add a column.
-- =====================================================================

ALTER TABLE public.agent_status
    ADD COLUMN IF NOT EXISTS current_call_sid TEXT;

CREATE INDEX IF NOT EXISTS agent_status_call_sid_idx
    ON public.agent_status (current_call_sid)
    WHERE current_call_sid IS NOT NULL;
