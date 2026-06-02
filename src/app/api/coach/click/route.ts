import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/coach/click
 *
 * Tiny fire-and-forget telemetry endpoint. The client posts whenever the agent
 * copies a suggested reply. We persist to `coach_clicks` so we can later
 * grade prompt quality (e.g. % of suggestions copied, which intents land
 * most, which objections close vs. stall).
 *
 * Always returns 200 — failures here must never affect the dialer UX.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ClickBody {
    callSid: string;
    suggestionText: string;
    intent?: string;
    objection?: string;
    suggestionIdx?: number;
}

function sanitize(b: unknown): ClickBody | null {
    if (!b || typeof b !== 'object') return null;
    const obj = b as Record<string, unknown>;
    const callSid = typeof obj.callSid === 'string' ? obj.callSid : '';
    const suggestionText = typeof obj.suggestionText === 'string'
        ? obj.suggestionText.slice(0, 600)
        : '';
    if (!callSid || !suggestionText) return null;
    return {
        callSid,
        suggestionText,
        intent: typeof obj.intent === 'string' ? obj.intent.slice(0, 40) : undefined,
        objection: typeof obj.objection === 'string' ? obj.objection.slice(0, 40) : undefined,
        suggestionIdx: typeof obj.suggestionIdx === 'number' && Number.isFinite(obj.suggestionIdx)
            ? Math.max(0, Math.min(99, Math.floor(obj.suggestionIdx)))
            : undefined,
    };
}

export async function POST(request: Request) {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ ok: true }); // never 4xx — telemetry must not block UI
    }

    const click = sanitize(body);
    if (!click) return NextResponse.json({ ok: true });

    try {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
        if (url && key) {
            const sb = createClient(url, key, {
                auth: { persistSession: false, autoRefreshToken: false },
            });
            await sb.from('coach_clicks').insert({
                call_sid: click.callSid,
                suggestion_text: click.suggestionText,
                intent: click.intent || null,
                objection: click.objection || null,
                suggestion_idx: click.suggestionIdx ?? null,
            });
        }
    } catch (err) {
        console.warn('[coach/click] write failed:', err);
    }

    return NextResponse.json({ ok: true });
}
