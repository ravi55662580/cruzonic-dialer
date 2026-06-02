-- =====================================================================
-- 003 — Split agent role into sales / support
--
-- The dialer originally had one role ("agent"). Now we differentiate between
-- sales agents (call from the sales Twilio number) and support agents (call
-- from the support number). Admins are unchanged.
--
-- Run in Supabase SQL editor or via `supabase db push`. Safe to re-run.
-- =====================================================================

-- Step 1: drop any existing role constraint so we can replace it.
ALTER TABLE public.profiles
    DROP CONSTRAINT IF EXISTS profiles_role_check;

-- Step 2: migrate everyone currently on the legacy 'agent' role to 'sales'.
-- (Admin can flip individuals to 'support' from the admin UI afterwards.)
UPDATE public.profiles
    SET role = 'sales'
    WHERE role = 'agent';

-- Step 3: add the new constraint. We keep 'agent' as an allowed legacy value
-- for safety in case any orphan rows survive the UPDATE above; the admin UI
-- will only ever write 'sales' or 'support' going forward.
ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_role_check
    CHECK (role IN ('admin', 'sales', 'support', 'agent'));

-- Step 4: index on (is_active, role) — the voice TwiML route looks up profiles
-- by email and reads `role`, so an index on `role` alone isn't useful, but a
-- composite helps the admin agents list page that filters active by role.
CREATE INDEX IF NOT EXISTS profiles_active_role_idx
    ON public.profiles (is_active, role);
