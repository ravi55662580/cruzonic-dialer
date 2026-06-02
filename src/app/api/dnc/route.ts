import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

// GET: Fetch all DNC numbers
export async function GET() {
    const { data, error } = await supabase
        .from('dnc_numbers')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ numbers: data });
}

// POST: Add a number to DNC list
export async function POST(request: Request) {
    const body = await request.json();
    const { phone, reason, added_by } = body;

    if (!phone) {
        return NextResponse.json({ error: 'Phone number required' }, { status: 400 });
    }

    // Normalize phone
    const normalized = phone.replace(/[^+\d]/g, '');

    const { data, error } = await supabase
        .from('dnc_numbers')
        .upsert([{
            phone: normalized,
            reason: reason || '',
            added_by: added_by || null,
        }], { onConflict: 'phone' })
        .select()
        .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ entry: data });
}

// DELETE: Remove a number from DNC list
export async function DELETE(request: NextRequest) {
    const id = request.nextUrl.searchParams.get('id');
    const phone = request.nextUrl.searchParams.get('phone');

    if (!id && !phone) {
        return NextResponse.json({ error: 'ID or phone required' }, { status: 400 });
    }

    let query = supabase.from('dnc_numbers').delete();
    if (id) query = query.eq('id', id);
    else if (phone) query = query.eq('phone', phone.replace(/[^+\d]/g, ''));

    const { error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true });
}

// PUT: Check if a number is on DNC list
export async function PUT(request: Request) {
    const body = await request.json();
    const { phones } = body; // array of phone numbers

    if (!phones || !Array.isArray(phones)) {
        return NextResponse.json({ error: 'phones array required' }, { status: 400 });
    }

    const normalized = phones.map((p: string) => p.replace(/[^+\d]/g, ''));

    const { data, error } = await supabase
        .from('dnc_numbers')
        .select('phone')
        .in('phone', normalized);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const dncSet = new Set(data?.map((d: { phone: string }) => d.phone) || []);
    return NextResponse.json({ dnc: Array.from(dncSet) });
}
