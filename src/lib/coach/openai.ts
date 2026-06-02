/**
 * OpenAI Chat Completions adapter for the live coach.
 *
 * Mirrors the Anthropic adapter: REST call, no SDK, JSON-mode response so the
 * model is constrained to a parseable object.
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

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';

export class OpenAICoachAdapter implements CoachAdapter {
    readonly name = 'openai';

    constructor(
        private readonly apiKey: string,
        private readonly model: string = DEFAULT_MODEL,
    ) {
        if (!apiKey) throw new Error('OPENAI_API_KEY is required');
    }

    async suggest(req: CoachRequest): Promise<CoachResponse> {
        const userPrompt = buildUserPrompt(req);

        const res = await fetch(OPENAI_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                temperature: 0.4,
                max_tokens: 400,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: userPrompt },
                ],
            }),
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
        }

        const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content || '';
        return parseCoachResponse(text);
    }

    async summarize(req: SummaryRequest): Promise<CallSummary> {
        const userPrompt = buildSummaryUserPrompt(req);
        const res = await fetch(OPENAI_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                temperature: 0.3,
                max_tokens: 700,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
                    { role: 'user', content: userPrompt },
                ],
            }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
        }
        const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content || '';
        return parseCallSummary(text);
    }
}
