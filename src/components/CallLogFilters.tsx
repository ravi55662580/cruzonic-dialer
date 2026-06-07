'use client';

import { Search, X, ICON_DEFAULTS } from '@/components/Icon';

/**
 * Filters shared by the agent (`/`) and admin (`/admin`) Call Logs views.
 * Pure UI — parent owns the state and applies the predicate.
 */
export interface CallLogFilterState {
    /** Free-text — matched against number, agent name, notes. */
    q: string;
    /** YYYY-MM-DD inclusive lower bound, "" for no lower bound. */
    dateFrom: string;
    /** YYYY-MM-DD inclusive upper bound, "" for no upper bound. */
    dateTo: string;
    /** Exact disposition match, "" for any. */
    disposition: string;
    /** 'inbound' | 'outbound' | "" for any. */
    direction: string;
}

export const EMPTY_FILTER: CallLogFilterState = {
    q: '',
    dateFrom: '',
    dateTo: '',
    disposition: '',
    direction: '',
};

interface Props {
    value: CallLogFilterState;
    onChange: (next: CallLogFilterState) => void;
    /** Distinct disposition values found in the current data, for the
     *  dropdown. Always includes the canonical set. */
    dispositions?: string[];
    /** Whether to show the direction filter (admin yes, agent maybe not). */
    showDirection?: boolean;
    /** Count summary shown to the right ("12 of 87"). */
    matchCount?: number;
    totalCount?: number;
}

const CANONICAL_DISPOSITIONS = ['completed', 'no-answer', 'failed', 'busy', 'callback', 'voicemail'];

export default function CallLogFilters({
    value,
    onChange,
    dispositions = [],
    showDirection = true,
    matchCount,
    totalCount,
}: Props) {
    const set = <K extends keyof CallLogFilterState>(k: K, v: CallLogFilterState[K]) =>
        onChange({ ...value, [k]: v });

    const allDispositions = Array.from(
        new Set([...CANONICAL_DISPOSITIONS, ...dispositions.filter(Boolean)]),
    ).sort();

    const hasAnyFilter =
        value.q || value.dateFrom || value.dateTo || value.disposition || value.direction;

    return (
        <div className="logfilter-bar">
            <div className="logfilter-search">
                <Search {...ICON_DEFAULTS} size={14} />
                <input
                    type="search"
                    placeholder="Search phone, agent, notes…"
                    value={value.q}
                    onChange={(e) => set('q', e.target.value)}
                />
            </div>

            <label className="logfilter-field">
                <span>From</span>
                <input
                    type="date"
                    value={value.dateFrom}
                    onChange={(e) => set('dateFrom', e.target.value)}
                />
            </label>

            <label className="logfilter-field">
                <span>To</span>
                <input
                    type="date"
                    value={value.dateTo}
                    onChange={(e) => set('dateTo', e.target.value)}
                />
            </label>

            <label className="logfilter-field">
                <span>Disposition</span>
                <select
                    value={value.disposition}
                    onChange={(e) => set('disposition', e.target.value)}
                >
                    <option value="">Any</option>
                    {allDispositions.map((d) => (
                        <option key={d} value={d}>{d}</option>
                    ))}
                </select>
            </label>

            {showDirection && (
                <label className="logfilter-field">
                    <span>Direction</span>
                    <select
                        value={value.direction}
                        onChange={(e) => set('direction', e.target.value)}
                    >
                        <option value="">Any</option>
                        <option value="inbound">Inbound</option>
                        <option value="outbound">Outbound</option>
                    </select>
                </label>
            )}

            <div className="logfilter-meta">
                {(matchCount !== undefined && totalCount !== undefined) && (
                    <span className="logfilter-count">
                        {matchCount === totalCount
                            ? `${totalCount} call${totalCount === 1 ? '' : 's'}`
                            : `${matchCount} of ${totalCount}`}
                    </span>
                )}
                {hasAnyFilter && (
                    <button
                        type="button"
                        className="logfilter-clear"
                        onClick={() => onChange(EMPTY_FILTER)}
                        aria-label="Clear filters"
                    >
                        <X {...ICON_DEFAULTS} size={12} /> Clear
                    </button>
                )}
            </div>
        </div>
    );
}

/** Predicate built from a filter state — call this for each log row. */
export function matchesFilter(
    filter: CallLogFilterState,
    log: {
        number?: string | null;
        agent_name?: string | null;
        notes?: string | null;
        disposition?: string | null;
        direction?: string | null;
        created_at?: string | null;
    },
): boolean {
    const q = filter.q.trim().toLowerCase();
    if (q) {
        const haystack = [
            log.number || '',
            log.agent_name || '',
            log.notes || '',
        ].join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
    }
    if (filter.disposition && (log.disposition || '') !== filter.disposition) return false;
    if (filter.direction && (log.direction || '') !== filter.direction) return false;

    const day = log.created_at?.split('T')[0] || '';
    if (filter.dateFrom && day < filter.dateFrom) return false;
    if (filter.dateTo && day > filter.dateTo) return false;
    return true;
}
