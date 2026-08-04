/**
 * Object detection module — client-side phone/object detection using COCO-SSD.
 *
 * Uses TensorFlow.js with the COCO-SSD model (lite_mobilenet_v2) to detect
 * prohibited objects in the webcam feed during proctored quiz attempts.
 *
 * Key design decisions:
 * - Standalone module: decoupled from face detection, can be loaded independently.
 * - Persistence-based alerting: object must appear in N consecutive detection
 *   cycles before flagging a violation, dramatically reducing false positives.
 * - Configurable prohibited objects list from server-side settings.
 * - Graceful degradation: if model fails to load, face detection continues.
 *
 * @module     quizaccess_proctor/object_detector
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
define([], function () {

    /** @type {Object|null} Loaded COCO-SSD model instance. */
    let model = null;

    /** @type {boolean} Whether the model has been loaded successfully. */
    let modelLoaded = false;

    /** @type {boolean} Whether the model is currently loading. */
    let isLoading = false;

    /** @type {boolean} Whether the detection loop is active. */
    let isActive = false;

    /** @type {number|null} Timer ID for the detection loop. */
    let detectionTimer = null;

    /** @type {Object} Configuration passed from the proctoring engine. */
    let config = {};

    /**
     * Map of detected object classes to their consecutive detection count.
     * Used for persistence-based alerting: an object must appear in
     * `persistenceThreshold` consecutive frames before it's flagged.
     *
     * @type {Object<string, number>}
     */
    let persistenceCounters = {};

    /**
     * Current detection state for UI updates and reporting.
     *
     * @type {Object}
     */
    let currentState = {
        /** @type {boolean} Whether a violation is active. */
        isViolation: false,
        /** @type {Array<Object>} Raw detections from the latest cycle. */
        detections: [],
        /** @type {Array<string>} Objects that have passed the persistence threshold. */
        confirmedObjects: [],
        /** @type {string|null} Highest-severity confirmed object. */
        worstObject: null,
        /** @type {number} Highest confidence score among confirmed objects. */
        worstScore: 0
    };

    /**
     * Default list of prohibited COCO-SSD classes relevant to exam proctoring.
     * Ordered by severity (highest first).
     *
     * @type {Array<string>}
     */
    const DEFAULT_PROHIBITED = ['cell phone', 'book', 'laptop'];

    /**
     * Human-readable display labels for COCO-SSD class names.
     *
     * @type {Object<string, string>}
     */
    const DISPLAY_LABELS = {
        'cell phone': 'Phone',
        'book': 'Book',
        'laptop': 'Laptop',
        'remote': 'Remote',
        'tv': 'Screen',
    };

    /**
     * Initialize the object detector by loading TensorFlow.js and COCO-SSD model.
     *
     * @param {Object} cfg Configuration object.
     * @param {string} cfg.cocoModelUrl URL to the self-hosted model.json.
     * @param {Array<string>} [cfg.prohibitedObjects] List of prohibited COCO class names.
     * @param {number} [cfg.objectDetectionInterval=3000] Detection interval in ms.
     * @param {number} [cfg.objectPersistenceThreshold=2] Consecutive frames before flagging.
     * @param {number} [cfg.objectScoreThreshold=0.5] Minimum confidence score.
     * @returns {Promise<boolean>} Whether the model loaded successfully.
     */
    async function init(cfg) {
        config = cfg;

        // Apply defaults.
        config.prohibitedObjects = config.prohibitedObjects || DEFAULT_PROHIBITED;
        config.objectDetectionInterval = config.objectDetectionInterval || 3000;
        config.objectPersistenceThreshold = config.objectPersistenceThreshold || 2;
        config.objectScoreThreshold = config.objectScoreThreshold || 0.5;

        if (isLoading || modelLoaded) {
            return modelLoaded;
        }

        isLoading = true;

        try {
            // Verify TensorFlow.js and cocoSsd are available globally.
            if (typeof tf === 'undefined') {
                throw new Error('TensorFlow.js not loaded');
            }
            if (typeof cocoSsd === 'undefined') {
                throw new Error('COCO-SSD library not loaded');
            }

            // Ensure WebGL backend is ready.
            await tf.ready();
            console.log('[Proctor ObjectDetector] TF.js backend:', tf.getBackend());

            // Load the COCO-SSD model from self-hosted files.
            model = await cocoSsd.load({
                base: 'lite_mobilenet_v2',
                modelUrl: config.cocoModelUrl
            });

            modelLoaded = true;
            isLoading = false;
            console.log('[Proctor ObjectDetector] COCO-SSD model loaded successfully');
            return true;

        } catch (err) {
            console.error('[Proctor ObjectDetector] Failed to load model:', err);
            modelLoaded = false;
            isLoading = false;
            return false;
        }
    }

    /**
     * Run a single object detection cycle on the given video element.
     *
     * Filters results to only prohibited classes and applies the persistence
     * filter to determine whether a violation should be flagged.
     *
     * @param {HTMLVideoElement} videoEl The webcam video element.
     * @returns {Promise<Object>} Detection result with:
     *   - {boolean} isViolation - Whether a violation was confirmed.
     *   - {Array<Object>} detections - All prohibited object detections.
     *   - {Array<string>} confirmedObjects - Objects passing persistence threshold.
     *   - {string|null} worstObject - Highest-severity confirmed object.
     *   - {number} worstScore - Confidence of worst object.
     */
    async function detect(videoEl) {
        if (!modelLoaded || !model) {
            return {
                isViolation: false,
                detections: [],
                confirmedObjects: [],
                worstObject: null,
                worstScore: 0
            };
        }

        if (!videoEl || videoEl.paused || videoEl.ended || !videoEl.videoWidth) {
            return currentState;
        }

        try {
            // Run COCO-SSD detection.
            // maxNumBoxes=10, minScore from config (default 0.5).
            const predictions = await model.detect(
                videoEl,
                10,
                config.objectScoreThreshold
            );

            // Filter to only prohibited objects.
            const prohibited = predictions.filter(function (pred) {
                return config.prohibitedObjects.indexOf(pred.class) !== -1;
            });

            // Update persistence counters.
            // Increment counters for detected objects, reset for non-detected.
            const detectedClasses = {};
            prohibited.forEach(function (pred) {
                // Keep the highest score for each class.
                if (!detectedClasses[pred.class] || pred.score > detectedClasses[pred.class]) {
                    detectedClasses[pred.class] = pred.score;
                }
            });

            // Update persistence for all tracked classes.
            config.prohibitedObjects.forEach(function (cls) {
                if (detectedClasses[cls]) {
                    // Object detected in this frame — increment counter.
                    persistenceCounters[cls] = (persistenceCounters[cls] || 0) + 1;
                } else {
                    // Object not detected — reset counter.
                    persistenceCounters[cls] = 0;
                }
            });

            // Determine which objects have passed the persistence threshold.
            var confirmed = [];
            config.prohibitedObjects.forEach(function (cls) {
                if (persistenceCounters[cls] >= config.objectPersistenceThreshold) {
                    confirmed.push(cls);
                }
            });

            // Determine worst (highest-severity) confirmed object.
            // Severity order follows the prohibitedObjects array order.
            var worstObj = null;
            var worstScore = 0;
            if (confirmed.length > 0) {
                worstObj = confirmed[0]; // First in list = highest severity.
                worstScore = detectedClasses[worstObj] || 0;
            }

            // Update current state.
            currentState = {
                isViolation: confirmed.length > 0,
                detections: prohibited,
                confirmedObjects: confirmed,
                worstObject: worstObj,
                worstScore: worstScore
            };

            return currentState;

        } catch (err) {
            console.error('[Proctor ObjectDetector] Detection error:', err);
            return currentState;
        }
    }

    /**
     * Start the continuous object detection loop.
     *
     * @param {HTMLVideoElement} videoEl The webcam video element.
     * @param {Function} [onResult] Callback invoked after each detection cycle.
     */
    function start(videoEl, onResult) {
        if (isActive) {
            return;
        }

        isActive = true;
        var interval = config.objectDetectionInterval || 3000;

        async function loop() {
            if (!isActive || !modelLoaded) {
                return;
            }

            var result = await detect(videoEl);

            if (typeof onResult === 'function') {
                onResult(result);
            }

            if (isActive) {
                detectionTimer = setTimeout(loop, interval);
            }
        }

        loop();
    }

    /**
     * Stop the detection loop and clean up resources.
     */
    function stop() {
        isActive = false;

        if (detectionTimer) {
            clearTimeout(detectionTimer);
            detectionTimer = null;
        }

        // Reset persistence counters.
        persistenceCounters = {};

        // Reset state.
        currentState = {
            isViolation: false,
            detections: [],
            confirmedObjects: [],
            worstObject: null,
            worstScore: 0
        };
    }

    /**
     * Get the current detection state.
     *
     * @returns {Object} Current state with isViolation, detections, confirmedObjects, etc.
     */
    function getState() {
        return currentState;
    }

    /**
     * Check whether the COCO-SSD model is loaded and ready.
     *
     * @returns {boolean} True if model is loaded.
     */
    function isReady() {
        return modelLoaded;
    }

    /**
     * Get a human-readable display label for a COCO-SSD class name.
     *
     * @param {string} className COCO-SSD class name (e.g. 'cell phone').
     * @returns {string} Display label (e.g. 'Phone').
     */
    function getDisplayLabel(className) {
        return DISPLAY_LABELS[className] || className;
    }

    /**
     * Get all display labels as a map.
     *
     * @returns {Object<string, string>} Map of class names to display labels.
     */
    function getDisplayLabels() {
        return DISPLAY_LABELS;
    }

    return {
        init: init,
        detect: detect,
        start: start,
        stop: stop,
        getState: getState,
        isReady: isReady,
        getDisplayLabel: getDisplayLabel,
        getDisplayLabels: getDisplayLabels
    };
});
