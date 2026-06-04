import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
    appUrl,
    conferenceNameForCall,
    getTwilioClient,
} from '@/lib/conference';
import { callerIdForRole, type AgentRole } from '@/lib/callerId';

/**
 * POST /api/twilio/transfer
 *
 * Body: {
 *   agentCallSid: string;       // the parent call SID the agent's SDK is on
 *   targetPhone: string;        // E.164 of the senior to dial in
 *   targetName?: string;        // pretty label for the UI
 *   agentEmail?: string;        // identity of the agent triggering it
 * }
 *
 * Flow (warm transfer):
 *   1. Look up the customer leg (child call) of the agent's parent call.
 *   2. Pick a conference name keyed off the parent call SID.
 *   3. Redirect BOTH legs into the conference simultaneously. Audio bridges
 *      via the conference; customer never hears hold music.
 *   4. Dial the senior into the same conference.
 *   5. Record the conference + the agent/customer rows in Supabase so the
 *      dialer UI can subscribe to participant joins via Realtime.
 *
 * Returns: { conferenceName, transferCallSid }
 *
 * Failures don't unwind partial state — best-effort, log + 500.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getServiceClient() {
    return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || '',
        process.env.SUPABASE_SERVICE_ROLE_KEY || '',
        { auth: { persistSession: false, autoRefreshToken: false } },
    );
}

export async function POST(request: Request) {
    let body: {
        agentCallSid?: string;
        targetPhone?: string;
        targetName?: string;
        agentEmail?: string;
    };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }

    const agentCallSid = (body.agentCallSid || '').trim();
    const targetPhone = (body.targetPhone || '').trim();
    if (!agentCallSid || !targetPhone) {
        return NextResponse.json(
            { error: 'agentCallSid and targetPhone required' },
            { status: 400 },
        );
    }

    const conferenceName = conferenceNameForCall(agentCallSid);
    const client = getTwilioClient();

    try {
        // 1) Find the customer leg. The agent's parent call may have one or
        //    more child legs from a <Dial>. We want the most recently
        //    in-progress one.
        const children = await client.calls.list({
            parentCallSid: agentCallSid,
            limit: 5,
        });
        const customerLeg = children.find((c) => c.status === 'in-progress')
            || children[0];
        const customerCallSid = customerLeg?.sid;
        if (!customerCallSid) {
            return NextResponse.json(
                { error: 'no customer leg found for this call' },
                { status: 409 },
            );
        }

        // 2) Build the conference-join URLs for each role.
        const baseUrl = appUrl();
        const agentJoinUrl = `${baseUrl}/api/twilio/conference-join?name=${encodeURIComponent(conferenceName)}&role=agent`;
        const customerJoinUrl = `${baseUrl}/api/twilio/conference-join?name=${encodeURIComponent(conferenceName)}&role=customer`;

        // 3) Redirect the existing legs into the conference. Run in parallel
        //    to minimise the silent gap.
        await Promise.all([
            client.calls(agentCallSid).update({ url: agentJoinUrl, method: 'POST' }),
            client.calls(customerCallSid).update({ url: customerJoinUrl, method: 'POST' }),
        ]);

        // 4) Dial the senior into the same conference. Caller-ID respects the
        //    inviting agent's role (sales agents dialing from sales number, etc).
        //    The agent's role isn't always available here; fall back to legacy.
        const role: AgentRole = 'support'; // safe default for transfers
        const fromNumber = callerIdForRole(role);

        const transferCall = await client.calls.create({
            to: targetPhone,
            from: fromNumber,
            url: `${baseUrl}/api/twilio/conference-join?name=${encodeURIComponent(conferenceName)}&role=transfer-target`,
            method: 'POST',
            timeout: 30,
        });

        // 5) Persist conference state for the dialer UI to subscribe to.
        const sb = getServiceClient();
        try {
            await sb.from('call_conferences').upsert(
                {
                    conference_name: conferenceName,
                    original_call_sid: agentCallSid,
                    started_by_agent: body.agentEmail || null,
                    purpose: 'transfer',
                },
                { onConflict: 'conference_name' },
            );
            // Seed initial rows for agent + customer + pending senior so the UI
            // can show "Senior: calling…" right away, before the webhook fires.
            await sb.from('conference_participants').upsert(
                [
                    {
                        conference_name: conferenceName,
                        call_sid: agentCallSid,
                        role: 'agent',
                        display_name: body.agentEmail || 'Agent',
                    },
                    {
                        conference_name: conferenceName,
                        call_sid: customerCallSid,
                        role: 'customer',
                        display_name: 'Customer',
                    },
                    {
                        conference_name: conferenceName,
                        call_sid: transferCall.sid,
                        role: 'transfer-target',
                        display_name: body.targetName || 'Senior',
                        phone_number: targetPhone,
                    },
                ],
                { onConflict: 'conference_name,call_sid' },
            );
        } catch (err) {
            // Don't fail the transfer if Supabase persist hiccups — the call
            // continues. We just lose live participant updates in the UI.
            console.warn('[transfer] persist failed:', err);
        }

        return NextResponse.json({
            conferenceName,
            transferCallSid: transferCall.sid,
            customerCallSid,
        });
    } catch (err) {
        console.error('[transfer] failed:', err);
        const msg = err instanceof Error ? err.message : 'transfer failed';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
