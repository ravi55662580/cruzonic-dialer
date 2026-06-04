import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * GET /api/lead-lists/leads?list_id=N
 *
 * Returns all leads in a given list. Service role used so the response is
 * consistent regardless of RLS — the calling page already checks ownership
 * by filtering list IDs server-side.
 */
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const listId = request.nextUrl.searchParams.get('list_id');
    if (!listId) {
        return NextResponse.json({ error: 'list_id required' }, { status: 400 });
    }

    const { data, error } = await supabase
        .from('leads')
        .select('*')
        .eq('list_id', listId)
        .order('id', { ascending: true });

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ leads: data || [] });
}
