import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

// GET: Fetch leads for a list
export async function GET(request: NextRequest) {
    const listId = request.nextUrl.searchParams.get('list_id');
    if (!listId) {
        return NextResponse.json({ error: 'list_id required' }, { status: 400 });
    }

    const { data, error } = await supabase
        .from('leads')
        .select('*')
        .eq('list_id', listId)
        .order('created_at', { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ leads: data });
}

// PUT: Update a lead's status
export async function PUT(request: Request) {
    const body = await request.json();
    const { id, status, last_called_at } = body;

    if (!id) {
        return NextResponse.json({ error: 'Lead ID required' }, { status: 400 });
    }

    const updateData: Record<string, unknown> = {};
    if (status) updateData.status = status;
    if (last_called_at) updateData.last_called_at = last_called_at;

    const { data, error } = await supabase
        .from('leads')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ lead: data });
}
