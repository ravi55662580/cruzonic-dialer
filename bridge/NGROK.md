# Bridge — ngrok Dev Setup

Zero-cost setup for testing live transcription end-to-end before paying any
host. Your laptop runs the bridge; ngrok gives Twilio a public `wss://` URL
to talk to it.

Trade-off: your laptop has to stay on (and on the same Wi-Fi) for calls to
work. Fine for dev / demo. Not fine for production agents in another office.

---

## One-time setup (~5 minutes)

### 1. Install ngrok

macOS:
```bash
brew install ngrok
```

Other OSes: download from https://ngrok.com/download

### 2. Get a free ngrok account

Go to https://dashboard.ngrok.com/signup. Free, email only — no card.

Copy your authtoken from https://dashboard.ngrok.com/get-started/your-authtoken
and run:
```bash
ngrok config add-authtoken YOUR_TOKEN
```

This is one-time; your config is now saved at `~/.config/ngrok/ngrok.yml`.

### 3. (Recommended) Claim a free static domain

Free ngrok gives you **one reserved domain** (looks like `tame-cattle-12345.ngrok-free.app`)
that stays the same across sessions. Go to
https://dashboard.ngrok.com/cloud-edge/domains and click "New Domain".

Copy the domain — you'll use it as `--url` below. Without this, ngrok gives
you a random URL every time you start it, and you'll have to update Vercel
env vars constantly.

### 4. Install the bridge's deps (one-time)

```bash
cd bridge
npm install
```

The `.env` file is already populated with your Deepgram key, Supabase creds,
and shared secret. Nothing to fill in.

---

## Each dev session

You'll need **two terminals**.

### Option A: one command (uses both terminals as one)

```bash
cd bridge
npm run dev:tunnel
```

This runs the bridge **and** ngrok side-by-side, colour-coded. Press Ctrl-C
once and both stop. Note: this uses ngrok's random URL — only use this if
you don't mind updating Vercel each session.

### Option B: two terminals (recommended for a stable URL)

**Terminal A — start the bridge:**

```bash
cd bridge
npm run dev
```

You should see:
```
[bridge] listening on :8080
[bridge] STT provider: deepgram
```

Leave this running.

**Terminal B — start the ngrok tunnel:**

If you claimed a static domain (recommended):
```bash
ngrok http --url=tame-cattle-12345.ngrok-free.app 8080
```

Or with a random URL (changes every time):
```bash
ngrok http 8080
```

ngrok prints something like:
```
Forwarding   https://tame-cattle-12345.ngrok-free.app -> http://localhost:8080
```

Quick test from a third terminal:
```bash
curl https://tame-cattle-12345.ngrok-free.app/healthz
# → ok
```

Leave ngrok running.

---

## Wire the dialer to ngrok

In your dialer's `.env.local`, set:

```
STREAM_BRIDGE_URL=wss://tame-cattle-12345.ngrok-free.app
BRIDGE_SHARED_SECRET=981f394b02a702ca6a5a085cac316c50
```

Note `wss://` not `https://` — Twilio Media Streams uses WebSocket, and ngrok
serves both protocols on the same domain.

If you're deploying the dialer to Vercel for staging, set the same two values
in **Vercel → Settings → Environment Variables** and redeploy.

If you're running the dialer locally too, restart `npm run dev` so the new env
gets picked up.

---

## End-to-end smoke test

1. Open the dialer (local or Vercel) and sign in.
2. Dial your own cell phone.
3. When you answer, say a few words.
4. Within ~1 second, transcript bubbles should appear in the middle panel.
5. After the customer (your cell) speaks a final sentence, the "Suggested
   replies" chips should populate from Gemini.

Watch the bridge terminal for activity:

```
[call CAxxx...] stream started (deepgram)
```

If you see `STT error:` in the logs, check that Deepgram key is still valid
in https://console.deepgram.com.

If transcripts appear but suggestions don't, check the browser console — that
side is Gemini-related, not bridge.

---

## Common gotchas

**"ngrok account already has 1 simultaneous session"**
You started ngrok in another terminal. Find and kill it:
```bash
pkill ngrok
```

**Twilio shows "WebSocket handshake error" in the debugger**
The shared secret in Vercel doesn't match `bridge/.env`. They MUST be identical.

**ngrok says "tunnel session failed: free plan limits"**
Free tier gives you ~40 connections/minute. That's a lot of calls; if you're
hitting it during normal testing something's looping.

**Calls work but no transcript appears**
- Did you run the Supabase migration `001_call_transcripts.sql`?
- In Supabase → Table Editor → `call_transcripts`, are rows appearing? If yes,
  the bridge → DB path works and it's a Realtime subscription issue. If no,
  the bridge isn't writing.

**"My laptop went to sleep and calls stopped working"**
Yep. ngrok kills the tunnel, the bridge keeps running but Twilio can't reach
it. For dev that's fine. For anything resembling production, move to a real
host (Fly.io, Oracle Cloud, etc).

---

## When you're done

Just `Ctrl-C` both terminals. Nothing to clean up.

Next time, repeat the "Each dev session" steps. The setup is permanent.
