import { NextResponse } from 'next/server';
import twilio from 'twilio';

export async function POST(request: Request) {
    const twiml = new twilio.twiml.VoiceResponse();
    const formData = await request.formData();
    const dialCallStatus = formData.get('DialCallStatus') as string;

    if (dialCallStatus !== 'completed' && dialCallStatus !== 'answered') {
        // Browser agent didn't answer — forward to mobile
        const fallbackNumber = process.env.FALLBACK_PHONE_NUMBER;

        if (fallbackNumber) {
            twiml.say('Please hold while we connect you.');
            const dial = twiml.dial({
                timeout: 20,
                callerId: formData.get('Called') as string,
            });
            dial.number(fallbackNumber);
        } else {
            twiml.say('Sorry, no one is available right now. Please leave a message after the beep.');
            twiml.record({
                maxLength: 120,
                transcribe: false,
            });
        }
    }

    return new NextResponse(twiml.toString(), {
        headers: { 'Content-Type': 'text/xml' },
    });
}
