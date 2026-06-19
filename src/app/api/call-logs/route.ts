import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Use service role key to bypass RLS for server-side operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseServiceKey);

function isConfigured() {
    return Boolean(supabaseUrl && supabaseServiceKey);
}

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;

/**
 * GET /api/call-logs
 *
 * Query params (all optional):
 *   agent_id    Filter to a single agent
 *   limit       Max rows returned (default 1000, max 10000)
 *   offset      Skip N rows for pagination (default 0)
 *   from        YYYY-MM-DD inclusive lower bound on created_at
 *   to          YYYY-MM-DD inclusive upper bound on created_at
 *
 * Returns: { logs: [...], total: <count> }
 *   - `total` is the count of rows matching the filters before limit/offset,
 *     so the admin UI can show "Showing 1000 of 4,213" and paginate.
 */
export async function GET(request: NextRequest) {
    if (!isConfigured()) {
        return NextResponse.json({ logs: [], total: 0, error: 'Database not configured' });
    }

    const params = request.nextUrl.searchParams;
    const agentId = params.get('agent_id');

    const requestedLimit = Number.parseInt(params.get('limit') || '', 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const requestedOffset = Number.parseInt(params.get('offset') || '', 10);
    const offset = Number.isFinite(requestedOffset) && requestedOffset > 0
        ? requestedOffset
        : 0;

    const from = params.get('from');
    const to = params.get('to');

    let query = supabase
        .from('call_logs')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (agentId) query = query.eq('agent_id', agentId);
    if (from) query = query.gte('created_at', `${from.slice(0, 10)}T00:00:00.000Z`);
    if (to) query = query.lte('created_at', `${to.slice(0, 10)}T23:59:59.999Z`);

    const { data, error, count } = await query;

    if (error) {
        return NextResponse.json({ logs: [], total: 0, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
        logs: data,
        total: count ?? (data?.length ?? 0),
        limit,
        offset,
    });
}

/**
 * POST /api/call-logs
 *
 * Behaviour: UPSERT by `call_sid` when one is provided. If a row with the
 * same call_sid already exists (e.g. created earlier by the server-side
 * Twilio dial-status callback), we UPDATE it in-place so the agent's
 * browser doesn't create a duplicate row. Rows without a call_sid are
 * always inserted (legacy behavior).
 *
 * The merge is forgiving: caller-provided non-empty fields win over what's
 * already in the row. The `disposition` field also wins (so the agent's
 * 'completed' overrides an earlier 'ringing' placeholder).
 */
export async function POST(request: Request) {
    if (!isConfigured()) {
        return NextResponse.json({ error: 'Database not configured' }, { status: 503 });
    }

    const body = await request.json();
    const { number, direction, duration, disposition, agent_id, agent_name, call_sid, notes } = body;

    // Try to find an existing row with the same call_sid.
    if (call_sid) {
        const { data: existing } = await supabase
            .from('call_logs')
            .select('id, number, agent_id, agent_name, duration, notes')
            .eq('call_sid', call_sid)
            .maybeSingle();

        if (existing) {
            const patch: Record<string, unknown> = {
                direction: direction || 'outbound',
                disposition: disposition || 'completed',
            };
            // Only overwrite fields when the new value is non-empty / non-zero
            // so we don't blow away good data with a partial update.
            if (number) patch.number = number;
            if (agent_id) patch.agent_id = agent_id;
            if (agent_name) patch.agent_name = agent_name;
            if (typeof duration === 'number' && duration > 0) patch.duration = duration;
            if (notes) patch.notes = notes;

            const { data, error } = await supabase
                .from('call_logs')
                .update(patch)
                .eq('id', existing.id)
                .select()
                .single();
            if (error) {
                console.error('DB Upsert Error:', error);
                return NextResponse.json({ error: error.message }, { status: 500 });
            }
            return NextResponse.json({ log: data, upserted: true });
        }
    }

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
