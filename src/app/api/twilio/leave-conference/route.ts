import { NextResponse } from 'next/server';
import { getTwilioClient } from '@/lib/conference';

/**
 * POST /api/twilio/leave-conference
 *
 * Body: { callSid: string }
 *
 * Used by the agent's UI after a warm transfer: the agent drops out of the
 * conference, leaving the customer + senior connected. Implemented by
 * redirecting the agent's leg to a `<Hangup/>` TwiML.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    let body: { callSid?: string };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }
    const callSid = (body.callSid || '').trim();
    if (!callSid) {
        return NextResponse.json({ error: 'callSid required' }, { status: 400 });
    }

    try {
        const client = getTwilioClient();
        await client.calls(callSid).update({
            twiml: '<Response><Hangup/></Response>',
        });
        return NextResponse.json({ ok: true });
    } catch (err) {
        console.error('[leave-conference] failed:', err);
        const msg = err instanceof Error ? err.message : 'failed';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
