/**
 * Google Gemini coach adapter.
 *
 * Google ships an OpenAI-compatible endpoint at
 *   https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
 * so we can reuse the OpenAI request/response shape almost verbatim. Auth is
 * a `Bearer <api-key>` header instead of OpenAI's bearer token, and the
 * response shape is OpenAI-compatible (choices[0].message.content).
 *
 * Recommended models (as of 2025):
 *   gemini-2.0-flash      — fast + cheap, generous free tier
 *   gemini-2.5-flash      — newer, slightly better quality
 *   gemini-1.5-flash      — legacy, still free-tier eligible
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

const GEMINI_URL =
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const DEFAULT_MODEL = 'gemini-2.0-flash';

export class GeminiCoachAdapter implements CoachAdapter {
    readonly name = 'gemini';

    constructor(
        private readonly apiKey: string,
        private readonly model: string = DEFAULT_MODEL,
    ) {
        if (!apiKey) throw new Error('GEMINI_API_KEY is required');
    }

    private async chat(systemPrompt: string, userPrompt: string, maxTokens: number, temperature: number): Promise<string> {
        const res = await fetch(GEMINI_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                temperature,
                max_tokens: maxTokens,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
            }),
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
        }

        const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
        };
        return data.choices?.[0]?.message?.content || '';
    }

    async suggest(req: CoachRequest): Promise<CoachResponse> {
        const text = await this.chat(SYSTEM_PROMPT, buildUserPrompt(req), 400, 0.4);
        return parseCoachResponse(text);
    }

    async summarize(req: SummaryRequest): Promise<CallSummary> {
        const text = await this.chat(SUMMARY_SYSTEM_PROMPT, buildSummaryUserPrompt(req), 700, 0.3);
        return parseCallSummary(text);
    }
}
