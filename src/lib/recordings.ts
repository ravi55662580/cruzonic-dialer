/**
 * Convert a Twilio recording URL (raw `https://api.twilio.com/.../Recordings/REabc.mp3`)
 * into a same-origin proxy URL the browser can load without HTTP Basic-Auth
 * credentials. Twilio's recording endpoints require the account SID + auth
 * token as username/password, which Chrome surfaces as a login prompt. We
 * authenticate server-side via `/api/twilio/recordings/[sid]` instead.
 *
 * Input examples that work:
 *   https://api.twilio.com/2010-04-01/Accounts/ACxxx/Recordings/REabc.mp3
 *   https://api.twilio.com/2010-04-01/Accounts/ACxxx/Recordings/REabc
 *
 * If the URL doesn't look like a Twilio recording (already a proxy URL, a
 * custom CDN, or null), it's returned unchanged.
 */
export function recordingProxyUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    // Already a proxy URL — pass through.
    if (url.startsWith('/api/twilio/recordings/')) return url;
    // Match the recording SID (RE-prefixed) in a Twilio API URL.
    const m = url.match(/\/Recordings\/(RE[A-Za-z0-9]+)(?:\.[a-z0-9]+)?(?:\?|$)/);
    if (m && m[1]) {
        return `/api/twilio/recordings/${m[1]}.mp3`;
    }
    // Unrecognised — return as-is so non-Twilio recordings still play.
    return url;
}
