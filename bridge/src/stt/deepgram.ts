/**
 * Deepgram streaming adapter.
 *
 * Why one session per channel: Deepgram supports multichannel input
 * directly, but their multichannel mode requires we mux both inbound +
 * outbound into a single stereo stream — which means we'd buffer + align
 * frames ourselves. For Phase 1 we keep things simple: open TWO live
 * connections (one tagged "agent", one tagged "customer") and let
 * Deepgram label each chunk by which session it came from.
 */

import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import type { LiveClient } from '@deepgram/sdk';
import type { STTAdapter, STTSession, Speaker, TranscriptChunk } from './types';

const TWILIO_SAMPLE_RATE = 8000; // Twilio Media Streams: 8kHz μ-law

export class DeepgramAdapter implements STTAdapter {
    readonly name = 'deepgram';

    constructor(private readonly apiKey: string) {
        if (!apiKey) throw new Error('DEEPGRAM_API_KEY is required');
    }

    async openSession(args: {
        callSid: string;
        onTranscript: (chunk: TranscriptChunk) => void;
        onError: (err: Error) => void;
    }): Promise<STTSession> {
        const deepgram = createClient(this.apiKey);

        // Spin up one live connection per speaker — Deepgram returns transcript
        // events tagged with the speaker we set up here.
        const openOne = (speaker: Speaker): LiveClient => {
            const conn = deepgram.listen.live({
                model: 'nova-3-general',
                language: 'en',
                encoding: 'mulaw',
                sample_rate: TWILIO_SAMPLE_RATE,
                channels: 1,
                interim_results: true,
                smart_format: true,
                punctuate: true,
                endpointing: 300,        // ms of silence before a segment finalizes
                vad_events: false,
            });

            conn.on(LiveTranscriptionEvents.Transcript, (data: unknown) => {
                // Deepgram payload shape: { channel: { alternatives: [{ transcript }] }, is_final }
                const d = data as {
                    is_final?: boolean;
                    channel?: { alternatives?: Array<{ transcript?: string }> };
                };
                const text = d?.channel?.alternatives?.[0]?.transcript?.trim() || '';
                if (!text) return;
                args.onTranscript({
                    speaker,
                    text,
                    isFinal: Boolean(d?.is_final),
                });
            });

            conn.on(LiveTranscriptionEvents.Error, (err: unknown) => {
                args.onError(err instanceof Error ? err : new Error(String(err)));
            });

            return conn;
        };

        const agentConn = openOne('agent');
        const customerConn = openOne('customer');

        const ready = new Promise<void>((resolve) => {
            let opened = 0;
            const onOpen = () => {
                opened++;
                if (opened === 2) resolve();
            };
            agentConn.on(LiveTranscriptionEvents.Open, onOpen);
            customerConn.on(LiveTranscriptionEvents.Open, onOpen);
        });
        await Promise.race([
            ready,
            new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error('Deepgram open timeout')), 8000)
            ),
        ]);

        return {
            sendAudio(frame: Buffer, channel: Speaker) {
                const conn = channel === 'agent' ? agentConn : customerConn;
                try {
                    // Deepgram's send() is typed as ArrayBufferLike|string|Blob and
                    // does not accept a Node Buffer directly. Slice out a clean
                    // ArrayBuffer view over the frame's bytes.
                    const ab = frame.buffer.slice(
                        frame.byteOffset,
                        frame.byteOffset + frame.byteLength
                    ) as ArrayBuffer;
                    conn.send(ab);
                } catch (err) {
                    args.onError(err instanceof Error ? err : new Error(String(err)));
                }
            },
            async close() {
                // `finish()` was renamed to `requestClose()` in @deepgram/sdk v3.4.
                try { agentConn.requestClose(); } catch { /* ignore */ }
                try { customerConn.requestClose(); } catch { /* ignore */ }
            },
        };
    }
}
