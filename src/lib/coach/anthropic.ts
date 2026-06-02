/**
 * Anthropic Messages API adapter for the live coach.
 *
 * Uses a Haiku model for fast, cheap inference. We call the REST API directly
 * (no SDK) so the route stays zero-dependency and cold-boots quickly on Vercel.
 */

import type {
    CoachAdapter,
    CoachRequest,
    CoachResponse,
    SummaryRequest,
    CallSummary,
} from './types';
import {
    SYSTEM_PROMPT,
    buildUserPrompt,
    parseCoachResponse,
    SUMMARY_SYSTEM_PROMPT,
    buildSummaryUserPrompt,
    parseCallSummary,
} from './prompt';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export class AnthropicCoachAdapter implements CoachAdapter {
    readonly name = 'anthropic';

    constructor(
        private readonly apiKey: string,
        private readonly model: string = DEFAULT_MODEL,
    ) {
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');
    }

    async suggest(req: CoachRequest): Promise<CoachResponse> {
        const userPrompt = buildUserPrompt(req);

        const res = await fetch(ANTHROPIC_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: 400,
                temperature: 0.4,
                system: SYSTEM_PROMPT,
                messages: [{ role: 'user', content: userPrompt }],
            }),
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`);
        }

        const data = (await res.json()) as {
            content?: Array<{ type: string; text?: string }>;
        };
        const text =
            (data.content || [])
                .filter((c) => c.type === 'text')
                .map((c) => c.text || '')
                .join('') || '';

        return parseCoachResponse(text);
    }

    async summarize(req: SummaryRequest): Promise<CallSummary> {
        const userPrompt = buildSummaryUserPrompt(req);
        const res = await fetch(ANTHROPIC_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: 700, // summary needs a bit more headroom than suggestions
                temperature: 0.3,
                system: SUMMARY_SYSTEM_PROMPT,
                messages: [{ role: 'user', content: userPrompt }],
            }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`);
        }
        const data = (await res.json()) as {
            content?: Array<{ type: string; text?: string }>;
        };
        const text =
            (data.content || [])
                .filter((c) => c.type === 'text')
                .map((c) => c.text || '')
                .join('') || '';
        return parseCallSummary(text);
    }
}
