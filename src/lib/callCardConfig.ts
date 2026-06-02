/**
 * Call-card display configuration.
 *
 * Drives which lead fields appear in the on-call popup (Dialer.tsx) and the
 * lead card (PowerDialer.tsx). Both the available fields and the order are
 * admin-configurable from the admin panel ("Call Card" tab).
 *
 * Storage: localStorage on the agent's browser. Two keys:
 *   - `cruzonic_known_columns`     — every CSV header ever seen, deduped.
 *   - `cruzonic_call_card_config`  — ordered list of {key, enabled} entries.
 *
 * Field keys are stored lowercase to match how `page.tsx` parses CSV headers.
 */

export type CallCardField = {
    /** Lowercase column key (e.g. "phone_number", "company"). */
    key: string;
    /** Whether to render this field in the call card. */
    enabled: boolean;
};

export const KNOWN_COLUMNS_KEY = 'cruzonic_known_columns';
export const CALL_CARD_CONFIG_KEY = 'cruzonic_call_card_config';

/**
 * Default field order — used when no config has been saved yet, and as the
 * baseline that "Reset to defaults" returns to. Mirrors the keys the CSV
 * importer recognizes today.
 */
export const DEFAULT_FIELD_ORDER: string[] = [
    'phone',
    'phone_number',
    'first_name',
    'last_name',
    'company',
    'email',
    'city',
    'state',
    'mc_number',
    'fleet_size',
    'current_eld',
    'custom_field_1',
    'custom_field_2',
    'custom_field_3',
];

/**
 * Friendly labels for fields the importer knows about. Anything not in this
 * map falls back to a Title-Cased version of the column key.
 */
const FIELD_LABELS: Record<string, string> = {
    phone: 'Phone',
    phone_number: 'Phone',
    first_name: 'First Name',
    firstname: 'First Name',
    last_name: 'Last Name',
    lastname: 'Last Name',
    company: 'Company',
    email: 'Email',
    city: 'City',
    state: 'State',
    mc_number: 'MC Number',
    fleet_size: 'Fleet Size',
    current_eld: 'Current ELD',
    custom_field_1: 'Custom 1',
    custom_field_2: 'Custom 2',
    custom_field_3: 'Custom 3',
};

/** Default emoji per known field; everything else gets a generic 📋. */
const FIELD_ICONS: Record<string, string> = {
    phone: '📞',
    phone_number: '📞',
    first_name: '👤',
    firstname: '👤',
    last_name: '👤',
    lastname: '👤',
    company: '🏢',
    email: '📧',
    city: '📍',
    state: '🗺️',
    mc_number: '🏷️',
    fleet_size: '🚛',
    current_eld: '📱',
    custom_field_1: '📋',
    custom_field_2: '📋',
    custom_field_3: '📋',
};

export function labelForField(key: string): string {
    if (FIELD_LABELS[key]) return FIELD_LABELS[key];
    return key
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
}

export function iconForField(key: string): string {
    return FIELD_ICONS[key] || '📋';
}

/* ── known columns ──────────────────────────────────────────────── */

export function loadKnownColumns(): string[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = localStorage.getItem(KNOWN_COLUMNS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * Merge new column names into the known set. Returns the updated list (deduped,
 * in first-seen order). Safe to call from CSV-upload code on every import.
 */
export function rememberColumns(newCols: string[]): string[] {
    if (typeof window === 'undefined') return newCols;
    const existing = loadKnownColumns();
    const seen = new Set(existing);
    const merged = [...existing];
    for (const col of newCols) {
        const lc = col.toLowerCase().trim();
        if (lc && !seen.has(lc)) {
            seen.add(lc);
            merged.push(lc);
        }
    }
    try {
        localStorage.setItem(KNOWN_COLUMNS_KEY, JSON.stringify(merged));
    } catch {
        /* ignore quota errors */
    }
    return merged;
}

/* ── call-card config ──────────────────────────────────────────── */

/**
 * Build the default config from a list of available column names.
 * Defaults: every known column is enabled, ordered by DEFAULT_FIELD_ORDER
 * first, then any unknown columns appended afterwards.
 */
export function buildDefaultConfig(availableCols: string[]): CallCardField[] {
    const lc = availableCols.map((c) => c.toLowerCase());
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const key of DEFAULT_FIELD_ORDER) {
        if (lc.includes(key) && !seen.has(key)) {
            ordered.push(key);
            seen.add(key);
        }
    }
    for (const key of lc) {
        if (!seen.has(key)) {
            ordered.push(key);
            seen.add(key);
        }
    }
    return ordered.map((key) => ({ key, enabled: true }));
}

export function loadCallCardConfig(): CallCardField[] | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = localStorage.getItem(CALL_CARD_CONFIG_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        return parsed
            .filter((x): x is { key: unknown; enabled: unknown } => x && typeof x === 'object')
            .map((x) => ({
                key: String(x.key ?? '').toLowerCase(),
                enabled: Boolean(x.enabled),
            }))
            .filter((x) => x.key.length > 0);
    } catch {
        return null;
    }
}

export function saveCallCardConfig(config: CallCardField[]): void {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(CALL_CARD_CONFIG_KEY, JSON.stringify(config));
    } catch {
        /* ignore quota errors */
    }
}

/**
 * Resolve the effective config for rendering. If no admin config exists yet,
 * fall back to the defaults built from the provided columns.
 */
export function resolveConfig(availableCols: string[]): CallCardField[] {
    const stored = loadCallCardConfig();
    if (!stored || stored.length === 0) return buildDefaultConfig(availableCols);

    // Append any newly-seen columns that the stored config doesn't know about
    // yet, so a freshly-uploaded CSV doesn't hide new fields by default.
    const knownInStored = new Set(stored.map((s) => s.key));
    const extras = availableCols
        .map((c) => c.toLowerCase())
        .filter((c) => c && !knownInStored.has(c))
        .map<CallCardField>((key) => ({ key, enabled: true }));
    return [...stored, ...extras];
}
