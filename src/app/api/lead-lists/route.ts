import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

// GET: Fetch all lead lists (optionally filter by agent_id; pass
//      "all=1" to include both global lists (NULL agent_id) and lists
//      assigned to the agent — useful for the agent dialer).
export async function GET(request: NextRequest) {
    const agentId = request.nextUrl.searchParams.get('agent_id');
    const includeGlobal = request.nextUrl.searchParams.get('all') === '1';

    let query = supabase
        .from('lead_lists')
        .select('*')
        .order('created_at', { ascending: false });

    if (agentId) {
        query = includeGlobal
            ? query.or(`agent_id.eq.${agentId},agent_id.is.null`)
            : query.eq('agent_id', agentId);
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Join the assigned agent's display name so the admin UI can render it
    // without a second lookup. Only one round-trip — fine at admin volumes.
    const lists = data || [];
    const agentIds = Array.from(new Set(
        lists.map((l) => l.agent_id).filter((id): id is string => !!id)
    ));
    let agents: Record<string, { name: string; email: string }> = {};
    if (agentIds.length > 0) {
        const { data: profs } = await supabase
            .from('profiles')
            .select('id, full_name, email')
            .in('id', agentIds);
        if (profs) {
            agents = Object.fromEntries(profs.map((p) => [p.id, {
                name: p.full_name || p.email,
                email: p.email,
            }]));
        }
    }

    const enriched = lists.map((l) => ({
        ...l,
        agent_name: l.agent_id ? agents[l.agent_id]?.name || null : null,
        agent_email: l.agent_id ? agents[l.agent_id]?.email || null : null,
    }));

    return NextResponse.json({ lists: enriched });
}

// POST: Create a new lead list with leads
export async function POST(request: Request) {
    const body = await request.json();
    const { name, agent_id, leads, notes, created_by } = body;

    if (!name) {
        return NextResponse.json({ error: 'List name required' }, { status: 400 });
    }

    // Create the list
    const { data: list, error: listError } = await supabase
        .from('lead_lists')
        .insert([{
            name,
            agent_id: agent_id || null,
            notes: notes || null,
            created_by: created_by || null,
            lead_count: leads?.length || 0,
        }])
        .select()
        .single();

    if (listError) {
        return NextResponse.json({ error: listError.message }, { status: 500 });
    }

    // Insert leads if provided
    if (leads && leads.length > 0) {
        const leadsWithListId = leads.map((lead: Record<string, unknown>) => ({
            list_id: list.id,
            phone: typeof lead.phone === 'string' ? lead.phone : '',
            first_name: (lead.firstName || lead.first_name || '') as string,
            last_name: (lead.lastName || lead.last_name || '') as string,
            company: (lead.company || '') as string,
            email: (lead.email || '') as string,
            city: (lead.city || '') as string,
            state: (lead.state || '') as string,
            custom1: (lead.custom1 || '') as string,
            custom2: (lead.custom2 || '') as string,
            custom3: (lead.custom3 || '') as string,
            // Free-form extra CSV columns the admin chose to keep — surfaces
            // through the Call Card config on the agent's screen.
            extra: lead.extra && typeof lead.extra === 'object' ? lead.extra : {},
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
