/**
 * Thin Supabase wrapper for the bridge.
 *
 * Uses the service role key so RLS doesn't block inserts. This file is only
 * imported from server-side bridge code — never bundled with the browser.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Speaker } from './stt/types';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
    if (client) return client;
    const url = process.env.SUPABASE_URL || '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!url || !key) {
        throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    return client;
}

/**
 * Insert a single transcript chunk. We don't await inside the hot audio
 * path — instead, callers fire-and-log so a slow Supabase round-trip
 * never backs up audio processing.
 */
export async function insertTranscript(args: {
    callSid: string;
    speaker: Speaker;
    text: string;
    isFinal: boolean;
}): Promise<void> {
    const sb = getSupabase();
    const { error } = await sb.from('call_transcripts').insert({
        call_sid: args.callSid,
        speaker: args.speaker,
        text: args.text,
        is_final: args.isFinal,
    });
    if (error) {
        // Just log; we don't want to crash the bridge over a transient DB issue.
        console.warn('[supabase] insert failed:', error.message);
    }
}
