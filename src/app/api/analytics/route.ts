import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

const NOT_ANSWERED = new Set([
    'no-answer', 'missed', 'busy', 'failed', 'canceled', 'cancelled', 'no_answer',
]);

/** Defensively coerce duration to seconds. Old rows occasionally stored ms. */
function parseDuration(d: unknown): number {
    if (typeof d !== 'number' || !d || d < 0) return 0;
    return d > 3600 ? Math.round(d / 1000) : d;
}

/**
 * GET /api/analytics
 *
 * Query params (optional):
 *   from   YYYY-MM-DD inclusive lower bound (default: 30 days ago)
 *   to     YYYY-MM-DD inclusive upper bound (default: today)
 *   tz     IANA timezone for grouping the per-day chart (default: Asia/Kolkata)
 *
 * Returns metrics computed over the matching slice of call_logs.
 */
export async function GET(request: NextRequest) {
    try {
        const params = request.nextUrl.searchParams;
        const tz = params.get('tz') || 'Asia/Kolkata';
        // Default window: trailing 30 days through today, inclusive.
        const todayLocal = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
        const defaultTo = todayLocal.toISOString().split('T')[0];
        const defaultFromDate = new Date(todayLocal);
        defaultFromDate.setDate(defaultFromDate.getDate() - 29);
        const defaultFrom = defaultFromDate.toISOString().split('T')[0];

        const from = (params.get('from') || defaultFrom).slice(0, 10);
        const to = (params.get('to') || defaultTo).slice(0, 10);

        // Pull the rows that fall in the requested window. We pull a larger
        // page than before (5000) so most teams' month-of-data fits in one
        // round trip — true server-side aggregation would scale further but
        // this covers a few thousand calls/month comfortably.
        const fromIso = `${from}T00:00:00.000Z`;
        const toIso = `${to}T23:59:59.999Z`;

        // Total count for the all-time totals tile. Separate from the in-window count.
        const { count: lifetimeCount } = await supabase
            .from('call_logs')
            .select('*', { count: 'exact', head: true });

        const { data: rangeLogs, count: rangeCount } = await supabase
            .from('call_logs')
            .select('duration, disposition, direction, created_at, agent_name', { count: 'exact' })
            .gte('created_at', fromIso)
            .lte('created_at', toIso)
            .order('created_at', { ascending: false })
            .limit(5000);

        const logs = rangeLogs || [];

        // ── Answered vs not-answered partition ───────────────────────────
        const answeredLogs = logs.filter(
            (l) => !NOT_ANSWERED.has((l.disposition || '').toLowerCase()),
        );
        const totalDuration = answeredLogs.reduce(
            (sum, l) => sum + parseDuration(l.duration),
            0,
        );
        const avgDuration = answeredLogs.length > 0
            ? Math.round(totalDuration / answeredLogs.length)
            : 0;

        // Longest answered call in the window. Useful sanity check + tile.
        const longestDuration = answeredLogs.reduce(
            (m, l) => Math.max(m, parseDuration(l.duration)),
            0,
        );

        // Connect rate: % of attempts that ended in a real conversation.
        const connectRate = logs.length > 0
            ? Math.round((answeredLogs.length / logs.length) * 100)
            : 0;

        // ── Disposition breakdown ────────────────────────────────────────
        const dispositions: Record<string, number> = {};
        logs.forEach((l) => {
            const d = (l.disposition || 'unknown').toLowerCase();
            dispositions[d] = (dispositions[d] || 0) + 1;
        });

        // ── Direction breakdown ──────────────────────────────────────────
        const directions: Record<string, number> = { inbound: 0, outbound: 0 };
        logs.forEach((l) => {
            const dir = (l.direction || 'outbound').toLowerCase();
            if (dir === 'inbound' || dir === 'outbound') {
                directions[dir]++;
            }
        });

        // ── Calls per day (grouped by IST / requested tz, not UTC) ───────
        const callsPerDay: Record<string, number> = {};
        // Build the date buckets in the requested timezone for the window.
        const fromDate = new Date(`${from}T00:00:00Z`);
        const toDate = new Date(`${to}T00:00:00Z`);
        const days: string[] = [];
        for (
            let d = new Date(fromDate);
            d <= toDate;
            d.setUTCDate(d.getUTCDate() + 1)
        ) {
            const key = d.toISOString().split('T')[0];
            days.push(key);
            callsPerDay[key] = 0;
        }
        logs.forEach((l) => {
            if (!l.created_at) return;
            const dateInTz = new Date(l.created_at).toLocaleString('en-CA', { timeZone: tz });
            // en-CA gives YYYY-MM-DD, HH:MM:SS — take the date portion.
            const day = dateInTz.split(',')[0].split(' ')[0];
            if (Object.prototype.hasOwnProperty.call(callsPerDay, day)) {
                callsPerDay[day]++;
            }
        });

        // ── Agent performance ────────────────────────────────────────────
        const agentStats: Record<string, {
            name: string;
            calls: number;
            answered: number;
            totalDuration: number;
        }> = {};
        logs.forEach((l) => {
            const name = l.agent_name || 'Unknown';
            if (!agentStats[name]) {
                agentStats[name] = { name, calls: 0, answered: 0, totalDuration: 0 };
            }
            agentStats[name].calls++;
            const disp = (l.disposition || '').toLowerCase();
            if (!NOT_ANSWERED.has(disp)) {
                agentStats[name].answered++;
                agentStats[name].totalDuration += parseDuration(l.duration);
            }
        });

        const agentPerformance = Object.values(agentStats)
            .map((a) => ({
                name: a.name,
                calls: a.calls,
                answered: a.answered,
                avgDuration: a.answered > 0 ? Math.round(a.totalDuration / a.answered) : 0,
                connectRate: a.calls > 0 ? Math.round((a.answered / a.calls) * 100) : 0,
                totalTalkTime: a.totalDuration,
            }))
            .sort((a, b) => b.calls - a.calls);

        return NextResponse.json({
            // Always-on totals (entire DB, not the window).
            lifetimeTotalCalls: lifetimeCount || 0,
            // Window slice (what every other metric is computed over).
            range: { from, to, tz },
            totalCalls: rangeCount || logs.length,
            answeredCalls: answeredLogs.length,
            avgDuration,          // seconds per answered call
            totalDuration,        // seconds — sum of all answered durations
            longestDuration,      // seconds — longest single answered call
            connectRate,          // 0..100 (%)
            dispositions,
            directions,
            callsPerDay,
            agentPerformance,
        });
    } catch (err) {
        console.error('Analytics error:', err);
        return NextResponse.json({ error: 'Failed to fetch analytics' }, { status: 500 });
    }
}
