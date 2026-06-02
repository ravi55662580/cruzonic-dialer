/**
 * Prompt assembly shared by all coach providers.
 *
 * The system prompt nudges the model toward short, copy-paste-ready replies
 * and asks for a strict JSON object so we can render without parsing prose.
 */

import type {
    CoachRequest,
    CoachResponse,
    ObjectionKind,
    SummaryRequest,
    CallSummary,
    CallSentiment,
} from './types';

/** Trim turns + collapse interim duplicates so we don't blow the context window. */
export function condenseTurns(turns: CoachRequest['turns'], max = 12): CoachRequest['turns'] {
    const tail = turns.slice(-max);
    // Drop empty / whitespace-only.
    return tail.filter((t) => t.text.trim().length > 0);
}

export const SYSTEM_PROMPT = `You are an inside-sales coach listening to a live phone call.
The dialer agent works the AGENT speaker; the customer works the CUSTOMER speaker.
Your job: produce 3 short, friendly reply options the agent could say next, plus
a one-word read of the customer's current objection (if any).

Hard rules:
- Each reply must be ONE or TWO sentences, max ~30 words, conversational tone.
- Each reply must move the call forward (acknowledge → reframe → ask a question, or close).
- Vary intents across the three options (e.g. empathise, anchor value, advance to next step).
- If the customer hasn't spoken yet, suggest openers / discovery questions.
- objection field must be one of: price, timing, competitor, authority, trust, value, none.

Return STRICT JSON only, no markdown fence, no commentary, with this shape:
{
  "suggestions": [
    { "text": "...", "intent": "..." },
    { "text": "...", "intent": "..." },
    { "text": "...", "intent": "..." }
  ],
  "objection": "price",
  "summary": "..."
}`;

export function buildUserPrompt(req: CoachRequest): string {
    const turns = condenseTurns(req.turns);
    const transcript = turns.length
        ? turns.map((t) => `${t.speaker.toUpperCase()}: ${t.text}`).join('\n')
        : '(no speech yet)';

    const leadBits: string[] = [];
    if (req.lead?.name) leadBits.push(`Name: ${req.lead.name}`);
    if (req.lead?.company) leadBits.push(`Company: ${req.lead.company}`);
    if (req.lead?.extra) {
        for (const [k, v] of Object.entries(req.lead.extra)) {
            if (v && leadBits.length < 8) leadBits.push(`${k}: ${v}`);
        }
    }
    const leadBlock = leadBits.length ? `\nLead context:\n${leadBits.join('\n')}\n` : '';

    return `Transcript so far:\n${transcript}\n${leadBlock}\nProduce the JSON object.`;
}

const VALID_OBJECTIONS: ObjectionKind[] = [
    'price', 'timing', 'competitor', 'authority', 'trust', 'value', 'none',
];

/**
 * Parse the LLM output safely. Models occasionally wrap the JSON in fenced
 * code blocks or add a preamble, so we extract the first `{...}` blob and
 * fall back to an empty response if anything is off.
 */
export function parseCoachResponse(raw: string): CoachResponse {
    const empty: CoachResponse = { suggestions: [], objection: 'none' };
    if (!raw) return empty;
    // Find the first JSON object in the string.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return empty;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
        return empty;
    }
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const p = parsed as Record<string, unknown>;

    const suggestionsRaw = Array.isArray(p.suggestions) ? p.suggestions : [];
    const suggestions: Array<{ text: string; intent?: string }> = [];
    for (const s of suggestionsRaw.slice(0, 3)) {
        if (typeof s === 'string') {
            const t = s.trim();
            if (t) suggestions.push({ text: t });
            continue;
        }
        if (s && typeof s === 'object') {
            const obj = s as Record<string, unknown>;
            const text = typeof obj.text === 'string' ? obj.text.trim() : '';
            if (!text) continue;
            const intent = typeof obj.intent === 'string' && obj.intent.trim()
                ? obj.intent.trim()
                : undefined;
            suggestions.push(intent ? { text, intent } : { text });
        }
    }

    const objection: ObjectionKind = (
        typeof p.objection === 'string' && (VALID_OBJECTIONS as string[]).includes(p.objection)
    ) ? (p.objection as ObjectionKind) : 'none';

    const summary = typeof p.summary === 'string' ? p.summary : undefined;

    return { suggestions, objection, summary };
}

// ─────────────────────────────────────────────────────────────────────
// Post-call summary
// ─────────────────────────────────────────────────────────────────────

export const SUMMARY_SYSTEM_PROMPT = `You are a sales-call analyst. Given the transcript of a phone call between a
sales agent and a customer, produce a structured wrap-up the agent can paste
straight into a CRM.

Hard rules:
- "summary" = 1-2 sentence overview, neutral business tone, max ~40 words.
- "sentiment" = one of: positive, neutral, negative, mixed.
- "next_action" = ONE concrete next step the agent should take. Imperative
  voice, max ~20 words. Examples: "Send the pricing PDF and follow up Tuesday."
- "key_points" = up to 5 objects { kind, note }. kind is a short tag like
  objection, buying-signal, commitment, pain-point, requirement, competitor.
  note is one sentence describing the moment.
- "crm_note" = multi-line text the agent can paste into the CRM. Include the
  summary, then the next action on a new line prefixed "Next:". Keep it under
  ~80 words total. Plain text, no markdown.
- If the transcript is empty or too short to summarize, still return the JSON
  with reasonable empty/neutral defaults (sentiment="neutral", empty arrays).

Return STRICT JSON only, no markdown fence, no commentary, with this shape:
{
  "summary": "...",
  "sentiment": "neutral",
  "next_action": "...",
  "key_points": [{ "kind": "objection", "note": "..." }],
  "crm_note": "..."
}`;

export function buildSummaryUserPrompt(req: SummaryRequest): string {
    const turns = condenseTurns(req.turns, 40); // longer window — post-call we want full context
    const transcript = turns.length
        ? turns.map((t) => `${t.speaker.toUpperCase()}: ${t.text}`).join('\n')
        : '(no transcript captured)';

    const leadBits: string[] = [];
    if (req.lead?.name) leadBits.push(`Name: ${req.lead.name}`);
    if (req.lead?.company) leadBits.push(`Company: ${req.lead.company}`);
    if (req.lead?.extra) {
        for (const [k, v] of Object.entries(req.lead.extra)) {
            if (v && leadBits.length < 8) leadBits.push(`${k}: ${v}`);
        }
    }
    const leadBlock = leadBits.length ? `\nLead context:\n${leadBits.join('\n')}\n` : '';

    return `Full call transcript:\n${transcript}\n${leadBlock}\nProduce the JSON wrap-up.`;
}

const VALID_SENTIMENTS: CallSentiment[] = ['positive', 'neutral', 'negative', 'mixed'];

/** Sentinel summary returned when the LLM output is unusable. */
const EMPTY_SUMMARY: CallSummary = {
    summary: '',
    sentiment: 'neutral',
    next_action: '',
    key_points: [],
    crm_note: '',
};

export function parseCallSummary(raw: string): CallSummary {
    if (!raw) return EMPTY_SUMMARY;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return EMPTY_SUMMARY;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
        return EMPTY_SUMMARY;
    }
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_SUMMARY;
    const p = parsed as Record<string, unknown>;

    const summary = typeof p.summary === 'string' ? p.summary.trim().slice(0, 500) : '';
    const next_action = typeof p.next_action === 'string' ? p.next_action.trim().slice(0, 300) : '';
    const crm_note = typeof p.crm_note === 'string' ? p.crm_note.trim().slice(0, 800) : '';

    const sentiment: CallSentiment =
        typeof p.sentiment === 'string' &&
        (VALID_SENTIMENTS as string[]).includes(p.sentiment)
            ? (p.sentiment as CallSentiment)
            : 'neutral';

    const key_points: { kind: string; note: string }[] = [];
    const kpRaw = Array.isArray(p.key_points) ? p.key_points : [];
    for (const k of kpRaw.slice(0, 5)) {
        if (!k || typeof k !== 'object') continue;
        const obj = k as Record<string, unknown>;
        const kind = typeof obj.kind === 'string' ? obj.kind.trim().slice(0, 40) : '';
        const note = typeof obj.note === 'string' ? obj.note.trim().slice(0, 240) : '';
        if (kind && note) key_points.push({ kind, note });
    }

    return { summary, sentiment, next_action, key_points, crm_note };
}
