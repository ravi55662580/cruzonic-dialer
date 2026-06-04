import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/twilio/conference-events
 *
 * Twilio's conference status callback. Fires for participant join / leave /
 * mute / hold and start / end of the conference. We write the deltas into
 * the conference_participants table so the dialer + admin UIs can update
 * via Supabase Realtime.
 *
 * Twilio sends form-urlencoded fields. Relevant ones:
 *   StatusCallbackEvent — participant-join | participant-leave | participant-mute |
 *                         participant-unmute | conference-end | conference-start
 *   CallSid             — the participant call SID
 *   ConferenceSid       — Twilio's CFxxx SID (not our name)
 *   FriendlyName        — the conference name we chose (matches `name` param)
 *   Muted               — "true" / "false"
 *   Hold                — "true" / "false"
 *
 * The `role` query param we set on the conference statusCallback URL travels
 * with each event so we can label participants without a separate lookup.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getServiceClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    return createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
}

export async function POST(request: Request) {
    let form: FormData;
    try {
        form = await request.formData();
    } catch {
        return NextResponse.json({ ok: true }); // never 4xx — Twilio retries.
    }

    const event = (form.get('StatusCallbackEvent') || '').toString();
    const callSid = (form.get('CallSid') || '').toString();
    const friendlyName = (form.get('FriendlyName') || '').toString();
    const muted = (form.get('Muted') || '').toString() === 'true';

    const url = new URL(request.url);
    const role = url.searchParams.get('role') || null;

    if (!friendlyName) {
        return NextResponse.json({ ok: true });
    }

    try {
        const sb = getServiceClient();

        if (event === 'conference-end') {
            await sb
                .from('call_conferences')
                .update({ ended_at: new Date().toISOString() })
                .eq('conference_name', friendlyName);
        } else if (event === 'participant-leave' && callSid) {
            await sb
                .from('conference_participants')
                .update({ left_at: new Date().toISOString() })
                .eq('conference_name', friendlyName)
                .eq('call_sid', callSid);
        } else if (event === 'participant-join' && callSid) {
            // Upsert in case the row already exists (seeded by /transfer or /monitor).
            await sb.from('conference_participants').upsert(
                {
                    conference_name: friendlyName,
                    call_sid: callSid,
                    role: role || 'customer',
                    is_muted: muted,
                    joined_at: new Date().toISOString(),
                    left_at: null,
                },
                { onConflict: 'conference_name,call_sid' },
            );
        } else if ((event === 'participant-mute' || event === 'participant-unmute') && callSid) {
            await sb
                .from('conference_participants')
                .update({ is_muted: muted })
                .eq('conference_name', friendlyName)
                .eq('call_sid', callSid);
        }
    } catch (err) {
        console.warn('[conference-events] persist failed:', err);
    }

    return NextResponse.json({ ok: true });
}
