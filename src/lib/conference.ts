/**
 * Conference helpers — shared between the transfer + monitor endpoints.
 *
 * The Twilio REST API lets us redirect any in-progress call leg to new TwiML
 * via `client.calls(sid).update({ twiml: ... })`. We use that to drop both
 * the agent and customer legs into a named Conference, then add a third leg
 * (the senior or the admin) into the same Conference.
 *
 * Conference names are namespaced by call SID so they're unique per call.
 */

import twilio from 'twilio';

/** Pick a deterministic conference name from a call SID. */
export function conferenceNameForCall(callSid: string): string {
    return `cf-${callSid.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;
}

/** Resolve the absolute URL of one of our API routes — Twilio webhooks need a public URL. */
export function appUrl(): string {
    return process.env.NEXT_PUBLIC_APP_URL || 'https://cruzonic-dialer.vercel.app';
}

/** Build the `<Response><Dial><Conference>…</Conference></Dial></Response>` TwiML
 *  used to join a participant into the conference. Centralised so all callers
 *  pass the same status callback / start / end conditions.
 */
export function buildConferenceTwiml(opts: {
    conferenceName: string;
    muted?: boolean;
    role: 'agent' | 'customer' | 'transfer-target' | 'monitor';
    endConferenceOnExit?: boolean;
    startConferenceOnEnter?: boolean;
    beep?: 'true' | 'false' | 'onEnter' | 'onExit';
}): string {
    const twiml = new twilio.twiml.VoiceResponse();
    const dial = twiml.dial();
    dial.conference(
        {
            // Twilio status callback so we can populate the participants table.
            statusCallback: `${appUrl()}/api/twilio/conference-events?role=${opts.role}`,
            statusCallbackEvent: ['start', 'end', 'join', 'leave', 'mute'],
            statusCallbackMethod: 'POST',
            muted: opts.muted === true,
            // Default: don't end the whole conference when one person leaves.
            // We want the customer + senior to keep talking after the agent
            // drops out of a warm transfer.
            endConferenceOnExit: opts.endConferenceOnExit === true,
            // Default: start the conference the moment any participant joins
            // so audio bridges immediately (no silent hold while we wait for
            // a moderator).
            startConferenceOnEnter: opts.startConferenceOnEnter !== false,
            // No beep on join/leave — pure UX-quality audio.
            beep: opts.beep ?? 'false',
            waitUrl: '', // no hold music while waiting
        },
        opts.conferenceName,
    );
    return twiml.toString();
}

/** Lazy Twilio client. */
export function getTwilioClient() {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error('Twilio credentials missing');
    return twilio(sid, token);
}
