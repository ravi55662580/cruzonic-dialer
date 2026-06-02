import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

// GET: List all support shifts
export async function GET() {
    const { data, error } = await supabase
        .from('support_shifts')
        .select('*')
        .order('shift_start_hour', { ascending: true });

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Also return which shift is currently active
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const currentHour = nowIST.getHours();

    const shifts = (data || []).map(s => ({
        ...s,
        is_current_shift: s.is_active && (
            s.shift_start_hour < s.shift_end_hour
                ? currentHour >= s.shift_start_hour && currentHour < s.shift_end_hour
                : currentHour >= s.shift_start_hour || currentHour < s.shift_end_hour
        ),
    }));

    return NextResponse.json({ shifts, currentHourIST: currentHour });
}

// POST: Create a new shift
export async function POST(request: NextRequest) {
    const body = await request.json();
    const { agent_name, phone_number, shift_start_hour, shift_end_hour } = body;

    if (!agent_name || !phone_number || shift_start_hour === undefined || shift_end_hour === undefined) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const { data, error } = await supabase
        .from('support_shifts')
        .insert([{
            agent_name,
            phone_number,
            shift_start_hour,
            shift_end_hour,
            is_active: true,
        }])
        .select()
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ shift: data });
}

// PUT: Update an existing shift
export async function PUT(request: NextRequest) {
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
        return NextResponse.json({ error: 'Missing shift ID' }, { status: 400 });
    }

    // Add updated_at timestamp
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
        .from('support_shifts')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ shift: data });
}

// DELETE: Remove a shift
export async function DELETE(request: NextRequest) {
    const id = request.nextUrl.searchParams.get('id');

    if (!id) {
        return NextResponse.json({ error: 'Missing shift ID' }, { status: 400 });
    }

    const { error } = await supabase
        .from('support_shifts')
        .delete()
        .eq('id', id);

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
}
