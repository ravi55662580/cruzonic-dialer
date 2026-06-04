import { NextResponse } from 'next/server';

/**
 * GET /api/twilio/recordings/[sid].mp3
 *
 * Server-side proxy for a Twilio call recording. Without this, the browser
 * tries to load Twilio's API URL directly, hits HTTP Basic-Auth, and pops a
 * username/password prompt asking for the Account SID + Auth Token (which
 * you obviously don't want to ship to the browser).
 *
 * We authenticate with the Twilio creds server-side and stream the audio
 * bytes back with appropriate headers. Supports Range requests (so the
 * audio player can seek mid-file).
 *
 * URL format: `/api/twilio/recordings/REabc123.mp3` — the `.mp3` extension
 * is preserved in the param and stripped here. Twilio also serves `.wav`
 * and other formats; we accept whatever extension the client passes through.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ sid: string }> },
) {
    const { sid: rawSid } = await params;
    if (!rawSid) {
        return NextResponse.json({ error: 'sid required' }, { status: 400 });
    }
    // Strip the format extension if present — Twilio decides format by URL.
    const sidMatch = rawSid.match(/^(RE[A-Za-z0-9]+)(?:\.([a-z0-9]+))?$/);
    if (!sidMatch) {
        return NextResponse.json({ error: 'invalid recording sid' }, { status: 400 });
    }
    const sid = sidMatch[1];
    const ext = (sidMatch[2] || 'mp3').toLowerCase();

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
        return NextResponse.json({ error: 'twilio credentials not configured' }, { status: 500 });
    }

    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${sid}.${ext}`;
    const basicAuth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    // Forward Range header for seekable playback.
    const range = request.headers.get('range');
    const forwardedHeaders: Record<string, string> = {
        Authorization: basicAuth,
    };
    if (range) forwardedHeaders.Range = range;

    const upstream = await fetch(twilioUrl, {
        headers: forwardedHeaders,
        // Don't cache — each Twilio request is auth'd individually.
        cache: 'no-store',
    });

    if (!upstream.ok && upstream.status !== 206) {
        return NextResponse.json(
            { error: `twilio ${upstream.status}` },
            { status: upstream.status },
        );
    }

    // Build the response headers from the upstream, copying audio-relevant ones.
    const responseHeaders = new Headers();
    const contentType = upstream.headers.get('content-type');
    const contentLength = upstream.headers.get('content-length');
    const contentRange = upstream.headers.get('content-range');
    const acceptRanges = upstream.headers.get('accept-ranges');

    if (contentType) responseHeaders.set('Content-Type', contentType);
    else responseHeaders.set('Content-Type', ext === 'wav' ? 'audio/wav' : 'audio/mpeg');
    if (contentLength) responseHeaders.set('Content-Length', contentLength);
    if (contentRange) responseHeaders.set('Content-Range', contentRange);
    if (acceptRanges) responseHeaders.set('Accept-Ranges', acceptRanges);
    // Small private cache is fine — content is immutable per SID, but only
    // the authenticated session should see it.
    responseHeaders.set('Cache-Control', 'private, max-age=60');

    return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
    });
}
