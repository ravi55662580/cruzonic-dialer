'use client';

/**
 * Live call transcription + AI reply suggestions.
 *
 * Phase 1: subscribes to Supabase Realtime inserts on `call_transcripts`
 * filtered by `call_sid` and renders the running conversation in chat-bubble
 * style.
 *
 * Phase 2: when the customer's last line finalizes, fires a debounced POST
 * to `/api/coach/suggestions` and renders three click-to-copy reply chips
 * plus an objection-detection badge.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useBrowserStt, type BrowserSttRow } from '@/hooks/useBrowserStt';
import { useWhisperStt, type WhisperSttRow } from '@/hooks/useWhisperStt';

/** Source of live transcripts:
 *   'realtime' → Supabase Realtime fed by the stream bridge (Phase 1).
 *   'browser'  → Web Speech API in the agent's browser (free, no infra,
 *                agent-mic only). Default when NEXT_PUBLIC_LIVECOACH_MODE
 *                is unset.
 */
const LIVECOACH_MODE: 'realtime' | 'browser' =
    process.env.NEXT_PUBLIC_LIVECOACH_MODE === 'realtime' ? 'realtime' : 'browser';
import {
    Phone,
    User,
    Sparkles,
    Copy,
    Check,
    AlertTriangle,
    X,
    ICON_DEFAULTS,
} from '@/components/Icon';
import type {
    CoachResponse,
    ObjectionKind,
    CallSummary,
    CallSentiment,
} from '@/lib/coach/types';

/**
 * NOTE on lifecycle: the parent must render this component with a React
 * `key` tied to the active call SID (or some "idle" sentinel when there
 * is no call). That way, switching between calls remounts a fresh
 * instance and we don't need to manually reset internal state when
 * `callSid` changes — which would trigger React's set-state-in-effect
 * warnings.
 */

interface TranscriptRow {
    id: number | string;
    call_sid: string;
    speaker: 'agent' | 'customer' | 'unknown';
    text: string;
    is_final: boolean;
    created_at: string;
}

interface LeadInfo {
    name?: string;
    company?: string;
    extra?: Record<string, string>;
}

interface Props {
    /** When null/empty, the panel renders an idle state. */
    callSid: string | null;
    /** Optional lead context handed to the coach for personalised suggestions. */
    lead?: LeadInfo | null;
    /**
     * When set, the most recently ended call. Triggers post-call summary
     * generation and switches the panel to its "Call wrap-up" view. The parent
     * is responsible for clearing this once the agent dismisses the summary
     * or starts a new call.
     */
    wrapUpCallSid?: string | null;
    /** Fired when the agent dismisses the wrap-up card. */
    onDismissWrapUp?: () => void;
    /**
     * The customer's remote audio MediaStream from Twilio Voice SDK. When
     * provided in browser-STT mode, LiveCoach feeds it into Whisper for
     * customer-side transcription on top of the agent's mic capture. Pass
     * `null` when there's no active call.
     */
    customerStream?: MediaStream | null;
}

/** Sentiment chip colour mapping. */
const SENTIMENT_LABEL: Record<CallSentiment, string> = {
    positive: 'Positive',
    neutral: 'Neutral',
    negative: 'Negative',
    mixed: 'Mixed',
};

/** Human-friendly labels for each objection kind. */
const OBJECTION_LABEL: Record<ObjectionKind, string> = {
    price: 'Price objection',
    timing: 'Timing pushback',
    competitor: 'Competitor mention',
    authority: 'Decision-maker absent',
    trust: 'Trust hesitation',
    value: 'Value not clear',
    none: 'Clear runway',
};

/** Debounce window — wait this long after a customer line before asking. */
const COACH_DEBOUNCE_MS = 1200;

export default function LiveCoach({ callSid, lead, wrapUpCallSid, onDismissWrapUp, customerStream }: Props) {
    // ── Browser STT path (free, both sides) ─────────────────────────────
    // Agent mic → Web Speech API. Customer's Twilio remote stream → Whisper
    // running in-browser (WASM/WebGPU). The two streams' rows are merged
    // chronologically into a single transcript array the coach panel reads.
    const browser = useBrowserStt();
    const whisper = useWhisperStt({
        stream: LIVECOACH_MODE === 'browser' ? customerStream || null : null,
    });
    const [supabaseRows, setSupabaseRows] = useState<TranscriptRow[]>([]);
    /** Combined transcript: agent + customer rows interleaved by timestamp
     *  so the chat bubbles render in conversational order. */
    const mergedBrowserRows: (BrowserSttRow | WhisperSttRow)[] = [
        ...browser.rows,
        ...whisper.rows,
    ].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const rows: (TranscriptRow | BrowserSttRow | WhisperSttRow)[] =
        LIVECOACH_MODE === 'browser' ? mergedBrowserRows : supabaseRows;
    // Realtime-mode subscription status. In browser mode we treat
    // `listening` as the equivalent connected indicator.
    const [connected, setConnected] = useState(false);
    const connectedNow = LIVECOACH_MODE === 'browser'
        ? (browser.listening || whisper.listening)
        : connected;
    const [coach, setCoach] = useState<CoachResponse | null>(null);
    const [coaching, setCoaching] = useState(false);
    const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const fetchAbort = useRef<AbortController | null>(null);
    const lastTriggerLenRef = useRef(0);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Snapshot rows + lead in refs so the debounced trigger reads the FRESHEST
    // values when the timer fires, without being a useEffect dependency.
    // (Putting `rows` into triggerCoach's deps caused the debounce useEffect
    // to re-run on every row insert, and its cleanup wiped pending timers —
    // so e.g. an agent line typed within 1.2s of a customer line cancelled
    // the coach fetch entirely.)
    const rowsRef = useRef<(TranscriptRow | BrowserSttRow | WhisperSttRow)[]>(rows);
    const leadRef = useRef<LeadInfo | null | undefined>(lead);
    useEffect(() => { rowsRef.current = rows; }, [rows]);
    useEffect(() => { leadRef.current = lead; }, [lead]);

    // ── Browser STT: start when a call is active, stop when it ends. ────
    // In realtime mode this hook is mounted but never started; both `start`
    // and `stop` are stable callbacks, so no needless re-runs.
    useEffect(() => {
        if (LIVECOACH_MODE !== 'browser') return;
        if (!callSid) {
            browser.stop();
            return;
        }
        browser.reset();
        browser.start();
        return () => browser.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only react to callSid; `browser` callbacks are stable
    }, [callSid]);

    // ── Realtime subscription (only in realtime mode) ───────────────────
    useEffect(() => {
        if (LIVECOACH_MODE !== 'realtime') return;
        if (!callSid) return;

        let cancelled = false;

        (async () => {
            const { data } = await supabase
                .from('call_transcripts')
                .select('*')
                .eq('call_sid', callSid)
                .order('created_at', { ascending: true });
            if (!cancelled && data) setSupabaseRows(data as TranscriptRow[]);
        })();

        const channel = supabase
            .channel(`call-${callSid}`)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'call_transcripts',
                    filter: `call_sid=eq.${callSid}`,
                },
                (payload) => {
                    const row = payload.new as TranscriptRow;
                    setSupabaseRows((prev) => [...prev, row]);
                }
            )
            .subscribe((status) => {
                if (!cancelled) setConnected(status === 'SUBSCRIBED');
            });

        return () => {
            cancelled = true;
            supabase.removeChannel(channel);
        };
    }, [callSid]);

    // ── Auto-scroll to newest line ─────────────────────────────────────
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [rows.length]);

    // ── Coach trigger: when a FINAL customer line lands, debounce + fetch.
    // We intentionally only refetch on new finalized customer turns — not
    // every interim — to keep token spend down and the UI stable.
    // Reads `rows` and `lead` via refs so this callback is stable across
    // re-renders and our debounce effect doesn't have to depend on `rows`.
    const triggerCoach = useCallback(async () => {
        if (!callSid) return;
        const turns = rowsRef.current
            .filter((r) => r.is_final && r.text.trim().length > 0)
            .map((r) => ({ speaker: r.speaker, text: r.text }));
        if (turns.length === 0) return;

        fetchAbort.current?.abort();
        const ac = new AbortController();
        fetchAbort.current = ac;
        setCoaching(true);
        try {
            const res = await fetch('/api/coach/suggestions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    callSid,
                    turns,
                    lead: leadRef.current || undefined,
                }),
                signal: ac.signal,
            });
            if (!res.ok) throw new Error(`coach ${res.status}`);
            const data = (await res.json()) as CoachResponse;
            if (!ac.signal.aborted) setCoach(data);
        } catch (err) {
            if ((err as Error).name === 'AbortError') return;
            // Silent failure — we don't want to nag the agent. Log for ops.
            console.warn('[coach] suggest failed:', err);
        } finally {
            if (!ac.signal.aborted) setCoaching(false);
        }
    }, [callSid]);

    useEffect(() => {
        if (!callSid) return;
        // We coach on customer turns — the agent's reply is what we suggest,
        // so we fetch when the customer just finished saying something. This
        // is now valid in browser mode too because Whisper transcribes the
        // remote stream.
        const finalCount = rows.filter(
            (r) => r.is_final && r.speaker === 'customer',
        ).length;
        if (finalCount === 0) return;
        if (finalCount === lastTriggerLenRef.current) return;
        lastTriggerLenRef.current = finalCount;

        // Replace the pending timer ONLY when a new customer turn lands.
        // We intentionally don't clear in the effect cleanup — that would
        // wipe the timer on every unrelated `rows` update (agent reply,
        // interim transcript edit, etc.).
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            debounceRef.current = null;
            void triggerCoach();
        }, COACH_DEBOUNCE_MS);
    }, [rows, callSid, triggerCoach]);

    // Single unmount cleanup: cancel the debounce timer + any in-flight fetch.
    useEffect(() => {
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            fetchAbort.current?.abort();
        };
    }, []);

    // Reset chip-copied feedback after a beat.
    useEffect(() => {
        if (copiedIdx === null) return;
        const t = setTimeout(() => setCopiedIdx(null), 1500);
        return () => clearTimeout(t);
    }, [copiedIdx]);

    const copySuggestion = async (idx: number, text: string, intent: string | undefined) => {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            /* ignore — some browsers block clipboard in iframes */
        }
        setCopiedIdx(idx);
        // Fire-and-forget telemetry — never block the UI on this.
        if (callSid) {
            void fetch('/api/coach/click', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    callSid,
                    suggestionText: text,
                    intent,
                    objection: coach?.objection,
                    suggestionIdx: idx,
                }),
                keepalive: true, // survive a fast navigation
            }).catch(() => { /* swallow */ });
        }
    };

    // ── Post-call summary ──────────────────────────────────────────────
    // When the parent passes a wrapUpCallSid, kick off a summarize request
    // and subscribe to its Realtime row so the card lights up the moment the
    // server finishes writing.
    const [summary, setSummary] = useState<CallSummary | null>(null);
    const [summarizing, setSummarizing] = useState(false);
    const [crmCopied, setCrmCopied] = useState(false);
    const summaryFetchAbort = useRef<AbortController | null>(null);

    useEffect(() => {
        if (!wrapUpCallSid) {
            // Cleared / not in wrap-up mode — reset visible state.
            setSummary(null);
            setSummarizing(false);
            setCrmCopied(false);
            return;
        }
        let cancelled = false;
        summaryFetchAbort.current?.abort();
        const ac = new AbortController();
        summaryFetchAbort.current = ac;
        setSummarizing(true);

        // Prime from any existing row (re-opens / hot reloads).
        (async () => {
            const { data } = await supabase
                .from('call_summaries')
                .select('*')
                .eq('call_sid', wrapUpCallSid)
                .maybeSingle();
            if (cancelled) return;
            if (data) {
                setSummary({
                    summary: data.summary,
                    sentiment: data.sentiment,
                    next_action: data.next_action || '',
                    key_points: Array.isArray(data.key_points) ? data.key_points : [],
                    crm_note: data.crm_note || '',
                });
            }
        })();

        // Kick the generator. In browser mode there are no transcripts in
        // Supabase, so we ship the local final turns along with the request.
        // The route prefers `turns` from the body and falls back to DB read.
        (async () => {
            try {
                const localTurns = LIVECOACH_MODE === 'browser'
                    ? rowsRef.current
                        .filter((r) => r.is_final && r.text.trim().length > 0)
                        .map((r) => ({ speaker: r.speaker, text: r.text }))
                    : undefined;
                const res = await fetch('/api/coach/summarize', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callSid: wrapUpCallSid,
                        lead: leadRef.current || undefined,
                        turns: localTurns,
                    }),
                    signal: ac.signal,
                });
                if (!res.ok) throw new Error(`summarize ${res.status}`);
                const data = (await res.json()) as CallSummary;
                if (!cancelled && !ac.signal.aborted) setSummary(data);
            } catch (err) {
                if ((err as Error).name === 'AbortError') return;
                console.warn('[coach] summarize failed:', err);
            } finally {
                if (!cancelled && !ac.signal.aborted) setSummarizing(false);
            }
        })();

        // Realtime: if some OTHER tab finishes the summary first, sync.
        const channel = supabase
            .channel(`summary-${wrapUpCallSid}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'call_summaries',
                    filter: `call_sid=eq.${wrapUpCallSid}`,
                },
                (payload) => {
                    const row = payload.new as {
                        summary: string;
                        sentiment: CallSentiment;
                        next_action: string | null;
                        key_points: unknown;
                        crm_note: string | null;
                    };
                    if (cancelled) return;
                    setSummary({
                        summary: row.summary,
                        sentiment: row.sentiment,
                        next_action: row.next_action || '',
                        key_points: Array.isArray(row.key_points)
                            ? (row.key_points as { kind: string; note: string }[])
                            : [],
                        crm_note: row.crm_note || '',
                    });
                    setSummarizing(false);
                }
            )
            .subscribe();

        return () => {
            cancelled = true;
            ac.abort();
            supabase.removeChannel(channel);
        };
    }, [wrapUpCallSid]);

    const copyCrmNote = async () => {
        if (!summary?.crm_note) return;
        try {
            await navigator.clipboard.writeText(summary.crm_note);
        } catch { /* ignore */ }
        setCrmCopied(true);
        setTimeout(() => setCrmCopied(false), 1500);
    };

    // ── Wrap-up state (call just ended; show summary instead of transcript) ─
    if (wrapUpCallSid && !callSid) {
        return (
            <div className="lc-panel lc-wrapup">
                <div className="lc-header">
                    <div className="lc-title">
                        <Sparkles {...ICON_DEFAULTS} size={14} />
                        <strong>Call wrap-up</strong>
                    </div>
                    {onDismissWrapUp && (
                        <button
                            type="button"
                            className="lc-wrapup-close"
                            onClick={onDismissWrapUp}
                            title="Dismiss"
                        >
                            <X {...ICON_DEFAULTS} size={14} />
                        </button>
                    )}
                </div>

                <div className="lc-wrapup-body">
                    {summarizing && !summary && (
                        <p className="lc-coach-hint">
                            <span className="lc-coach-spinner" aria-label="thinking" />
                            Summarising the call…
                        </p>
                    )}

                    {summary && summary.summary && (
                        <>
                            <div className="lc-wrapup-row">
                                <span className={`lc-sent lc-sent-${summary.sentiment}`}>
                                    {SENTIMENT_LABEL[summary.sentiment]}
                                </span>
                            </div>
                            <p className="lc-wrapup-summary">{summary.summary}</p>

                            {summary.next_action && (
                                <div className="lc-wrapup-next">
                                    <span className="lc-wrapup-label">Next step</span>
                                    <p>{summary.next_action}</p>
                                </div>
                            )}

                            {summary.key_points.length > 0 && (
                                <div className="lc-wrapup-points">
                                    <span className="lc-wrapup-label">Key moments</span>
                                    <ul>
                                        {summary.key_points.map((kp, i) => (
                                            <li key={i}>
                                                <span className="lc-kp-kind">{kp.kind}</span>
                                                <span className="lc-kp-note">{kp.note}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {summary.crm_note && (
                                <button
                                    type="button"
                                    className="lc-crm-btn"
                                    onClick={copyCrmNote}
                                    title="Copy CRM note to clipboard"
                                >
                                    {crmCopied ? (
                                        <>
                                            <Check {...ICON_DEFAULTS} size={14} /> Copied
                                        </>
                                    ) : (
                                        <>
                                            <Copy {...ICON_DEFAULTS} size={14} /> Copy CRM note
                                        </>
                                    )}
                                </button>
                            )}
                        </>
                    )}

                    {!summarizing && summary && !summary.summary && (
                        <p className="lc-coach-hint">No summary available for this call.</p>
                    )}
                </div>
            </div>
        );
    }

    // ── Idle state ─────────────────────────────────────────────────────
    if (!callSid) {
        return (
            <div className="lc-panel lc-idle">
                <div className="lc-idle-icon">
                    <Phone {...ICON_DEFAULTS} size={32} />
                </div>
                <h3>Live Transcript</h3>
                <p>Start a call and the live transcript will appear here.</p>
            </div>
        );
    }

    const showSuggestions = (coach?.suggestions?.length ?? 0) > 0;
    const showObjection = coach && coach.objection !== 'none';

    return (
        <div className="lc-panel">
            <div className="lc-header">
                <div className="lc-title">
                    <span className={`lc-dot ${connectedNow ? 'is-live' : ''}`} />
                    <strong>Live Transcript</strong>
                </div>
                <span className="lc-meta">
                    {whisper.loadingModel && LIVECOACH_MODE === 'browser' && customerStream && (
                        <span className="lc-model-loading" title="Downloading the Whisper STT model — happens once, cached for next time.">
                            Loading customer model… {Math.round(whisper.loadProgress * 100)}%
                        </span>
                    )}
                    {!whisper.loadingModel && <>{rows.length} segments</>}
                </span>
            </div>

            <div className="lc-stream" ref={scrollRef}>
                {rows.length === 0 ? (
                    <p className="lc-waiting">
                        Listening… the first words will appear here in a second or two.
                    </p>
                ) : (
                    rows.map((r) => (
                        <div
                            key={r.id}
                            className={`lc-bubble lc-bubble-${r.speaker} ${r.is_final ? '' : 'is-interim'}`}
                        >
                            <span className="lc-speaker">
                                {r.speaker === 'agent' ? (
                                    <>
                                        <User {...ICON_DEFAULTS} size={12} /> You
                                    </>
                                ) : r.speaker === 'customer' ? (
                                    <>
                                        <Phone {...ICON_DEFAULTS} size={12} /> Customer
                                    </>
                                ) : (
                                    <>—</>
                                )}
                            </span>
                            <p>{r.text}</p>
                        </div>
                    ))
                )}
            </div>

            {/* AI coach panel — visible whenever we have transcript content. */}
            <div className="lc-coach">
                <div className="lc-coach-head">
                    <span className="lc-coach-title">
                        <Sparkles {...ICON_DEFAULTS} size={14} /> Suggested replies
                        {coaching && <span className="lc-coach-spinner" aria-label="thinking" />}
                    </span>
                    {showObjection && coach && (
                        <span
                            className={`lc-obj lc-obj-${coach.objection}`}
                            title={coach.summary || OBJECTION_LABEL[coach.objection]}
                        >
                            <AlertTriangle {...ICON_DEFAULTS} size={12} />
                            {OBJECTION_LABEL[coach.objection]}
                        </span>
                    )}
                </div>

                {showSuggestions && coach ? (
                    <div className="lc-chips">
                        {coach.suggestions.map((s, i) => (
                            <button
                                key={i}
                                type="button"
                                className="lc-chip"
                                onClick={() => copySuggestion(i, s.text, s.intent)}
                                title="Click to copy"
                            >
                                {s.intent && <span className="lc-chip-intent">{s.intent}</span>}
                                <span className="lc-chip-text">{s.text}</span>
                                <span className="lc-chip-icon">
                                    {copiedIdx === i ? (
                                        <Check {...ICON_DEFAULTS} size={14} />
                                    ) : (
                                        <Copy {...ICON_DEFAULTS} size={14} />
                                    )}
                                </span>
                            </button>
                        ))}
                    </div>
                ) : (
                    <p className="lc-coach-hint">
                        {coaching
                            ? 'Thinking…'
                            : 'Suggestions appear after the customer speaks.'}
                    </p>
                )}
            </div>
        </div>
    );
}
