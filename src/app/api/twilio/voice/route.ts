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
 * Look up the identities (emails) of agents to ring for an inbound call.
 *
 * Two layers, fall through:
 *   1. Agents whose `agent_status.status === 'ready'` AND whose row was
 *      updated within the last 30 minutes (the heartbeat keeps it fresh —
 *      anything older means the browser tab is closed / laptop asleep).
 *   2. If nobody fits, recent (<10 min) non-busy agents regardless of
 *      status — covers wrap-up / connecting state where the dialer is
 *      effectively alive but didn't get back to 'ready' yet.
 *
 * Agents demonstrably busy (on-call / wrap-up) are always excluded.
 *
 * @param roles  Profile roles eligible to take this call. Sales calls →
 *               ['sales', 'admin']; support calls → ['support', 'admin'].
 */
async function getOnlineAgentsForRoles(roles: Array<'sales' | 'support' | 'admin'>): Promise<string[]> {
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

        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

        // Layer 1: ready AND fresh.
        const readyIds = allStatuses
            .filter((s) => s.status === 'ready'
                && s.last_updated && s.last_updated >= thirtyMinAgo)
            .sort((a, b) => (b.last_updated || '').localeCompare(a.last_updated || ''))
            .map((s) => s.agent_id);

        let candidateIds = readyIds;

        // Layer 2: recently-seen non-busy.
        if (candidateIds.length === 0) {
            candidateIds = allStatuses
                .filter((s) => !busyIds.has(s.agent_id)
                    && s.last_updated && s.last_updated >= tenMinAgo)
                .map((s) => s.agent_id);
        }

        if (candidateIds.length === 0) return [];

        const { data: profiles } = await supabase
            .from('profiles')
            .select('id, email, role, is_active')
            .in('id', candidateIds);
        if (!profiles) return [];

        const eligibleById = new Map(
            profiles
                .filter((p) => p.is_active && roles.includes(p.role as 'sales' | 'support' | 'admin'))
                .map((p) => [p.id, p.email as string]),
        );

        const emails = candidateIds
            .map((id) => eligibleById.get(id))
            .filter((e): e is string => !!e);

        console.log(`[voice] inbound fanout (${roles.join(',')}) to ${emails.length} client(s): ${emails.join(', ')}`);
        return emails;
    } catch (err) {
        console.error('[voice] online-agent lookup failed:', err);
        return [];
    }
}

const getOnlineSalesAgents = () => getOnlineAgentsForRoles(['sales', 'admin']);
const getOnlineSupportAgents = () => getOnlineAgentsForRoles(['support', 'admin']);

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
    // The CallSid Twilio assigns to this leg. For inbound PSTN calls, this is
    // the PARENT call SID — and it's also the CallSid that will appear on the
    // <Dial> recording status callback. We pass it down to the agent's browser
    // as a <Parameter> so the inbound row in call_logs is keyed by it and the
    // recording lookup succeeds.
    const parentCallSid = (formData.get('CallSid') as string) || '';
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

        // Shared helper to append a phone-number fallback dial leg. Returns
        // the appended <Dial> so the caller can chain `.number(...)`.
        const appendPhoneDial = (toNumber: string, label?: string) => {
            if (label) twiml.say({ voice: 'alice' }, label);
            const dial = twiml.dial({
                callerId: from || getRandomCallerId(),
                timeout: 30,
                record: 'record-from-answer-dual',
                recordingStatusCallback: `${appUrl}/api/twilio/recording`,
                recordingStatusCallbackMethod: 'POST',
                action: `${appUrl}/api/twilio/dial-status`,
                method: 'POST',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);
            dial.number(toNumber);
            return dial;
        };

        if (isSupportCall) {
            // ── SUPPORT inbound: ring online support agents' browsers, then
            //    fall back to the on-shift Indian phone, then voicemail.
            const onlineAgents = await getOnlineSupportAgents();
            if (onlineAgents.length > 0) {
                const dial = twiml.dial({
                    callerId: from || getRandomCallerId(),
                    timeout: 25,
                    record: 'record-from-answer-dual',
                    recordingStatusCallback: `${appUrl}/api/twilio/recording`,
                    recordingStatusCallbackMethod: 'POST',
                    action: `${appUrl}/api/twilio/dial-status`,
                    method: 'POST',
                    answerOnBridge: true,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any);
                for (const identity of onlineAgents) {
                    const client = dial.client(identity);
                    // Surface the parent CallSid + true caller to the agent's
                    // browser so the call_logs row is keyed correctly.
                    if (parentCallSid) {
                        client.parameter({ name: 'parentCallSid', value: parentCallSid });
                    }
                    if (from) client.parameter({ name: 'callerFrom', value: from });
                    if (to) client.parameter({ name: 'calledTo', value: to });
                    client.parameter({ name: 'callDirection', value: 'inbound' });
                    client.parameter({ name: 'callQueue', value: 'support' });
                }
            }
            // Second leg: on-shift agent's phone (if any). Twilio only reaches
            // this if the <Client> dial above didn't connect (or wasn't emitted).
            const shiftPhone = await getOnShiftPhone();
            if (shiftPhone) {
                appendPhoneDial(
                    shiftPhone,
                    onlineAgents.length > 0
                        ? undefined
                        : 'Please hold while we connect you to support.',
                );
            }
            // Final leg: voicemail.
            twiml.say(
                { voice: 'alice' },
                "Sorry, no support agents are available right now. Please leave a message after the beep and we'll call you back."
            );
            twiml.record({ maxLength: 120, transcribe: true });
        } else if (isSalesCall) {
            // ── SALES inbound: ring online sales agents in the browser, then
            //    fall back to the configured Indian sales-agent phone, then
            //    voicemail. No spoken greeting — `answerOnBridge` keeps
            //    normal ringback playing to the caller.
            const onlineAgents = await getOnlineSalesAgents();
            if (onlineAgents.length > 0) {
                const dial = twiml.dial({
                    callerId: from || getRandomCallerId(),
                    timeout: 25,
                    record: 'record-from-answer-dual',
                    recordingStatusCallback: `${appUrl}/api/twilio/recording`,
                    recordingStatusCallbackMethod: 'POST',
                    action: `${appUrl}/api/twilio/dial-status`,
                    method: 'POST',
                    answerOnBridge: true,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any);
                for (const identity of onlineAgents) {
                    const client = dial.client(identity);
                    if (parentCallSid) {
                        client.parameter({ name: 'parentCallSid', value: parentCallSid });
                    }
                    if (from) client.parameter({ name: 'callerFrom', value: from });
                    if (to) client.parameter({ name: 'calledTo', value: to });
                    client.parameter({ name: 'callDirection', value: 'inbound' });
                    client.parameter({ name: 'callQueue', value: 'sales' });
                }
            }
            // Second leg: dial the Indian sales-agent fallback phone.
            const salesFallback = (process.env.SALES_FALLBACK_PHONE
                || '+919614308316').replace(/\s/g, '');
            if (salesFallback) {
                appendPhoneDial(salesFallback);
            }
            // Final leg: voicemail.
            twiml.say(
                { voice: 'alice' },
                "Sorry, our sales agents didn't pick up. Please leave a brief message after the beep and we'll call you back."
            );
            twiml.record({ maxLength: 120, transcribe: true });
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
