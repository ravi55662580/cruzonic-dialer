import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

// GET: Fetch all lead lists (optionally filter by agent_id)
export async function GET(request: NextRequest) {
    const agentId = request.nextUrl.searchParams.get('agent_id');

    let query = supabase
        .from('lead_lists')
        .select('*')
        .order('created_at', { ascending: false });

    if (agentId) {
        query = query.eq('agent_id', agentId);
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ lists: data });
}

// POST: Create a new lead list with leads
export async function POST(request: Request) {
    const body = await request.json();
    const { name, agent_id, leads } = body;

    if (!name) {
        return NextResponse.json({ error: 'List name required' }, { status: 400 });
    }

    // Create the list
    const { data: list, error: listError } = await supabase
        .from('lead_lists')
        .insert([{
            name,
            agent_id: agent_id || null,
            lead_count: leads?.length || 0,
        }])
        .select()
        .single();

    if (listError) {
        return NextResponse.json({ error: listError.message }, { status: 500 });
    }

    // Insert leads if provided
    if (leads && leads.length > 0) {
        const leadsWithListId = leads.map((lead: Record<string, string>) => ({
            list_id: list.id,
            phone: lead.phone || '',
            first_name: lead.firstName || lead.first_name || '',
            last_name: lead.lastName || lead.last_name || '',
            company: lead.company || '',
            email: lead.email || '',
            city: lead.city || '',
            state: lead.state || '',
            custom1: lead.custom1 || '',
            custom2: lead.custom2 || '',
            custom3: lead.custom3 || '',
            status: 'new',
        }));

        // Insert in batches of 500
        for (let i = 0; i < leadsWithListId.length; i += 500) {
            const batch = leadsWithListId.slice(i, i + 500);
            const { error: leadsError } = await supabase.from('leads').insert(batch);
            if (leadsError) {
                console.error('Lead insert error:', leadsError);
            }
        }
    }

    return NextResponse.json({ list });
}

// DELETE: Delete a lead list and its leads
export async function DELETE(request: NextRequest) {
    const listId = request.nextUrl.searchParams.get('id');
    if (!listId) {
        return NextResponse.json({ error: 'List ID required' }, { status: 400 });
    }

    const { error } = await supabase
        .from('lead_lists')
        .delete()
        .eq('id', listId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true });
}
