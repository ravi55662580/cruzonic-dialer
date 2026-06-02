import { NextResponse } from 'next/server';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';

export async function POST(request: Request) {
    try {
        const formData = await request.formData();
        const recordingSid = formData.get('RecordingSid') as string;
        const recordingUrl = formData.get('RecordingUrl') as string;
        const callSid = formData.get('CallSid') as string;
        const recordingDuration = formData.get('RecordingDuration') as string;
        const recordingStatus = formData.get('RecordingStatus') as string;

        console.log('Recording callback:', {
            recordingSid,
            recordingUrl,
            callSid,
            recordingDuration,
            recordingStatus,
        });

        // Save recording URL to database, matching by call_sid
        if (isSupabaseConfigured() && recordingUrl && callSid && recordingStatus === 'completed') {
            // Twilio recording URL needs .mp3 extension for playback
            const playbackUrl = `${recordingUrl}.mp3`;

            // Update the call log that has this call_sid
            const { data, error } = await supabase
                .from('call_logs')
                .update({ recording_url: playbackUrl })
                .eq('call_sid', callSid)
                .select();

            if (error) {
                console.error('Failed to save recording URL:', error);
            } else {
                console.log(`Recording saved for call ${callSid}:`, data);
            }
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Recording callback error:', error);
        return NextResponse.json({ error: 'Failed' }, { status: 500 });
    }
}
