/**
 * Main proctoring engine — continuous client-side face detection, matching,
 * and phone/object detection.
 *
 * Uses @vladmandic/face-api (loaded globally) for face detection and
 * TensorFlow.js COCO-SSD (via object_detector module) for phone/object detection.
 *
 * Detection pipeline:
 * 1. Capture webcam stream
 * 2. Continuously detect faces using TinyFaceDetector (every 2s)
 * 3. Match detected face against student's profile picture descriptor
 * 4. Continuously detect prohibited objects using COCO-SSD (every 3s)
 * 5. Merge results and report violations to server via Moodle AJAX
 * 6. Display real-time status overlay on quiz page
 *
 * @module     quizaccess_proctor/proctoring
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
define([
    'core/ajax',
    'core/notification',
    'core/str',
    'quizaccess_proctor/object_detector',
    'quizaccess_proctor/gaze_tracker',
    'quizaccess_proctor/gaze_calibration_ui',
    'quizaccess_proctor/voice_detector'
], function (Ajax, Notification, Str, ObjectDetector, GazeTracker, GazeCalibrationUI, VoiceDetector) {

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

        /** @type {boolean} Whether face detection models have been loaded. */
        let modelsLoaded = false;

        /** @type {boolean} Whether the object detection model is loaded and ready. */
        let objectDetectorReady = false;

        /** @type {boolean} Whether the gaze tracking model is loaded and ready. */
        let gazeTrackerReady = false;

        /** @type {boolean} Whether the microphone pipeline is live. */
        let voiceDetectorReady = false;

        /** @type {boolean} Whether the proctoring engine is active. */
        let isActive = false;

        /** @type {number} Timer ID for the detection loop. */
        let detectionTimer = null;

        /** @type {number} Timer ID for the report loop. */
        let reportTimer = null;

        /** @type {Array} Buffer of detection results for batched reporting. */
        let resultBuffer = [];

        /** @type {number} Timestamp of the last immediate violation report sent. */
        let lastViolationReportTime = 0;

        /** @type {number|null} Timer that auto-hides the overlay warning banner. */
        let warningHideTimer = null;

        /** @type {Object} Current detection state for UI updates. */
        let currentState = {
            faceStatus: 'active',
            confidence: 0,
            objectViolation: false,
            worstObject: null,
            gazeViolation: false,
            gazeDirection: 'center',
            gazeData: ''
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

                // Step 4: Load object detection model (if enabled).
                if (config.objectDetectionEnabled) {
                    updateOverlayStatus('loading', 'Loading object detection model...');
                    try {
                        // Load object detection model in background.
                        ObjectDetector.init(config).then(function (ready) {
                            objectDetectorReady = ready;
                        });

                        // Load gaze tracking model and wait for it.
                        gazeTrackerReady = await GazeTracker.init(config);

                        console.log('[Proctor] Models loaded');
                    } catch (objErr) {
                        console.warn('[Proctor] Object detection init error:', objErr);
                        objectDetectorReady = false;
                    }
                }

                // Step 4.5: Run Gaze Calibration
                if (gazeTrackerReady) {
                    await runGazeCalibration();
                }

                // Step 4.6: Start voice detection. Deliberately after
                // calibration so the microphone permission prompt cannot
                // appear over the full-screen calibration sequence. Failure
                // here is non-fatal — the mic may be missing or blocked, and
                // camera-based proctoring must carry on regardless.
                if (config.voiceDetectionEnabled) {
                    updateOverlayStatus('loading', 'Starting microphone...');
                    voiceDetectorReady = await VoiceDetector.init(config, onVoiceViolation);
                    if (!voiceDetectorReady) {
                        console.warn('[Proctor] Voice detection unavailable — continuing without it');
                    }
                }

                // Step 5: Start continuous detection.
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
         * Run the full-screen 5-point gaze calibration sequence. The student
         * looks at the center then each screen edge in turn; GazeTracker
         * derives personalized violation thresholds and a distance reference
         * from what it measures at each point (see gaze_tracker.js). The
         * sequence UI itself lives in gaze_calibration_ui.js, shared with the
         * admin-facing calibration helper on the quiz settings page so both
         * measure the same way.
         */
        async function runGazeCalibration() {
            if (!gazeTrackerReady) {
                return;
            }

            await GazeCalibrationUI.run(GazeTracker, videoEl, {
                completionText: 'Calibration complete! Starting quiz…'
            });
        }

        /**
         * Handle a confirmed continuous-speech violation.
         *
         * Unlike the video checks, this is not driven by the detection loop:
         * voice_detector.js calls straight through the moment the student has
         * been speaking continuously for longer than the quiz allows, so the
         * flag lands at the instant it happens rather than up to one capture
         * interval later. It can afford to be immediate because the required
         * duration is itself the filter — a cough or a short remark never
         * reaches it.
         *
         * @param {Object} episode The flagged episode: startedAt, endedAt,
         *   duration (seconds), confidence.
         */
        function onVoiceViolation(episode) {
            resultBuffer.push({
                status: 'talking_detected',
                // The confidence column carries face-match distance; the voice
                // episode's own confidence travels in voiceData instead.
                confidence: 0,
                imageData: captureSnapshot(),
                timestamp: episode.endedAt,
                objectsDetected: '',
                gazeData: '',
                voiceData: VoiceDetector.formatForReport()
            });

            showWarning('Continuous speech detected — please do not talk during the quiz.');

            const now = Date.now();
            if (now - lastViolationReportTime > 5000) {
                lastViolationReportTime = now;
                sendReport();
            }

            VoiceDetector.clearViolation();
        }

        /**
         * Capture a small JPEG snapshot of the current webcam frame.
         *
         * @returns {string} Base64 data URL, or '' if capture failed.
         */
        function captureSnapshot() {
            if (!videoEl || !videoEl.videoWidth) {
                return '';
            }
            try {
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = 320;
                tempCanvas.height = 240;
                const tempCtx = tempCanvas.getContext('2d');
                tempCtx.drawImage(videoEl, 0, 0, 320, 240);
                return tempCanvas.toDataURL('image/jpeg', 0.6);
            } catch (e) {
                return '';
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

            header.addEventListener('mousedown', function (e) {
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

            document.addEventListener('mousemove', function (e) {
                if (!isDragging) return;

                const dx = e.clientX - startX;
                const dy = e.clientY - startY;

                overlay.style.left = (initialLeft + dx) + 'px';
                overlay.style.top = (initialTop + dy) + 'px';
            });

            document.addEventListener('mouseup', function () {
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

                // Set element dimensions to match video. Required for TF.js models.
                videoEl.width = videoEl.videoWidth || 640;
                videoEl.height = videoEl.videoHeight || 480;
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
            const interval = config.captureInterval || 500;

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

            // Run object detection if enabled and ready.
            let objectResult = { isViolation: false, detections: [], confirmedObjects: [] };
            if (objectDetectorReady) {
                objectResult = await ObjectDetector.detect(videoEl);
            }

            // Run gaze tracking if enabled and ready.
            let gazeResult = { isViolation: false, direction: 'center', gazeData: '' };
            if (gazeTrackerReady) {
                try {
                    let gtState = await GazeTracker.analyze(videoEl);
                    gazeResult = {
                        isViolation: gtState.isViolation,
                        direction: gtState.direction,
                        gazeData: GazeTracker.formatForReport()
                    };
                } catch (e) {
                    console.error('[Proctor] Gaze tracking error:', e);
                }
            }

            // Merge face + object + gaze detection results.
            // Highest priority: Object detection (phone) > Gaze (looking away) > Face match.
            if (objectResult.isViolation) {
                status = 'phone_detected';
            } else if (gazeResult.isViolation) {
                status = 'looking_away';
            }

            // Update state.
            currentState = {
                faceStatus: status,
                confidence: confidence,
                objectViolation: objectResult.isViolation,
                worstObject: objectResult.confirmedObjects.length > 0 ? objectResult.confirmedObjects[0] : null,
                gazeViolation: gazeResult.isViolation,
                gazeDirection: gazeResult.direction,
                gazeData: gazeResult.gazeData
            };

            // Capture an immediate snapshot if there is a violation.
            let imageData = '';
            if (status !== 'match') {
                imageData = captureSnapshot();
            }

            // Buffer the result for batched reporting.
            resultBuffer.push({
                status: status,
                confidence: confidence,
                imageData: imageData,
                timestamp: Date.now(),
                objectsDetected: (objectResult.confirmedObjects || []).join(','),
                gazeData: gazeResult.gazeData,
                voiceData: ''
            });

            // Update UI.
            updateOverlayFromState();

            // If a prohibited object is detected or gaze violation, send an immediate debounced report (cooldown: 5s).
            if (status === 'phone_detected' || status === 'looking_away') {
                const now = Date.now();
                if (now - lastViolationReportTime > 5000) {
                    lastViolationReportTime = now;
                    sendReport();
                }
            }
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

            // The webcam video is mirrored horizontally via CSS scaleX(-1).
            // To keep text normal (non-mirrored) and readable, the canvas itself is not mirrored in CSS,
            // and we mirror the horizontal X coordinate of boxes when rendering:
            // mirroredX = displaySize.width - boxX - boxWidth.

            if (detections.length > 0) {
                const resized = faceapi.resizeResults(detections, displaySize);

                // Draw boxes with color based on match status.
                resized.forEach(function (det) {
                    const box = det.detection.box;
                    const mirroredX = displaySize.width - box.x - box.width;
                    const color = currentState.status === 'match' ? '#00e676' :
                        currentState.status === 'mismatch' ? '#ff1744' :
                            currentState.status === 'multiple_faces' ? '#ff9100' : '#2979ff';

                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    ctx.strokeRect(mirroredX, box.y, box.width, box.height);

                    // Draw confidence label (unmirrored, perfectly readable).
                    if (currentState.confidence > 0) {
                        const threshold = config.matchThreshold || 0.50;
                        const label = (currentState.confidence < threshold)
                            ? '✓ Dist: ' + currentState.confidence.toFixed(2)
                            : '✗ Dist: ' + currentState.confidence.toFixed(2);
                        ctx.fillStyle = color;
                        ctx.font = '12px Inter, sans-serif';
                        ctx.fillText(label, mirroredX, box.y - 5);
                    }
                });
            }

            // Draw object detection bounding boxes (if any).
            if (objectDetectorReady) {
                var objState = ObjectDetector.getState();
                if (objState.detections && objState.detections.length > 0) {
                    // Calculate scale factors from video native size to display size.
                    var scaleX = displaySize.width / (videoEl.videoWidth || 640);
                    var scaleY = displaySize.height / (videoEl.videoHeight || 480);

                    objState.detections.forEach(function (det) {
                        var bbox = det.bbox; // [x, y, width, height]
                        var isConfirmed = objState.confirmedObjects.indexOf(det.class) !== -1;
                        var objColor = isConfirmed ? '#ff6d00' : '#ffd600';

                        // Scale bounding box to display dimensions.
                        var bx = bbox[0] * scaleX;
                        var by = bbox[1] * scaleY;
                        var bw = bbox[2] * scaleX;
                        var bh = bbox[3] * scaleY;

                        // Mirror X coordinate for overlay alignment with mirrored video.
                        var mirroredObjX = displaySize.width - bx - bw;

                        ctx.strokeStyle = objColor;
                        ctx.lineWidth = isConfirmed ? 3 : 2;
                        ctx.setLineDash(isConfirmed ? [] : [6, 3]);
                        ctx.strokeRect(mirroredObjX, by, bw, bh);
                        ctx.setLineDash([]);

                        // Draw label (unmirrored, readable left-to-right).
                        var label = ObjectDetector.getDisplayLabel(det.class) +
                            ' ' + Math.round(det.score * 100) + '%';
                        ctx.fillStyle = objColor;
                        ctx.font = 'bold 11px Inter, sans-serif';
                        var labelWidth = ctx.measureText(label).width;
                        ctx.fillRect(mirroredObjX, by - 16, labelWidth + 8, 16);
                        ctx.fillStyle = '#000';
                        ctx.fillText(label, mirroredObjX + 4, by - 4);
                    });
                }
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

            // Priority order: phone_detected > talking_detected > looking_away >
            // mismatch > multiple_faces > no_face > error > match.
            const priorityOrder = ['phone_detected', 'talking_detected', 'looking_away', 'mismatch', 'multiple_faces', 'no_face', 'error', 'match'];
            let worstResult = resultBuffer[0];
            let allObjects = [];

            resultBuffer.forEach(function (r) {
                if (r.objectsDetected) {
                    r.objectsDetected.split(',').forEach(function (obj) {
                        const trimmed = obj.trim();
                        if (trimmed && allObjects.indexOf(trimmed) === -1) {
                            allObjects.push(trimmed);
                        }
                    });
                }
                const currentPriority = priorityOrder.indexOf(r.status);
                const worstPriority = priorityOrder.indexOf(worstResult.status);
                if (currentPriority < worstPriority) {
                    worstResult = r;
                }
            });

            // Ensure detected objects are preserved on the worstResult.
            if (allObjects.length > 0 && !worstResult.objectsDetected) {
                worstResult.objectsDetected = allObjects.join(',');
            }

            // A voice episode is flagged from its own callback rather than from
            // the detection loop, so it may lose the priority comparison to a
            // camera violation buffered in the same window. Carry the voice
            // data across to whichever record is actually sent, the same way
            // detected objects are preserved above, so the episode is not
            // silently dropped.
            let voiceData = worstResult.voiceData || '';
            if (!voiceData) {
                for (var v = 0; v < resultBuffer.length; v++) {
                    if (resultBuffer[v].voiceData) {
                        voiceData = resultBuffer[v].voiceData;
                        break;
                    }
                }
            }

            // Use the snapshot captured at the exact moment of the violation.
            let imageData = worstResult.imageData || '';

            // If worstResult has no imageData but another violation in buffer has one, use that.
            if (!imageData) {
                for (var i = 0; i < resultBuffer.length; i++) {
                    if (resultBuffer[i].imageData) {
                        imageData = resultBuffer[i].imageData;
                        break;
                    }
                }
            }

            // Clear buffer before sending to avoid race conditions.
            resultBuffer = [];

            // If there were no violations in this batch (perfect match), do NOT send network request.
            if (worstResult.status === 'match') {
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
                    imagedata: imageData,
                    objectsdetected: worstResult.objectsDetected || '',
                    gazedata: worstResult.gazeData || '',
                    voicedata: voiceData,
                    timestamp: Math.floor((worstResult.timestamp || Date.now()) / 1000)
                }
            }])[0].then(function (result) {
                if (result.success) {
                    console.log('[Proctor] Violation report sent, logId:', result.logid, 'status:', worstResult.status, 'objects:', worstResult.objectsDetected);
                }
            }).catch(function (err) {
                console.error('[Proctor] Failed to send report:', err);
            });
        }

        /**
         * Update the overlay UI based on the current detection state.
         */
        function updateOverlayFromState() {
            const indicator = document.getElementById('proctor-indicator');
            const statusText = document.getElementById('proctor-status-text');
            const title = document.getElementById('proctor-overlay-title');

            if (!indicator || !statusText) {
                return;
            }

            switch (currentState.faceStatus) {
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

                case 'phone_detected':
                    indicator.className = 'proctor-overlay-indicator proctor-status-phone';
                    statusText.textContent = 'Prohibited object detected';
                    title.textContent = 'Proctoring ⚠';
                    showWarning('Prohibited object detected — please don\'t use unfair means.');
                    break;

                case 'looking_away':
                    indicator.className = 'proctor-overlay-indicator proctor-status-gaze';
                    statusText.textContent = 'Looking away from screen';
                    title.textContent = 'Proctoring ⚠';
                    showWarning('Please look at the screen. Gaze tracking active.');
                    break;

                case 'talking_detected':
                    indicator.className = 'proctor-overlay-indicator proctor-status-talking';
                    statusText.textContent = 'Continuous speech detected';
                    title.textContent = 'Proctoring ⚠';
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
        }

        /**
         * Show the overlay warning banner.
         *
         * @param {string} message Warning message.
         */
        function showWarning(message) {
            const warning = document.getElementById('proctor-warning');
            const warningText = document.getElementById('proctor-warning-text');

            if (!warning || !warningText) {
                return;
            }

            warning.style.display = 'block';
            warningText.textContent = message;

            // Auto-hide after 5 seconds. The timer is tracked so that a later
            // warning cannot be cut short by an earlier one's timeout firing.
            if (warningHideTimer) {
                clearTimeout(warningHideTimer);
            }
            warningHideTimer = setTimeout(function () {
                warningHideTimer = null;
                const el = document.getElementById('proctor-warning');
                if (el) {
                    el.style.display = 'none';
                }
            }, 5000);
        }

        /**
         * Hide the overlay warning banner, unless it is still within its
         * auto-hide window.
         *
         * This runs on every clean detection cycle, which at a 2s capture
         * interval would otherwise cut a warning short almost immediately —
         * most visibly for voice warnings, which are raised between cycles
         * and would be wiped by the very next clean frame. Leaving the
         * pending timer to do the hiding guarantees every warning stays up
         * long enough to actually be read.
         */
        function hideWarning() {
            if (warningHideTimer) {
                return;
            }
            const warning = document.getElementById('proctor-warning');
            if (warning) {
                warning.style.display = 'none';
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

            if (warningHideTimer) {
                clearTimeout(warningHideTimer);
                warningHideTimer = null;
            }

            // Stop object detector.
            ObjectDetector.stop();

            // Release the microphone.
            VoiceDetector.stop();

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
