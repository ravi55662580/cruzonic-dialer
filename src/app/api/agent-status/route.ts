import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

// GET: Fetch all agent statuses
export async function GET() {
    // Join with profiles to get agent names
    const { data, error } = await supabase
        .from('agent_status')
        .select(`
            agent_id,
            status,
            current_call_number,
            current_call_sid,
            last_updated
        `);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Fetch profile names separately
    const agentIds = (data || []).map(d => d.agent_id);
    let profiles: Record<string, string> = {};
    if (agentIds.length > 0) {
        const { data: profileData } = await supabase
            .from('profiles')
            .select('id, full_name, email')
            .in('id', agentIds);
        if (profileData) {
            profiles = Object.fromEntries(
                profileData.map(p => [p.id, p.full_name || p.email])
            );
        }
    }

    // Treat any 'ready' row whose last_updated is older than the staleness
    // cutoff as actually 'offline'. This catches closed-browser / asleep-
    // laptop sessions that never sent us a clean 'offline' update.
    const STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();
    const enriched = (data || []).map((d) => {
        const updatedAt = d.last_updated ? new Date(d.last_updated).getTime() : 0;
        const isStale = updatedAt > 0 && now - updatedAt > STALE_AFTER_MS;
        return {
            ...d,
            status: isStale && d.status !== 'offline' ? 'offline' : d.status,
            stale: isStale,
            agent_name: profiles[d.agent_id] || 'Unknown',
        };
    });

    return NextResponse.json({ statuses: enriched });
}

// PUT: Update agent status
export async function PUT(request: Request) {
    const body = await request.json();
    const { agent_id, status, current_call_number, current_call_sid } = body;

    if (!agent_id || !status) {
        return NextResponse.json({ error: 'agent_id and status required' }, { status: 400 });
    }

    const { data, error } = await supabase
        .from('agent_status')
        .upsert([{
            agent_id,
            status,
            current_call_number: current_call_number || '',
            current_call_sid: current_call_sid || null,
            last_updated: new Date().toISOString(),
        }], { onConflict: 'agent_id' })
        .select()
        .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ status: data });
}
