import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';
import { getRandomCallerId } from '@/lib/twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
const authToken = process.env.TWILIO_AUTH_TOKEN || '';

// POST: Initiate an outbound call via Twilio REST API (for mobile app)
// The mobile app doesn't have the native Voice SDK, so we use server-initiated calling.
// Flow: Mobile → POST /api/twilio/mobile-call → Twilio creates call → connects to target
export async function POST(request: NextRequest) {
    try {
        if (!accountSid || !authToken) {
            return NextResponse.json(
                { error: 'Twilio not configured' },
                { status: 503 }
            );
        }

        const body = await request.json();
        const { to, callSid, action } = body;

        const client = twilio(accountSid, authToken);

        // Handle hangup action
        if (action === 'hangup' && callSid) {
            await client.calls(callSid).update({ status: 'completed' });
            return NextResponse.json({ success: true, status: 'completed' });
        }

        if (!to) {
            return NextResponse.json(
                { error: 'Missing "to" phone number' },
                { status: 400 }
            );
        }

        const callerId = getRandomCallerId();
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://cruzonic-dialer.vercel.app';

        // Create the call using Twilio REST API
        // This calls the target number and connects via TwiML
        const call = await client.calls.create({
            to: to,
            from: callerId,
            url: `${appUrl}/api/twilio/voice`,
            method: 'POST',
            record: true,
            statusCallback: `${appUrl}/api/twilio/mobile-call-status`,
            statusCallbackMethod: 'POST',
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            machineDetection: 'Enable',
        });

        return NextResponse.json({
            success: true,
            callSid: call.sid,
            status: call.status,
            to: call.to,
            from: call.from,
        });
    } catch (err: unknown) {
        console.error('Mobile call error:', err);
        const message = err instanceof Error ? err.message : 'Failed to initiate call';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

// GET: Check call status
export async function GET(request: NextRequest) {
    const callSid = request.nextUrl.searchParams.get('callSid');

    if (!callSid || !accountSid || !authToken) {
        return NextResponse.json({ error: 'Missing params' }, { status: 400 });
    }

    try {
        const client = twilio(accountSid, authToken);
        const call = await client.calls(callSid).fetch();

        return NextResponse.json({
            callSid: call.sid,
            status: call.status,
            duration: call.duration,
            startTime: call.startTime,
            endTime: call.endTime,
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to fetch call';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
