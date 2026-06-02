import { NextResponse } from 'next/server';

/**
 * GET /api/admin/support-config
 *
 * Returns the env-configured outbound numbers so the admin Support tab can
 * display them. We don't ship env vars to the client bundle directly — this
 * route is the read-only escape hatch.
 *
 * No auth check (matches the rest of /api/admin/*). Tighten in a future pass.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
    return NextResponse.json({
        supportNumber: process.env.TWILIO_SUPPORT_NUMBER || null,
        salesNumber: process.env.TWILIO_SALES_NUMBER || null,
        // Convenience: also surface the legacy fallback for sanity-checking.
        legacyNumber: process.env.TWILIO_PHONE_NUMBER_1 || null,
    });
}
