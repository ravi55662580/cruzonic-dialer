'use client';

/**
 * useBrowserStt — wraps the browser's built-in Web Speech API
 * (`webkitSpeechRecognition` / `SpeechRecognition`) into a tiny React hook
 * shaped like the rest of the LiveCoach data flow.
 *
 * Why this exists: it's the free, zero-infra path. No Deepgram, no bridge, no
 * Supabase Realtime needed for transcripts. Trade-off: the browser API only
 * captures the agent's microphone — the customer's voice (which arrives over
 * Twilio's WebRTC connection and plays through the agent's speakers) is not
 * available to `SpeechRecognition` because the spec doesn't accept arbitrary
 * MediaStreams. Every turn produced by this hook is therefore tagged
 * `speaker: 'agent'`.
 *
 * Supported in: Chrome, Edge, Safari (with quirks). Not supported in Firefox.
 * Note: Chrome's implementation sends audio to Google's servers under the
 * hood — it's free but not strictly local.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Row shape that mirrors the Supabase `call_transcripts` rows so the rest
 * of LiveCoach can treat them identically. */
export interface BrowserSttRow {
    id: string;
    speaker: 'agent';
    text: string;
    is_final: boolean;
    created_at: string;
}

interface UseBrowserSttReturn {
    /** Live transcript rows, oldest first. Final + interim interleaved. */
    rows: BrowserSttRow[];
    /** True when actively listening to the microphone. */
    listening: boolean;
    /** True iff this browser supports the Web Speech API at all. */
    supported: boolean;
    /** Last error (mic denied, network failure, etc.) — null if OK. */
    error: string | null;
    /** Begin listening. Idempotent — calling it twice is a no-op. */
    start: () => void;
    /** Stop listening and drop any pending interim segment. */
    stop: () => void;
    /** Wipe the rows array — used when starting a new call. */
    reset: () => void;
}

// Browser SpeechRecognition types aren't in lib.dom yet for older TS targets,
// so we declare a minimal shape here. Cast through unknown to avoid `any`.
interface SpeechRecognitionEvent extends Event {
    resultIndex: number;
    results: SpeechRecognitionResultList;
}
interface SpeechRecognitionResultList {
    readonly length: number;
    item(idx: number): SpeechRecognitionResult;
    [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionResult {
    readonly length: number;
    readonly isFinal: boolean;
    item(idx: number): SpeechRecognitionAlternative;
    [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionAlternative {
    readonly transcript: string;
    readonly confidence: number;
}
interface SpeechRecognitionErrorEvent extends Event {
    error: string;
    message?: string;
}
interface SpeechRecognitionInstance extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    maxAlternatives: number;
    onresult: ((ev: SpeechRecognitionEvent) => void) | null;
    onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getCtor(): SpeechRecognitionCtor | null {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as {
        SpeechRecognition?: SpeechRecognitionCtor;
        webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function useBrowserStt(): UseBrowserSttReturn {
    const [rows, setRows] = useState<BrowserSttRow[]>([]);
    const [listening, setListening] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const recRef = useRef<SpeechRecognitionInstance | null>(null);
    // We want continuous recognition; the Web Speech API tends to auto-stop
    // on long silences, so we restart on `onend` while we still want to listen.
    const wantListeningRef = useRef(false);
    // Most recent interim row id, so we update-in-place instead of pushing
    // a new row every keystroke of the partial transcript.
    const interimIdRef = useRef<string | null>(null);

    const supported = !!getCtor();

    const reset = useCallback(() => {
        setRows([]);
        interimIdRef.current = null;
        setError(null);
    }, []);

    const stop = useCallback(() => {
        wantListeningRef.current = false;
        try { recRef.current?.stop(); } catch { /* already stopped */ }
        recRef.current = null;
        setListening(false);
        interimIdRef.current = null;
    }, []);

    const start = useCallback(() => {
        const Ctor = getCtor();
        if (!Ctor) {
            setError('Browser does not support speech recognition');
            return;
        }
        if (wantListeningRef.current && recRef.current) return; // already going

        const rec = new Ctor();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = 'en-US';
        rec.maxAlternatives = 1;

        rec.onresult = (ev) => {
            // The event carries results[resultIndex..length-1] — new or updated
            // segments since the last event. Walk that slice and update the
            // rows array: each interim segment lives in place; each final
            // segment is committed and the interim slot is cleared.
            for (let i = ev.resultIndex; i < ev.results.length; i++) {
                const result = ev.results[i];
                const text = result[0]?.transcript?.trim() || '';
                if (!text) continue;
                const isFinal = result.isFinal;

                setRows((prev) => {
                    const next = [...prev];
                    // If there's a pending interim row, update it in place.
                    if (interimIdRef.current) {
                        const idx = next.findIndex((r) => r.id === interimIdRef.current);
                        if (idx >= 0) {
                            next[idx] = { ...next[idx], text, is_final: isFinal };
                            if (isFinal) interimIdRef.current = null;
                            return next;
                        }
                    }
                    // No interim yet — create a new row.
                    const id = `${Date.now()}-${i}`;
                    next.push({
                        id,
                        speaker: 'agent',
                        text,
                        is_final: isFinal,
                        created_at: new Date().toISOString(),
                    });
                    if (!isFinal) interimIdRef.current = id;
                    return next;
                });
            }
        };

        rec.onerror = (ev) => {
            // 'no-speech' fires constantly during silence; ignore it. Real
            // errors (denied, network, audio-capture) we surface.
            if (ev.error === 'no-speech' || ev.error === 'aborted') return;
            setError(ev.error || 'speech recognition error');
        };

        rec.onend = () => {
            // The API stops itself after long silences. Restart if we still
            // want to listen; otherwise mark not-listening.
            if (wantListeningRef.current) {
                try { rec.start(); } catch { /* mid-flight, will recover */ }
            } else {
                setListening(false);
            }
        };

        try {
            rec.start();
            recRef.current = rec;
            wantListeningRef.current = true;
            setListening(true);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'failed to start recognition');
            wantListeningRef.current = false;
        }
    }, []);

    // Stop on unmount so we don't leave the mic hot.
    useEffect(() => () => stop(), [stop]);

    return { rows, listening, supported, error, start, stop, reset };
}
