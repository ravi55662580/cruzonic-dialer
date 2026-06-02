import type { STTAdapter } from './types';
import { DeepgramAdapter } from './deepgram';
import { AssemblyAIAdapter } from './assemblyai';

/** Pick an STT adapter from env. Throws early if config is bad. */
export function createSTTAdapter(): STTAdapter {
    const provider = (process.env.STT_PROVIDER || 'deepgram').toLowerCase();
    switch (provider) {
        case 'deepgram':
            return new DeepgramAdapter(process.env.DEEPGRAM_API_KEY || '');
        case 'assemblyai':
            return new AssemblyAIAdapter(process.env.ASSEMBLYAI_API_KEY || '');
        default:
            throw new Error(`Unknown STT_PROVIDER: ${provider}`);
    }
}

export type { STTAdapter, STTSession, TranscriptChunk, Speaker } from './types';
