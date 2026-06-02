# Bridge Deploy Runbook — copy/paste

Three steps. ~5 minutes total. Run them on your laptop (not in a CI runner).

## 1. Install flyctl (one-time)

macOS:
```bash
brew install flyctl
```

Other OSes: `curl -L https://fly.io/install.sh | sh`

Then authenticate:
```bash
fly auth signup     # or `fly auth login` if you already have an account
```

Fly will ask for a credit card. The bridge runs on a shared-cpu-1x machine which is free under the no-cost tier as long as you stay inside their free allowance. Expect $0 in most months; a busy production dialer might hit a few dollars/month.

## 2. Launch the app (one-time per environment)

From inside the `bridge/` folder:

```bash
cd bridge
fly launch --no-deploy --copy-config --name cruzonic-stream-bridge
```

It will read `fly.toml` and ask a couple of questions:
- "Would you like to copy its configuration?" → **Yes** (we already have a `fly.toml`)
- Region → **ord** (or whichever is closest to your Twilio edge — Twilio is in many regions)
- Postgres / Redis → **No** (we use Supabase, not Fly Postgres)

This just creates the app on Fly; nothing is deployed yet.

## 3. Set secrets + deploy

Paste this whole block (already has the right values from `bridge/.env`):

```bash
fly secrets set \
  STT_PROVIDER=deepgram \
  DEEPGRAM_API_KEY=971713e5c4d899754bbfe0b0140cf750ebfbfc2c \
  SUPABASE_URL=https://kelqaixboklrdguikvqw.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtlbHFhaXhib2tscmRndWlrdnF3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDUxNTA5MCwiZXhwIjoyMDkwMDkxMDkwfQ.d7vDa_qNHca7HHaFZS9nx9lZwrSb16c7m1Y3Ml716-k' \
  BRIDGE_SHARED_SECRET=981f394b02a702ca6a5a085cac316c50

fly deploy
```

The first deploy takes ~2 minutes (it builds the Docker image, ships it, starts a machine). Wait for `Machine ... started`.

## 4. Sanity-check it's live

```bash
fly status                              # should show 1 machine, started
curl https://cruzonic-stream-bridge.fly.dev/healthz   # → "ok"
fly logs                                 # tail logs (Ctrl-C to exit)
```

## 5. Tell the dialer where the bridge lives

In your Vercel project → **Settings → Environment Variables**, add:

```
STREAM_BRIDGE_URL     = wss://cruzonic-stream-bridge.fly.dev
BRIDGE_SHARED_SECRET  = 981f394b02a702ca6a5a085cac316c50
```

(The shared secret must match Fly's — they're the same value.)

Also update `.env.local` for local dev: uncomment the `STREAM_BRIDGE_URL=` line.

Redeploy Vercel (`vercel --prod` or push to main).

## 6. End-to-end smoke

Open the dialer, dial your own cell phone, say a few words. Within ~1 second, transcription should appear in the live coach panel, and the AI suggestion chips should populate after the customer (your cell) speaks.

If nothing shows up:

```bash
fly logs                                 # look for `stream started` + `STT_PROVIDER: deepgram`
```

If Fly logs say `Deepgram open timeout` or `STT error:`, the Deepgram key is wrong or rate-limited — regenerate at https://console.deepgram.com.

If Fly logs look healthy but the dialer panel stays empty, check the browser console for Supabase Realtime subscription errors. Run migration 001 (`call_transcripts.sql`) if you haven't.

## 7. Update later

```bash
cd bridge
fly deploy                               # ships current code
fly secrets set DEEPGRAM_API_KEY=newkey  # rotates a single secret
fly scale count 1                        # ensure 1 always-on machine if you remove auto-stop
```
