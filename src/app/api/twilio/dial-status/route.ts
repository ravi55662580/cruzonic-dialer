import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

/**
 * POST /api/twilio/dial-status
 *
 * Twilio posts here from `<Dial action="...">` on inbound calls when the
 * dial verb finishes (answered, no-answer, busy, failed). We use this as the
 * authoritative record of every inbound call — including those nobody picked
 * up — so the call_logs table has a row even when no browser session
 * answered.
 *
 * Twilio fields we care about:
 *   CallSid          — the PARENT (inbound PSTN) call SID. Stable across
 *                      all dial legs and matches the recording callback's
 *                      CallSid for `<Dial record="...">`.
 *   DialCallStatus   — completed | no-answer | busy | failed | canceled
 *   DialCallDuration — seconds the connected leg lasted (0 if no-answer)
 *   DialCallSid      — child call SID (the leg that actually rang/answered)
 *   From             — original caller's phone number
 *   To               — our Twilio number that was dialed
 *
 * Strategy: UPSERT by CallSid into call_logs. The agent's browser may have
 * already written a 'completed' row when they accepted — in that case we
 * preserve their fields (agent_name, duration). For missed calls, we write
 * a fresh row with disposition='no-answer' or whichever Twilio reported.
 */
export async function POST(request: Request) {
    try {
        const formData = await request.formData();
        const parentCallSid = (formData.get('CallSid') as string) || '';
        const dialStatus = ((formData.get('DialCallStatus') as string) || '').toLowerCase();
        const dialDurationRaw = formData.get('DialCallDuration') as string;
        const dialDuration = Number.parseInt(dialDurationRaw || '0', 10) || 0;
        const from = (formData.get('From') as string) || '';
        const to = (formData.get('To') as string) || '';

        // Map Twilio's dial statuses into the disposition labels the rest of
        // the app uses.
        const dispositionMap: Record<string, string> = {
            completed: 'completed',
            answered: 'completed',
            'no-answer': 'no-answer',
            busy: 'busy',
            failed: 'failed',
            canceled: 'canceled',
        };
        const disposition = dispositionMap[dialStatus] || dialStatus || 'unknown';

        console.log('[dial-status]', {
            parentCallSid, dialStatus, dialDuration, from, to,
        });

        if (!parentCallSid) {
            // Nothing we can key on — bail out gracefully.
            return new NextResponse('<Response/>', {
                headers: { 'Content-Type': 'text/xml' },
            });
        }

        // Look for an existing row written by the agent's browser.
        const { data: existing } = await supabase
            .from('call_logs')
            .select('id, disposition, duration, agent_id, agent_name')
            .eq('call_sid', parentCallSid)
            .maybeSingle();

        if (existing) {
            // The browser already wrote a row. Only fill in fields it might
            // have missed (e.g. confirm a duration) without clobbering the
            // agent attribution.
            const patch: Record<string, unknown> = {};
            // If the browser said 'completed' we trust it; otherwise upgrade
            // to whatever Twilio says.
            if (!existing.disposition || existing.disposition === 'ringing') {
                patch.disposition = disposition;
            }
            if (!existing.duration && dialDuration > 0) {
                patch.duration = dialDuration;
            }
            if (Object.keys(patch).length > 0) {
                await supabase
                    .from('call_logs')
                    .update(patch)
                    .eq('id', existing.id);
            }
        } else {
            // No agent ever wrote a row — this is a missed call. Insert one
            // so it shows up in the admin Call Logs as a missed inbound.
            await supabase
                .from('call_logs')
                .insert([{
                    number: from || '',
                    direction: 'inbound',
                    duration: dialDuration,
                    disposition,
                    agent_id: null,
                    agent_name: null,
                    call_sid: parentCallSid,
                    notes: to ? `Called: ${to}` : '',
                }]);
        }

        // Return empty TwiML — Twilio expects a TwiML response from action
        // callbacks. Returning nothing tells Twilio to hang up cleanly.
        return new NextResponse('<Response/>', {
            headers: { 'Content-Type': 'text/xml' },
        });
    } catch (err) {
        console.error('[dial-status] error:', err);
        return new NextResponse('<Response/>', {
            headers: { 'Content-Type': 'text/xml' },
        });
    }
}
