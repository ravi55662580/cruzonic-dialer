import { NextResponse } from 'next/server';
import { createCoachAdapter, type CoachRequest, type CoachResponse } from '@/lib/coach';

/**
 * POST /api/coach/suggestions
 *
 * Body: { callSid: string, turns: CoachTurn[], lead?: CoachLeadInfo }
 *
 * Returns the {@link CoachResponse} produced by the configured provider.
 * The API key never reaches the browser — this route runs on the server.
 *
 * We intentionally keep this fast and stateless:
 * - No DB read; the client already has the transcript in memory.
 * - The Node runtime (default) is fine; we don't stream, we just return JSON.
 */
export const runtime = 'nodejs';
// Force this route to be dynamic — we don't want any caching here.
export const dynamic = 'force-dynamic';

const MAX_TURNS = 12;
const MAX_TEXT = 600;

function sanitize(req: unknown): CoachRequest | null {
    if (!req || typeof req !== 'object') return null;
    const r = req as Record<string, unknown>;
    const callSid = typeof r.callSid === 'string' ? r.callSid : '';
    const turnsRaw = Array.isArray(r.turns) ? r.turns : [];
    const turns = turnsRaw
        .slice(-MAX_TURNS)
        .map((t) => {
            if (!t || typeof t !== 'object') return null;
            const obj = t as Record<string, unknown>;
            const speakerRaw = typeof obj.speaker === 'string' ? obj.speaker : '';
            const speaker =
                speakerRaw === 'agent' || speakerRaw === 'customer'
                    ? (speakerRaw as 'agent' | 'customer')
                    : 'unknown';
            const text = typeof obj.text === 'string' ? obj.text.slice(0, MAX_TEXT) : '';
            if (!text.trim()) return null;
            return { speaker, text };
        })
        .filter((x): x is { speaker: 'agent' | 'customer' | 'unknown'; text: string } => x !== null);

    let lead: CoachRequest['lead'] | undefined;
    if (r.lead && typeof r.lead === 'object') {
        const l = r.lead as Record<string, unknown>;
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

    return { callSid, turns, lead };
}

export async function POST(request: Request) {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }

    const req = sanitize(body);
    if (!req || !req.turns.length) {
        // No transcript yet — return an empty suggestion set rather than an error
        // so the UI just hides the panel.
        const empty: CoachResponse = { suggestions: [], objection: 'none' };
        return NextResponse.json(empty);
    }

    try {
        const adapter = createCoachAdapter();
        const response = await adapter.suggest(req);
        return NextResponse.json(response);
    } catch (err) {
        // Don't 500 — we'd rather degrade silently than break the dialer UI.
        // Log and return an empty result so the client just hides the chips.
        console.error('[coach] suggest failed:', err);
        const empty: CoachResponse = { suggestions: [], objection: 'none' };
        return NextResponse.json(empty);
    }
}
