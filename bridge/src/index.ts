/**
 * Cruzonic Stream Bridge
 * ----------------------
 * One WebSocket server that:
 *   1. Accepts a Twilio <Stream> connection per call.
 *   2. Decodes Twilio's Media Streams JSON envelope (start/media/stop).
 *   3. Forwards audio to the configured STT provider, per channel (agent /
 *      customer), based on Twilio's `track` field ("inbound" vs "outbound").
 *   4. Writes each transcript chunk to Supabase, where the dialer UI
 *      subscribes via Realtime.
 *
 * Health check at GET /healthz so Fly can stop/start the machine.
 */

import 'dotenv/config';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createSTTAdapter, type STTSession, type Speaker } from './stt';
import { insertTranscript } from './supabase';

const PORT = Number(process.env.PORT || 8080);
const SHARED_SECRET = process.env.BRIDGE_SHARED_SECRET || '';

/** Map Twilio's `track` value (inbound = caller, outbound = agent) → speaker. */
function trackToSpeaker(track: string | undefined): Speaker {
    if (track === 'inbound') return 'customer';
    if (track === 'outbound') return 'agent';
    return 'unknown';
}

/**
 * Per-connection state. One Twilio <Stream> connection = one call =
 * one STT session.
 */
interface CallContext {
    callSid: string | null;
    streamSid: string | null;
    stt: STTSession | null;
    framesIn: number;
    closed: boolean;
}

async function handleTwilioConnection(socket: WebSocket): Promise<void> {
    const ctx: CallContext = {
        callSid: null,
        streamSid: null,
        stt: null,
        framesIn: 0,
        closed: false,
    };
    const adapter = createSTTAdapter();

    socket.on('message', async (raw) => {
        if (ctx.closed) return;
        let msg: { event?: string; start?: unknown; media?: unknown; stop?: unknown };
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return; // ignore garbage frames
        }

        switch (msg.event) {
            case 'connected':
                // Twilio always sends this first; nothing to do.
                break;

            case 'start': {
                const start = msg.start as {
                    streamSid?: string;
                    callSid?: string;
                    customParameters?: Record<string, string>;
                };
                // Twilio Media Streams always sends `callSid` in the `start`
                // event for outbound calls. We also accept `callSidHint`
                // (set on the TwiML <Parameter>) as a belt-and-braces fallback
                // for edge cases like inbound transfers where the parent SID
                // may be a different field.
                ctx.callSid =
                    start.callSid ||
                    start.customParameters?.callSidHint ||
                    start.customParameters?.callSid ||
                    null;
                ctx.streamSid = start.streamSid || null;
                if (!ctx.callSid) {
                    console.warn('[twilio] start without callSid; closing');
                    socket.close();
                    return;
                }
                console.log(`[call ${ctx.callSid}] stream started (${adapter.name})`);
                try {
                    ctx.stt = await adapter.openSession({
                        callSid: ctx.callSid,
                        onTranscript: (chunk) => {
                            // Fire-and-log to keep the audio path non-blocking.
                            void insertTranscript({
                                callSid: ctx.callSid!,
                                speaker: chunk.speaker,
                                text: chunk.text,
                                isFinal: chunk.isFinal,
                            });
                        },
                        onError: (err) => {
                            console.error(`[call ${ctx.callSid}] STT error:`, err.message);
                        },
                    });
                } catch (err) {
                    console.error('[stt] open failed:', err);
                    socket.close();
                }
                break;
            }

            case 'media': {
                if (!ctx.stt) return;
                const media = msg.media as { payload?: string; track?: string };
                if (!media?.payload) return;
                const audio = Buffer.from(media.payload, 'base64');
                ctx.stt.sendAudio(audio, trackToSpeaker(media.track));
                ctx.framesIn++;
                break;
            }

            case 'stop':
                console.log(`[call ${ctx.callSid}] stream stopped after ${ctx.framesIn} frames`);
                socket.close();
                break;
        }
    });

    const cleanup = async () => {
        if (ctx.closed) return;
        ctx.closed = true;
        try { await ctx.stt?.close(); } catch { /* ignore */ }
    };

    socket.on('close', () => { void cleanup(); });
    socket.on('error', (err) => {
        console.error('[ws] socket error:', err);
        void cleanup();
    });
}

const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/healthz')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, sock, head) => {
    // Optional shared-secret check. Twilio includes ?token=... if you set
    // BRIDGE_SHARED_SECRET in env and include the same token on the
    // <Stream url="wss://.../twilio?token=..."/> URL.
    if (SHARED_SECRET) {
        const url = new URL(req.url || '/', 'http://x');
        const token = url.searchParams.get('token');
        if (token !== SHARED_SECRET) {
            sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            sock.destroy();
            return;
        }
    }
    wss.handleUpgrade(req, sock, head, (ws) => {
        void handleTwilioConnection(ws);
    });
});

server.listen(PORT, () => {
    console.log(`[bridge] listening on :${PORT}`);
    console.log(`[bridge] STT provider: ${process.env.STT_PROVIDER || 'deepgram'}`);
});
