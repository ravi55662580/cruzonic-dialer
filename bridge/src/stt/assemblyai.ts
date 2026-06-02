/**
 * AssemblyAI streaming adapter.
 *
 * AssemblyAI's "Streaming v3" API accepts 16-bit PCM at 16kHz over a
 * WebSocket. Twilio sends μ-law @ 8kHz, so we upsample + convert each
 * frame before forwarding. Like the Deepgram adapter, we open one
 * upstream connection per channel so we can tag transcripts by speaker.
 */

import { AssemblyAI } from 'assemblyai';
import type { RealtimeTranscriber } from 'assemblyai';
import type { STTAdapter, STTSession, Speaker, TranscriptChunk } from './types';

const TARGET_SAMPLE_RATE = 16000;

/** Decode one μ-law byte to a 16-bit linear PCM sample. */
function muLawDecode(u: number): number {
    u = ~u & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    return sign ? -sample : sample;
}

/** Convert μ-law 8kHz → 16-bit PCM 16kHz (linear interpolation upsample). */
function mulaw8kToPcm16k(input: Buffer): Buffer {
    const decoded = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) decoded[i] = muLawDecode(input[i]);
    // simple 2× upsample via linear interp
    const out = new Int16Array(decoded.length * 2);
    for (let i = 0; i < decoded.length; i++) {
        out[i * 2] = decoded[i];
        out[i * 2 + 1] = i + 1 < decoded.length
            ? Math.round((decoded[i] + decoded[i + 1]) / 2)
            : decoded[i];
    }
    return Buffer.from(out.buffer);
}

export class AssemblyAIAdapter implements STTAdapter {
    readonly name = 'assemblyai';

    constructor(private readonly apiKey: string) {
        if (!apiKey) throw new Error('ASSEMBLYAI_API_KEY is required');
    }

    async openSession(args: {
        callSid: string;
        onTranscript: (chunk: TranscriptChunk) => void;
        onError: (err: Error) => void;
    }): Promise<STTSession> {
        const client = new AssemblyAI({ apiKey: this.apiKey });

        const openOne = async (speaker: Speaker): Promise<RealtimeTranscriber> => {
            const transcriber = client.realtime.transcriber({
                sampleRate: TARGET_SAMPLE_RATE,
            });
            transcriber.on('transcript', (t) => {
                const text = (t.text || '').trim();
                if (!text) return;
                args.onTranscript({
                    speaker,
                    text,
                    isFinal: t.message_type === 'FinalTranscript',
                });
            });
            transcriber.on('error', (err: Error) => args.onError(err));
            await transcriber.connect();
            return transcriber;
        };

        const [agentT, customerT] = await Promise.all([
            openOne('agent'),
            openOne('customer'),
        ]);

        return {
            sendAudio(frame: Buffer, channel: Speaker) {
                const pcm = mulaw8kToPcm16k(frame);
                const t = channel === 'agent' ? agentT : customerT;
                try {
                    // AssemblyAI's sendAudio() wants ArrayBufferLike, not a Node
                    // Buffer. Pull out a clean ArrayBuffer view.
                    const ab = pcm.buffer.slice(
                        pcm.byteOffset,
                        pcm.byteOffset + pcm.byteLength
                    ) as ArrayBuffer;
                    t.sendAudio(ab);
                } catch (err) {
                    args.onError(err instanceof Error ? err : new Error(String(err)));
                }
            },
            async close() {
                await Promise.allSettled([agentT.close(), customerT.close()]);
            },
        };
    }
}
