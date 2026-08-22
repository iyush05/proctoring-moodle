/**
 * AudioWorklet processor for voice activity detection.
 *
 * Deliberately dumb: this runs on the realtime audio thread, so it only
 * extracts two cheap per-frame features (RMS energy and zero-crossing rate)
 * and posts them to the main thread. All classification — noise-floor
 * tracking, thresholds, the continuous-speech timer — lives in
 * amd/src/voice_detector.js, where it can be changed without risking audio
 * glitches.
 *
 * Why a worklet at all rather than polling an AnalyserNode on a timer:
 * the main thread is already running FaceMesh and COCO-SSD inference every
 * few seconds, which stalls it for tens/hundreds of ms at a time. A polled
 * analyser would silently drop frames during those stalls, and those gaps
 * are indistinguishable from real silence — which would reset the
 * continuous-speech timer and let sustained talking go unflagged. The audio
 * thread is never blocked by main-thread work, and every frame is stamped
 * with the audio clock (`currentTime`), so the timer measures real elapsed
 * audio time regardless of what the main thread is doing.
 *
 * This is a plain (non-AMD) script: AudioWorklet modules are loaded by URL
 * via audioWorklet.addModule() into a separate global scope that has no
 * module loader, no window, and no DOM.
 *
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/* eslint-env worker */
/* globals AudioWorkletProcessor, registerProcessor, sampleRate, currentTime */

/** @type {number} Default analysis frame length in milliseconds. */
const DEFAULT_FRAME_MS = 30;

/**
 * Extracts per-frame RMS energy and zero-crossing rate from the mic stream.
 */
class ProctorVadProcessor extends AudioWorkletProcessor {

    /**
     * @param {Object} options Node options; processorOptions.frameMs sets frame length.
     */
    constructor(options) {
        super();

        const opts = (options && options.processorOptions) || {};
        const frameMs = opts.frameMs || DEFAULT_FRAME_MS;

        // `sampleRate` is a global in AudioWorkletGlobalScope. Frames are at
        // least one render quantum (128 samples) long so a frame is never
        // completed more than once per process() call.
        this.frameSize = Math.max(128, Math.round((sampleRate * frameMs) / 1000));
        this.buffer = new Float32Array(this.frameSize);
        this.filled = 0;
        this.running = true;

        this.port.onmessage = (event) => {
            if (event.data && event.data.command === 'stop') {
                this.running = false;
            }
        };

        // Tell the main thread what geometry it's actually receiving, since
        // the browser picks the sample rate and it may not be what we asked for.
        this.port.postMessage({
            type: 'ready',
            sampleRate: sampleRate,
            frameSize: this.frameSize,
            frameMs: (this.frameSize / sampleRate) * 1000
        });
    }

    /**
     * Accumulate incoming audio into fixed-size frames.
     *
     * @param {Array<Array<Float32Array>>} inputs Input channel data.
     * @returns {boolean} False to tear the processor down, true to keep it alive.
     */
    process(inputs) {
        if (!this.running) {
            // Returning false lets the browser garbage-collect this processor.
            return false;
        }

        const input = inputs[0];
        if (!input || input.length === 0) {
            return true;
        }

        const channel = input[0];
        if (!channel || channel.length === 0) {
            // No data this quantum (e.g. the track is muted) — stay alive.
            return true;
        }

        for (let i = 0; i < channel.length; i++) {
            this.buffer[this.filled++] = channel[i];
            if (this.filled === this.frameSize) {
                this.emitFrame();
                this.filled = 0;
            }
        }

        return true;
    }

    /**
     * Compute features for one complete frame and hand them to the main thread.
     */
    emitFrame() {
        const buf = this.buffer;
        const n = this.frameSize;

        let sumSquares = 0;
        let crossings = 0;
        let previous = buf[0];

        for (let i = 0; i < n; i++) {
            const sample = buf[i];
            sumSquares += sample * sample;
            // Sign change == zero crossing. Voiced speech sits in a moderate
            // ZCR band; broadband hiss and impulsive clicks sit far above it.
            if ((sample >= 0) !== (previous >= 0)) {
                crossings++;
            }
            previous = sample;
        }

        this.port.postMessage({
            type: 'frame',
            // Audio-clock timestamp (seconds). Immune to main-thread stalls.
            time: currentTime,
            rms: Math.sqrt(sumSquares / n),
            zcr: crossings / n
        });
    }
}

registerProcessor('proctor-vad-processor', ProctorVadProcessor);
