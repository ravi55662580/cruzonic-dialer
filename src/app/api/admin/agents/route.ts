import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Use service role key for admin operations
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

// GET: List all agents
export async function GET() {
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ agents: data });
}

// POST: Create a new agent
export async function POST(request: Request) {
    const body = await request.json();
    const { email, password, full_name, role } = body;

    if (!email || !password) {
        return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
    }

    // Create user in Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
    });

    if (authError) {
        return NextResponse.json({ error: authError.message }, { status: 400 });
    }

    // Create profile
    const { error: profileError } = await supabaseAdmin
        .from('profiles')
        .insert([{
            id: authData.user.id,
            email,
            full_name: full_name || email.split('@')[0],
            role: role || 'agent',
            is_active: true,
        }]);

    if (profileError) {
        return NextResponse.json({ error: profileError.message }, { status: 500 });
    }

    return NextResponse.json({ user: { id: authData.user.id, email } });
}

/**
 * PATCH /api/admin/agents
 * Body: { id, role?, is_active? }
 *
 * Lets an admin flip an existing agent's role (sales/support/admin) or
 * activation flag without re-creating the user.
 */
export async function PATCH(request: Request) {
    const body = await request.json();
    const { id, role, is_active } = body as {
        id?: string;
        role?: 'admin' | 'sales' | 'support';
        is_active?: boolean;
    };
    if (!id) {
        return NextResponse.json({ error: 'id required' }, { status: 400 });
    }
    if (role !== undefined && !['admin', 'sales', 'support'].includes(role)) {
        return NextResponse.json({ error: 'invalid role' }, { status: 400 });
    }
    const patch: Record<string, unknown> = {};
    if (role !== undefined) patch.role = role;
    if (is_active !== undefined) patch.is_active = is_active;
    if (Object.keys(patch).length === 0) {
        return NextResponse.json({ error: 'no changes' }, { status: 400 });
    }
    const { error } = await supabaseAdmin
        .from('profiles')
        .update(patch)
        .eq('id', id);
    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
}
