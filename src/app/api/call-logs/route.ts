import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Use service role key to bypass RLS for server-side operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseServiceKey);

function isConfigured() {
    return Boolean(supabaseUrl && supabaseServiceKey);
}

// GET: Fetch call logs (optionally filtered by agent)
export async function GET(request: NextRequest) {
    if (!isConfigured()) {
        return NextResponse.json({ logs: [], error: 'Database not configured' });
    }

    const agentId = request.nextUrl.searchParams.get('agent_id');

    let query = supabase
        .from('call_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);

    // If agent_id provided, filter by it
    if (agentId) {
        query = query.eq('agent_id', agentId);
    }

    const { data, error } = await query;

    if (error) {
        return NextResponse.json({ logs: [], error: error.message }, { status: 500 });
    }

    return NextResponse.json({ logs: data });
}

// POST: Save a new call log
export async function POST(request: Request) {
    if (!isConfigured()) {
        return NextResponse.json({ error: 'Database not configured' }, { status: 503 });
    }

    const body = await request.json();
    const { number, direction, duration, disposition, agent_id, agent_name, call_sid, notes } = body;

    const { data, error } = await supabase
        .from('call_logs')
        .insert([{
            number: number || '',
            direction: direction || 'outbound',
            duration: duration || 0,
            disposition: disposition || 'completed',
            agent_id: agent_id || null,
            agent_name: agent_name || null,
            call_sid: call_sid || null,
            notes: notes || '',
        }])
        .select()
        .single();

    if (error) {
        console.error('DB Insert Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ log: data });
}
