/**
 * Shared 5-point gaze calibration UI — the full-screen overlay + dot sequence
 * used both when a student starts a proctored quiz attempt (proctoring.js)
 * and when an admin/teacher runs the camera calibration helper on the quiz
 * settings page (admin_calibration.js). Extracted into its own module so both
 * callers run the exact same measurement procedure — if they drifted apart,
 * an admin-configured ceiling wouldn't reliably correspond to what a
 * student's own calibration measures on comparable hardware.
 *
 * This module only runs the on-screen sequence and calls
 * GazeTracker.captureCalibrationPoint() for each point; it does NOT decide
 * what happens with the result (a student attempt uses it in place, the
 * admin helper reads it back out and adds a leeway margin) — see run()'s
 * returned summary and GazeTracker.getCalibratedThresholds().
 *
 * @module     quizaccess_proctor/gaze_calibration_ui
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
define([], function () {

    /**
     * The 5 calibration points: screen center plus the 4 edges. Looking at
     * the actual edges of the screen (not a fixed small angle) is what lets
     * GazeTracker derive thresholds personalized to this student's screen
     * size and distance from it, instead of one fixed angle that's only
     * correct for one specific setup. Positions leave a small margin from
     * the true viewport edge (dots exactly at 0%/100% are easy to clip on
     * some displays/OS taskbars).
     */
    var CALIBRATION_POINTS = [
        { id: 'center', label: 'Look at the dot in the CENTER of your screen', left: '50%', top: '50%' },
        { id: 'right', label: 'Look at the dot on the RIGHT edge of your screen', left: '94%', top: '50%' },
        { id: 'left', label: 'Look at the dot on the LEFT edge of your screen', left: '6%', top: '50%' },
        { id: 'up', label: 'Look at the dot near the TOP of your screen', left: '50%', top: '10%' },
        { id: 'down', label: 'Look at the dot near the BOTTOM of your screen', left: '50%', top: '90%' }
    ];

    /** @type {number} Consecutive stable ~100ms polls required before the "start" button is enabled. */
    var MIN_STABLE_FRAMES = 15; // ~1.5s

    /** @type {number} Pause after moving the dot, before checking for a stable hold, to give reaction time. */
    var REACTION_DELAY_MS = 800;

    /** @type {number} Consecutive stable ~100ms polls required before capturing a point. */
    var HOLD_FRAMES = 8; // ~800ms

    /**
     * After this many milliseconds of waiting without success, the status
     * message switches from the plain instruction to an actionable hint. A
     * silent indefinite wait with no diagnostic was the actual bug reported
     * here — this doesn't fix camera/lighting problems, but it stops them
     * from looking indistinguishable from the page being frozen.
     *
     * @type {number}
     */
    var HINT_AFTER_MS = 6000;

    /** @type {number} Milliseconds of waiting before the hint escalates to explicitly mention Cancel. */
    var ESCALATE_AFTER_MS = 18000;

    function sleep(ms) {
        return new Promise(function (resolveSleep) {
            setTimeout(resolveSleep, ms);
        });
    }

    /**
     * Thrown internally when the user clicks Cancel; caught by run() so it
     * can clean up and resolve to null rather than surfacing as a crash.
     */
    function CalibrationCancelledError() {
        this.name = 'CalibrationCancelledError';
        this.message = 'Calibration cancelled by user.';
    }
    CalibrationCancelledError.prototype = Object.create(Error.prototype);

    /**
     * Run the full-screen 5-point gaze calibration sequence: shows an
     * overlay, moves a dot through the center and all 4 screen edges, and
     * captures a GazeTracker calibration point at each after a stability
     * hold. Calls GazeTracker.beginCalibration() at the start and
     * GazeTracker.finishCalibration() at the end.
     *
     * @param {Object} GazeTracker The gaze_tracker module instance (already init()'d).
     * @param {HTMLVideoElement} videoEl Live webcam video element to analyze throughout.
     * @param {Object} [options]
     * @param {string} [options.title] Overlay heading text.
     * @param {string} [options.completionText] Message shown briefly once all points are captured.
     * @returns {Promise<Object|null>} The finishCalibration() summary
     *   ({ baseline, yawLeft, yawRight, pitchUp, pitchDown }), or null if the
     *   user cancelled before it completed.
     */
    async function run(GazeTracker, videoEl, options) {
        options = options || {};
        var title = options.title || 'Gaze Tracking Calibration';
        var completionText = options.completionText || 'Calibration complete!';

        var overlay = document.createElement('div');
        overlay.className = 'proctor-calibration-overlay';
        overlay.innerHTML = '' +
            '<div class="proctor-calibration-container">' +
                '<h2>' + title + '</h2>' +
                '<p class="proctor-calibration-instruction">Please sit comfortably and look at the camera.</p>' +
                '<div class="proctor-calibration-preview"></div>' +
                '<button type="button" class="proctor-calibration-btn btn btn-primary" disabled>Hold still…</button>' +
                '<p class="proctor-calibration-status"></p>' +
                '<button type="button" class="proctor-calibration-cancel-btn btn btn-link">Cancel</button>' +
            '</div>' +
            '<div class="proctor-calibration-dot"></div>';
        document.body.appendChild(overlay);

        var btn = overlay.querySelector('.proctor-calibration-btn');
        var cancelBtn = overlay.querySelector('.proctor-calibration-cancel-btn');
        var dot = overlay.querySelector('.proctor-calibration-dot');
        var instructionEl = overlay.querySelector('.proctor-calibration-instruction');
        var statusEl = overlay.querySelector('.proctor-calibration-status');
        var previewSlot = overlay.querySelector('.proctor-calibration-preview');

        // Temporarily move the live video feed into the overlay itself so it
        // stays visibly on-screen for the whole sequence, instead of being
        // covered by this overlay's own backdrop. Reparenting a playing
        // <video> preserves its stream/playback state in every modern
        // browser — this is NOT a cosmetic-only fix: some browsers (notably
        // Safari) can stop reliably feeding WebGL/TF.js texture reads from a
        // <video> element once it's effectively hidden behind opaque
        // content, which silently starves face detection of real frames
        // with no error ever thrown — exactly the "stuck with no face ever
        // detected, no console errors" symptom this is meant to fix.
        var originalParent = videoEl.parentNode;
        var originalNextSibling = videoEl.nextSibling;
        var hadPreviewClass = videoEl.classList.contains('proctor-calibration-preview-video');
        videoEl.classList.add('proctor-calibration-preview-video');
        previewSlot.appendChild(videoEl);

        // Reparenting a <video> whose srcObject is a live camera MediaStream
        // can silently pause playback in some browsers (notably Safari) —
        // no error fires, the video just stops advancing frames. analyze()
        // checks videoEl.paused and quietly no-ops per frame when true (so a
        // brief real pause doesn't spam errors), which from the outside is
        // indistinguishable from "no face ever detected": zero detections,
        // zero console errors. Defensively resume playback right after the
        // move, and again if it's ever found paused during the loop below.
        videoEl.play().catch(function (err) {
            console.warn('[Proctor GazeCalibrationUI] Could not resume video after reparenting:', err);
        });

        var running = true;
        var cancelled = false;

        cancelBtn.addEventListener('click', function () {
            cancelled = true;
        });

        // Keep GazeTracker's EMA fed throughout the whole sequence.
        async function analyzeLoop() {
            while (running) {
                if (videoEl.paused && !videoEl.ended) {
                    videoEl.play().catch(function () {
                        // Ignore — will simply retry on the next tick.
                    });
                }
                await GazeTracker.analyze(videoEl);
                await sleep(100);
            }
        }
        analyzeLoop();

        /**
         * Wait until the face has been detected continuously for minFrames
         * consecutive ~100ms polls; any dropout resets the count. Used both
         * for the initial "ready" gate and for each calibration point's hold
         * period, so a brief detection dropout (blink, glare) doesn't
         * capture a garbage sample.
         *
         * Surfaces a progressively more actionable status message the longer
         * it takes (see HINT_AFTER_MS/ESCALATE_AFTER_MS) instead of silently
         * waiting forever, and bails out via CalibrationCancelledError if the
         * user clicks Cancel.
         *
         * @param {number} minFrames Consecutive stable frames required.
         * @param {string} baseMessage Status text to show before the hint kicks in.
         * @returns {Promise<void>}
         */
        async function waitForStableFace(minFrames, baseMessage) {
            var count = 0;
            var waitedMs = 0;
            var escalated = false;

            while (count < minFrames) {
                if (cancelled) {
                    throw new CalibrationCancelledError();
                }

                await sleep(100);
                waitedMs += 100;
                count = GazeTracker.getState().faceDetected ? count + 1 : 0;

                if (waitedMs >= ESCALATE_AFTER_MS && !escalated) {
                    escalated = true;
                    statusEl.textContent = 'Still no face detected after ' + Math.round(waitedMs / 1000) +
                        's. Check that your browser has camera permission, the correct camera is selected, ' +
                        'and you\'re well-lit and facing the camera — or click Cancel below.';
                } else if (waitedMs >= HINT_AFTER_MS && !escalated) {
                    statusEl.textContent = baseMessage +
                        ' (Taking longer than expected — make sure your face is centered and well-lit.)';
                }
            }
        }

        try {
            // Phase 1: wait for a stable face before anything else.
            // Calibrating before the EMA has settled bakes a skewed baseline
            // into every subsequent reading.
            var readyMessage = 'Position yourself so your face is visible…';
            statusEl.textContent = readyMessage;
            await waitForStableFace(MIN_STABLE_FRAMES, readyMessage);
            btn.disabled = false;
            btn.textContent = 'Start Calibration';
            statusEl.textContent = 'Face detected. Ready to calibrate.';

            await new Promise(function (resolveClick) {
                btn.addEventListener('click', resolveClick, { once: true });
                cancelBtn.addEventListener('click', resolveClick, { once: true });
            });
            if (cancelled) {
                throw new CalibrationCancelledError();
            }
            btn.style.display = 'none';

            GazeTracker.beginCalibration();

            // Phase 2: sequence through each point — move the dot, give a
            // moment to react, require a short stable hold, then capture.
            // One retry if the face wasn't detected at capture time (e.g.
            // mid-blink) rather than silently skipping the point.
            for (var i = 0; i < CALIBRATION_POINTS.length; i++) {
                var point = CALIBRATION_POINTS[i];
                dot.style.left = point.left;
                dot.style.top = point.top;
                instructionEl.textContent = point.label;
                var holdMessage = 'Move your eyes there and hold still…';
                statusEl.textContent = holdMessage;

                await sleep(REACTION_DELAY_MS);
                await waitForStableFace(HOLD_FRAMES, holdMessage);

                var captured = GazeTracker.captureCalibrationPoint(point.id);
                if (!captured) {
                    var retryMessage = 'Lost face — hold still, retrying…';
                    statusEl.textContent = retryMessage;
                    await waitForStableFace(HOLD_FRAMES, retryMessage);
                    captured = GazeTracker.captureCalibrationPoint(point.id);
                }
                statusEl.textContent = captured ? 'Captured.' : 'Skipped (no face detected).';
            }

            var summary = GazeTracker.finishCalibration();
            instructionEl.textContent = completionText;
            statusEl.textContent = '';
            running = false;

            await sleep(500);
            return summary;
        } catch (err) {
            if (err instanceof CalibrationCancelledError) {
                return null;
            }
            throw err;
        } finally {
            running = false;

            // Restore the video element to wherever it came from before
            // removing the overlay — the caller (proctoring.js) still owns
            // and reuses this element for the rest of the attempt.
            if (!hadPreviewClass) {
                videoEl.classList.remove('proctor-calibration-preview-video');
            }
            if (originalParent) {
                originalParent.insertBefore(videoEl, originalNextSibling);
            }

            if (overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
        }
    }

    return {
        run: run
    };
});
