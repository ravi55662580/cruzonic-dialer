/**
 * Find the customer's remote MediaStream from a Twilio Voice SDK Call.
 *
 * Twilio's Voice SDK 2.x doesn't expose a public `getRemoteStream()` method
 * across all versions, but it always plays the remote audio through an
 * `<audio>` element it attaches to the DOM. That element's `srcObject` is
 * the MediaStream we want.
 *
 * This polls the DOM for up to `timeoutMs` after the call is accepted,
 * which is normally enough for Twilio to add the audio element.
 */
export async function findTwilioRemoteStream(
    timeoutMs = 4000,
): Promise<MediaStream | null> {
    if (typeof document === 'undefined') return null;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const audios = document.querySelectorAll('audio');
        for (const a of Array.from(audios)) {
            const src = (a as HTMLAudioElement).srcObject;
            if (src instanceof MediaStream && src.getAudioTracks().length > 0) {
                return src;
            }
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    return null;
}
