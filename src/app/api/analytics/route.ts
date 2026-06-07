import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

// GET: Fetch analytics data
export async function GET() {
    try {
        // 1. Total calls
        const { count: totalCalls } = await supabase
            .from('call_logs')
            .select('*', { count: 'exact', head: true });

        // 2. All call logs for calculations
        const { data: allLogs } = await supabase
            .from('call_logs')
            .select('duration, disposition, direction, created_at, agent_name')
            .order('created_at', { ascending: false })
            .limit(1000);

        const logs = allLogs || [];

        // 3. Average duration — over ANSWERED calls only. Including no-answer
        //    / missed calls dilutes the metric (a missed call has 0 talk-time
        //    and shouldn't lower the average). Total duration still sums
        //    every answered call for the time-on-the-phone tile.
        const parseDuration = (d: number) => {
            if (!d || d < 0) return 0;
            // If duration > 1 hour stored as raw int, assume it's milliseconds.
            return d > 3600 ? Math.round(d / 1000) : d;
        };
        const NOT_ANSWERED = new Set([
            'no-answer', 'missed', 'busy', 'failed', 'canceled', 'cancelled', 'no_answer',
        ]);
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

        // 4. Disposition breakdown
        const dispositions: Record<string, number> = {};
        logs.forEach(l => {
            const d = l.disposition || 'unknown';
            dispositions[d] = (dispositions[d] || 0) + 1;
        });

        // 5. Direction breakdown
        const directions: Record<string, number> = { inbound: 0, outbound: 0 };
        logs.forEach(l => {
            const dir = l.direction || 'outbound';
            directions[dir] = (directions[dir] || 0) + 1;
        });

        // 6. Calls per day (last 30 days)
        const callsPerDay: Record<string, number> = {};
        const now = new Date();
        for (let i = 29; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            callsPerDay[d.toISOString().split('T')[0]] = 0;
        }
        logs.forEach(l => {
            const day = l.created_at?.split('T')[0];
            if (day && callsPerDay[day] !== undefined) {
                callsPerDay[day]++;
            }
        });

        // 7. Agent performance — `calls` counts every attempt (so the leaderboard
        //    reflects effort), but `avgDuration` is over answered calls only
        //    (so it's not pulled to zero by missed-call rows).
        const agentStats: Record<string, {
            calls: number;
            answered: number;
            totalDuration: number;
            name: string;
        }> = {};
        logs.forEach((l) => {
            const name = l.agent_name || 'Unknown';
            if (!agentStats[name]) {
                agentStats[name] = { calls: 0, answered: 0, totalDuration: 0, name };
            }
            agentStats[name].calls++;
            const disp = (l.disposition || '').toLowerCase();
            if (!NOT_ANSWERED.has(disp)) {
                agentStats[name].answered++;
                agentStats[name].totalDuration += parseDuration(l.duration);
            }
        });

        const agentPerformance = Object.values(agentStats).map((a) => ({
            name: a.name,
            calls: a.calls,
            answered: a.answered,
            avgDuration: a.answered > 0 ? Math.round(a.totalDuration / a.answered) : 0,
        })).sort((a, b) => b.calls - a.calls);

        return NextResponse.json({
            totalCalls: totalCalls || 0,
            avgDuration,
            totalDuration,
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
