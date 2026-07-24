/**
 * Main proctoring engine — continuous client-side face detection & matching.
 *
 * Uses @vladmandic/face-api (loaded globally) to:
 * 1. Capture webcam stream
 * 2. Continuously detect faces using TinyFaceDetector
 * 3. Match detected face against student's profile picture descriptor
 * 4. Report results to server via Moodle AJAX
 * 5. Display real-time status overlay on quiz page
 *
 * @module     quizaccess_proctor/proctoring
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
define(['core/ajax', 'core/notification', 'core/str'], function (Ajax, Notification, Str) {

    /** @type {Object} Configuration passed from PHP. */
    let config = {};

    /** @type {HTMLVideoElement} Webcam video element. */
    let videoEl = null;

    /** @type {HTMLCanvasElement} Offscreen canvas for frame capture. */
    let canvasEl = null;

    /** @type {MediaStream} Active webcam stream. */
    let stream = null;

    /** @type {Float32Array|null} Reference face descriptor from profile picture. */
    let referenceDescriptor = null;

    /** @type {boolean} Whether models have been loaded. */
    let modelsLoaded = false;

    /** @type {boolean} Whether the proctoring engine is active. */
    let isActive = false;

    /** @type {number} Timer ID for the detection loop. */
    let detectionTimer = null;

    /** @type {number} Timer ID for the report loop. */
    let reportTimer = null;

    /** @type {Array} Buffer of detection results for batched reporting. */
    let resultBuffer = [];

    /** @type {Object} Current detection state for UI updates. */
    let currentState = {
        status: 'initializing',
        confidence: 0,
        faceCount: 0
    };

    /**
     * Initialize the proctoring engine.
     *
     * @param {Object} cfg Configuration object from PHP.
     */
    async function init(cfg) {
        config = cfg;

        // Build the overlay UI.
        createOverlayUI();

        try {
            // Step 1: Start webcam.
            updateOverlayStatus('initializing', 'Starting camera...');
            await startWebcam();

            // Step 2: Load face detection models.
            updateOverlayStatus('loading', 'Loading face detection models...');
            await loadModels();

            // Step 3: Load reference descriptor from profile picture.
            if (config.hasProfilePic && config.profileImageUrl) {
                updateOverlayStatus('loading', 'Analyzing profile picture...');
                await loadReferenceDescriptor();
            } else {
                updateOverlayStatus('warning', 'No profile picture — detection only');
            }

            // Step 4: Start continuous detection.
            isActive = true;
            startDetectionLoop();
            startReportLoop();

            updateOverlayStatus('active', 'Proctoring active');

        } catch (err) {
            console.error('[Proctor] Initialization failed:', err);
            updateOverlayStatus('error', 'Proctoring error: ' + err.message);
        }
    }

    /**
     * Create the proctoring overlay UI on the quiz page.
     * Shows a small camera preview and status indicator.
     */
    function createOverlayUI() {
        // Main container.
        const overlay = document.createElement('div');
        overlay.id = 'proctor-overlay';
        overlay.className = 'proctor-overlay';
        overlay.innerHTML = `
            <div class="proctor-overlay-header" id="proctor-overlay-header">
                <span class="proctor-overlay-indicator" id="proctor-indicator"></span>
                <span class="proctor-overlay-title" id="proctor-overlay-title">Proctoring</span>
                <button class="proctor-overlay-toggle" id="proctor-toggle" title="Toggle camera preview">
                    <span id="proctor-toggle-icon">▼</span>
                </button>
            </div>
            <div class="proctor-overlay-body" id="proctor-overlay-body">
                <div class="proctor-video-wrapper">
                    <video id="proctor-video" autoplay muted playsinline></video>
                    <canvas id="proctor-canvas" style="position:absolute;top:0;left:0;"></canvas>
                </div>
                <div class="proctor-overlay-status" id="proctor-status-text">Initializing...</div>
            </div>
            <div class="proctor-overlay-warning" id="proctor-warning" style="display:none;">
                <span id="proctor-warning-text"></span>
            </div>
        `;

        document.body.appendChild(overlay);

        // Toggle collapse/expand.
        const toggleBtn = document.getElementById('proctor-toggle');
        const body = document.getElementById('proctor-overlay-body');
        const toggleIcon = document.getElementById('proctor-toggle-icon');
        let collapsed = false;

        toggleBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            collapsed = !collapsed;
            body.style.display = collapsed ? 'none' : 'block';
            toggleIcon.textContent = collapsed ? '▶' : '▼';
        });

        // Store references.
        videoEl = document.getElementById('proctor-video');
        canvasEl = document.getElementById('proctor-canvas');

        // Drag logic
        const header = document.getElementById('proctor-overlay-header');
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        header.addEventListener('mousedown', function(e) {
            if (e.target.closest('#proctor-toggle')) return;
            
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            
            const rect = overlay.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            
            // Switch from bottom/right positioning to top/left for dragging
            overlay.style.right = 'auto';
            overlay.style.bottom = 'auto';
            overlay.style.left = initialLeft + 'px';
            overlay.style.top = initialTop + 'px';
            
            e.preventDefault();
        });

        document.addEventListener('mousemove', function(e) {
            if (!isDragging) return;
            
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            
            overlay.style.left = (initialLeft + dx) + 'px';
            overlay.style.top = (initialTop + dy) + 'px';
        });

        document.addEventListener('mouseup', function() {
            isDragging = false;
        });
    }

    /**
     * Start the webcam stream.
     *
     * @returns {Promise<void>}
     */
    async function startWebcam() {
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    facingMode: 'user'
                },
                audio: false
            });

            videoEl.srcObject = stream;
            await videoEl.play();

            // Set canvas dimensions to match video.
            canvasEl.width = videoEl.videoWidth || 640;
            canvasEl.height = videoEl.videoHeight || 480;

        } catch (err) {
            throw new Error('Camera access denied. Please allow camera permissions.');
        }
    }

    /**
     * Load face-api.js models from the server.
     *
     * @returns {Promise<void>}
     */
    async function loadModels() {
        // face-api.js is loaded as a global by the PHP page.
        if (typeof faceapi === 'undefined') {
            throw new Error('face-api.js library not loaded');
        }

        const modelUrl = config.modelUrl;

        await Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl),
            faceapi.nets.faceLandmark68Net.loadFromUri(modelUrl), // Using full landmark model
            faceapi.nets.faceRecognitionNet.loadFromUri(modelUrl),
        ]);

        modelsLoaded = true;
    }

    /** @type {boolean} Whether the profile picture failed to provide a valid face descriptor. */
    let profilePicFailed = false;

    /**
     * Load the reference face descriptor from the student's profile picture.
     *
     * @returns {Promise<void>}
     */
    async function loadReferenceDescriptor() {
        try {
            // Create an image element from the profile picture URL.
            const img = await loadImage(config.profileImageUrl);

            // Detect face and extract descriptor (lowered threshold to 0.1 for profile pics).
            const detection = await faceapi
                .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.1 }))
                .withFaceLandmarks() // Use full landmarks.
                .withFaceDescriptor();

            if (detection) {
                referenceDescriptor = detection.descriptor;
                profilePicFailed = false;
                console.log('[Proctor] Reference descriptor loaded from profile picture');
            } else {
                console.warn('[Proctor] No face detected in profile picture');
                referenceDescriptor = null;
                profilePicFailed = true;
            }
        } catch (err) {
            console.error('[Proctor] Failed to load reference descriptor:', err);
            referenceDescriptor = null;
            profilePicFailed = true;
        }
    }

    /**
     * Load an image from URL and return a promise.
     *
     * @param {string} url Image URL.
     * @returns {Promise<HTMLImageElement>}
     */
    function loadImage(url) {
        return new Promise(function (resolve, reject) {
            const img = new Image();

            // For external profile pictures (like Gravatar), we MUST request CORS 
            // so we don't taint the canvas. For local Moodle files, we MUST NOT 
            // request CORS because Moodle doesn't send the headers.
            if (url.startsWith('http') && !url.startsWith(window.location.origin)) {
                img.crossOrigin = 'anonymous';
            }

            img.onload = function () { resolve(img); };
            img.onerror = function () { reject(new Error('Failed to load image: ' + url)); };
            img.src = url;
        });
    }

    /**
     * Start the continuous face detection loop.
     */
    function startDetectionLoop() {
        const interval = config.captureInterval || 2000;

        async function detect() {
            if (!isActive || !modelsLoaded) {
                return;
            }

            try {
                await performDetection();
            } catch (err) {
                console.error('[Proctor] Detection error:', err);
                currentState.status = 'error';
                updateOverlayFromState();
            }

            // Schedule next detection.
            if (isActive) {
                detectionTimer = setTimeout(detect, interval);
            }
        }

        detect();
    }

    /**
     * Perform a single face detection cycle.
     *
     * @returns {Promise<void>}
     */
    async function performDetection() {
        if (!videoEl || videoEl.paused || videoEl.ended || !videoEl.videoWidth) {
            return;
        }

        // Detect all faces in the current video frame.
        const detections = await faceapi
            .detectAllFaces(videoEl, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }))
            .withFaceLandmarks() // Use full landmarks
            .withFaceDescriptors();

        // Draw detection boxes on the overlay canvas.
        drawDetections(detections);

        // Classify the result.
        let status = 'no_face';
        let confidence = 0;

        if (detections.length === 0) {
            status = 'no_face';
        } else if (detections.length > 1) {
            status = 'multiple_faces';
        } else {
            // Single face detected.
            const faceDescriptor = detections[0].descriptor;

            if (referenceDescriptor) {
                // Compare with reference.
                const distance = faceapi.euclideanDistance(faceDescriptor, referenceDescriptor);
                confidence = distance;
                const threshold = config.matchThreshold || 0.50;

                if (distance < threshold) {
                    status = 'match';
                } else {
                    status = 'mismatch';
                }
            } else if (config.hasProfilePic && profilePicFailed) {
                // We expected a profile picture but it failed to load or had no face.
                status = 'error';
                confidence = -1;
            } else {
                // No reference — detection only mode.
                status = 'match'; // Face detected, can't verify identity.
                confidence = -1;   // Indicates no matching was done.
            }
        }

        // Update state.
        currentState = {
            status: status,
            confidence: confidence,
            faceCount: detections.length
        };

        // Capture an immediate snapshot if there is a violation.
        let imageData = '';
        if (status !== 'match') {
            try {
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = 320;
                tempCanvas.height = 240;
                const tempCtx = tempCanvas.getContext('2d');
                tempCtx.drawImage(videoEl, 0, 0, 320, 240);
                imageData = tempCanvas.toDataURL('image/jpeg', 0.5);
            } catch (e) {
                imageData = '';
            }
        }

        // Buffer the result for batched reporting.
        resultBuffer.push({
            status: status,
            confidence: confidence,
            imageData: imageData,
            timestamp: Date.now()
        });

        // Update UI.
        updateOverlayFromState();
    }

    /**
     * Draw face detection boxes on the overlay canvas.
     *
     * @param {Array} detections Array of face detections.
     */
    function drawDetections(detections) {
        const displaySize = {
            width: videoEl.offsetWidth || videoEl.videoWidth,
            height: videoEl.offsetHeight || videoEl.videoHeight
        };

        // Resize canvas to match display.
        faceapi.matchDimensions(canvasEl, displaySize);

        // Clear previous drawings.
        const ctx = canvasEl.getContext('2d');
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

        if (detections.length > 0) {
            const resized = faceapi.resizeResults(detections, displaySize);

            // Draw boxes with color based on match status.
            resized.forEach(function (det) {
                const box = det.detection.box;
                const color = currentState.status === 'match' ? '#00e676' :
                    currentState.status === 'mismatch' ? '#ff1744' :
                        currentState.status === 'multiple_faces' ? '#ff9100' : '#2979ff';

                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.strokeRect(box.x, box.y, box.width, box.height);

                // Draw confidence label.
                if (currentState.confidence > 0) {
                    const threshold = config.matchThreshold || 0.50;
                    const label = (currentState.confidence < threshold)
                        ? '✓ Dist: ' + currentState.confidence.toFixed(2)
                        : '✗ Dist: ' + currentState.confidence.toFixed(2);
                    ctx.fillStyle = color;
                    ctx.font = '12px Inter, sans-serif';
                    ctx.fillText(label, box.x, box.y - 5);
                }
            });
        }
    }

    /**
     * Start the batched report loop that sends results to the server.
     */
    function startReportLoop() {
        const interval = config.reportInterval || 15000;

        reportTimer = setInterval(function () {
            if (!isActive || resultBuffer.length === 0) {
                return;
            }

            sendReport();
        }, interval);
    }

    /**
     * Send buffered detection results to the server.
     * Sends the "worst" result from the buffer.
     */
    function sendReport() {
        if (resultBuffer.length === 0) {
            return;
        }

        // Priority order: mismatch > multiple_faces > no_face > error > match.
        const priorityOrder = ['mismatch', 'multiple_faces', 'no_face', 'error', 'match'];
        let worstResult = resultBuffer[0];

        resultBuffer.forEach(function (r) {
            const currentPriority = priorityOrder.indexOf(r.status);
            const worstPriority = priorityOrder.indexOf(worstResult.status);
            if (currentPriority < worstPriority) {
                worstResult = r;
            }
        });

        // Use the snapshot captured at the exact moment of the violation.
        let imageData = worstResult.imageData || '';

        // If there were no violations in this batch (perfect match), do NOT send network request.
        // This prevents polluting the database with "Match" logs and follows enterprise architecture.
        if (worstResult.status === 'match') {
            resultBuffer = [];
            return;
        }

        // Send via Moodle AJAX.
        Ajax.call([{
            methodname: 'quizaccess_proctor_store_snapshot',
            args: {
                attemptid: config.attemptId,
                quizid: config.quizId,
                courseid: config.courseId,
                status: worstResult.status,
                confidence: worstResult.confidence >= 0 ? worstResult.confidence : 0,
                imagedata: imageData
            }
        }])[0].then(function (result) {
            if (result.success) {
                console.log('[Proctor] Report sent, logId:', result.logid);
            }
        }).catch(function (err) {
            console.error('[Proctor] Failed to send report:', err);
        });

        // Clear buffer.
        resultBuffer = [];
    }

    /**
     * Update the overlay UI based on the current detection state.
     */
    function updateOverlayFromState() {
        const indicator = document.getElementById('proctor-indicator');
        const statusText = document.getElementById('proctor-status-text');
        const title = document.getElementById('proctor-overlay-title');
        const warning = document.getElementById('proctor-warning');
        const warningText = document.getElementById('proctor-warning-text');

        if (!indicator || !statusText) {
            return;
        }

        switch (currentState.status) {
            case 'match':
                indicator.className = 'proctor-overlay-indicator proctor-status-match';
                statusText.textContent = 'Identity verified';
                title.textContent = 'Proctoring ✓';
                hideWarning();
                break;

            case 'mismatch':
                indicator.className = 'proctor-overlay-indicator proctor-status-mismatch';
                statusText.textContent = 'Face mismatch (distance: ' +
                    currentState.confidence.toFixed(3) + ')';
                title.textContent = 'Proctoring ⚠';
                showWarning('Face does not match your profile picture. Please ensure you are the registered student.');
                break;

            case 'no_face':
                indicator.className = 'proctor-overlay-indicator proctor-status-warning';
                statusText.textContent = 'No face detected';
                title.textContent = 'Proctoring ⚠';
                showWarning('No face detected — please look at the camera.');
                break;

            case 'multiple_faces':
                indicator.className = 'proctor-overlay-indicator proctor-status-mismatch';
                statusText.textContent = 'Multiple faces detected';
                title.textContent = 'Proctoring ⚠';
                showWarning('Multiple faces detected — only one person should be visible.');
                break;

            case 'error':
                indicator.className = 'proctor-overlay-indicator proctor-status-error';
                statusText.textContent = 'Detection error';
                title.textContent = 'Proctoring ✗';
                break;

            default:
                indicator.className = 'proctor-overlay-indicator proctor-status-loading';
                statusText.textContent = 'Initializing...';
        }

        /**
         * Show warning banner.
         * @param {string} message Warning message.
         */
        function showWarning(message) {
            if (warning && warningText) {
                warning.style.display = 'block';
                warningText.textContent = message;
                // Auto-hide after 5 seconds.
                setTimeout(function () {
                    if (warning) {
                        warning.style.display = 'none';
                    }
                }, 5000);
            }
        }

        /**
         * Hide warning banner.
         */
        function hideWarning() {
            if (warning) {
                warning.style.display = 'none';
            }
        }
    }

    /**
     * Update the overlay status for non-detection states.
     *
     * @param {string} status Status type: initializing, loading, active, warning, error.
     * @param {string} message Status message text.
     */
    function updateOverlayStatus(status, message) {
        const indicator = document.getElementById('proctor-indicator');
        const statusText = document.getElementById('proctor-status-text');
        const title = document.getElementById('proctor-overlay-title');

        if (!indicator || !statusText) {
            return;
        }

        statusText.textContent = message;

        switch (status) {
            case 'active':
                indicator.className = 'proctor-overlay-indicator proctor-status-match';
                title.textContent = 'Proctoring ✓';
                break;
            case 'warning':
                indicator.className = 'proctor-overlay-indicator proctor-status-warning';
                title.textContent = 'Proctoring ⚠';
                break;
            case 'error':
                indicator.className = 'proctor-overlay-indicator proctor-status-error';
                title.textContent = 'Proctoring ✗';
                break;
            default:
                indicator.className = 'proctor-overlay-indicator proctor-status-loading';
                title.textContent = 'Proctoring...';
        }
    }

    /**
     * Stop the proctoring engine and clean up resources.
     */
    function stop() {
        isActive = false;

        if (detectionTimer) {
            clearTimeout(detectionTimer);
            detectionTimer = null;
        }

        if (reportTimer) {
            clearInterval(reportTimer);
            reportTimer = null;
        }

        // Send any remaining results.
        if (resultBuffer.length > 0) {
            sendReport();
        }

        // Stop the webcam stream.
        if (stream) {
            stream.getTracks().forEach(function (track) { track.stop(); });
            stream = null;
        }
    }

    // Stop proctoring when the page unloads (quiz submission).
    window.addEventListener('beforeunload', function () {
        stop();
    });

    return {
        init: init,
        stop: stop
    };
});
