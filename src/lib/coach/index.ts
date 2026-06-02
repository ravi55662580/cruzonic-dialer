import type { CoachAdapter } from './types';
import { AnthropicCoachAdapter } from './anthropic';
import { OpenAICoachAdapter } from './openai';
import { GeminiCoachAdapter } from './gemini';

/**
 * Pick a coach adapter from env. Defaults to Anthropic Haiku because it's
 * the fastest + cheapest paid option. Switch to:
 *   COACH_PROVIDER=openai   → OpenAI (gpt-4o-mini)
 *   COACH_PROVIDER=gemini   → Google Gemini (gemini-2.0-flash, free tier)
 */
export function createCoachAdapter(): CoachAdapter {
    const provider = (process.env.COACH_PROVIDER || 'anthropic').toLowerCase();
    switch (provider) {
        case 'anthropic':
            return new AnthropicCoachAdapter(
                process.env.ANTHROPIC_API_KEY || '',
                process.env.COACH_MODEL || undefined,
            );
        case 'openai':
            return new OpenAICoachAdapter(
                process.env.OPENAI_API_KEY || '',
                process.env.COACH_MODEL || undefined,
            );
        case 'gemini':
        case 'google':
            return new GeminiCoachAdapter(
                process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
                process.env.COACH_MODEL || undefined,
            );
        default:
            throw new Error(`Unknown COACH_PROVIDER: ${provider}`);
    }
}

export type {
    CoachAdapter,
    CoachRequest,
    CoachResponse,
    CoachSuggestion,
    CoachTurn,
    CoachLeadInfo,
    ObjectionKind,
    SummaryRequest,
    CallSummary,
    CallSentiment,
    CallKeyPoint,
} from './types';
