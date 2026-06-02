/**
 * Common interface for streaming speech-to-text providers.
 *
 * The bridge picks one implementation at startup based on STT_PROVIDER.
 * Both Deepgram and AssemblyAI expose a streaming WS API; we hide the
 * differences behind this small interface so the WS-bridge code doesn't
 * care which one is in use.
 */

export type Speaker = 'agent' | 'customer' | 'unknown';

export interface TranscriptChunk {
    /** Speaker who produced this segment, when we can attribute it. */
    speaker: Speaker;
    /** The transcribed text for this chunk. */
    text: string;
    /** True once the provider considers the segment finalized (vs. interim). */
    isFinal: boolean;
}

export interface STTSession {
    /**
     * Feed a frame of raw μ-law PCM audio (the format Twilio's Media Streams
     * sends after we base64-decode). Implementations are expected to convert
     * or repackage as the provider requires.
     */
    sendAudio(frame: Buffer, channel: Speaker): void;

    /** Gracefully close the upstream connection. */
    close(): Promise<void>;
}

export interface STTAdapter {
    /**
     * Open a new STT session for one call. `onTranscript` is called for each
     * transcribed chunk produced by either channel.
     */
    openSession(args: {
        callSid: string;
        onTranscript: (chunk: TranscriptChunk) => void;
        onError: (err: Error) => void;
    }): Promise<STTSession>;

    /** Human-readable name for logs. */
    readonly name: string;
}
