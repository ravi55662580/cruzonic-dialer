import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
    appUrl,
    conferenceNameForCall,
    getTwilioClient,
} from '@/lib/conference';
import { callerIdForRole } from '@/lib/callerId';

/**
 * POST /api/twilio/monitor
 *
 * Body: {
 *   agentCallSid: string;     // the agent's parent call SID
 *   adminPhone: string;       // E.164 phone of the admin to ring
 *   adminEmail?: string;      // pretty label
 * }
 *
 * Promotes the agent's active 2-party call into a Conference and dials the
 * admin in MUTED — they hear both sides but neither side hears them. Useful
 * for live coaching / QA.
 *
 * If the call is already a conference (e.g. a transfer was initiated first),
 * we just add the admin as a muted participant.
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
        adminIdentity?: string;  // email of admin's signed-in dialer (preferred)
        adminPhone?: string;     // fallback to PSTN ring
        adminEmail?: string;
    };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }

    const agentCallSid = (body.agentCallSid || '').trim();
    const adminIdentity = (body.adminIdentity || '').trim();
    const adminPhone = (body.adminPhone || '').trim();
    if (!agentCallSid || (!adminIdentity && !adminPhone)) {
        return NextResponse.json(
            { error: 'agentCallSid and either adminIdentity or adminPhone required' },
            { status: 400 },
        );
    }

    const conferenceName = conferenceNameForCall(agentCallSid);
    const client = getTwilioClient();
    const baseUrl = appUrl();

    try {
        const sb = getServiceClient();

        // 1) Check if the conference already exists (active transfer in
        //    progress, or a previous monitor). If not, promote the call into
        //    a fresh conference now.
        const { data: existingConf } = await sb
            .from('call_conferences')
            .select('conference_name, ended_at')
            .eq('conference_name', conferenceName)
            .maybeSingle();
        const alreadyInConference = existingConf && !existingConf.ended_at;

        if (!alreadyInConference) {
            // Look up the customer leg + redirect both into a conference.
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

            const agentJoinUrl = `${baseUrl}/api/twilio/conference-join?name=${encodeURIComponent(conferenceName)}&role=agent`;
            const customerJoinUrl = `${baseUrl}/api/twilio/conference-join?name=${encodeURIComponent(conferenceName)}&role=customer`;

            await Promise.all([
                client.calls(agentCallSid).update({ url: agentJoinUrl, method: 'POST' }),
                client.calls(customerCallSid).update({ url: customerJoinUrl, method: 'POST' }),
            ]);

            try {
                await sb.from('call_conferences').upsert(
                    {
                        conference_name: conferenceName,
                        original_call_sid: agentCallSid,
                        started_by_agent: body.adminEmail || null,
                        purpose: 'monitor',
                    },
                    { onConflict: 'conference_name' },
                );
                await sb.from('conference_participants').upsert(
                    [
                        {
                            conference_name: conferenceName,
                            call_sid: agentCallSid,
                            role: 'agent',
                            display_name: 'Agent',
                        },
                        {
                            conference_name: conferenceName,
                            call_sid: customerCallSid,
                            role: 'customer',
                            display_name: 'Customer',
                        },
                    ],
                    { onConflict: 'conference_name,call_sid' },
                );
            } catch (err) {
                console.warn('[monitor] seed persist failed:', err);
            }
        }

        // 2) Ring the admin into the conference muted. Browser identity is
        //    preferred (no phone needed); PSTN phone is the fallback.
        const toAddress = adminIdentity
            ? `client:${adminIdentity}`
            : adminPhone;

        const monitorCall = await client.calls.create({
            to: toAddress,
            from: callerIdForRole('admin'),
            url: `${baseUrl}/api/twilio/conference-join?name=${encodeURIComponent(conferenceName)}&role=monitor&muted=true`,
            method: 'POST',
            timeout: 30,
        });

        try {
            await sb.from('conference_participants').upsert(
                {
                    conference_name: conferenceName,
                    call_sid: monitorCall.sid,
                    role: 'monitor',
                    display_name: body.adminEmail || adminIdentity || 'Admin',
                    phone_number: adminPhone || (adminIdentity ? `client:${adminIdentity}` : null),
                    is_muted: true,
                },
                { onConflict: 'conference_name,call_sid' },
            );
        } catch (err) {
            console.warn('[monitor] persist failed:', err);
        }

        return NextResponse.json({
            conferenceName,
            monitorCallSid: monitorCall.sid,
        });
    } catch (err) {
        console.error('[monitor] failed:', err);
        const msg = err instanceof Error ? err.message : 'monitor failed';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
