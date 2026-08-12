/**
 * Gaze tracking module — client-side head pose + iris tracking using MediaPipe FaceMesh.
 *
 * Uses @tensorflow-models/face-landmarks-detection with the MediaPipe FaceMesh
 * model (478 3D landmarks + 10 iris landmarks) to detect when a student is
 * looking away from the screen during proctored quiz attempts.
 *
 * Key design decisions:
 * - Standalone module: decoupled from face detection, follows object_detector.js pattern.
 * - Two-layer gaze estimation: head pose (yaw/pitch/roll from facial landmarks)
 *   fused with iris offset (from dedicated iris landmarks 468-477).
 * - Persistence-based alerting: gaze must be off-screen for N consecutive
 *   detection cycles before flagging a violation.
 * - EMA smoothing: reduces landmark noise and prevents jitter from causing
 *   false positives.
 * - Calibration-free: uses angular thresholds, not screen coordinate mapping.
 * - Graceful degradation: if FaceMesh fails to load, proctoring continues
 *   without gaze tracking.
 *
 * @module     quizaccess_proctor/gaze_tracker
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
define([], function () {

    // -------------------------------------------------------------------------
    // State variables
    // -------------------------------------------------------------------------

    /** @type {Object|null} MediaPipe FaceMesh detector instance. */
    let detector = null;

    /** @type {boolean} Whether the FaceMesh model loaded successfully. */
    let modelLoaded = false;

    /** @type {boolean} Whether the model is currently loading. */
    let isLoading = false;

    /** @type {Object} Configuration passed from the proctoring engine. */
    let config = {};

    /** @type {Object} Calibration baseline to offset raw angles (Zero-baseline). */
    let calibrationBaseline = {
        yaw: 0,
        pitch: 0
    };

    /** @type {number} Consecutive frames where gaze was detected as off-screen. */
    let violationCounter = 0;

    // -------------------------------------------------------------------------
    // EMA (Exponential Moving Average) smoothing state
    // -------------------------------------------------------------------------

    /** @type {Object} EMA-smoothed values for effective yaw, pitch, and roll. */
    let smoothed = {
        yaw: 0,
        pitch: 0,
        roll: 0
    };

    /** @type {boolean} Whether we have a previous smoothed value (first frame skip). */
    let hasSmoothedBaseline = false;

    // -------------------------------------------------------------------------
    // Current gaze state
    // -------------------------------------------------------------------------

    /** @type {Object} Current gaze detection state for UI updates and reporting. */
    let currentState = {
        /** @type {boolean} Whether a confirmed gaze violation is active. */
        isViolation: false,
        /** @type {string} Gaze direction: 'center', 'left', 'right', 'up', 'down'. */
        direction: 'center',
        /** @type {number} Effective yaw angle in degrees. */
        yaw: 0,
        /** @type {number} Effective pitch angle in degrees. */
        pitch: 0,
        /** @type {number} Head roll angle in degrees. */
        roll: 0,
        /** @type {number} Horizontal iris offset (-1 to 1). */
        irisOffsetX: 0,
        /** @type {number} Vertical iris offset (-1 to 1). */
        irisOffsetY: 0,
        /** @type {boolean} Whether eyes are open. */
        eyesOpen: true,
        /** @type {boolean} Whether a face was detected in this frame. */
        faceDetected: false,
        /** @type {number} Current violation counter value. */
        violationCount: 0
    };

    // -------------------------------------------------------------------------
    // Constants — MediaPipe 478-point mesh landmark indices
    // -------------------------------------------------------------------------

    /**
     * Key landmark indices from the MediaPipe 478-point face mesh
     * used for head pose estimation.
     */
    const LANDMARKS = {
        NOSE_TIP: 1,
        CHIN: 152,
        LEFT_EYE_OUTER: 33,
        RIGHT_EYE_OUTER: 263,
        LEFT_MOUTH: 61,
        RIGHT_MOUTH: 291,
        FOREHEAD: 10,

        // Iris landmarks (only available with refineLandmarks: true)
        LEFT_IRIS_CENTER: 468,
        LEFT_IRIS_RIGHT: 469,
        LEFT_IRIS_TOP: 470,
        LEFT_IRIS_LEFT: 471,
        LEFT_IRIS_BOTTOM: 472,
        RIGHT_IRIS_CENTER: 473,
        RIGHT_IRIS_RIGHT: 474,
        RIGHT_IRIS_TOP: 475,
        RIGHT_IRIS_LEFT: 476,
        RIGHT_IRIS_BOTTOM: 477
    };

    /**
     * Left eye contour landmark indices for EAR (Eye Aspect Ratio) calculation.
     * These outline the left eye opening.
     */
    const LEFT_EYE = {
        OUTER: 33,
        INNER: 133,
        UPPER_1: 159,
        UPPER_2: 158,
        LOWER_1: 145,
        LOWER_2: 153
    };

    /**
     * Right eye contour landmark indices for EAR calculation.
     */
    const RIGHT_EYE = {
        OUTER: 263,
        INNER: 362,
        UPPER_1: 386,
        UPPER_2: 385,
        LOWER_1: 374,
        LOWER_2: 380
    };

    /**
     * 36-point Stable Anchor indices — rigid bone structure landmarks
     * (jawline, forehead, nose bridge) that do NOT deform when the user
     * blinks, speaks, or moves their eyes.
     *
     * Averaging these produces a jitter-free face center that is far more
     * stable than using just two eye corner points.
     *
     * Reference: Xiao et al. (2018) — "Robust and Accurate Gaze Estimation"
     */
    const STABLE_ANCHOR_INDICES = [
        // Jawline contour (outer face boundary)
        10, 338, 297, 332, 284, 251, 389, 356, 454, 323,
        361, 288, 397, 365, 379, 378, 400, 377, 152, 148,
        176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
        162, 21, 54, 103, 67, 109
    ];

    // -------------------------------------------------------------------------
    // Default configuration values
    // -------------------------------------------------------------------------

    /** @type {number} Yaw threshold in degrees — looking left/right beyond this is a violation. */
    const DEFAULT_YAW_THRESHOLD = 3;

    /** @type {number} Pitch-up threshold in degrees — looking up beyond this is a violation. */
    const DEFAULT_PITCH_UP_THRESHOLD = 3;

    /** @type {number} Pitch-down threshold — more lenient to allow keyboard glances. */
    const DEFAULT_PITCH_DOWN_THRESHOLD = 2;

    /** @type {number} How many consecutive violation frames before flagging. */
    const DEFAULT_PERSISTENCE_THRESHOLD = 2;

    /** @type {number} EMA smoothing factor (0-1). Higher = more reactive, lower = smoother. */
    const DEFAULT_EMA_ALPHA = 0.6;

    /** @type {number} EAR threshold below which eyes are considered closed. */
    const EAR_THRESHOLD = 0.2;

    /** @type {number} Scale factor converting iris offset ratio to approximate angle. */
    const IRIS_TO_ANGLE_SCALE = 30;

    /**
     * Iris-only threshold: if the normalized iris offset exceeds this value,
     * the user is looking away with their eyes alone (head still).
     * Range is roughly -1.5 to 1.5; 0.15 catches clear sideways glances.
     */
    const IRIS_ONLY_THRESHOLD = 0.15;

    /**
     * EMA fast-path multiplier: if the raw angle exceeds the violation
     * threshold by this factor, skip EMA smoothing and use the raw value
     * directly.  Prevents the EMA from masking obvious look-aways.
     */
    const EMA_BYPASS_FACTOR = 1.8;

    // -------------------------------------------------------------------------
    // Utility functions
    // -------------------------------------------------------------------------

    /**
     * Calculate the Euclidean distance between two 2D points.
     *
     * @param {Object} a Point with x, y properties.
     * @param {Object} b Point with x, y properties.
     * @returns {number} Distance.
     */
    function dist(a, b) {
        return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
    }

    /**
     * Calculate the Euclidean distance between two 3D points.
     *
     * @param {Object} a Point with x, y, z properties.
     * @param {Object} b Point with x, y, z properties.
     * @returns {number} 3D distance.
     */
    function dist3D(a, b) {
        var dx = a.x - b.x;
        var dy = a.y - b.y;
        var dz = (a.z || 0) - (b.z || 0);
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    /**
     * Clamp a value between min and max.
     *
     * @param {number} val Value to clamp.
     * @param {number} min Minimum bound.
     * @param {number} max Maximum bound.
     * @returns {number} Clamped value.
     */
    function clamp(val, min, max) {
        return Math.max(min, Math.min(max, val));
    }

    /**
     * Convert radians to degrees.
     *
     * @param {number} rad Angle in radians.
     * @returns {number} Angle in degrees.
     */
    function toDeg(rad) {
        return rad * (180 / Math.PI);
    }

    /**
     * Apply exponential moving average smoothing.
     *
     * @param {number} current Current raw value.
     * @param {number} previous Previous smoothed value.
     * @param {number} alpha Smoothing factor (0-1).
     * @returns {number} Smoothed value.
     */
    function ema(current, previous, alpha) {
        return alpha * current + (1 - alpha) * previous;
    }

    // -------------------------------------------------------------------------
    // Stable Anchor Point Calculation
    // -------------------------------------------------------------------------

    /**
     * Compute a jitter-free face center by averaging 36 structurally rigid
     * landmarks (jawline, forehead, nose bridge).
     *
     * These landmarks sit on bone structure and do NOT deform when the user
     * blinks, speaks, or moves their eyes — producing a stable reference
     * point that is immune to the pixel-level jitter that plagues individual
     * landmark-based approaches.
     *
     * @param {Array<Object>} keypoints Full 478-point keypoints array.
     * @returns {Object} { x, y, z } averaged stable center.
     */
    function computeStableCenter(keypoints) {
        var sumX = 0, sumY = 0, sumZ = 0;
        var count = STABLE_ANCHOR_INDICES.length;

        for (var i = 0; i < count; i++) {
            var pt = keypoints[STABLE_ANCHOR_INDICES[i]];
            sumX += pt.x;
            sumY += pt.y;
            sumZ += (pt.z || 0);
        }

        return {
            x: sumX / count,
            y: sumY / count,
            z: sumZ / count
        };
    }

    /**
     * Calculate head pose (yaw, pitch, roll) using a 2D tangent projection solver.
     *
     * This mathematically replicates the 3D behavior by projecting the head
     * movement onto 2D space. It uses the shrinking of the eye distance (cos)
     * and the horizontal movement of the nose (sin) to compute tan(yaw),
     * rendering it completely immune to MediaPipe's corrupted Z-depth scaling.
     *
     * @param {Array<Object>} keypoints Array of 478 {x, y, z} keypoints.
     * @returns {Object} { yaw, pitch, roll } in degrees.
     */
    function estimateHeadPose(keypoints) {
        var leftEyeOuter = keypoints[LANDMARKS.LEFT_EYE_OUTER];
        var rightEyeOuter = keypoints[LANDMARKS.RIGHT_EYE_OUTER];
        var noseTip = keypoints[LANDMARKS.NOSE_TIP];
        var chin = keypoints[LANDMARKS.CHIN];

        // --- Yaw (Horizontal Turn) ---
        var eyeMidX = (leftEyeOuter.x + rightEyeOuter.x) / 2;
        var noseOffsetX = noseTip.x - eyeMidX;
        var eyeDistX = Math.abs(rightEyeOuter.x - leftEyeOuter.x);

        if (eyeDistX < 0.0001) {
            return { yaw: 0, pitch: 0, roll: 0 };
        }

        // noseOffsetX is proportional to sin(yaw).
        // eyeDistX is proportional to cos(yaw).
        // Therefore, noseOffsetX / eyeDistX is proportional to tan(yaw).
        // The constant 0.4 represents the anatomical ratio of nose protrusion to eye distance.
        // We lowered this from 0.7 to 0.4 to make it much more sensitive to head turns.
        var yawRatio = (noseOffsetX / eyeDistX) / 0.4;
        var yaw = toDeg(Math.atan(yawRatio));

        // --- Pitch (Vertical Tilt) ---
        var eyeMidY = (leftEyeOuter.y + rightEyeOuter.y) / 2;
        var faceHeight = chin.y - eyeMidY;

        if (faceHeight < 0.0001) {
            return { yaw: yaw, pitch: 0, roll: 0 };
        }

        var noseToEye = noseTip.y - eyeMidY;
        var noseRatio = noseToEye / faceHeight;

        // Anatomical baseline: nose is usually at ~40% of the distance from eyes to chin.
        var normalNoseRatio = 0.4;

        // Multiply by 300 to map ratio deviation to degrees (empirical scale factor).
        // Increased from 200 to 300 to make vertical tilt more sensitive.
        var pitch = (noseRatio - normalNoseRatio) * 300;

        // --- Roll ---
        var dx = rightEyeOuter.x - leftEyeOuter.x;
        var dy = rightEyeOuter.y - leftEyeOuter.y;
        var roll = toDeg(Math.atan2(dy, dx));

        return {
            yaw: yaw,
            pitch: pitch,
            roll: roll
        };
    }

    // -------------------------------------------------------------------------
    // Eye Aspect Ratio (Blink Detection)
    // -------------------------------------------------------------------------

    /**
     * Calculate the Eye Aspect Ratio (EAR) for blink/closure detection.
     *
     * EAR = (|upper1 - lower1| + |upper2 - lower2|) / (2 * |outer - inner|)
     *
     * When eyes are open, EAR is typically 0.25-0.40.
     * When eyes are closed/blinking, EAR drops below ~0.2.
     *
     * @param {Array<Object>} keypoints Full 478-point keypoints array.
     * @param {Object} eyeIndices Object with OUTER, INNER, UPPER_1, UPPER_2, LOWER_1, LOWER_2.
     * @returns {number} EAR value.
     */
    function calculateEAR(keypoints, eyeIndices) {
        var outer = keypoints[eyeIndices.OUTER];
        var inner = keypoints[eyeIndices.INNER];
        var upper1 = keypoints[eyeIndices.UPPER_1];
        var upper2 = keypoints[eyeIndices.UPPER_2];
        var lower1 = keypoints[eyeIndices.LOWER_1];
        var lower2 = keypoints[eyeIndices.LOWER_2];

        var eyeWidth = dist(outer, inner);
        if (eyeWidth < 0.0001) {
            return 0.3; // Default open-eye value to avoid false blink detection.
        }

        var v1 = dist(upper1, lower1);
        var v2 = dist(upper2, lower2);

        return (v1 + v2) / (2 * eyeWidth);
    }

    // -------------------------------------------------------------------------
    // Iris Offset Calculation
    // -------------------------------------------------------------------------

    /**
     * Calculate how far the iris/pupil center has moved from the eye socket center.
     *
     * Uses the 36-point stable anchor center as a secondary reference for
     * the horizontal offset, which eliminates the jitter caused by using
     * only 2 eye corner landmarks (which deform during blinks).
     *
     * Returns a normalized offset where:
     * - x: -1 = fully looking left, 0 = center, +1 = fully looking right
     * - y: -1 = fully looking up, 0 = center, +1 = fully looking down
     *
     * @param {Array<Object>} keypoints Full 478-point keypoints array.
     * @param {Object} stableCenter The 36-point stable anchor center.
     * @returns {Object} { x, y } normalized iris offset, or null if iris not available.
     */
    function calculateIrisOffset(keypoints, stableCenter) {
        // Verify iris landmarks exist (indices 468-477).
        if (keypoints.length < 478) {
            return null;
        }

        // Left eye iris.
        var leftIrisCenter = keypoints[LANDMARKS.LEFT_IRIS_CENTER];
        var leftEyeOuter = keypoints[LEFT_EYE.OUTER];
        var leftEyeInner = keypoints[LEFT_EYE.INNER];
        var leftEyeUpper = keypoints[LEFT_EYE.UPPER_1];
        var leftEyeLower = keypoints[LEFT_EYE.LOWER_1];

        // Use the midpoint of outer+inner for eye socket center (per-eye),
        // but stabilize the overall reference with the anchor center.
        var leftEyeCenterX = (leftEyeOuter.x + leftEyeInner.x) / 2;
        var leftEyeCenterY = (leftEyeUpper.y + leftEyeLower.y) / 2;
        var leftEyeWidth = dist(leftEyeOuter, leftEyeInner);
        var leftEyeHeight = dist(leftEyeUpper, leftEyeLower);

        // Right eye iris.
        var rightIrisCenter = keypoints[LANDMARKS.RIGHT_IRIS_CENTER];
        var rightEyeOuter = keypoints[RIGHT_EYE.OUTER];
        var rightEyeInner = keypoints[RIGHT_EYE.INNER];
        var rightEyeUpper = keypoints[RIGHT_EYE.UPPER_1];
        var rightEyeLower = keypoints[RIGHT_EYE.LOWER_1];

        var rightEyeCenterX = (rightEyeOuter.x + rightEyeInner.x) / 2;
        var rightEyeCenterY = (rightEyeUpper.y + rightEyeLower.y) / 2;
        var rightEyeWidth = dist(rightEyeOuter, rightEyeInner);
        var rightEyeHeight = dist(rightEyeUpper, rightEyeLower);

        // Compute a stable face width from the anchor bounding extent.
        // This uses multiple points instead of just 2, reducing jitter.
        var minX = Infinity, maxX = -Infinity;
        for (var i = 0; i < STABLE_ANCHOR_INDICES.length; i++) {
            var px = keypoints[STABLE_ANCHOR_INDICES[i]].x;
            if (px < minX) { minX = px; }
            if (px > maxX) { maxX = px; }
        }
        var stableFaceWidth = maxX - minX;

        // Avoid division by zero.
        if (stableFaceWidth < 0.0001 || leftEyeHeight < 0.0001 || rightEyeHeight < 0.0001) {
            return null;
        }

        // Calculate normalized offset for each eye.
        // Horizontal: use per-eye socket center for accuracy.
        // Vertical: use per-eye upper/lower for accuracy.
        var leftOffsetX = (leftIrisCenter.x - leftEyeCenterX) / (leftEyeWidth > 0.0001 ? leftEyeWidth / 2 : stableFaceWidth / 4);
        var leftOffsetY = (leftIrisCenter.y - leftEyeCenterY) / (leftEyeHeight / 2);

        var rightOffsetX = (rightIrisCenter.x - rightEyeCenterX) / (rightEyeWidth > 0.0001 ? rightEyeWidth / 2 : stableFaceWidth / 4);
        var rightOffsetY = (rightIrisCenter.y - rightEyeCenterY) / (rightEyeHeight / 2);

        // Clamp individual offsets to prevent outlier spikes from jittery landmarks.
        leftOffsetX = clamp(leftOffsetX, -1.5, 1.5);
        leftOffsetY = clamp(leftOffsetY, -1.5, 1.5);
        rightOffsetX = clamp(rightOffsetX, -1.5, 1.5);
        rightOffsetY = clamp(rightOffsetY, -1.5, 1.5);

        // Average both eyes for robustness.
        return {
            x: (leftOffsetX + rightOffsetX) / 2,
            y: (leftOffsetY + rightOffsetY) / 2
        };
    }

    // -------------------------------------------------------------------------
    // Dual-Signal Gaze Detection
    // -------------------------------------------------------------------------

    /**
     * Gaze detection uses a dual-signal approach evaluated directly in analyze():
     *
     * Signal A (Head Pose): yaw/pitch from facial landmark geometry.
     * Signal B (Iris Offset): normalized iris displacement within the eye socket.
     * Signal C (Combined): additive head + iris for co-directional gaze.
     *
     * A violation is triggered if ANY signal independently exceeds its threshold.
     * This prevents the vestibulo-ocular reflex (VOR) from cancelling head and
     * iris signals when the user turns their head but eyes compensate.

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Initialize the gaze tracker by loading the MediaPipe FaceMesh model.
     *
     * @param {Object} cfg Configuration object.
     * @param {string} cfg.faceMeshDetectorModelUrl URL to self-hosted face detector model.json.
     * @param {string} cfg.faceMeshLandmarkModelUrl URL to self-hosted attention_mesh model.json.
     * @param {number} [cfg.gazeYawThreshold=30] Yaw threshold in degrees.
     * @param {number} [cfg.gazePitchUpThreshold=20] Pitch-up threshold in degrees.
     * @param {number} [cfg.gazePitchDownThreshold=15] Pitch-down threshold in degrees.
     * @param {number} [cfg.gazePersistenceThreshold=3] Consecutive violation frames.
     * @param {number} [cfg.gazeEmaAlpha=0.4] EMA smoothing factor.
     * @returns {Promise<boolean>} Whether the model loaded successfully.
     */
    async function init(cfg) {
        config = cfg;

        if (isLoading || modelLoaded) {
            return modelLoaded;
        }

        isLoading = true;

        try {
            // Verify TensorFlow.js is available.
            if (typeof tf === 'undefined') {
                throw new Error('TensorFlow.js not loaded');
            }
            // Verify face-landmarks-detection library is available.
            if (typeof faceLandmarksDetection === 'undefined') {
                throw new Error('face-landmarks-detection library not loaded');
            }

            // Ensure TF.js backend is ready.
            await tf.ready();
            console.log('[Proctor GazeTracker] TF.js backend:', tf.getBackend());

            // Create the MediaPipe FaceMesh detector with iris refinement.
            var detectorConfig = {
                runtime: 'tfjs',
                refineLandmarks: true,
                maxFaces: 1,
                landmarkModelUrl: config.faceMeshLandmarkModelUrl,
                detectorModelUrl: config.faceMeshDetectorModelUrl
            };

            detector = await faceLandmarksDetection.createDetector(
                faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
                detectorConfig
            );

            modelLoaded = true;
            isLoading = false;
            console.log('[Proctor GazeTracker] MediaPipe FaceMesh model loaded (478 landmarks + iris)');
            return true;

        } catch (err) {
            console.error('[Proctor GazeTracker] Failed to load FaceMesh model:', err);
            modelLoaded = false;
            isLoading = false;
            return false;
        }
    }

    /**
     * Run a single gaze analysis cycle on the given video element.
     *
     * Performs FaceMesh inference → head pose estimation → iris offset
     * → gaze fusion → persistence filtering → result.
     *
     * @param {HTMLVideoElement} videoEl The webcam video element.
     * @returns {Promise<Object>} Gaze detection result.
     */
    async function analyze(videoEl) {
        if (!modelLoaded || !detector) {
            return currentState;
        }

        if (!videoEl || videoEl.paused || videoEl.ended || !videoEl.videoWidth) {
            return currentState;
        }

        try {
            // Run MediaPipe FaceMesh inference.
            var faces = await detector.estimateFaces(videoEl, {
                flipHorizontal: false,
                staticImageMode: false
            });

            if (!faces || faces.length === 0) {
                // No face detected — don't count as violation, just skip.
                currentState.faceDetected = false;
                currentState.isViolation = false;
                violationCounter = 0;
                return currentState;
            }

            var keypoints = faces[0].keypoints;
            currentState.faceDetected = true;

            // Verify we have enough landmarks (478 for iris tracking).
            if (!keypoints || keypoints.length < 468) {
                return currentState;
            }

            // --- Step 1: Check if eyes are open (EAR) ---
            var leftEAR = calculateEAR(keypoints, LEFT_EYE);
            var rightEAR = calculateEAR(keypoints, RIGHT_EYE);
            var avgEAR = (leftEAR + rightEAR) / 2;

            currentState.eyesOpen = avgEAR >= EAR_THRESHOLD;

            // We no longer return early when eyes are closed. Head pose tracking
            // is still valid even if eyes are closed (e.g., looking down at keyboard).
            // We just skip the iris tracking step below.

            // --- Step 2: Head pose estimation ---
            var headPose = estimateHeadPose(keypoints);

            // --- Step 3: Stable anchor center + Iris offset ---
            var stableCenter = computeStableCenter(keypoints);
            var irisOffset = null;
            // Only calculate iris offset if eyes are open. If closed, the landmarks
            // deform and provide garbage data for iris tracking.
            if (currentState.eyesOpen && keypoints.length >= 478) {
                irisOffset = calculateIrisOffset(keypoints, stableCenter);
            }

            // --- Step 4: Dual-signal processing ---
            // Head pose angles (calibration-corrected later).
            var headYaw = headPose.yaw;
            var headPitch = headPose.pitch;

            // Iris angles (converted from normalized offset to degrees).
            var irisYaw = 0;
            var irisPitch = 0;
            var rawIrisX = 0;
            var rawIrisY = 0;
            if (irisOffset) {
                rawIrisX = irisOffset.x;
                rawIrisY = irisOffset.y;
                irisYaw = irisOffset.x * IRIS_TO_ANGLE_SCALE;
                irisPitch = irisOffset.y * IRIS_TO_ANGLE_SCALE;
            }

            // --- Step 5: EMA smoothing with fast-path bypass ---
            var alpha = config.gazeEmaAlpha || DEFAULT_EMA_ALPHA;
            var yawThreshold = config.gazeYawThreshold || DEFAULT_YAW_THRESHOLD;
            var pitchUpThreshold = config.gazePitchUpThreshold || DEFAULT_PITCH_UP_THRESHOLD;
            var pitchDownThreshold = config.gazePitchDownThreshold || DEFAULT_PITCH_DOWN_THRESHOLD;

            if (!hasSmoothedBaseline) {
                smoothed.yaw = headYaw;
                smoothed.pitch = headPitch;
                smoothed.roll = headPose.roll;
                hasSmoothedBaseline = true;
            } else {
                // Fast-path bypass: if the raw head angle is far beyond the
                // threshold, use it directly instead of slowly ramping via EMA.
                // This prevents the EMA from masking obvious head turns.
                var bypassYaw = Math.abs(headYaw - calibrationBaseline.yaw) > yawThreshold * EMA_BYPASS_FACTOR;
                var bypassPitch = Math.abs(headPitch - calibrationBaseline.pitch) > Math.max(pitchUpThreshold, pitchDownThreshold) * EMA_BYPASS_FACTOR;

                smoothed.yaw = bypassYaw ? headYaw : ema(headYaw, smoothed.yaw, alpha);
                smoothed.pitch = bypassPitch ? headPitch : ema(headPitch, smoothed.pitch, alpha);
                smoothed.roll = ema(headPose.roll, smoothed.roll, alpha);
            }

            // --- Step 6: Apply Calibration Baseline (head pose only) ---
            var finalHeadYaw = smoothed.yaw - calibrationBaseline.yaw;
            var finalHeadPitch = smoothed.pitch - calibrationBaseline.pitch;

            // --- Step 7: Dual-signal boundary detection ---
            // Evaluate head pose and iris offset INDEPENDENTLY.
            // A violation is triggered if EITHER signal exceeds its threshold.
            // This prevents the vestibulo-ocular reflex (VOR) from cancelling
            // the two signals when head turns but eyes compensate.

            var direction = 'center';
            var isLookingAway = false;

            // --- Signal A: Head pose violation ---
            var headViolation = false;
            var headDirection = 'center';

            if (Math.abs(finalHeadYaw) > yawThreshold) {
                headDirection = finalHeadYaw > 0 ? 'right' : 'left';
                headViolation = true;
            } else if (finalHeadPitch > pitchUpThreshold) {
                headDirection = 'down';
                headViolation = true;
            } else if (finalHeadPitch < -pitchDownThreshold) {
                headDirection = 'up';
                headViolation = true;
            }

            // --- Signal B: Iris-only violation ---
            // Uses normalized iris offset directly (not fused with head).
            // Only triggers when head is roughly centered but eyes look away.
            var irisViolation = false;
            var irisDirection = 'center';

            if (irisOffset) {
                if (Math.abs(rawIrisX) > IRIS_ONLY_THRESHOLD) {
                    irisDirection = rawIrisX > 0 ? 'right' : 'left';
                    irisViolation = true;
                } else if (rawIrisY < -IRIS_ONLY_THRESHOLD) {
                    irisDirection = 'up';
                    irisViolation = true;
                } else if (rawIrisY > IRIS_ONLY_THRESHOLD) {
                    irisDirection = 'down';
                    irisViolation = true;
                }
            }

            // --- Signal C: Combined (additive) — catches co-directional gaze ---
            var combinedYaw = finalHeadYaw + irisYaw;
            var combinedPitch = finalHeadPitch + irisPitch;
            var combinedViolation = false;
            var combinedDirection = 'center';

            if (Math.abs(combinedYaw) > yawThreshold) {
                combinedDirection = combinedYaw > 0 ? 'right' : 'left';
                combinedViolation = true;
            } else if (combinedPitch > pitchUpThreshold) {
                combinedDirection = 'down';
                combinedViolation = true;
            } else if (combinedPitch < -pitchDownThreshold) {
                combinedDirection = 'up';
                combinedViolation = true;
            }

            // Final decision: any signal triggers a violation.
            // Priority: head > iris > combined (for direction label).
            if (headViolation) {
                isLookingAway = true;
                direction = headDirection;
            } else if (irisViolation) {
                isLookingAway = true;
                direction = irisDirection;
            } else if (combinedViolation) {
                isLookingAway = true;
                direction = combinedDirection;
            }

            // Debug log: print signal breakdown roughly every 10 frames.
            if (Math.random() < 0.1) {
                console.log(
                    '[Proctor Debug] HeadYaw: ' + finalHeadYaw.toFixed(1) + '° | ' +
                    'HeadPitch: ' + finalHeadPitch.toFixed(1) + '° | ' +
                    'IrisX: ' + rawIrisX.toFixed(2) + ' | ' +
                    'IrisY: ' + rawIrisY.toFixed(2) + ' | ' +
                    'Head:' + (headViolation ? headDirection : 'ok') + ' | ' +
                    'Iris:' + (irisViolation ? irisDirection : 'ok') + ' | ' +
                    'Combined:' + (combinedViolation ? combinedDirection : 'ok') + ' | ' +
                    'Result: ' + (isLookingAway ? 'VIOLATION (' + direction + ')' : 'OK')
                );
            }

            // --- Step 8: Persistence filter ---
            var persistenceThreshold = config.gazePersistenceThreshold || DEFAULT_PERSISTENCE_THRESHOLD;

            if (isLookingAway) {
                violationCounter++;
            } else {
                violationCounter = 0;
            }

            var isConfirmedViolation = violationCounter >= persistenceThreshold;

            // --- Step 9: Update state ---
            // Report the dominant signal's angle for the final yaw/pitch readout.
            var reportYaw = headViolation ? finalHeadYaw : combinedYaw;
            var reportPitch = headViolation ? finalHeadPitch : combinedPitch;

            currentState = {
                isViolation: isConfirmedViolation,
                direction: isLookingAway ? direction : 'center',
                yaw: Math.round(reportYaw * 10) / 10,
                pitch: Math.round(reportPitch * 10) / 10,
                roll: Math.round(smoothed.roll * 10) / 10,
                irisOffsetX: irisOffset ? Math.round(irisOffset.x * 100) / 100 : 0,
                irisOffsetY: irisOffset ? Math.round(irisOffset.y * 100) / 100 : 0,
                eyesOpen: true,
                faceDetected: true,
                violationCount: violationCounter
            };

            return currentState;

        } catch (err) {
            console.error('[Proctor GazeTracker] Analysis error:', err);
            return currentState;
        }
    }

    /**
     * Get the current gaze detection state.
     *
     * @returns {Object} Current state.
     */
    function getState() {
        return currentState;
    }

    /**
     * Get the current gaze direction as a human-readable string.
     *
     * @returns {string} 'center', 'left', 'right', 'up', or 'down'.
     */
    function getDirection() {
        return currentState.direction;
    }

    /**
     * Check whether the FaceMesh model is loaded and ready.
     *
     * @returns {boolean} True if model is loaded.
     */
    function isReady() {
        return modelLoaded;
    }

    /**
     * Stop the gaze tracker and reset all state.
     * Disposes the FaceMesh model to free GPU memory.
     */
    function stop() {
        violationCounter = 0;
        hasSmoothedBaseline = false;

        smoothed = {
            yaw: 0,
            pitch: 0,
            roll: 0,
            irisX: 0,
            irisY: 0
        };

        currentState = {
            isViolation: false,
            direction: 'center',
            yaw: 0,
            pitch: 0,
            roll: 0,
            irisOffsetX: 0,
            irisOffsetY: 0,
            eyesOpen: true,
            faceDetected: false,
            violationCount: 0
        };

        if (detector) {
            try {
                detector.dispose();
            } catch (e) {
                // Ignore disposal errors.
            }
            detector = null;
        }

        modelLoaded = false;
        isLoading = false;
    }

    /**
     * Format the current gaze state as a compact string for server reporting.
     * Format: "direction,yaw,pitch" e.g. "left,-35.2,5.1"
     *
     * @returns {string} Compact gaze data string.
     */
    function formatForReport() {
        return currentState.direction + ',' +
            currentState.yaw + ',' +
            currentState.pitch;
    }

    /**
     * Set the calibration baseline from current smoothed angles.
     * This effectively zeroes out the current gaze position.
     *
     * @returns {Object} The captured baseline {yaw, pitch}.
     */
    function calibrateCenter() {
        // Only capture the HEAD POSE component as the baseline.
        // Iris offset is inherently zero-centered (looking straight = iris
        // at socket center), so including it in calibration would absorb
        // real iris displacement as "normal" and reduce sensitivity.
        // We re-run head pose estimation on the current smoothed state.
        calibrationBaseline.yaw = smoothed.yaw;
        calibrationBaseline.pitch = smoothed.pitch;
        console.log('[Proctor GazeTracker] Calibration baseline set: yaw=' +
            calibrationBaseline.yaw.toFixed(1) + '° pitch=' +
            calibrationBaseline.pitch.toFixed(1) + '°');
        return calibrationBaseline;
    }

    return {
        init: init,
        analyze: analyze,
        getState: getState,
        getDirection: getDirection,
        isReady: isReady,
        stop: stop,
        formatForReport: formatForReport,
        calibrateCenter: calibrateCenter
    };
});
