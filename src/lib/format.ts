/**
 * Display helpers used across the dialer UI.
 */

/**
 * Pretty-print a phone number for display. Accepts E.164 (`+13075551234`),
 * 10-digit US (`3075551234`), or anything else (returns input unchanged).
 *
 *   formatPhone('+13075551234')  → '+1 (307) 555-1234'
 *   formatPhone('3075551234')    → '(307) 555-1234'
 *   formatPhone('+919876543210') → '+91 98765 43210'   (basic Indian format)
 */
export function formatPhone(input: string | null | undefined): string {
    if (!input) return '';
    const raw = String(input).trim();
    if (!raw) return '';

    const digits = raw.replace(/\D/g, '');

    // US / Canada (+1, NANP)
    if (raw.startsWith('+1') && digits.length === 11) {
        return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    if (digits.length === 10 && !raw.startsWith('+')) {
        return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    // India (+91)
    if (raw.startsWith('+91') && digits.length === 12) {
        return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
    }
    // UK (+44) — light format
    if (raw.startsWith('+44') && digits.length >= 12) {
        return `+44 ${digits.slice(2, 6)} ${digits.slice(6)}`;
    }

    // Fallback: keep the raw E.164 with a thin space after the country code
    if (raw.startsWith('+') && digits.length > 10) {
        const cc = digits.slice(0, digits.length - 10);
        const rest = digits.slice(digits.length - 10);
        return `+${cc} ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`;
    }
    return raw;
}

/**
 * Compact "time ago" helper for call-log timestamps. Falls back to a
 * locale-formatted date for anything older than a week.
 */
export function timeAgo(date: Date | string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
}

/**
 * Format a duration in seconds as MM:SS.
 */
export function formatDuration(seconds: number): string {
    const safe = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(safe / 60);
    const s = safe % 60;
    return `${m}m ${s}s`;
}
