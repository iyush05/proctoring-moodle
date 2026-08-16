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
 * - 5-point calibration (center + 4 edges): a single fixed angular threshold
 *   is physically wrong for every user, because the angle needed to look at
 *   the edge of the screen depends on screen size AND distance from it — a
 *   student sitting close to a large screen needs a much wider angle budget
 *   than one sitting far from a small one. Rather than estimate physical
 *   distance directly (would need known camera intrinsics we don't have),
 *   the student looks at the screen's edges once during setup; the angle
 *   actually required is measured directly and used to derive personalized
 *   thresholds. This is the same approach used by webcam eye-tracking
 *   libraries like WebGazer.js.
 * - Live distance compensation: interocular distance in the frame (a proxy
 *   for distance-to-camera) is recorded at calibration time and compared
 *   every frame afterward; thresholds are rescaled proportionally if the
 *   student leans closer/farther after calibrating.
 * - Graceful degradation: if FaceMesh fails to load, proctoring continues
 *   without gaze tracking. If calibration is skipped or incomplete, the
 *   configured/default angular thresholds are used unscaled instead.
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

    /**
     * @type {HTMLCanvasElement|null} Offscreen canvas used to snapshot each
     * video frame before handing it to the detector, instead of passing the
     * <video> element directly. Some browsers (notably Safari) can silently
     * fail to read live pixel data via WebGL directly from a <video> element
     * sourced from a getUserMedia MediaStream — no error is thrown, the
     * detector just keeps seeing a blank/stale frame and reports zero faces
     * forever. Drawing to a canvas first and reading from that instead is
     * the standard, well-established workaround. Created lazily on first use.
     */
    let frameCanvas = null;

    /** @type {CanvasRenderingContext2D|null} 2D context for frameCanvas. */
    let frameCanvasCtx = null;

    /** @type {Object} Calibration baseline to offset raw angles (Zero-baseline, from the 'center' point). */
    let calibrationBaseline = {
        yaw: 0,
        pitch: 0
    };

    /**
     * @type {Object} Raw samples captured per calibration point during setup,
     * keyed by point id ('center'|'left'|'right'|'up'|'down'). Each value is
     * { yaw, pitch, irisX, irisY, eyeDistX } or undefined if never captured.
     */
    let calibrationPoints = {};

    /**
     * @type {Object} Personalized angular thresholds (degrees) derived from
     * calibrationPoints. Null fields fall back to config/DEFAULT_* values.
     * yawLeft/yawRight (like pitchUp/pitchDown) are independent — a shared
     * single yaw threshold averaged from both edges only produces the right
     * number for either side by coincidence when the setup is perfectly
     * symmetric (camera dead-center, no second monitor to one side, etc.).
     */
    let calibratedThresholds = {
        yawLeft: null,
        yawRight: null,
        pitchUp: null,
        pitchDown: null
    };

    /**
     * @type {number|null} Interocular distance (normalized frame units) measured
     * at the 'center' calibration point — the reference for live distance
     * compensation. Null until calibration completes.
     */
    let referenceEyeDist = null;

    /** @type {number} Interocular distance from the most recent analyzed frame. */
    let lastEyeDistX = 0;

    /** @type {number} Consecutive frames where gaze was detected as off-screen. */
    let violationCounter = 0;

    // -------------------------------------------------------------------------
    // EMA (Exponential Moving Average) smoothing state
    // -------------------------------------------------------------------------

    /** @type {Object} EMA-smoothed values for effective yaw, pitch, roll, and iris offset. */
    let smoothed = {
        yaw: 0,
        pitch: 0,
        roll: 0,
        irisX: 0,
        irisY: 0
    };

    /** @type {boolean} Whether we have a previous smoothed head-pose value (first frame skip). */
    let hasSmoothedBaseline = false;

    /** @type {boolean} Whether we have a previous smoothed iris value (first frame skip). */
    let hasIrisBaseline = false;

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

    /**
     * Default thresholds below MUST stay in sync with the PHP-side defaults in
     * rule.php (30 / 20 / 25 / 2). These are only used when the host page fails
     * to pass a config value, or when calibratedThresholds hasn't been set for
     * a given axis — they are a safety net, not the primary source of truth
     * (see the 5-point calibration flow below for the personalized path).
     *
     * A previous "sensitivity" tuning pass shrank these by roughly 10x (e.g.
     * yaw 30 -> 3), which made ordinary head jitter register as a violation on
     * almost every frame. Do not lower these without measuring real
     * false-positive rates first.
     *
     * PERSISTENCE_THRESHOLD and the EMA alphas below are tuned against the
     * detection loop's actual cadence (captureInterval, 2000ms by default —
     * see rule.php). At persistence=2 that's a ~4 second confirmation delay
     * for a sustained look-away, matching the desired responsiveness. If
     * captureInterval is changed, these should be re-tuned together — a
     * 2-frame persistence requirement is far too fast at a 500ms cadence, and
     * far too slow at a 5000ms one.
     */

    /** @type {number} Yaw threshold in degrees — looking left/right beyond this is a violation. */
    const DEFAULT_YAW_THRESHOLD = 30;

    /** @type {number} Pitch-up threshold in degrees — looking up beyond this is a violation. */
    const DEFAULT_PITCH_UP_THRESHOLD = 20;

    /** @type {number} Pitch-down threshold — more lenient to allow keyboard/notes glances. */
    const DEFAULT_PITCH_DOWN_THRESHOLD = 25;

    /** @type {number} How many consecutive violation frames before flagging (~4s at the default 2s capture interval). */
    const DEFAULT_PERSISTENCE_THRESHOLD = 2;

    /**
     * EMA smoothing factor (0-1) for head pose. Higher = more reactive, lower
     * = smoother. Tuned for the ~2s default capture interval: at that cadence
     * consecutive frames are already well-spaced (not high-frequency video
     * jitter), so heavy smoothing mostly just adds detection latency rather
     * than removing noise. Combined with EMA_BYPASS_FACTOR below, a genuine
     * sustained deviation should register within 1 frame.
     *
     * @type {number}
     */
    const DEFAULT_EMA_ALPHA = 0.65;

    /** @type {number} EAR threshold below which eyes are considered closed. */
    const EAR_THRESHOLD = 0.2;

    /**
     * Scale factor converting normalized iris offset (roughly -1..1 within the
     * eye socket) to an approximate angle in degrees. 1.0 of normalized offset
     * corresponds to the eye rotated to about its comfortable limit (~30°)
     * without head movement.
     *
     * @type {number}
     */
    const IRIS_TO_ANGLE_SCALE = 30;

    /**
     * Iris-only threshold: if the normalized iris offset exceeds this value
     * *while the head is roughly centered*, the user is looking away with
     * their eyes alone. This must be well above the offset produced by normal
     * on-screen reading/scanning (empirically ~0.15-0.3 while reading text
     * across a monitor) or every glance at a different part of the question
     * gets flagged, but reachable within a couple of seconds for a deliberate
     * eyes-only glance away (e.g. at a phone in the lap) — 0.35 is the
     * midpoint between those two constraints.
     */
    const IRIS_ONLY_THRESHOLD = 0.35;

    /**
     * EMA smoothing factor for the iris offset signal. Iris landmarks are
     * noisier frame-to-frame than the coarse head-pose landmarks, so the raw
     * offset is smoothed before being used in any violation check — otherwise
     * single-frame landmark jitter can spike past IRIS_ONLY_THRESHOLD. Kept
     * responsive (more so than DEFAULT_EMA_ALPHA, since iris has no bypass
     * mechanism of its own) given the ~2s capture cadence and the ~4s
     * detection target.
     *
     * @type {number}
     */
    const IRIS_EMA_ALPHA = 0.75;

    /**
     * EMA fast-path multiplier: if the raw angle exceeds the violation
     * threshold by this factor, skip EMA smoothing and use the raw value
     * directly. Prevents the EMA from masking obvious look-aways. Kept close
     * to 1 so a clearly-over-threshold reading registers on its first frame
     * instead of needing several frames to ramp up — important for hitting
     * the ~4s (2-frame) persistence target.
     */
    const EMA_BYPASS_FACTOR = 1.15;

    // -------------------------------------------------------------------------
    // 5-point calibration tuning constants
    // -------------------------------------------------------------------------

    /**
     * Fraction of the measured edge-look angle to use as the actual violation
     * threshold. Leaves a buffer so glancing near (but not literally at) the
     * screen edge doesn't flag, while still catching a look-away that goes
     * past where the student demonstrated they can see the screen.
     *
     * @type {number}
     */
    const CALIBRATION_MARGIN = 0.85;

    /** @type {number} Clamp bounds (degrees) for calibration-derived yaw threshold. */
    const CALIBRATED_YAW_MIN = 15;
    const CALIBRATED_YAW_MAX = 45;

    /** @type {number} Clamp bounds (degrees) for calibration-derived pitch thresholds. */
    const CALIBRATED_PITCH_MIN = 10;
    const CALIBRATED_PITCH_MAX = 40;

    /**
     * Clamp bounds for the live distance-compensation scale factor
     * (currentEyeDistX / referenceEyeDist). Bounded so a single bad-frame
     * landmark glitch, or the student briefly leaning far out of frame,
     * can't swing the effective threshold to an unusable extreme.
     *
     * @type {number}
     */
    const DISTANCE_SCALE_MIN = 0.6;
    const DISTANCE_SCALE_MAX = 1.8;

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
     * @returns {Object} { yaw, pitch, roll, eyeDistX } — angles in degrees,
     *   eyeDistX is the normalized interocular distance (a proxy for distance
     *   from the camera, used for calibration and live distance compensation).
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
            return { yaw: 0, pitch: 0, roll: 0, eyeDistX: 0 };
        }

        // noseOffsetX is proportional to sin(yaw).
        // eyeDistX is proportional to cos(yaw).
        // Therefore, noseOffsetX / eyeDistX is proportional to tan(yaw).
        // The constant 0.5 approximates the anatomical ratio of nose protrusion
        // (depth) to half the inter-eye distance. A previous change lowered this
        // to 0.4 to make the estimate "more sensitive", which instead amplified
        // every small, natural head movement into a large reported yaw and was
        // the single biggest cause of false-positive violations; 0.6 corrected
        // too far the other way and under-detected genuine head turns. 0.5 is a
        // middle ground — real calibration (see calibratedThresholds) does most
        // of the personalization work now anyway.
        var yawRatio = (noseOffsetX / eyeDistX) / 0.5;
        var yaw = toDeg(Math.atan(yawRatio));

        // --- Pitch (Vertical Tilt) ---
        var eyeMidY = (leftEyeOuter.y + rightEyeOuter.y) / 2;
        var faceHeight = chin.y - eyeMidY;

        if (faceHeight < 0.0001) {
            return { yaw: yaw, pitch: 0, roll: 0, eyeDistX: eyeDistX };
        }

        var noseToEye = noseTip.y - eyeMidY;
        var noseRatio = noseToEye / faceHeight;

        // Anatomical baseline: nose is usually at ~40% of the distance from eyes to chin.
        var normalNoseRatio = 0.4;

        // Multiply by 200 to map ratio deviation to degrees (empirical scale factor).
        // A previous change raised this to 300 to make tilt "more sensitive",
        // which — like the yaw amplification above — turned small natural nods
        // into large reported pitch values and caused constant false positives.
        var pitch = (noseRatio - normalNoseRatio) * 200;

        // --- Roll ---
        var dx = rightEyeOuter.x - leftEyeOuter.x;
        var dy = rightEyeOuter.y - leftEyeOuter.y;
        var roll = toDeg(Math.atan2(dy, dx));

        return {
            yaw: yaw,
            pitch: pitch,
            roll: roll,
            eyeDistX: eyeDistX
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
     * @param {number} [cfg.gazeYawLeftThreshold=30] Yaw-left threshold in degrees.
     *   Admin-configured CEILING — student calibration may tighten this for
     *   their setup but never exceed it (see analyze()).
     * @param {number} [cfg.gazeYawRightThreshold=30] Yaw-right threshold in degrees. Same ceiling semantics as gazeYawLeftThreshold.
     * @param {number} [cfg.gazePitchUpThreshold=20] Pitch-up threshold in degrees. Same ceiling semantics as gazeYawLeftThreshold.
     * @param {number} [cfg.gazePitchDownThreshold=25] Pitch-down threshold in degrees
     *   (more lenient than up, to allow keyboard/notes glances). Same ceiling semantics as gazeYawLeftThreshold.
     * @param {number} [cfg.gazePersistenceThreshold=2] Consecutive violation frames
     *   (~4s at the default 2s captureInterval).
     * @param {number} [cfg.gazeEmaAlpha=0.65] EMA smoothing factor.
     * @param {boolean} [cfg.gazeDebug=false] Log per-frame signal breakdown to the console.
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
            if (config.gazeDebug) {
                console.log('[Proctor Debug] analyze() skipped — video not ready:', {
                    hasVideoEl: !!videoEl,
                    paused: videoEl && videoEl.paused,
                    ended: videoEl && videoEl.ended,
                    videoWidth: videoEl && videoEl.videoWidth,
                    videoHeight: videoEl && videoEl.videoHeight,
                    readyState: videoEl && videoEl.readyState
                });
            }
            return currentState;
        }

        try {
            // Snapshot the current frame to an offscreen canvas rather than
            // handing the <video> element to the detector directly — see the
            // comment on frameCanvas above for why.
            if (!frameCanvas) {
                frameCanvas = document.createElement('canvas');
                frameCanvasCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
            }
            if (frameCanvas.width !== videoEl.videoWidth || frameCanvas.height !== videoEl.videoHeight) {
                frameCanvas.width = videoEl.videoWidth;
                frameCanvas.height = videoEl.videoHeight;
            }
            frameCanvasCtx.drawImage(videoEl, 0, 0, frameCanvas.width, frameCanvas.height);

            // Run MediaPipe FaceMesh inference.
            var faces = await detector.estimateFaces(frameCanvas, {
                flipHorizontal: false,
                staticImageMode: false
            });

            if (config.gazeDebug && Math.random() < 0.3) {
                console.log(
                    '[Proctor Debug] estimateFaces() ->',
                    faces ? faces.length + ' face(s)' : faces,
                    faces && faces[0] ? { box: faces[0].box, score: faces[0].score, kp: faces[0].keypoints && faces[0].keypoints.length } : null
                );
            }

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
            if (headPose.eyeDistX) {
                // eyeDistX shrinks not only when the student moves farther from
                // the camera, but also — independently — whenever they turn
                // their head sideways (perspective foreshortening; eyeDistX is
                // proportional to cos(yaw), per the yaw formula above). Using
                // the raw value as a distance proxy therefore misreads "turned
                // to look at the screen edge" as "moved farther away", which
                // tightens the very threshold that turn was supposed to be
                // measured against — a self-defeating feedback loop that gets
                // worse the closer to the edge (larger yaw) someone looks.
                // Divide out the foreshortening factor so what's left reflects
                // distance from the camera only, not head orientation.
                var yawForCorrection = clamp(headPose.yaw, -70, 70);
                var foreshortening = Math.cos(yawForCorrection * Math.PI / 180);
                lastEyeDistX = headPose.eyeDistX / foreshortening;
            }

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

            // --- Step 5: EMA smoothing with fast-path bypass ---
            var alpha = config.gazeEmaAlpha || DEFAULT_EMA_ALPHA;

            // Admin ceilings: the quiz-level configured value (itself either
            // typed in directly, or captured via the admin calibration helper
            // — see admin_calibration.js — which already bakes in a leeway
            // margin so it isn't tight to one specific setup). The effective
            // threshold used below is NEVER allowed past this value, no matter
            // what the student's own calibration or live distance compensation
            // would otherwise produce. This is what stops a student from
            // gaming their own calibration (e.g. turning further than needed,
            // or calibrating from an exaggerated distance) into a wide-open
            // threshold: the ceiling is applied last, after every other
            // adjustment, not just to the raw calibrated value.
            var adminYawLeftCeiling = config.gazeYawLeftThreshold || DEFAULT_YAW_THRESHOLD;
            var adminYawRightCeiling = config.gazeYawRightThreshold || DEFAULT_YAW_THRESHOLD;
            var adminPitchUpCeiling = config.gazePitchUpThreshold || DEFAULT_PITCH_UP_THRESHOLD;
            var adminPitchDownCeiling = config.gazePitchDownThreshold || DEFAULT_PITCH_DOWN_THRESHOLD;

            // Base thresholds: the student's own calibration may refine
            // (tighten or loosen, within reason) the admin ceiling for their
            // specific setup; absent calibration, the ceiling is used directly.
            // Left/right (like up/down) are independent — see the note on
            // calibratedThresholds above.
            var baseYawLeftThreshold = calibratedThresholds.yawLeft || adminYawLeftCeiling;
            var baseYawRightThreshold = calibratedThresholds.yawRight || adminYawRightCeiling;
            var basePitchUpThreshold = calibratedThresholds.pitchUp || adminPitchUpCeiling;
            var basePitchDownThreshold = calibratedThresholds.pitchDown || adminPitchDownCeiling;

            // Live distance compensation: if the student is now closer/farther
            // from the camera than at calibration time, the angle required to
            // look at the screen edge has changed proportionally — scale the
            // thresholds to match instead of using a single fixed angle that's
            // only correct at one specific distance. Uses lastEyeDistX (the
            // foreshortening-corrected value set above), NOT headPose.eyeDistX
            // directly, so turning to look at the screen edge isn't itself
            // misread as "moved farther away".
            var distanceScale = 1;
            if (referenceEyeDist && lastEyeDistX) {
                distanceScale = clamp(lastEyeDistX / referenceEyeDist, DISTANCE_SCALE_MIN, DISTANCE_SCALE_MAX);
            }

            // Final effective thresholds: distance-scaled, then re-capped at
            // the admin ceiling as the very last step (see comment above).
            var yawLeftThreshold = Math.min(baseYawLeftThreshold * distanceScale, adminYawLeftCeiling);
            var yawRightThreshold = Math.min(baseYawRightThreshold * distanceScale, adminYawRightCeiling);
            var pitchUpThreshold = Math.min(basePitchUpThreshold * distanceScale, adminPitchUpCeiling);
            var pitchDownThreshold = Math.min(basePitchDownThreshold * distanceScale, adminPitchDownCeiling);
            // Used only where a single non-directional yaw magnitude is needed
            // (the EMA bypass gate below) — direction-specific checks further
            // down use yawLeftThreshold/yawRightThreshold directly.
            var yawThreshold = Math.min(yawLeftThreshold, yawRightThreshold);

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

            // Iris offset (converted from normalized offset to degrees) — smoothed
            // separately from head pose because iris landmarks are noisier than
            // the coarse landmarks used for head pose, and jitter here used to
            // spike straight past IRIS_ONLY_THRESHOLD on essentially every frame.
            var rawIrisX = 0;
            var rawIrisY = 0;
            var irisYaw = 0;
            var irisPitch = 0;
            if (irisOffset) {
                rawIrisX = irisOffset.x;
                rawIrisY = irisOffset.y;
                if (!hasIrisBaseline) {
                    smoothed.irisX = rawIrisX;
                    smoothed.irisY = rawIrisY;
                    hasIrisBaseline = true;
                } else {
                    smoothed.irisX = ema(rawIrisX, smoothed.irisX, IRIS_EMA_ALPHA);
                    smoothed.irisY = ema(rawIrisY, smoothed.irisY, IRIS_EMA_ALPHA);
                }
                rawIrisX = smoothed.irisX;
                rawIrisY = smoothed.irisY;
                irisYaw = smoothed.irisX * IRIS_TO_ANGLE_SCALE;
                irisPitch = smoothed.irisY * IRIS_TO_ANGLE_SCALE;
            } else {
                // No iris reading this frame (eyes closed / iris unavailable).
                // Drop the iris contribution entirely rather than holding a
                // stale value, and reset the baseline so the signal doesn't
                // jump-smooth from a now-irrelevant past reading once the
                // eyes reopen.
                hasIrisBaseline = false;
            }

            // --- Step 6: Apply Calibration Baseline (head pose only) ---
            var finalHeadYaw = smoothed.yaw - calibrationBaseline.yaw;
            var finalHeadPitch = smoothed.pitch - calibrationBaseline.pitch;

            // --- Step 7: Dual-signal boundary detection ---
            // Evaluate head pose and iris offset INDEPENDENTLY.
            // A violation is triggered if EITHER signal exceeds its threshold.
            // This prevents the vestibulo-ocular reflex (VOR) from cancelling
            // the two signals when head turns but eyes compensate.
            //
            // Pitch sign convention: finalHeadPitch/combinedPitch is POSITIVE when
            // looking down (nose moves proportionally closer to the chin) and
            // NEGATIVE when looking up. pitchDownThreshold therefore gates the
            // "down" branch and pitchUpThreshold gates the "up" branch — a
            // previous version had these two swapped, which meant the (usually
            // more lenient) "down" allowance was actually being applied to
            // upward glances and vice versa.
            //
            // Yaw sign convention: finalHeadYaw/combinedYaw is POSITIVE turning
            // right, NEGATIVE turning left. yawRightThreshold/yawLeftThreshold
            // are independent (see calibratedThresholds) rather than one shared
            // magnitude — a real setup (off-center camera, a second monitor to
            // one side) is rarely equally lenient in both directions.

            var direction = 'center';
            var isLookingAway = false;

            // --- Signal A: Head pose violation ---
            var headViolation = false;
            var headDirection = 'center';

            if (finalHeadYaw > yawRightThreshold) {
                headDirection = 'right';
                headViolation = true;
            } else if (finalHeadYaw < -yawLeftThreshold) {
                headDirection = 'left';
                headViolation = true;
            } else if (finalHeadPitch > pitchDownThreshold) {
                headDirection = 'down';
                headViolation = true;
            } else if (finalHeadPitch < -pitchUpThreshold) {
                headDirection = 'up';
                headViolation = true;
            }

            // --- Signal B: Iris-only violation ---
            // Uses the smoothed normalized iris offset directly (not fused with
            // head). Only meaningfully triggers when the head is roughly
            // centered but the eyes alone look away, since Signal A already
            // covers head-pose violations with priority.
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

            if (combinedYaw > yawRightThreshold) {
                combinedDirection = 'right';
                combinedViolation = true;
            } else if (combinedYaw < -yawLeftThreshold) {
                combinedDirection = 'left';
                combinedViolation = true;
            } else if (combinedPitch > pitchDownThreshold) {
                combinedDirection = 'down';
                combinedViolation = true;
            } else if (combinedPitch < -pitchUpThreshold) {
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
            // Opt-in only (config.gazeDebug) — this used to log unconditionally
            // on 10% of frames in production, which is noisy and not needed
            // once the thresholds below are correctly tuned.
            if (config.gazeDebug && Math.random() < 0.1) {
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

            // Eyes-open state was computed in Step 1 above (currentState.eyesOpen);
            // capture it before currentState is replaced below. A previous version
            // hardcoded this to `true` in the reported state regardless of the
            // actual EAR-based reading.
            var eyesOpenState = currentState.eyesOpen;

            currentState = {
                isViolation: isConfirmedViolation,
                direction: isLookingAway ? direction : 'center',
                yaw: Math.round(reportYaw * 10) / 10,
                pitch: Math.round(reportPitch * 10) / 10,
                roll: Math.round(smoothed.roll * 10) / 10,
                irisOffsetX: irisOffset ? Math.round(rawIrisX * 100) / 100 : 0,
                irisOffsetY: irisOffset ? Math.round(rawIrisY * 100) / 100 : 0,
                eyesOpen: eyesOpenState,
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
        hasIrisBaseline = false;
        calibrationPoints = {};
        calibratedThresholds = { yawLeft: null, yawRight: null, pitchUp: null, pitchDown: null };
        referenceEyeDist = null;
        lastEyeDistX = 0;

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
     * Reset any in-progress calibration point samples. Call before starting a
     * fresh 5-point calibration sequence (does not clear a previously
     * *finished* calibration — that only happens if finishCalibration() is
     * called again with new points, or stop() is called).
     */
    function beginCalibration() {
        calibrationPoints = {};
    }

    /**
     * Capture the current smoothed gaze reading as a calibration sample for
     * the given screen point. Call once the student has been looking steadily
     * at that point for a moment (the caller — proctoring.js — is responsible
     * for waiting out a stability/dwell period first, so the EMA has settled).
     *
     * @param {string} pointId One of 'center', 'left', 'right', 'up', 'down'.
     * @returns {boolean} Whether a usable sample was captured (false if no
     *   face/iris data is currently available).
     */
    function captureCalibrationPoint(pointId) {
        if (!currentState.faceDetected) {
            return false;
        }

        calibrationPoints[pointId] = {
            yaw: smoothed.yaw,
            pitch: smoothed.pitch,
            irisX: smoothed.irisX,
            irisY: smoothed.irisY,
            eyeDistX: lastEyeDistX
        };

        console.log('[Proctor GazeTracker] Captured calibration point "' + pointId + '": yaw=' +
            smoothed.yaw.toFixed(1) + '° pitch=' + smoothed.pitch.toFixed(1) + '°');
        return true;
    }

    /**
     * Derive the zero-baseline and personalized angular thresholds from the
     * calibration points captured so far. Only 'center' is required — it sets
     * calibrationBaseline and referenceEyeDist. Any of 'left'/'right'/'up'/
     * 'down' that were also captured refine the corresponding threshold;
     * missing edges simply leave that axis on the config/default threshold
     * (unscaled by calibration, but still distance-scaled if 'center' and at
     * least one edge — needed to know the direction of "further" — were
     * captured... in practice we only distance-scale once referenceEyeDist
     * exists, which just needs 'center').
     *
     * @returns {Object} Summary of what was derived, for UI/logging purposes.
     */
    function finishCalibration() {
        var center = calibrationPoints.center;
        var summary = { baseline: false, yawLeft: false, yawRight: false, pitchUp: false, pitchDown: false };

        if (!center) {
            console.warn('[Proctor GazeTracker] finishCalibration() called without a "center" point — skipping.');
            return summary;
        }

        calibrationBaseline.yaw = center.yaw;
        calibrationBaseline.pitch = center.pitch;
        referenceEyeDist = center.eyeDistX > 0 ? center.eyeDistX : null;
        summary.baseline = true;

        var left = calibrationPoints.left;
        var right = calibrationPoints.right;
        if (left && right) {
            // Which UI-prompted point ('left' edge dot vs 'right' edge dot)
            // produced the negative vs positive yaw delta is determined
            // empirically here, NOT assumed from the point id. Whether a
            // physical rightward turn reads as positive or negative yaw
            // depends on the camera/browser's mirroring behavior, which
            // estimateHeadPose has no visibility into (estimateFaces() always
            // runs on the raw, non-mirrored frame — see flipHorizontal:false
            // in init() — regardless of how the on-screen preview is shown).
            // Deriving the mapping from the actual signs avoids silently
            // swapping which threshold applies to which real-world direction.
            var leftDelta = left.yaw - center.yaw;
            var rightDelta = right.yaw - center.yaw;
            var negativeDelta = Math.min(leftDelta, rightDelta);
            var positiveDelta = Math.max(leftDelta, rightDelta);

            calibratedThresholds.yawLeft = clamp(Math.abs(negativeDelta) * CALIBRATION_MARGIN, CALIBRATED_YAW_MIN, CALIBRATED_YAW_MAX);
            calibratedThresholds.yawRight = clamp(Math.abs(positiveDelta) * CALIBRATION_MARGIN, CALIBRATED_YAW_MIN, CALIBRATED_YAW_MAX);
            summary.yawLeft = true;
            summary.yawRight = true;
        }

        var up = calibrationPoints.up;
        if (up) {
            // Pitch is POSITIVE looking down, NEGATIVE looking up (see analyze()).
            var upEstimate = Math.abs(up.pitch - center.pitch) * CALIBRATION_MARGIN;
            calibratedThresholds.pitchUp = clamp(upEstimate, CALIBRATED_PITCH_MIN, CALIBRATED_PITCH_MAX);
            summary.pitchUp = true;
        }

        var down = calibrationPoints.down;
        if (down) {
            var downEstimate = Math.abs(down.pitch - center.pitch) * CALIBRATION_MARGIN;
            calibratedThresholds.pitchDown = clamp(downEstimate, CALIBRATED_PITCH_MIN, CALIBRATED_PITCH_MAX);
            summary.pitchDown = true;
        }

        console.log('[Proctor GazeTracker] Calibration complete:', {
            baseline: calibrationBaseline,
            thresholds: calibratedThresholds,
            referenceEyeDist: referenceEyeDist
        });

        return summary;
    }

    /**
     * Get the personalized thresholds derived by the most recent
     * finishCalibration() call (degrees; already includes CALIBRATION_MARGIN,
     * already clamped — see getCalibrationBounds()). Used by the admin calibration helper
     * (admin_calibration.js) to read out measured values for the quiz
     * settings form; not needed for normal student-attempt operation, since
     * analyze() reads calibratedThresholds directly.
     *
     * @returns {Object} { yawLeft, yawRight, pitchUp, pitchDown } — any field
     *   may be null if that calibration point was never captured.
     */
    function getCalibratedThresholds() {
        return {
            yawLeft: calibratedThresholds.yawLeft,
            yawRight: calibratedThresholds.yawRight,
            pitchUp: calibratedThresholds.pitchUp,
            pitchDown: calibratedThresholds.pitchDown
        };
    }

    /**
     * Get the min/max bounds calibration values are clamped to. Exposed so
     * callers that further adjust a calibrated value (e.g. admin_calibration.js
     * adding a leeway margin) can re-clamp to the same sane range afterward,
     * rather than duplicating the bounds as separate magic numbers.
     *
     * @returns {Object} { yawMin, yawMax, pitchMin, pitchMax }
     */
    function getCalibrationBounds() {
        return {
            yawMin: CALIBRATED_YAW_MIN,
            yawMax: CALIBRATED_YAW_MAX,
            pitchMin: CALIBRATED_PITCH_MIN,
            pitchMax: CALIBRATED_PITCH_MAX
        };
    }

    return {
        init: init,
        analyze: analyze,
        getState: getState,
        getDirection: getDirection,
        isReady: isReady,
        stop: stop,
        formatForReport: formatForReport,
        beginCalibration: beginCalibration,
        captureCalibrationPoint: captureCalibrationPoint,
        finishCalibration: finishCalibration,
        getCalibratedThresholds: getCalibratedThresholds,
        getCalibrationBounds: getCalibrationBounds
    };
});
