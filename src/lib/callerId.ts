/**
 * Resolve the outbound caller-ID Twilio number for an agent based on their role.
 *
 *   sales   → TWILIO_SALES_NUMBER
 *   support → TWILIO_SUPPORT_NUMBER
 *   admin   → TWILIO_SALES_NUMBER (admins are usually demoing sales flows)
 *   else    → TWILIO_PHONE_NUMBER_1 (legacy fallback) or any number in pool
 *
 * Never throws — if env is missing we degrade to the pool selector so calls
 * still work, they just don't show the role-specific number.
 *
 * This module is SERVER-ONLY. It reads non-prefixed env vars and must not be
 * imported by any 'use client' file.
 */

import { getRandomCallerId } from './twilio';

export type AgentRole = 'admin' | 'sales' | 'support' | 'agent' | null | undefined;

/** Normalize a phone number candidate (strip spaces). Returns null if unset. */
function clean(n: string | undefined): string | null {
    if (!n) return null;
    const trimmed = n.replace(/\s/g, '');
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Pick the right outbound Twilio number for a given role.
 *
 * @param role - the agent's role from their profile row
 * @returns an E.164 number (preferred) or, as a last-resort, a number from the
 *   legacy `TWILIO_PHONE_NUMBER_*` pool. May fall back to `+10000000000` if
 *   nothing is configured (matches existing behavior of `getRandomCallerId`).
 */
export function callerIdForRole(role: AgentRole): string {
    const sales = clean(process.env.TWILIO_SALES_NUMBER);
    const support = clean(process.env.TWILIO_SUPPORT_NUMBER);
    const legacy = clean(process.env.TWILIO_PHONE_NUMBER_1);

    switch (role) {
        case 'sales':
            return sales || legacy || getRandomCallerId();
        case 'support':
            return support || legacy || getRandomCallerId();
        case 'admin':
            // Admins likely demoing sales flows; if no sales number, try support.
            return sales || support || legacy || getRandomCallerId();
        default:
            // 'agent' legacy / unknown — keep the original pool behaviour so
            // existing deployments aren't broken on day 1.
            return legacy || getRandomCallerId();
    }
}

/**
 * Same idea but returns just the configured number for a role, without falling
 * back to the legacy pool. Useful for the admin UI ("Sales number not set").
 */
export function configuredNumberForRole(role: AgentRole): string | null {
    if (role === 'sales') return clean(process.env.TWILIO_SALES_NUMBER);
    if (role === 'support') return clean(process.env.TWILIO_SUPPORT_NUMBER);
    if (role === 'admin') return clean(process.env.TWILIO_SALES_NUMBER) || clean(process.env.TWILIO_SUPPORT_NUMBER);
    return null;
}
