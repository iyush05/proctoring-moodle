/**
 * Voice detection module — client-side continuous-speech detection.
 *
 * Detects one thing only: whether the student is speaking *continuously* for
 * longer than the quiz allows. There is no speaker identification, no
 * voiceprint enrolment, and no transcription — the microphone signal never
 * leaves the browser, and nothing but the duration/confidence of a flagged
 * episode is ever sent to the server.
 *
 * Key design decisions:
 * - Standalone module: decoupled from the video pipeline, follows the
 *   object_detector.js / gaze_tracker.js pattern.
 * - Features come from an AudioWorklet (js/vad_worklet.js) so frames are
 *   stamped with the audio clock and never dropped when the main thread
 *   stalls on FaceMesh/COCO-SSD inference. See that file for why this
 *   matters.
 * - Adaptive noise floor rather than a fixed level threshold: a fixed
 *   threshold is wrong for every room, and wrong again when the fan turns on
 *   halfway through. Speech is detected as a signal-to-noise excess over a
 *   continuously re-estimated background level.
 * - Duration *is* the debounce: rather than flagging any detected speech and
 *   then filtering it, a violation requires speech to run continuously past
 *   the configured limit. A cough, a sigh, or a short muttered remark can
 *   never reach it, so the flag can fire the instant the limit is crossed
 *   without a persistence counter of the kind gaze tracking needs.
 * - Gap tolerance: brief silences (natural pauses between words and
 *   sentences) do not reset the timer — only a real stretch of silence does.
 *   Without this, ordinary sentence rhythm would keep the timer near zero
 *   and nothing would ever be flagged.
 * - Graceful degradation: if the mic is unavailable or the worklet fails to
 *   load, the rest of proctoring continues unaffected.
 *
 * @module     quizaccess_proctor/voice_detector
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
define([], function () {

    // -------------------------------------------------------------------------
    // Tuning constants
    //
    // These are deliberately not exposed as quiz settings: they describe the
    // acoustics of speech, not a policy choice a teacher should be making.
    // The one genuinely policy-level number — how long continuous speech is
    // allowed to run — is the admin-configured ceiling in the quiz settings.
    // -------------------------------------------------------------------------

    /** @type {number} Analysis frame length (ms). Matches the worklet default. */
    const FRAME_MS = 30;

    /**
     * @type {number} EMA smoothing factor for the per-frame speech score.
     * ~0.25 at 30ms frames gives a time constant around 120ms: enough to ride
     * out a single glitchy frame (a key click, a chair creak) without adding
     * lag that would blur the start/end of an episode.
     */
    const SCORE_EMA_ALPHA = 0.25;

    /** @type {number} Smoothed score above which a frame counts as speech. */
    const SPEECH_SCORE_THRESHOLD = 0.5;

    /**
     * @type {number} Signal-to-noise ratio (dB over the noise floor) at which
     * a frame starts to look like speech, and the ratio at which it certainly
     * does. Scores ramp linearly between the two rather than switching hard,
     * so a frame hovering near the boundary contributes partially instead of
     * flickering the classification.
     */
    const SNR_LOW_DB = 6;

    /** @type {number} SNR (dB) at or above which a frame scores a full 1.0. */
    const SNR_HIGH_DB = 12;

    /**
     * @type {number} Absolute RMS floor (~-44 dBFS). In a near-silent room the
     * noise floor estimate approaches zero, which would make the SNR ratio
     * enormous for sounds that are still objectively inaudible (breathing,
     * distant traffic). Nothing below this level is ever speech, whatever the
     * ratio says.
     */
    const MIN_ABSOLUTE_RMS = 0.006;

    /**
     * @type {number} Zero-crossing rate above which a frame is rejected.
     * Voiced speech is well below this; broadband hiss and impulsive clicks
     * (keyboard, mouse) are well above. Set generously so that unvoiced
     * fricatives ("s", "f"), which do run high, are not systematically
     * dropped mid-word.
     */
    const MAX_ZCR = 0.45;

    /** @type {number} Noise floor adaptation rate when the level drops (fast). */
    const NOISE_FLOOR_FALL_ALPHA = 0.25;

    /**
     * @type {number} Noise floor adaptation rate when the level rises (slow —
     * roughly a 6s time constant at 30ms frames). The rise branch is also
     * frozen while speech is active, so a long utterance can never be
     * gradually absorbed into the "background" and stop registering.
     */
    const NOISE_FLOOR_RISE_ALPHA = 0.005;

    /** @type {number} Default gap (ms) of silence tolerated inside one episode. */
    const DEFAULT_GAP_TOLERANCE_MS = 400;

    /** @type {number} Default ceiling for continuous speech (seconds). */
    const DEFAULT_MAX_CONTINUOUS_SPEECH_SEC = 8;

    /** @type {number} Frames of RMS history kept for the steadiness test (~1.5s). */
    const ENVELOPE_HISTORY_FRAMES = 50;

    /**
     * @type {number} Coefficient of variation (of the recent RMS envelope)
     * below which audio is judged too steady to be a person talking.
     *
     * Speech energy swings with every syllable; machinery does not. A fan or
     * air conditioner switching on mid-attempt is a step change the slow
     * noise floor takes seconds to absorb, and in the meantime it looks
     * exactly like a loud sustained "voice". Real speech runs well above this
     * variation, so the test only bites on the machine case.
     */
    const STEADY_CV_MAX = 0.18;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /** @type {Object} Configuration passed from the proctoring engine. */
    let config = {};

    /** @type {AudioContext|null} Audio graph context. */
    let audioContext = null;

    /** @type {MediaStream|null} Microphone stream (owned by this module). */
    let micStream = null;

    /** @type {MediaStreamAudioSourceNode|null} Source node for the mic. */
    let sourceNode = null;

    /** @type {AudioWorkletNode|null} Feature-extraction worklet node. */
    let workletNode = null;

    /** @type {boolean} Whether the detector initialised successfully. */
    let ready = false;

    /** @type {boolean} Whether the detector is currently running. */
    let isActive = false;

    /** @type {Function|null} Callback invoked the instant a violation is confirmed. */
    let violationCallback = null;

    /** @type {number|null} Adaptive background level estimate (RMS). */
    let noiseFloor = null;

    /** @type {number} EMA-smoothed speech score for the latest frame. */
    let smoothedScore = 0;

    /** @type {Array<number>} Recent frame RMS values, for the steadiness test. */
    let envelopeHistory = [];

    /**
     * @type {number|null} Audio-clock time (seconds) at which the current
     * continuous-speech episode began, or null when no episode is open.
     */
    let episodeStart = null;

    /** @type {number} Audio-clock time of the most recent speech frame. */
    let lastSpeechTime = 0;

    /** @type {number} Sum of smoothed scores across the current episode. */
    let episodeScoreSum = 0;

    /** @type {number} Number of frames counted into episodeScoreSum. */
    let episodeScoreCount = 0;

    /**
     * @type {number} Wall-clock milliseconds corresponding to audio time 0.
     * The audio clock starts at an arbitrary point, so episodes are converted
     * to real timestamps through this offset for reporting.
     */
    let audioEpochOffsetMs = 0;

    /** @type {Object|null} The most recently confirmed violation episode. */
    let lastViolation = null;

    /** @type {Object} Current detection state for UI and reporting. */
    let currentState = {
        /** @type {boolean} Whether a violation has been confirmed and not yet cleared. */
        isViolation: false,
        /** @type {boolean} Whether speech is being detected right now. */
        isSpeaking: false,
        /** @type {number} Duration (s) of the in-progress speech episode. */
        speechDuration: 0,
        /** @type {number} Smoothed speech confidence for the latest frame. */
        confidence: 0
    };

    /**
     * Initialise the voice detector: acquire the microphone, load the
     * feature-extraction worklet, and begin analysing.
     *
     * @param {Object} cfg Configuration object.
     * @param {string} cfg.voiceWorkletUrl URL of the AudioWorklet processor script.
     * @param {number} [cfg.voiceMaxContinuousSpeech=8] Seconds of continuous
     *   speech allowed before flagging. Admin-configured ceiling.
     * @param {number} [cfg.voiceGapToleranceMs=400] Silence (ms) tolerated
     *   within a single episode.
     * @param {Function} [onViolation] Invoked with the episode record the
     *   instant the ceiling is crossed.
     * @returns {Promise<boolean>} Whether the detector started successfully.
     */
    async function init(cfg, onViolation) {
        config = cfg || {};
        violationCallback = typeof onViolation === 'function' ? onViolation : null;

        config.voiceMaxContinuousSpeech =
            config.voiceMaxContinuousSpeech || DEFAULT_MAX_CONTINUOUS_SPEECH_SEC;
        config.voiceGapToleranceMs =
            config.voiceGapToleranceMs || DEFAULT_GAP_TOLERANCE_MS;

        if (ready) {
            return true;
        }

        try {
            if (!config.voiceWorkletUrl) {
                throw new Error('No worklet URL configured');
            }
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('getUserMedia unavailable');
            }

            micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    // Automatic gain control MUST stay off: it normalises the
                    // signal level, which is precisely the quantity this
                    // detector measures. With AGC on, a silent room gets
                    // amplified until background hiss looks like speech.
                    autoGainControl: false,
                    // Noise suppression reshapes the background unpredictably
                    // and would fight the adaptive noise floor.
                    noiseSuppression: false,
                    // Echo cancellation is kept on so audio played by the quiz
                    // page itself (media questions) is not picked up and
                    // attributed to the student.
                    echoCancellation: true,
                    channelCount: 1
                },
                video: false
            });

            const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextCtor) {
                throw new Error('Web Audio API unavailable');
            }
            audioContext = new AudioContextCtor();

            // Autoplay policy can start the context suspended; it resumes once
            // there has been a user gesture, and starting the attempt is one.
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            if (!audioContext.audioWorklet) {
                throw new Error('AudioWorklet unavailable');
            }
            await audioContext.audioWorklet.addModule(config.voiceWorkletUrl);

            audioEpochOffsetMs = Date.now() - (audioContext.currentTime * 1000);

            sourceNode = audioContext.createMediaStreamSource(micStream);
            workletNode = new AudioWorkletNode(audioContext, 'proctor-vad-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 0,
                processorOptions: { frameMs: FRAME_MS }
            });

            workletNode.port.onmessage = function (event) {
                const data = event.data;
                if (!data) {
                    return;
                }
                if (data.type === 'frame') {
                    handleFrame(data);
                }
            };

            // The worklet declares no outputs, so it is not connected onward to
            // the destination — nothing is played back to the student.
            sourceNode.connect(workletNode);

            ready = true;
            isActive = true;
            return true;

        } catch (err) {
            window.console.warn('[Proctor VoiceDetector] Init failed:', err);
            releaseAudio();
            ready = false;
            isActive = false;
            return false;
        }
    }

    /**
     * Process a single feature frame from the worklet.
     *
     * @param {Object} frame Frame features: {time, rms, zcr}.
     */
    function handleFrame(frame) {
        if (!isActive) {
            return;
        }

        const rms = frame.rms;
        const now = frame.time;

        // Seed the noise floor from the first frame rather than from zero, so
        // the detector does not spend its first seconds treating the room's
        // ordinary background as a huge SNR excess.
        if (noiseFloor === null) {
            noiseFloor = rms;
        }

        envelopeHistory.push(rms);
        if (envelopeHistory.length > ENVELOPE_HISTORY_FRAMES) {
            envelopeHistory.shift();
        }

        const speechScore = scoreFrame(frame);

        smoothedScore = (SCORE_EMA_ALPHA * speechScore) +
            ((1 - SCORE_EMA_ALPHA) * smoothedScore);

        // Loud enough to be speech, and varying enough to be a person rather
        // than a machine. Both must hold.
        const isSpeechFrame = (smoothedScore > SPEECH_SCORE_THRESHOLD) && !isTooSteady();

        // Track the background level, but never while speech is present —
        // otherwise a sustained utterance is slowly absorbed into the floor
        // and stops registering as an excess over it. Steady machinery is
        // deliberately *not* excluded here: letting the floor rise through it
        // is what absorbs a fan or air conditioner into the background within
        // a few seconds of it starting, instead of leaving it permanently
        // sitting above the floor and masking real speech on top of it.
        if (rms < noiseFloor) {
            noiseFloor += (rms - noiseFloor) * NOISE_FLOOR_FALL_ALPHA;
        } else if (!isSpeechFrame) {
            noiseFloor += (rms - noiseFloor) * NOISE_FLOOR_RISE_ALPHA;
        }

        updateEpisode(isSpeechFrame, now);
    }

    /**
     * Score one frame from 0 (certainly not speech) to 1 (certainly speech).
     *
     * @param {Object} frame Frame features: {rms, zcr}.
     * @returns {number} Speech score in [0, 1].
     */
    function scoreFrame(frame) {
        // Too quiet to be speech in absolute terms, regardless of how it
        // compares to the noise floor.
        if (frame.rms < MIN_ABSOLUTE_RMS) {
            return 0;
        }

        // Hiss or an impulsive click rather than a voice.
        if (frame.zcr > MAX_ZCR) {
            return 0;
        }

        const floor = Math.max(noiseFloor, 1e-6);
        const snrDb = 20 * Math.log10(frame.rms / floor);

        if (snrDb <= SNR_LOW_DB) {
            return 0;
        }
        if (snrDb >= SNR_HIGH_DB) {
            return 1;
        }
        return (snrDb - SNR_LOW_DB) / (SNR_HIGH_DB - SNR_LOW_DB);
    }

    /**
     * Advance the continuous-speech timer and flag a violation the instant the
     * configured ceiling is crossed.
     *
     * @param {boolean} isSpeechFrame Whether this frame counts as speech.
     * @param {number} now Audio-clock time of this frame (seconds).
     */
    function updateEpisode(isSpeechFrame, now) {
        const gapToleranceSec = config.voiceGapToleranceMs / 1000;

        if (isSpeechFrame) {
            if (episodeStart === null) {
                episodeStart = now;
                episodeScoreSum = 0;
                episodeScoreCount = 0;
            }
            lastSpeechTime = now;
            episodeScoreSum += smoothedScore;
            episodeScoreCount++;
        } else if (episodeStart !== null && (now - lastSpeechTime) > gapToleranceSec) {
            // Silence ran past the tolerated gap: the episode ended below the
            // ceiling, so nothing is flagged and the timer resets.
            resetEpisode();
            updateState(false, 0);
            return;
        }

        if (episodeStart === null) {
            updateState(false, 0);
            return;
        }

        const duration = now - episodeStart;

        updateState(isSpeechFrame, duration);

        if (duration >= config.voiceMaxContinuousSpeech) {
            confirmViolation(now, duration);
        }
    }

    /**
     * Whether recent audio is too steady in level to be speech.
     *
     * @returns {boolean} True if the envelope varies less than speech does.
     */
    function isTooSteady() {
        if (envelopeHistory.length < ENVELOPE_HISTORY_FRAMES) {
            return false;
        }

        let sum = 0;
        for (let i = 0; i < envelopeHistory.length; i++) {
            sum += envelopeHistory[i];
        }
        const mean = sum / envelopeHistory.length;
        if (mean <= 0) {
            return false;
        }

        let variance = 0;
        for (let i = 0; i < envelopeHistory.length; i++) {
            const diff = envelopeHistory[i] - mean;
            variance += diff * diff;
        }
        variance /= envelopeHistory.length;

        return (Math.sqrt(variance) / mean) < STEADY_CV_MAX;
    }

    /**
     * Record a confirmed violation and notify the proctoring engine at once.
     *
     * @param {number} now Audio-clock time of confirmation (seconds).
     * @param {number} duration Length of the episode (seconds).
     */
    function confirmViolation(now, duration) {
        const avgConfidence = episodeScoreCount > 0
            ? (episodeScoreSum / episodeScoreCount)
            : 0;

        lastViolation = {
            startedAt: Math.round(audioEpochOffsetMs + (episodeStart * 1000)),
            endedAt: Math.round(audioEpochOffsetMs + (now * 1000)),
            duration: duration,
            confidence: avgConfidence
        };

        currentState.isViolation = true;

        // Restart the timer from now rather than closing the episode outright,
        // so someone who simply keeps talking is flagged once per ceiling
        // period instead of once for the whole attempt — and, equally, is not
        // flagged again on every subsequent frame.
        episodeStart = now;
        lastSpeechTime = now;
        episodeScoreSum = 0;
        episodeScoreCount = 0;

        if (violationCallback) {
            try {
                violationCallback(lastViolation);
            } catch (err) {
                window.console.error('[Proctor VoiceDetector] Violation callback failed:', err);
            }
        }
    }

    /**
     * Clear the in-progress episode.
     */
    function resetEpisode() {
        episodeStart = null;
        episodeScoreSum = 0;
        episodeScoreCount = 0;
    }

    /**
     * Refresh the publicly visible state.
     *
     * @param {boolean} isSpeaking Whether speech is currently detected.
     * @param {number} duration Current episode duration (seconds).
     */
    function updateState(isSpeaking, duration) {
        currentState.isSpeaking = isSpeaking;
        currentState.speechDuration = duration;
        currentState.confidence = smoothedScore;
    }

    /**
     * Format the most recent violation for the log record.
     *
     * Mirrors gaze_tracker.js's compact comma-separated shape:
     * "talking,<duration seconds>,<average confidence>".
     *
     * @returns {string} Formatted voice data, or '' if nothing was flagged.
     */
    function formatForReport() {
        if (!lastViolation) {
            return '';
        }
        return 'talking,' +
            lastViolation.duration.toFixed(1) + ',' +
            lastViolation.confidence.toFixed(2);
    }

    /**
     * Clear the active violation flag once it has been reported.
     */
    function clearViolation() {
        currentState.isViolation = false;
    }

    /**
     * Get the current detection state.
     *
     * @returns {Object} State with isViolation, isSpeaking, speechDuration, confidence.
     */
    function getState() {
        return currentState;
    }

    /**
     * Whether the detector is running.
     *
     * @returns {boolean} True if the microphone pipeline is live.
     */
    function isReady() {
        return ready;
    }

    /**
     * Tear down the audio graph and release the microphone.
     */
    function releaseAudio() {
        if (workletNode) {
            try {
                workletNode.port.postMessage({ command: 'stop' });
                workletNode.disconnect();
            } catch (e) {
                // Already torn down.
            }
            workletNode = null;
        }

        if (sourceNode) {
            try {
                sourceNode.disconnect();
            } catch (e) {
                // Already disconnected.
            }
            sourceNode = null;
        }

        if (micStream) {
            micStream.getTracks().forEach(function (track) {
                track.stop();
            });
            micStream = null;
        }

        if (audioContext) {
            try {
                audioContext.close();
            } catch (e) {
                // Already closed.
            }
            audioContext = null;
        }
    }

    /**
     * Stop detection, release the microphone, and reset all state.
     */
    function stop() {
        isActive = false;
        ready = false;

        releaseAudio();

        noiseFloor = null;
        smoothedScore = 0;
        envelopeHistory = [];
        lastViolation = null;
        resetEpisode();

        currentState = {
            isViolation: false,
            isSpeaking: false,
            speechDuration: 0,
            confidence: 0
        };
    }

    return {
        init: init,
        getState: getState,
        isReady: isReady,
        formatForReport: formatForReport,
        clearViolation: clearViolation,
        stop: stop
    };
});
