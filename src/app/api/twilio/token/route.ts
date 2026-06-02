import { NextResponse } from 'next/server';
import { generateAccessToken } from '@/lib/twilio';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const identity = body.identity || 'agent-1';
        const platform = body.platform || 'web';
        const pushCredentialSid = platform === 'android'
            ? process.env.TWILIO_PUSH_CREDENTIAL_SID
            : undefined;
        const token = generateAccessToken(identity, pushCredentialSid);

        return NextResponse.json({ token, identity });
    } catch (error) {
        console.error('Token generation error:', error);
        return NextResponse.json(
            { error: 'Failed to generate token' },
            { status: 500 }
        );
    }
}

// GET handler for mobile clients
export async function GET(request: Request) {
    try {
        const url = new URL(request.url);
        const identity = url.searchParams.get('identity') || 'agent-1';
        const platform = url.searchParams.get('platform') || 'web';
        const pushCredentialSid = platform === 'android'
            ? process.env.TWILIO_PUSH_CREDENTIAL_SID
            : undefined;
        const token = generateAccessToken(identity, pushCredentialSid);

        return NextResponse.json({ token, identity });
    } catch (error) {
        console.error('Token generation error:', error);
        return NextResponse.json(
            { error: 'Failed to generate token' },
            { status: 500 }
        );
    }
}
