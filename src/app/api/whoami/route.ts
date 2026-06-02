import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { callerIdForRole, type AgentRole } from '@/lib/callerId';

/**
 * GET /api/whoami?email=user@example.com
 *
 * Returns the signed-in agent's role and the outbound Twilio number that
 * would be used for their calls. The browser doesn't see the raw env vars,
 * so this endpoint reveals just the resolved values.
 *
 * The dialer renders a small "Sales · +1 (307) 392-0208" badge from this.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const url = new URL(request.url);
    const email = (url.searchParams.get('email') || '').trim().toLowerCase();
    if (!email) {
        return NextResponse.json({ error: 'email required' }, { status: 400 });
    }

    let role: AgentRole = null;
    try {
        const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
        if (sbUrl && key) {
            const sb = createClient(sbUrl, key, {
                auth: { persistSession: false, autoRefreshToken: false },
            });
            const { data } = await sb
                .from('profiles')
                .select('role')
                .eq('email', email)
                .maybeSingle();
            if (data) role = data.role as AgentRole;
        }
    } catch (err) {
        console.warn('[whoami] lookup failed:', err);
    }

    const outboundNumber = callerIdForRole(role);
    return NextResponse.json({ role, outboundNumber });
}
