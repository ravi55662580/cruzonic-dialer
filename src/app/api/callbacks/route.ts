import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

// GET: Fetch callbacks for an agent
export async function GET(request: NextRequest) {
    const agentId = request.nextUrl.searchParams.get('agent_id');

    let query = supabase
        .from('callbacks')
        .select('*')
        .order('scheduled_at', { ascending: true });

    if (agentId) {
        query = query.eq('agent_id', agentId);
    }

    // Only show pending/upcoming by default
    query = query.eq('status', 'pending');

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ callbacks: data });
}

// POST: Create a callback
export async function POST(request: Request) {
    const body = await request.json();
    const { phone, lead_name, agent_id, scheduled_at, notes, lead_id } = body;

    if (!phone || !scheduled_at) {
        return NextResponse.json({ error: 'Phone and scheduled_at required' }, { status: 400 });
    }

    const { data, error } = await supabase
        .from('callbacks')
        .insert([{
            phone,
            lead_name: lead_name || '',
            agent_id: agent_id || null,
            scheduled_at,
            notes: notes || '',
            lead_id: lead_id || null,
            status: 'pending',
        }])
        .select()
        .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ callback: data });
}

// PUT: Update callback status (completed, cancelled)
export async function PUT(request: Request) {
    const body = await request.json();
    const { id, status } = body;

    if (!id || !status) {
        return NextResponse.json({ error: 'ID and status required' }, { status: 400 });
    }

    const { data, error } = await supabase
        .from('callbacks')
        .update({ status })
        .eq('id', id)
        .select()
        .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ callback: data });
}

// DELETE: Delete a callback
export async function DELETE(request: NextRequest) {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
        return NextResponse.json({ error: 'ID required' }, { status: 400 });
    }

    const { error } = await supabase.from('callbacks').delete().eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true });
}
