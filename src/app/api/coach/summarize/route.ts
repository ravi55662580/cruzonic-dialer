import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
    createCoachAdapter,
    type CallSummary,
    type CoachTurn,
} from '@/lib/coach';

/**
 * POST /api/coach/summarize
 *
 * Body: { callSid: string, lead?: { name?, company?, extra? } }
 *
 * 1. Fetches the call's transcripts from Supabase.
 * 2. Runs the configured LLM to produce a {@link CallSummary}.
 * 3. Upserts the summary into `call_summaries` (call_sid is unique).
 *
 * The dialer UI subscribes to that table via Supabase Realtime, so the
 * wrap-up card lights up the moment this finishes.
 *
 * If anything goes wrong, we return an empty payload (not 500) so the UI
 * degrades gracefully — just like the suggestions route.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getServiceClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!url || !key) {
        throw new Error('SUPABASE_URL / SERVICE_ROLE_KEY missing');
    }
    return createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
}

const EMPTY_SUMMARY: CallSummary = {
    summary: '',
    sentiment: 'neutral',
    next_action: '',
    key_points: [],
    crm_note: '',
};

export async function POST(request: Request) {
    let body: { callSid?: string; lead?: unknown; turns?: unknown };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }

    const callSid = typeof body.callSid === 'string' ? body.callSid : '';
    if (!callSid) {
        return NextResponse.json({ error: 'callSid required' }, { status: 400 });
    }

    // If the client passes `turns` directly (browser-STT mode where there's
    // nothing in Supabase to read from), use those instead of querying.
    const turnsFromBody: CoachTurn[] | undefined = Array.isArray(body.turns)
        ? body.turns
            .map((t) => {
                if (!t || typeof t !== 'object') return null;
                const o = t as Record<string, unknown>;
                const speakerRaw = typeof o.speaker === 'string' ? o.speaker : '';
                const speaker = (speakerRaw === 'agent' || speakerRaw === 'customer'
                    ? speakerRaw
                    : 'unknown') as CoachTurn['speaker'];
                const text = typeof o.text === 'string' ? o.text.slice(0, 600) : '';
                if (!text.trim()) return null;
                return { speaker, text };
            })
            .filter((t): t is CoachTurn => t !== null)
            .slice(-40) // hard cap so abusive clients can't blow tokens
        : undefined;

    // Lead is passed-through, lightly sanitized.
    let lead: { name?: string; company?: string; extra?: Record<string, string> } | undefined;
    if (body.lead && typeof body.lead === 'object') {
        const l = body.lead as Record<string, unknown>;
        lead = {
            name: typeof l.name === 'string' ? l.name : undefined,
            company: typeof l.company === 'string' ? l.company : undefined,
            extra: l.extra && typeof l.extra === 'object'
                ? Object.fromEntries(
                    Object.entries(l.extra as Record<string, unknown>)
                        .filter(([, v]) => typeof v === 'string' && v.length < 200)
                        .slice(0, 12)
                ) as Record<string, string>
                : undefined,
        };
    }

    let summary: CallSummary = EMPTY_SUMMARY;

    try {
        // 1) Resolve turns: prefer client-supplied (browser STT mode), fall
        // back to reading from Supabase (realtime/bridge mode).
        let turns: CoachTurn[];
        if (turnsFromBody && turnsFromBody.length > 0) {
            turns = turnsFromBody;
        } else {
            const sb = getServiceClient();
            const { data: rows } = await sb
                .from('call_transcripts')
                .select('speaker, text, is_final, created_at')
                .eq('call_sid', callSid)
                .eq('is_final', true)
                .order('created_at', { ascending: true });
            turns = (rows || [])
                .map((r) => ({
                    speaker: (r.speaker === 'agent' || r.speaker === 'customer'
                        ? r.speaker
                        : 'unknown') as CoachTurn['speaker'],
                    text: typeof r.text === 'string' ? r.text : '',
                }))
                .filter((t) => t.text.trim().length > 0);
        }

        // Empty transcript → still write a row so the UI doesn't hang forever.
        // (Best-effort — service-role write may fail in environments with no
        // Supabase set; we still return a 200 with a placeholder summary.)
        if (turns.length === 0) {
            try {
                const sb = getServiceClient();
                await sb.from('call_summaries').upsert(
                    {
                        call_sid: callSid,
                        summary: 'No speech captured for this call.',
                        sentiment: 'neutral',
                        next_action: '',
                        key_points: [],
                        crm_note: '',
                    },
                    { onConflict: 'call_sid' },
                );
            } catch { /* ignore — Supabase optional in browser-stt mode */ }
            return NextResponse.json({ ...EMPTY_SUMMARY, summary: 'No speech captured for this call.' });
        }

        // 2) Generate the summary.
        const adapter = createCoachAdapter();
        summary = await adapter.summarize({ callSid, turns, lead });

        // 3) Persist (upsert on call_sid — re-runs replace older summaries).
        // Best-effort: in browser-stt mode the user may not have run the
        // 002 migration. We swallow the error and still return the summary.
        try {
            const sb = getServiceClient();
            await sb.from('call_summaries').upsert(
                {
                    call_sid: callSid,
                    summary: summary.summary,
                    sentiment: summary.sentiment,
                    next_action: summary.next_action,
                    key_points: summary.key_points,
                    crm_note: summary.crm_note,
                },
                { onConflict: 'call_sid' },
            );
        } catch (err) {
            console.warn('[summarize] persist failed (ok in browser-stt mode):', err);
        }

        return NextResponse.json(summary);
    } catch (err) {
        console.error('[summarize] failed:', err);
        return NextResponse.json(EMPTY_SUMMARY);
    }
}
