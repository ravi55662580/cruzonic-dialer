# Cruzonic Stream Bridge

A small WebSocket service that sits between Twilio's Media Streams and a
speech-to-text provider (Deepgram or AssemblyAI). It writes transcripts
into Supabase, where the dialer UI subscribes via Supabase Realtime.

This is **Phase 1** of the live-coaching feature — transcription only.
Phase 2 adds AI reply suggestions on top of the same transcript stream.

```
Twilio <Stream>  ──▶  Bridge (this service)  ──▶  Deepgram / AssemblyAI
                              │
                              ▼
                  Supabase (call_transcripts table)
                              │
                              ▼
              Dialer UI <── Supabase Realtime subscription
```

---

## 1. One-time Supabase setup

Run the migration in **Supabase → SQL Editor**:

```bash
cat ../supabase/migrations/001_call_transcripts.sql | pbcopy   # macOS
# Paste into the SQL editor and click Run.
```

Verify with:

```sql
SELECT count(*) FROM call_transcripts;       -- should return 0
```

Make sure Realtime is enabled on the table (the migration adds it to the
`supabase_realtime` publication automatically).

---

## 2. Sign up for an STT provider

Pick one:

- **Deepgram** — https://deepgram.com. Free $200 credit. Generates an API key in the dashboard.
- **AssemblyAI** — https://www.assemblyai.com. Free $50 credit.

You can flip between them later via the `STT_PROVIDER` env var.

---

## 3. Local dev

```bash
cd bridge
cp .env.example .env
# fill in the values, then:
npm install
npm run dev
```

The bridge listens on `:8080` and exposes:

- `GET /healthz`        — returns "ok"
- `WS  /` (anything)    — Twilio Media Streams endpoint

To test locally without Twilio, point an ngrok tunnel at port 8080 and
set the `STREAM_BRIDGE_URL` env var in your Next.js `.env.local` to
`wss://YOUR-NGROK-SUBDOMAIN.ngrok-free.app`. Make a test call — you
should see `[call CAxxxx] stream started` in the bridge logs and rows
appearing in `call_transcripts`.

---

## 4. Deploy to Fly.io

```bash
# from inside the bridge/ directory:
fly launch --no-deploy --copy-config
fly secrets set \
  DEEPGRAM_API_KEY=... \
  SUPABASE_URL=https://your-project.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=... \
  STT_PROVIDER=deepgram \
  BRIDGE_SHARED_SECRET=$(openssl rand -hex 16)
fly deploy
fly status   # confirm the app is healthy
```

Note the WSS URL Fly assigns you (e.g. `wss://cruzonic-stream-bridge.fly.dev`).

---

## 5. Wire it into the dialer

In your Vercel project settings, add two env vars to **Production**
(and Preview if you want):

```
STREAM_BRIDGE_URL      = wss://cruzonic-stream-bridge.fly.dev
BRIDGE_SHARED_SECRET   = (the same value you set on Fly)
```

Redeploy the dialer. From now on, every outbound call's TwiML will
include a `<Start><Stream>` that forks audio to the bridge.

---

## 6. Test end-to-end

1. Open the dialer, go online, dial your own cell.
2. Watch the bridge logs (`fly logs`) — you should see
   `stream started` followed by `STT_PROVIDER: deepgram`.
3. In the dialer UI's middle column, the transcript bubbles should
   appear within ~1 second of speech.
4. In Supabase → Table Editor → `call_transcripts`, you should see new
   rows accumulating in real time.

If nothing appears:

- **Check Fly logs** for STT errors (bad API key, region issue).
- **Check the Twilio Debugger** for `<Stream>` errors (the URL must be
  `wss://` and accessible from the public internet).
- **Check the browser console** for Supabase Realtime subscription
  errors — RLS must allow `SELECT` for the user's role.

---

## Costs (typical 10-minute call)

| Item                                | Cost     |
| ----------------------------------- | -------- |
| Deepgram Nova-3 (2 channels × 10m)  | ~$0.09   |
| Fly.io shared-1x machine            | free tier |
| Supabase Realtime writes/reads      | free tier (well below caps) |
| **Per call**                        | **~$0.09** |

Switching `STT_PROVIDER=assemblyai` raises per-call cost to ~$0.24 but
you get built-in PII redaction.
