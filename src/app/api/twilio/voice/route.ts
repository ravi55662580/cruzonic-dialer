import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { getRandomCallerId } from '@/lib/twilio';
import { callerIdForRole, type AgentRole } from '@/lib/callerId';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://cruzonic-dialer.vercel.app';

/**
 * Look up the role of the agent who initiated this browser call.
 *
 * Twilio sends `From: client:<email>` for outbound calls placed via the
 * Voice SDK. We map that back to a profile row and read `role` so the
 * caller-ID can be picked based on whether the agent is sales or support.
 *
 * Returns null on any failure — the caller will fall back to the legacy
 * random pool, keeping calls working even if the DB is unreachable.
 */
async function lookupRoleForIdentity(identity: string): Promise<AgentRole> {
    try {
        // `identity` may be just the email or include a "client:" prefix; strip.
        const email = identity.replace(/^client:/, '').trim().toLowerCase();
        if (!email) return null;
        const { data } = await supabase
            .from('profiles')
            .select('role')
            .eq('email', email)
            .maybeSingle();
        if (!data) return null;
        return data.role as AgentRole;
    } catch (err) {
        console.warn('[voice] profile role lookup failed:', err);
        return null;
    }
}

/**
 * Get the Indian phone number of the agent currently on shift.
 * Shifts are stored in IST (UTC+5:30). Handles overnight shifts (e.g. 22→6).
 */
async function getOnShiftPhone(): Promise<string | null> {
    try {
        // Current hour in IST
        const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const currentHour = nowIST.getHours();

        const { data: shifts } = await supabase
            .from('support_shifts')
            .select('*')
            .eq('is_active', true);

        if (!shifts || shifts.length === 0) return null;

        const activeShift = shifts.find(s => {
            if (s.shift_start_hour < s.shift_end_hour) {
                // Normal shift (e.g. 6→14)
                return currentHour >= s.shift_start_hour && currentHour < s.shift_end_hour;
            } else {
                // Overnight shift (e.g. 22→6)
                return currentHour >= s.shift_start_hour || currentHour < s.shift_end_hour;
            }
        });

        return activeShift?.phone_number || null;
    } catch (err) {
        console.error('Error fetching on-shift agent:', err);
        return null;
    }
}

export async function POST(request: Request) {
    const twiml = new twilio.twiml.VoiceResponse();
    const formData = await request.formData();

    const to = formData.get('To') as string;
    const from = formData.get('From') as string;
    const callerId = formData.get('CallerId') as string;
    // Twilio also sends a `Direction` form field, but we infer direction
    // ourselves from From/To below since the Direction value is sometimes
    // missing for client-initiated outbound calls.

    // Detect if this is a real PSTN inbound call vs browser-initiated outbound
    // Browser outbound: From = "client:user@email.com", To = phone number
    // PSTN inbound: From = caller's phone, To = our Twilio number
    const isFromBrowser = from?.startsWith('client:');
    const ourNumbers = [
        process.env.TWILIO_PHONE_NUMBER_1 || '+13073920208',
        process.env.TWILIO_SALES_NUMBER,
        process.env.TWILIO_SUPPORT_NUMBER,
    ]
        .filter((n): n is string => Boolean(n))
        .map((n) => n.replace(/\s/g, ''));
    const isToOurNumber = to && ourNumbers.includes(to.replace(/\s/g, ''));

    const isInbound = !isFromBrowser && (!to || isToOurNumber);

    // If the live-coaching bridge is configured, fork the audio to it. The
    // <Start><Stream> verb is non-blocking — it starts a side-channel
    // WebSocket stream that runs in parallel with the <Dial> below.
    // Without STREAM_BRIDGE_URL set, this block is a no-op so existing
    // calls keep working unchanged.
    const bridgeUrl = process.env.STREAM_BRIDGE_URL;
    if (bridgeUrl) {
        const start = twiml.start();
        const streamUrl = process.env.BRIDGE_SHARED_SECRET
            ? `${bridgeUrl}?token=${encodeURIComponent(process.env.BRIDGE_SHARED_SECRET)}`
            : bridgeUrl;
        const stream = start.stream({ url: streamUrl, track: 'both_tracks' });
        // Custom parameters survive on the Twilio side and arrive in the
        // bridge's `start` event — handy when CallSid isn't yet populated
        // (e.g. browser-initiated outbound calls).
        stream.parameter({ name: 'callSidHint', value: formData.get('CallSid') as string || '' });
    }

    if (!isInbound && to) {
        // ── Outbound call from browser/app ──
        // Resolve the caller-ID number from the agent's role (sales vs support).
        // If the request explicitly provided a CallerId override (legacy clients
        // that pre-pick a number), we honour it. Otherwise we look up the role
        // for the browser identity and pick the matching env-configured number.
        let outboundCallerId = callerId;
        if (!outboundCallerId) {
            if (isFromBrowser) {
                const role = await lookupRoleForIdentity(from);
                outboundCallerId = callerIdForRole(role);
            } else {
                outboundCallerId = getRandomCallerId();
            }
        }
        if (/^[\d+\-() ]+$/.test(to.replace(/\s/g, ''))) {
            const dial = twiml.dial({
                callerId: outboundCallerId,
                record: 'record-from-answer-dual',
                recordingStatusCallback: `${appUrl}/api/twilio/recording`,
                recordingStatusCallbackMethod: 'POST',
                timeout: 30,
                machineDetection: 'Enable',
                machineDetectionTimeout: 5,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);
            dial.number(to);
        } else {
            // Dialing another client (agent)
            const dial = twiml.dial({
                callerId: from || getRandomCallerId(),
            });
            dial.client(to);
        }
    } else {
        // ── Inbound call — forward directly to on-shift agent's Indian phone ──
        const shiftPhone = await getOnShiftPhone();
        if (shiftPhone) {
            twiml.say({ voice: 'alice' }, 'Please hold while we connect you to support.');
            const dial = twiml.dial({
                callerId: from || getRandomCallerId(),
                timeout: 30,
                record: 'record-from-answer-dual',
                recordingStatusCallback: `${appUrl}/api/twilio/recording`,
                recordingStatusCallbackMethod: 'POST',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);
            dial.number(shiftPhone);
        } else {
            twiml.say(
                { voice: 'alice' },
                'Sorry, no support agents are available right now. Please try again later or leave a message after the beep.'
            );
            twiml.record({ maxLength: 120, transcribe: true });
        }
    }

    return new NextResponse(twiml.toString(), {
        headers: { 'Content-Type': 'text/xml' },
    });
}
