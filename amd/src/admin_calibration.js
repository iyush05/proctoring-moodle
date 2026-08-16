/**
 * Camera calibration helper for the quiz settings form — lets an admin/teacher
 * run the same 5-point gaze calibration a student sees at the start of their
 * attempt, and use the result to fill in the four gaze-threshold fields on
 * this form instead of guessing reasonable degree values.
 *
 * These fields are CEILINGS (see gaze_tracker.js and rule.php): a student's
 * own per-attempt calibration may tighten the effective threshold for their
 * setup, but can never exceed what's configured here. Because this single
 * measurement becomes a ceiling shared by every student taking the quiz —
 * not a personal setting tuned to one specific desk/camera — a leeway
 * margin is added on top of the raw measurement so it isn't so tight that
 * students with a slightly different setup false-positive against it.
 *
 * @module     quizaccess_proctor/admin_calibration
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
define(['quizaccess_proctor/gaze_tracker', 'quizaccess_proctor/gaze_calibration_ui'],
    function (GazeTracker, GazeCalibrationUI) {

        /**
         * Extra headroom applied on top of the raw calibration measurement
         * before it's used as a ceiling for every student. A personal
         * per-student calibration (see gaze_tracker.js CALIBRATION_MARGIN)
         * deliberately shrinks toward safety since it's the final value used
         * for that one person; this value does the opposite — it's measured
         * once, by one person (the admin), on one piece of hardware, but has
         * to be a reasonable ceiling for every student's setup, so it should
         * start more generous, not less.
         *
         * @type {number}
         */
        var ADMIN_CEILING_LEEWAY = 1.2;

        /**
         * Wire up the "Run camera calibration" button on the quiz settings form.
         *
         * @param {Object} config
         * @param {string} config.faceMeshDetectorModelUrl Self-hosted FaceMesh detector model.json URL.
         * @param {string} config.faceMeshLandmarkModelUrl Self-hosted FaceMesh landmark model.json URL.
         * @param {Object} config.fieldIds { yawLeft, yawRight, pitchUp, pitchDown } — form input element IDs to fill in.
         * @param {string} config.buttonId Element ID of the "Run calibration" button.
         * @param {string} config.statusId Element ID of the status message paragraph.
         */
        function init(config) {
            var btn = document.getElementById(config.buttonId);
            var statusEl = document.getElementById(config.statusId);

            if (!btn || !statusEl) {
                // Form markup didn't match what we expected — fail quietly
                // rather than throwing, since the manual number fields still
                // work fine without this helper.
                return;
            }

            btn.addEventListener('click', function () {
                runCalibration(config, btn, statusEl).catch(function (err) {
                    console.error('[Proctor AdminCalibration] Failed:', err);
                    statusEl.textContent = 'Calibration failed: ' + (err && err.message ? err.message : err);
                    btn.disabled = false;
                });
            });
        }

        /**
         * Request the webcam, load the FaceMesh model, run the shared 5-point
         * calibration sequence, and fill in the form fields from the result.
         *
         * @param {Object} config See init().
         * @param {HTMLButtonElement} btn The trigger button (disabled while running).
         * @param {HTMLElement} statusEl Status message element.
         * @returns {Promise<void>}
         */
        async function runCalibration(config, btn, statusEl) {
            btn.disabled = true;
            statusEl.textContent = 'Requesting camera access…';

            var stream = await navigator.mediaDevices.getUserMedia({ video: true });

            var videoEl = document.createElement('video');
            videoEl.autoplay = true;
            videoEl.muted = true;
            videoEl.playsInline = true;
            videoEl.width = 240;
            videoEl.style.borderRadius = '8px';
            videoEl.style.marginTop = '0.5rem';
            videoEl.srcObject = stream;
            document.getElementById('proctor-admin-calibration-root').appendChild(videoEl);

            try {
                await new Promise(function (resolve) {
                    videoEl.addEventListener('loadedmetadata', resolve, { once: true });
                });
                await videoEl.play();

                statusEl.textContent = 'Loading gaze tracking model…';
                var ready = await GazeTracker.init(config);
                if (!ready) {
                    throw new Error('Could not load the gaze tracking model.');
                }

                statusEl.textContent = 'Starting calibration…';
                var summary = await GazeCalibrationUI.run(GazeTracker, videoEl, {
                    title: 'Admin Camera Calibration',
                    completionText: 'Calibration complete! Filling in threshold fields…'
                });

                if (!summary) {
                    // User clicked Cancel — leave the existing field values untouched.
                    statusEl.textContent = 'Calibration cancelled.';
                    return;
                }

                applyResults(config, GazeTracker.getCalibratedThresholds(), GazeTracker.getCalibrationBounds(), statusEl);
            } finally {
                GazeTracker.stop();
                stream.getTracks().forEach(function (track) {
                    track.stop();
                });
                videoEl.remove();
                btn.disabled = false;
            }
        }

        /**
         * Apply the leeway margin to each measured threshold, clamp back to
         * the same sane range GazeTracker itself uses, and write the results
         * into the form fields.
         *
         * @param {Object} config See init().
         * @param {Object} thresholds GazeTracker.getCalibratedThresholds() result.
         * @param {Object} bounds GazeTracker.getCalibrationBounds() result.
         * @param {HTMLElement} statusEl Status message element, updated with a summary.
         */
        function applyResults(config, thresholds, bounds, statusEl) {
            var filled = [];
            var missing = [];

            var axes = [
                { key: 'yawLeft', fieldId: config.fieldIds.yawLeft, min: bounds.yawMin, max: bounds.yawMax, label: 'yaw-left' },
                { key: 'yawRight', fieldId: config.fieldIds.yawRight, min: bounds.yawMin, max: bounds.yawMax, label: 'yaw-right' },
                { key: 'pitchUp', fieldId: config.fieldIds.pitchUp, min: bounds.pitchMin, max: bounds.pitchMax, label: 'pitch-up' },
                { key: 'pitchDown', fieldId: config.fieldIds.pitchDown, min: bounds.pitchMin, max: bounds.pitchMax, label: 'pitch-down' }
            ];

            axes.forEach(function (axis) {
                var measured = thresholds[axis.key];
                var input = document.getElementById(axis.fieldId);

                if (measured === null || measured === undefined || !input) {
                    missing.push(axis.label);
                    return;
                }

                var withLeeway = measured * ADMIN_CEILING_LEEWAY;
                var clamped = Math.min(Math.max(withLeeway, axis.min), axis.max);
                input.value = Math.round(clamped);
                filled.push(axis.label + '=' + Math.round(clamped) + '°');
            });

            if (filled.length === 0) {
                statusEl.textContent = 'Calibration did not produce any usable measurements — thresholds unchanged.';
                return;
            }

            var summary = 'Filled in: ' + filled.join(', ') + '.';
            if (missing.length > 0) {
                summary += ' Could not measure: ' + missing.join(', ') + ' (left unchanged).';
            }
            summary += ' Remember to Save this form for the change to take effect.';
            statusEl.textContent = summary;
        }

        return {
            init: init
        };
    });
