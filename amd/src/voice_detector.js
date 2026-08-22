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
     * @type {number} Signal-to-noise ratio (dB over the noise floor) at which
     * a single frame counts as "loud".
     *
     * Measured against a real microphone in a noisy room: ambient frames never
     * exceeded 5.8 dB, while frames during talking reached 15 dB. Individual
     * frames are only ever loud or not — there is deliberately no partial
     * score, because what separates speech from silence is not how loud any
     * one frame is but how often loud frames occur (see below).
     */
    const SPEECH_SNR_DB = 6;

    /**
     * @type {number} Frames in the short-term activity window (~1s at 30ms).
     *
     * Speech is not a continuously loud signal. Between syllables the level
     * drops all the way back to the noise floor — real measurements show
     * roughly half of all frames during talking sitting at ambient level.
     * Judging each frame in isolation therefore classifies normal speech as
     * silence about half the time. What actually distinguishes talking from a
     * quiet room is the *proportion* of loud frames over about a second:
     * near zero when silent, around half while speaking.
     */
    const ACTIVITY_WINDOW_FRAMES = 33;

    /** @type {number} Loud-frame proportion at which speech is considered to start. */
    const ACTIVITY_ENTER_RATIO = 0.35;

    /**
     * @type {number} Loud-frame proportion below which speech is considered to
     * have stopped. Lower than the enter ratio on purpose: without hysteresis
     * the state would chatter on and off through every pause between words,
     * repeatedly restarting the continuous-speech timer.
     */
    const ACTIVITY_EXIT_RATIO = 0.15;

    /**
     * @type {number} Absolute RMS floor (~-54 dBFS). In a near-silent room the
     * noise floor estimate approaches zero, which would make the SNR ratio
     * enormous for sounds that are still objectively inaudible (breathing,
     * distant traffic). Nothing below this level is ever speech, whatever the
     * ratio says.
     *
     * Kept low deliberately: microphone sensitivity varies enormously between
     * devices with gain control disabled, and a floor set for a loud headset
     * silently ignores every word from a quiet built-in mic. Discrimination is
     * the SNR and steadiness tests' job; this is only a backstop against
     * amplifying digital near-silence.
     */
    const MIN_ABSOLUTE_RMS = 0.003;

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

    /** @type {GainNode|null} Zero-gain sink keeping the worklet in the render graph. */
    let silentGain = null;

    /** @type {boolean} Whether the detector initialised successfully. */
    let ready = false;

    /** @type {boolean} Whether the detector is currently running. */
    let isActive = false;

    /** @type {Function|null} Callback invoked the instant a violation is confirmed. */
    let violationCallback = null;

    /** @type {number|null} Adaptive background level estimate (RMS). */
    let noiseFloor = null;

    /** @type {Array<boolean>} Recent per-frame "loud" flags for the activity window. */
    let loudHistory = [];

    /** @type {number} Proportion of the activity window that was loud. */
    let activityRatio = 0;

    /** @type {boolean} Hysteresis state: whether speech is currently present. */
    let speechActive = false;

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

    /** @type {number} Feature frames received from the worklet. */
    let framesReceived = 0;

    /** @type {number} Audio time of the last debug line emitted. */
    let lastDebugLog = 0;

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
                    // All three MUST stay off. This detector measures signal
                    // level against an adaptive noise floor, and every one of
                    // these features exists to manipulate signal level.
                    //
                    // Gain control is the dangerous one. Requesting
                    // echoCancellation alone is enough to switch on Chrome's
                    // full WebRTC audio processing chain, which applies its
                    // own gain control regardless of autoGainControl being
                    // false beside it. The symptom is nasty and specific:
                    // detection works once, then the processor adapts its gain
                    // down after that first stretch of speech, later speech is
                    // normalised to roughly background level, the
                    // signal-to-noise excess collapses, and nothing is flagged
                    // again until the gain slowly recovers — minutes later.
                    //
                    // The cost is that audio played by the quiz page itself
                    // (media questions) can now be picked up and attributed to
                    // the student. That is the lesser problem: it is rare, it
                    // shows up as a reviewable flag, and the steadiness test
                    // rejects most sustained playback anyway.
                    autoGainControl: false,
                    noiseSuppression: false,
                    echoCancellation: false,
                    channelCount: 1
                },
                video: false
            });

            // Constraints are a request, not a guarantee — a browser may
            // silently keep its processing chain on. Since gain control
            // quietly breaks level-based detection, report what was actually
            // applied rather than assuming we got what we asked for.
            const track = micStream.getAudioTracks()[0];
            if (track && typeof track.getSettings === 'function') {
                const s = track.getSettings();
                if (s.autoGainControl || s.echoCancellation || s.noiseSuppression) {
                    window.console.warn(
                        '[Proctor VoiceDetector] Browser kept audio processing enabled ' +
                        '(agc=' + s.autoGainControl +
                        ' aec=' + s.echoCancellation +
                        ' ns=' + s.noiseSuppression +
                        '). Speech levels will be normalised, which reduces detection reliability.'
                    );
                }
            }

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
                // One (silent) output purely so the node can be connected
                // onward to the destination — see the connect() calls below.
                numberOfOutputs: 1,
                outputChannelCount: [1],
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

            // The worklet must have a path to the destination or it may never
            // run at all: the render graph is pulled from the destination
            // backwards, so a analysis-only node left dangling off the source
            // is not guaranteed to be processed, and process() simply never
            // fires — no frames, no error, nothing. Routing it through a
            // zero-gain node keeps it in the render graph while guaranteeing
            // the student never hears their own microphone played back.
            silentGain = audioContext.createGain();
            silentGain.gain.value = 0;

            sourceNode.connect(workletNode);
            workletNode.connect(silentGain);
            silentGain.connect(audioContext.destination);

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

        framesReceived++;
        if (framesReceived === 1) {
            window.console.log('[Proctor VoiceDetector] Receiving audio frames — analysis running');
        }

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

        // Track how much of the last second was loud, rather than judging this
        // frame alone — see ACTIVITY_WINDOW_FRAMES for why per-frame decisions
        // misclassify ordinary speech.
        loudHistory.push(isLoudFrame(frame));
        if (loudHistory.length > ACTIVITY_WINDOW_FRAMES) {
            loudHistory.shift();
        }

        let loudCount = 0;
        for (let i = 0; i < loudHistory.length; i++) {
            if (loudHistory[i]) {
                loudCount++;
            }
        }
        activityRatio = loudCount / loudHistory.length;

        if (speechActive) {
            if (activityRatio < ACTIVITY_EXIT_RATIO) {
                speechActive = false;
            }
        } else if (activityRatio >= ACTIVITY_ENTER_RATIO) {
            speechActive = true;
        }

        // A signal this steady is machinery, not a person.
        if (isTooSteady()) {
            speechActive = false;
        }

        const isSpeechFrame = speechActive;

        // Track the background level, but never while speech is present.
        //
        // This has to key off the sustained speech state, not a per-frame
        // decision. Keying it per-frame creates a vicious circle: the quiet
        // gaps between syllables read as "not speech", so the floor is allowed
        // to climb toward talking level, which lowers the signal-to-noise
        // excess, which makes still more frames read as "not speech". Measured
        // against a real microphone the floor climbed from 0.016 to 0.023
        // during a single stretch of talking, and detection degraded as it
        // went.
        //
        // Steady machinery is deliberately not excluded here: letting the
        // floor rise through it is what absorbs a fan or air conditioner into
        // the background within a few seconds of it starting, instead of
        // leaving it permanently masking real speech on top of it.
        if (rms < noiseFloor) {
            noiseFloor += (rms - noiseFloor) * NOISE_FLOOR_FALL_ALPHA;
        } else if (!speechActive) {
            noiseFloor += (rms - noiseFloor) * NOISE_FLOOR_RISE_ALPHA;
        }

        if (config.voiceDebug && (now - lastDebugLog) >= 1) {
            lastDebugLog = now;
            const floor = Math.max(noiseFloor, 1e-6);
            window.console.log(
                '[Proctor Voice] rms=' + rms.toFixed(4) +
                ' floor=' + floor.toFixed(4) +
                ' snr=' + (20 * Math.log10(rms / floor)).toFixed(1) + 'dB' +
                ' zcr=' + frame.zcr.toFixed(2) +
                ' loud=' + (loudHistory.length ? loudHistory[loudHistory.length - 1] : false) +
                ' activity=' + activityRatio.toFixed(2) +
                ' speech=' + isSpeechFrame +
                ' steady=' + isTooSteady() +
                ' episode=' + (episodeStart === null ? '-' : (now - episodeStart).toFixed(1) + 's') +
                ' limit=' + config.voiceMaxContinuousSpeech + 's'
            );
        }

        updateEpisode(isSpeechFrame, now);
    }

    /**
     * Whether a single frame stands out above the background.
     *
     * Deliberately a hard yes/no. A frame in the gap between two syllables is
     * genuinely at ambient level and there is no useful partial credit to give
     * it; what matters is how many frames in the surrounding second are loud.
     *
     * @param {Object} frame Frame features: {rms, zcr}.
     * @returns {boolean} True if the frame is loud enough to be part of speech.
     */
    function isLoudFrame(frame) {
        // Too quiet to be speech in absolute terms, regardless of how it
        // compares to the noise floor.
        if (frame.rms < MIN_ABSOLUTE_RMS) {
            return false;
        }

        // Hiss or an impulsive click rather than a voice.
        if (frame.zcr > MAX_ZCR) {
            return false;
        }

        const floor = Math.max(noiseFloor, 1e-6);
        return (20 * Math.log10(frame.rms / floor)) > SPEECH_SNR_DB;
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
            episodeScoreSum += activityRatio;
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
        currentState.confidence = activityRatio;
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
        // framesReceived is the first thing to check when nothing is being
        // flagged: zero means the worklet never ran and no audio was analysed
        // at all, which is a different problem from thresholds being wrong.
        currentState.framesReceived = framesReceived;
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

        if (silentGain) {
            try {
                silentGain.disconnect();
            } catch (e) {
                // Already disconnected.
            }
            silentGain = null;
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
        loudHistory = [];
        activityRatio = 0;
        speechActive = false;
        envelopeHistory = [];
        lastViolation = null;
        framesReceived = 0;
        lastDebugLog = 0;
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
