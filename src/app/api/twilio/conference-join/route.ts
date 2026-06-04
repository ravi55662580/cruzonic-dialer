import { NextResponse } from 'next/server';
import { buildConferenceTwiml } from '@/lib/conference';

/**
 * GET / POST /api/twilio/conference-join
 *
 * Twilio fetches this when we redirect a call leg into a conference. Returns
 * a `<Response><Dial><Conference>...</Conference></Dial></Response>`.
 *
 * Query params:
 *   name     — the conference name
 *   role     — agent | customer | transfer-target | monitor
 *   muted    — "true" to join muted (used for live-listen)
 *   endOnExit — "true" if THIS participant ending should kill the conference
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handle(request: Request) {
    const url = new URL(request.url);
    const name = url.searchParams.get('name') || '';
    const roleRaw = url.searchParams.get('role') || 'customer';
    const role = (
        ['agent', 'customer', 'transfer-target', 'monitor'].includes(roleRaw)
            ? roleRaw
            : 'customer'
    ) as 'agent' | 'customer' | 'transfer-target' | 'monitor';
    const muted = url.searchParams.get('muted') === 'true';
    const endOnExit = url.searchParams.get('endOnExit') === 'true';

    if (!name) {
        return new NextResponse('missing conference name', { status: 400 });
    }

    const twiml = buildConferenceTwiml({
        conferenceName: name,
        role,
        muted,
        endConferenceOnExit: endOnExit,
    });

    return new NextResponse(twiml, {
        headers: { 'Content-Type': 'text/xml' },
    });
}

export async function GET(request: Request) { return handle(request); }
export async function POST(request: Request) { return handle(request); }
