import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { getRandomCallerId } from '@/lib/twilio';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://cruzonic-dialer.vercel.app';

/**
 * Voice Fallback — called by Twilio when agents don't answer.
 * Forwards the call to the Indian phone number of the agent on shift.
 */
export async function POST(request: Request) {
    const twiml = new twilio.twiml.VoiceResponse();
    const formData = await request.formData();

    const dialCallStatus = formData.get('DialCallStatus') as string;
    const from = formData.get('From') as string;

    // If the agent answered, the call is already connected — do nothing
    if (dialCallStatus === 'completed') {
        twiml.hangup();
        return new NextResponse(twiml.toString(), {
            headers: { 'Content-Type': 'text/xml' },
        });
    }

    // Agent didn't answer (no-answer, busy, failed, canceled)
    // Forward to the on-shift agent's Indian phone number
    try {
        // Get current IST hour
        const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const currentHour = nowIST.getHours();

        const { data: shifts } = await supabase
            .from('support_shifts')
            .select('*')
            .eq('is_active', true);

        const activeShift = shifts?.find(s => {
            if (s.shift_start_hour < s.shift_end_hour) {
                return currentHour >= s.shift_start_hour && currentHour < s.shift_end_hour;
            } else {
                return currentHour >= s.shift_start_hour || currentHour < s.shift_end_hour;
            }
        });

        if (activeShift?.phone_number) {
            twiml.say(
                { voice: 'alice' },
                'Our online agents are busy. Connecting you to support.'
            );
            const dial = twiml.dial({
                callerId: from || getRandomCallerId(),
                timeout: 30,
                record: 'record-from-answer-dual',
                recordingStatusCallback: `${appUrl}/api/twilio/recording`,
                recordingStatusCallbackMethod: 'POST',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);
            dial.number(activeShift.phone_number);
        } else {
            twiml.say(
                { voice: 'alice' },
                'Sorry, no support agents are available right now. Please try again later or leave a message after the beep.'
            );
            twiml.record({ maxLength: 120, transcribe: true });
        }
    } catch (err) {
        console.error('Fallback error:', err);
        twiml.say({ voice: 'alice' }, 'We are experiencing technical difficulties. Please try again later.');
    }

    return new NextResponse(twiml.toString(), {
        headers: { 'Content-Type': 'text/xml' },
    });
}
