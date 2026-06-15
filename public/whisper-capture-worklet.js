/**
 * AudioWorklet processor that captures audio frames, downsamples to 16 kHz
 * mono PCM (Whisper's input format), and posts batches to the main thread.
 *
 * Whisper expects 16-bit-ish PCM at 16 kHz. We post Float32Array chunks of
 * roughly 1 second (16,000 samples) so the main thread can accumulate them
 * into the 5-second windows Whisper actually transcribes.
 *
 * Loaded via `audioContext.audioWorklet.addModule('/whisper-capture-worklet.js')`.
 */
class WhisperCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // Downsample ratio between the input rate (whatever the AudioContext
        // is running at — usually 48000) and our target 16000. Re-checked
        // every block in case the underlying rate changes.
        this._target = 16000;
        // Sliding buffer that accumulates ~1s of downsampled samples before
        // we post it back. Keeping the buffer small reduces main-thread
        // pressure.
        this._buffer = new Float32Array(this._target);
        this._bufferLen = 0;
    }

    /** Linear-interpolation downsample from `inputRate` to `_target`. */
    _downsample(input, inputRate) {
        if (inputRate === this._target) return input;
        const ratio = inputRate / this._target;
        const outLength = Math.floor(input.length / ratio);
        const out = new Float32Array(outLength);
        for (let i = 0; i < outLength; i++) {
            const srcIdx = i * ratio;
            const idx0 = Math.floor(srcIdx);
            const idx1 = Math.min(idx0 + 1, input.length - 1);
            const frac = srcIdx - idx0;
            out[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
        }
        return out;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input.length) return true;
        // Mono = channel 0; if stereo, we lose the right channel which is
        // fine for speech.
        const channel = input[0];
        if (!channel) return true;

        const downsampled = this._downsample(channel, sampleRate);

        let i = 0;
        while (i < downsampled.length) {
            const room = this._buffer.length - this._bufferLen;
            const take = Math.min(room, downsampled.length - i);
            this._buffer.set(downsampled.subarray(i, i + take), this._bufferLen);
            this._bufferLen += take;
            i += take;
            if (this._bufferLen >= this._buffer.length) {
                this.port.postMessage(this._buffer.slice(0, this._bufferLen));
                this._bufferLen = 0;
            }
        }
        return true;
    }
}

registerProcessor('whisper-capture', WhisperCaptureProcessor);
