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
 * Look up the identities (emails) of sales agents to ring for an inbound
 * call.
 *
 * Three layers, fall through each in turn:
 *   1. Agents whose `agent_status.status === 'ready'` (best case — they
 *      were registered and idle the last time their dialer broadcast).
 *   2. If nobody's "ready" (e.g. status broadcast missed) but recent
 *      agent_status rows exist (last 10 min, status NOT in busy set),
 *      include those.
 *   3. Last resort: every active sales / admin profile in the org. Twilio
 *      silently drops `<Dial><Client>` to identities whose Voice SDK
 *      Devices aren't registered, so this can't ring agents who are truly
 *      offline — it just guarantees we at least *try*.
 *
 * In all cases we exclude agents who are demonstrably busy (on-call /
 * wrap-up status) so we don't pile a second incoming on top of an active
 * conversation.
 */
async function getOnlineSalesAgents(): Promise<string[]> {
    try {
        const { data: statuses } = await supabase
            .from('agent_status')
            .select('agent_id, status, last_updated');

        const allStatuses = statuses || [];
        const busyIds = new Set(
            allStatuses
                .filter((s) => s.status === 'on-call' || s.status === 'wrap-up')
                .map((s) => s.agent_id),
        );

        // Layer 1: ready agents.
        const readyIds = allStatuses
            .filter((s) => s.status === 'ready')
            .sort((a, b) => (b.last_updated || '').localeCompare(a.last_updated || ''))
            .map((s) => s.agent_id);

        let candidateIds = readyIds;

        // Layer 2: recently-seen non-busy agents.
        if (candidateIds.length === 0) {
            const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            candidateIds = allStatuses
                .filter((s) => !busyIds.has(s.agent_id)
                    && s.last_updated && s.last_updated >= tenMinAgo)
                .map((s) => s.agent_id);
        }

        // Layer 3: all active sales / admin profiles.
        if (candidateIds.length === 0) {
            const { data: allActive } = await supabase
                .from('profiles')
                .select('id')
                .eq('is_active', true)
                .in('role', ['sales', 'admin']);
            candidateIds = (allActive || [])
                .map((p) => p.id as string)
                .filter((id) => !busyIds.has(id));
        }

        if (candidateIds.length === 0) return [];

        const { data: profiles } = await supabase
            .from('profiles')
            .select('id, email, role, is_active')
            .in('id', candidateIds);
        if (!profiles) return [];

        const eligibleById = new Map(
            profiles
                .filter((p) => p.is_active && (p.role === 'sales' || p.role === 'admin'))
                .map((p) => [p.id, p.email as string]),
        );

        const emails = candidateIds
            .map((id) => eligibleById.get(id))
            .filter((e): e is string => !!e);

        console.log(`[voice] inbound sales fanout to ${emails.length} client(s): ${emails.join(', ')}`);
        return emails;
    } catch (err) {
        console.error('Error fetching online sales agents:', err);
        return [];
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
        // ── Inbound call ─────────────────────────────────────────────────
        // Which of our Twilio numbers did the customer dial? That decides
        // whether we forward to a support agent's Indian phone (existing
        // shift-based routing) or ring online sales agents in the browser.
        const toNormalized = (to || '').replace(/\s/g, '');
        const supportNumber = (process.env.TWILIO_SUPPORT_NUMBER || '').replace(/\s/g, '');
        const salesNumber = (process.env.TWILIO_SALES_NUMBER || '').replace(/\s/g, '');
        const legacyNumber = (process.env.TWILIO_PHONE_NUMBER_1 || '+13073920208').replace(/\s/g, '');

        const isSupportCall = !!supportNumber && toNormalized === supportNumber;
        // Sales call: either dialed the explicit sales number, or the legacy
        // number (since legacy was historically the sales number). Falling
        // through to sales also covers the case where we can't tell.
        const isSalesCall = !isSupportCall && (
            (!!salesNumber && toNormalized === salesNumber) ||
            toNormalized === legacyNumber ||
            !toNormalized
        );

        if (isSupportCall) {
            // ── SUPPORT inbound: forward to on-shift support agent's Indian phone ──
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
        } else if (isSalesCall) {
            // ── SALES inbound: ring all currently-online sales agents in the
            //    browser. Twilio rings every <Client> simultaneously and the
            //    first to pick up wins; others stop ringing automatically.
            //    The agent's role is `sales` AND agent_status='ready'.
            const onlineAgents = await getOnlineSalesAgents();
            if (onlineAgents.length > 0) {
                // No greeting — `answerOnBridge: true` plays standard ringback
                // to the caller while we ring the agent browsers, which feels
                // like a normal phone call rather than an IVR.
                const dial = twiml.dial({
                    callerId: from || getRandomCallerId(),
                    timeout: 25,
                    record: 'record-from-answer-dual',
                    recordingStatusCallback: `${appUrl}/api/twilio/recording`,
                    recordingStatusCallbackMethod: 'POST',
                    answerOnBridge: true,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any);
                for (const identity of onlineAgents) {
                    dial.client(identity);
                }
                // If no agent picks up within the timeout, fall through to
                // voicemail (the <Say> + <Record> below execute when <Dial>
                // ends without an answered call).
                twiml.say(
                    { voice: 'alice' },
                    "Sorry, our sales agents didn't pick up. Please leave a brief message after the beep and we'll call you back."
                );
                twiml.record({ maxLength: 120, transcribe: true });
            } else {
                twiml.say(
                    { voice: 'alice' },
                    'Sorry, no sales agents are available right now. Please leave a message after the beep and we will call you back.'
                );
                twiml.record({ maxLength: 120, transcribe: true });
            }
        } else {
            // Unknown number — shouldn't happen, but fail safely with voicemail.
            twiml.say({ voice: 'alice' }, 'Please leave a message after the beep.');
            twiml.record({ maxLength: 120, transcribe: true });
        }
    }

    return new NextResponse(twiml.toString(), {
        headers: { 'Content-Type': 'text/xml' },
    });
}
