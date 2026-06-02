import { NextResponse } from 'next/server';

// POST: Receive call status updates from Twilio for mobile-initiated calls
export async function POST(request: Request) {
    const formData = await request.formData();
    const callSid = formData.get('CallSid') as string;
    const callStatus = formData.get('CallStatus') as string;
    const duration = formData.get('CallDuration') as string;

    console.log(`[Mobile Call Status] SID: ${callSid}, Status: ${callStatus}, Duration: ${duration}s`);

    return new NextResponse('OK', { status: 200 });
}
