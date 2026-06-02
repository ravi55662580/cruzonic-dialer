/**
 * Shared types for the live-coach AI layer.
 *
 * Both Anthropic and OpenAI adapters implement {@link CoachAdapter}. The
 * `/api/coach/suggestions` route picks one based on `COACH_PROVIDER` env.
 */

/** A turn from the transcript stream, trimmed for the LLM prompt. */
export interface CoachTurn {
    speaker: 'agent' | 'customer' | 'unknown';
    text: string;
}

/** Optional lead context the agent has on screen. */
export interface CoachLeadInfo {
    name?: string;
    company?: string;
    /** Free-form JSON the admin saw fit to surface (CSV custom columns, etc.). */
    extra?: Record<string, string>;
}

export interface CoachRequest {
    callSid: string;
    /** Conversation so far, oldest first. The route trims to the last ~12 turns. */
    turns: CoachTurn[];
    /** Lead info for personalised suggestions; pass through what the dialer has. */
    lead?: CoachLeadInfo;
}

export interface CoachSuggestion {
    /** A 1-2 sentence reply the agent can paste. */
    text: string;
    /** Optional one-word label to differentiate cards (e.g. "Empathise", "Anchor price"). */
    intent?: string;
}

export type ObjectionKind =
    | 'price'
    | 'timing'
    | 'competitor'
    | 'authority'
    | 'trust'
    | 'value'
    | 'none';

export interface CoachResponse {
    /** ≤3 short reply options for the agent. */
    suggestions: CoachSuggestion[];
    /** What the model thinks the customer's current objection is, if any. */
    objection: ObjectionKind;
    /** One-line summary of what's happening — useful as a tooltip / debug. */
    summary?: string;
}

/** Sentiment read on the customer at end-of-call. */
export type CallSentiment = 'positive' | 'neutral' | 'negative' | 'mixed';

/** One canonical "moment" from the call — the kind of thing an agent jots down. */
export interface CallKeyPoint {
    /** A category tag like "objection", "buying-signal", "commitment", "pain-point". */
    kind: string;
    /** One-sentence note. */
    note: string;
}

export interface SummaryRequest {
    callSid: string;
    /** Full transcript ordered oldest → newest. */
    turns: CoachTurn[];
    lead?: CoachLeadInfo;
}

export interface CallSummary {
    /** 1-2 sentence overview of the call. */
    summary: string;
    sentiment: CallSentiment;
    /** Recommended next step the agent should take (e.g. "Send proposal by Friday"). */
    next_action: string;
    /** Up to ~5 key moments. */
    key_points: CallKeyPoint[];
    /** Paste-ready note for the CRM (multi-line, includes summary + next action). */
    crm_note: string;
}

export interface CoachAdapter {
    readonly name: string;
    suggest(req: CoachRequest): Promise<CoachResponse>;
    summarize(req: SummaryRequest): Promise<CallSummary>;
}
