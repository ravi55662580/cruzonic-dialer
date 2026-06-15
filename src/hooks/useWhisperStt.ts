'use client';

/**
 * useWhisperStt — transcribes a MediaStream entirely in the browser using
 * Whisper compiled to WebAssembly via `@huggingface/transformers`.
 *
 * Why this exists: the browser's built-in Web Speech API can only listen to
 * the microphone, not the customer's audio that arrives via WebRTC. To
 * transcribe the OTHER side of a Twilio call without paying for Deepgram
 * or running a bridge, we feed the remote MediaStream into a Whisper model
 * that runs locally in the agent's browser.
 *
 * Trade-offs:
 *   - First call downloads the model (~75 MB for tiny.en, cached afterwards).
 *   - Inference is ~500ms per 5 s of audio on M1, slower on older machines.
 *   - Each "turn" lands ~5 seconds after the speaker finishes — much higher
 *     latency than Deepgram (~300ms) but free.
 *   - WebGPU is used when available (M1/M2/recent Intel), big speedup.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Row shape mirrors the browser-STT + Supabase transcript rows so it can
 *  drop straight into the LiveCoach panel. */
export interface WhisperSttRow {
    id: string;
    speaker: 'customer';
    text: string;
    is_final: boolean;
    created_at: string;
}

/** Window of audio we send to the model. Longer = better accuracy + higher
 *  latency. 5 s is the sweet spot for conversational phone audio. */
const WINDOW_SECONDS = 5;
const TARGET_SAMPLE_RATE = 16000;

/** Default model. tiny.en (~75 MB) is the fastest with acceptable quality
 *  for phone-quality English. base.en (~140 MB) is better but slower. */
const MODEL_ID = 'Xenova/whisper-tiny.en';

interface UseWhisperSttArgs {
    /** The MediaStream to transcribe. Null when there's no active call. */
    stream: MediaStream | null;
    /** Speaker label for produced rows (defaults to 'customer'). */
    speaker?: WhisperSttRow['speaker'];
}

interface UseWhisperSttReturn {
    rows: WhisperSttRow[];
    /** True while the model is downloading on first use. */
    loadingModel: boolean;
    /** 0..1 — progress for the model download. */
    loadProgress: number;
    /** True while audio is actively being captured + transcribed. */
    listening: boolean;
    /** Last error (model load, audio capture, inference) — null if OK. */
    error: string | null;
    /** Manually clear the rows array — used when starting a new call. */
    reset: () => void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type WhisperPipeline = (
    audio: Float32Array,
    opts?: Record<string, unknown>,
) => Promise<{ text: string } | { text: string }[]>;

// Module-level cache so we only load the model once per page lifetime.
let cachedPipeline: WhisperPipeline | null = null;
let cachedPromise: Promise<WhisperPipeline> | null = null;

async function loadWhisperPipeline(
    onProgress: (p: number) => void,
): Promise<WhisperPipeline> {
    if (cachedPipeline) return cachedPipeline;
    if (cachedPromise) return cachedPromise;
    cachedPromise = (async () => {
        // Dynamic import keeps the ~few-MB transformers.js bundle out of the
        // initial page load. Only paid when the agent actually starts a call.
        const tfMod = (await import('@huggingface/transformers')) as any;
        const env = tfMod.env;
        // Allow remote model fetching from the Hugging Face CDN.
        if (env) {
            env.allowLocalModels = false;
            env.allowRemoteModels = true;
        }
        const pipeline = await tfMod.pipeline(
            'automatic-speech-recognition',
            MODEL_ID,
            {
                // Use WebGPU when available, fall back to WASM otherwise.
                device: typeof navigator !== 'undefined' && 'gpu' in navigator
                    ? 'webgpu'
                    : 'wasm',
                progress_callback: (p: { status: string; progress?: number }) => {
                    if (p.status === 'progress' && typeof p.progress === 'number') {
                        onProgress(p.progress / 100);
                    } else if (p.status === 'ready') {
                        onProgress(1);
                    }
                },
            },
        );
        cachedPipeline = pipeline as WhisperPipeline;
        return cachedPipeline;
    })();
    try {
        return await cachedPromise;
    } finally {
        cachedPromise = null;
    }
}

export function useWhisperStt(args: UseWhisperSttArgs): UseWhisperSttReturn {
    const { stream, speaker = 'customer' } = args;
    const [rows, setRows] = useState<WhisperSttRow[]>([]);
    const [loadingModel, setLoadingModel] = useState(false);
    const [loadProgress, setLoadProgress] = useState(0);
    const [listening, setListening] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Audio plumbing kept in refs so the effect cleanup can tear it down.
    const ctxRef = useRef<AudioContext | null>(null);
    const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const workletRef = useRef<AudioWorkletNode | null>(null);
    // Rolling buffer of 16 kHz mono samples — we trigger a transcription
    // every WINDOW_SECONDS worth.
    const bufferRef = useRef<Float32Array>(new Float32Array(0));
    const inferenceBusyRef = useRef(false);

    const reset = useCallback(() => {
        setRows([]);
        bufferRef.current = new Float32Array(0);
        setError(null);
    }, []);

    useEffect(() => {
        if (!stream) return;
        let cancelled = false;

        (async () => {
            try {
                setError(null);
                setLoadingModel(!cachedPipeline);
                setLoadProgress(cachedPipeline ? 1 : 0);

                const pipelinePromise = loadWhisperPipeline((p) => {
                    if (!cancelled) setLoadProgress(p);
                });

                // Spin up audio capture in parallel with model loading so
                // the worklet is ready by the time the model finishes.
                const ctx = new AudioContext();
                ctxRef.current = ctx;
                await ctx.audioWorklet.addModule('/whisper-capture-worklet.js');
                if (cancelled) { ctx.close(); return; }

                const source = ctx.createMediaStreamSource(stream);
                sourceRef.current = source;
                const worklet = new AudioWorkletNode(ctx, 'whisper-capture');
                workletRef.current = worklet;

                worklet.port.onmessage = (ev) => {
                    const chunk = ev.data as Float32Array;
                    if (!chunk?.length) return;
                    // Append to rolling buffer.
                    const next = new Float32Array(bufferRef.current.length + chunk.length);
                    next.set(bufferRef.current, 0);
                    next.set(chunk, bufferRef.current.length);
                    bufferRef.current = next;
                };

                source.connect(worklet);
                // Connect to destination so the worklet's process() actually
                // runs — but use a zero-gain node so we don't echo audio.
                const sink = ctx.createGain();
                sink.gain.value = 0;
                worklet.connect(sink).connect(ctx.destination);

                const pipeline = await pipelinePromise;
                if (cancelled) return;
                setLoadingModel(false);
                setListening(true);

                // Drive a ticker that pulls the latest window out of the
                // buffer and runs Whisper on it. Skip if a previous inference
                // is still going so we don't stack up jobs.
                const tickMs = 1000; // check every second
                const windowSamples = TARGET_SAMPLE_RATE * WINDOW_SECONDS;
                const interval = window.setInterval(async () => {
                    if (cancelled) return;
                    if (inferenceBusyRef.current) return;
                    if (bufferRef.current.length < windowSamples) return;

                    // Slice the oldest WINDOW_SECONDS worth, keep ~1s overlap.
                    const slice = bufferRef.current.slice(0, windowSamples);
                    const keep = bufferRef.current.slice(windowSamples - TARGET_SAMPLE_RATE);
                    bufferRef.current = keep;

                    // Voice-activity heuristic: skip near-silent windows so
                    // we don't waste CPU + don't hallucinate text from noise.
                    let rms = 0;
                    for (let i = 0; i < slice.length; i++) rms += slice[i] * slice[i];
                    rms = Math.sqrt(rms / slice.length);
                    if (rms < 0.01) return;

                    inferenceBusyRef.current = true;
                    try {
                        const result = await pipeline(slice);
                        const text = Array.isArray(result)
                            ? (result[0]?.text || '').trim()
                            : ((result?.text as string) || '').trim();
                        if (text && !cancelled) {
                            const row: WhisperSttRow = {
                                id: `wh-${Date.now()}`,
                                speaker,
                                text,
                                is_final: true,
                                created_at: new Date().toISOString(),
                            };
                            setRows((prev) => [...prev, row]);
                        }
                    } catch (err) {
                        console.warn('[whisper] inference failed:', err);
                    } finally {
                        inferenceBusyRef.current = false;
                    }
                }, tickMs);

                // Stash so cleanup can stop it.
                (workletRef.current as unknown as { __interval?: number }).__interval = interval;
            } catch (err) {
                console.error('[whisper] setup failed:', err);
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : 'Whisper setup failed');
                    setLoadingModel(false);
                }
            }
        })();

        return () => {
            cancelled = true;
            setListening(false);
            try {
                const w = workletRef.current as unknown as { __interval?: number } | null;
                if (w?.__interval) window.clearInterval(w.__interval);
                workletRef.current?.disconnect();
                sourceRef.current?.disconnect();
                ctxRef.current?.close();
            } catch { /* ignore teardown errors */ }
            workletRef.current = null;
            sourceRef.current = null;
            ctxRef.current = null;
            bufferRef.current = new Float32Array(0);
        };
    }, [stream, speaker]);

    return { rows, loadingModel, loadProgress, listening, error, reset };
}
