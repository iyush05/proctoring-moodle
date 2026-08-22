/**
 * Preflight check module — webcam setup and face verification before quiz start.
 *
 * @module     quizaccess_proctor/preflight
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
define(['core/notification'], function (Notification) {

    /** @type {HTMLVideoElement} */
    let videoEl = null;
    /** @type {MediaStream} */
    let stream = null;
    /** @type {boolean} */
    let modelsLoaded = false;
    /** @type {Object} */
    let config = {};

    /** @type {MediaStream|null} Microphone stream used for the level preview. */
    let micStream = null;

    /** @type {AudioContext|null} Audio context for the microphone level preview. */
    let micContext = null;

    /**
     * Initialize the preflight webcam check.
     *
     * @param {Object} cfg Configuration from PHP.
     */
    async function init(cfg) {
        config = cfg;

        videoEl = document.getElementById('proctor-preflight-video');
        if (!videoEl) {
            return;
        }

        // Microphone setup runs independently of the camera checks: it must
        // still be attempted if the camera fails, and a mic failure must not
        // abort the camera preview.
        if (config.voiceDetectionEnabled) {
            startMicCheck();
        } else {
            // Logged rather than passed over silently: "no microphone prompt
            // appeared" is otherwise indistinguishable from a broken pipeline,
            // when the usual cause is simply that the quiz has voice detection
            // switched off.
            console.log(
                '[Proctor Preflight] Voice detection is disabled for this quiz — ' +
                'microphone not requested. Enable it in Quiz settings > ' +
                'Extra restrictions on attempts > Enable voice detection.'
            );
        }

        try {
            // Step 1: Start webcam.
            await startCamera();
            updateStatus('proctor-camera-status', 'success', 'Camera ready');

            // Step 2: Load models.
            await loadModels();
            updateStatus('proctor-model-status', 'success', 'Models loaded');

            // Step 3: Start live face detection preview.
            startPreviewDetection();

        } catch (err) {
            console.error('[Proctor Preflight]', err);
            updateStatus('proctor-camera-status', 'error', 'Error: ' + err.message);
        }
    }

    /**
     * Request microphone access and show a live input level, so the student
     * can confirm the microphone actually works before starting the attempt
     * rather than discovering it mid-quiz.
     *
     * Only the input level is measured here — no speech detection runs during
     * preflight, and nothing is recorded or sent anywhere.
     */
    async function startMicCheck() {
        const levelBar = document.getElementById('proctor-mic-level-bar');

        try {
            updateStatus('proctor-mic-status', 'warning', 'Requesting microphone access...');

            micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    // Must match the capture settings used during the attempt,
                    // or the level shown here misrepresents what the detector
                    // will actually see. See voice_detector.js for why all
                    // three processing features stay off.
                    autoGainControl: false,
                    noiseSuppression: false,
                    echoCancellation: false,
                    channelCount: 1
                },
                video: false
            });

            const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextCtor) {
                throw new Error('Web Audio API unavailable');
            }

            micContext = new AudioContextCtor();
            if (micContext.state === 'suspended') {
                await micContext.resume();
            }

            const source = micContext.createMediaStreamSource(micStream);
            const analyser = micContext.createAnalyser();
            analyser.fftSize = 1024;
            source.connect(analyser);

            const samples = new Float32Array(analyser.fftSize);

            updateStatus('proctor-mic-status', 'success', 'Microphone ready — speak to test');

            // A plain rAF loop is fine here: this is only a visual meter, so a
            // dropped frame costs nothing. The attempt page uses an
            // AudioWorklet instead, where timing accuracy actually matters.
            const drawLevel = function () {
                if (!micContext || !levelBar) {
                    return;
                }

                analyser.getFloatTimeDomainData(samples);

                let sumSquares = 0;
                for (let i = 0; i < samples.length; i++) {
                    sumSquares += samples[i] * samples[i];
                }
                const rms = Math.sqrt(sumSquares / samples.length);

                // 0.15 RMS is roughly a normal speaking voice at desk distance,
                // so ordinary speech fills most of the bar without clipping.
                const level = Math.min(100, Math.round((rms / 0.15) * 100));
                levelBar.style.width = level + '%';

                requestAnimationFrame(drawLevel);
            };
            requestAnimationFrame(drawLevel);

        } catch (err) {
            console.error('[Proctor Preflight] Microphone error:', err);
            updateStatus(
                'proctor-mic-status',
                'error',
                'Microphone unavailable — please allow microphone access'
            );
        }
    }

    /**
     * Start the webcam for preflight preview.
     */
    async function startCamera() {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 480 }, height: { ideal: 360 }, facingMode: 'user' },
            audio: false
        });
        videoEl.srcObject = stream;
        await videoEl.play();
    }

    /**
     * Load face-api.js models.
     */
    async function loadModels() {
        if (typeof faceapi === 'undefined') {
            throw new Error('face-api.js not loaded');
        }
        await Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(config.modelUrl),
            faceapi.nets.faceLandmark68Net.loadFromUri(config.modelUrl), // Using full landmark model for better alignment (handles glasses better).
            faceapi.nets.faceRecognitionNet.loadFromUri(config.modelUrl),
        ]);
        modelsLoaded = true;
    }

    /**
     * Run live face detection on the preflight video to give instant feedback.
     */
    function startPreviewDetection() {
        const faceOverlay = document.getElementById('proctor-face-overlay');

        async function detectLoop() {
            if (!videoEl || videoEl.paused || !modelsLoaded) {
                requestAnimationFrame(detectLoop);
                return;
            }

            try {
                const detections = await faceapi
                    .detectAllFaces(videoEl, new faceapi.TinyFaceDetectorOptions({
                        inputSize: 416,
                        scoreThreshold: 0.4
                    }))
                    .withFaceLandmarks() // Use full 68-point landmarks
                    .withFaceDescriptors();

                if (detections.length === 1) {
                    updateStatus('proctor-face-status', 'success', 'Face detected ✓');
                    if (faceOverlay) {
                        faceOverlay.classList.add('face-found');
                        faceOverlay.classList.remove('face-missing');
                    }

                    // Try matching with profile picture.
                    if (config.hasProfilePic && config.profileImageUrl) {
                        await matchWithProfile(detections[0].descriptor);
                    }
                } else if (detections.length === 0) {
                    updateStatus('proctor-face-status', 'warning', 'No face detected — look at camera');
                    if (faceOverlay) {
                        faceOverlay.classList.remove('face-found');
                        faceOverlay.classList.add('face-missing');
                    }
                } else {
                    updateStatus('proctor-face-status', 'warning', 'Multiple faces — only you should be visible');
                    if (faceOverlay) {
                        faceOverlay.classList.remove('face-found');
                        faceOverlay.classList.add('face-missing');
                    }
                }
            } catch (e) {
                // Silently retry.
            }

            // Run again after a short delay (every ~1 second for preflight).
            setTimeout(function () {
                requestAnimationFrame(detectLoop);
            }, 1000);
        }

        requestAnimationFrame(detectLoop);
    }

    /** @type {Float32Array|null} Cached profile descriptor. */
    let profileDescriptor = null;

    /**
     * Match detected face with profile picture.
     *
     * @param {Float32Array} liveDescriptor Current face descriptor.
     */
    async function matchWithProfile(liveDescriptor) {
        // Load profile descriptor once.
        if (profileDescriptor === null) {
            updateStatus('proctor-profile-status', 'warning', 'Loading profile picture...');
            try {
                const img = await loadImage(config.profileImageUrl);
                updateStatus('proctor-profile-status', 'warning', 'Detecting face in profile...');

                const det = await faceapi
                    .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.1 }))
                    .withFaceLandmarks() // Use full 68-point landmarks
                    .withFaceDescriptor();

                if (det) {
                    profileDescriptor = det.descriptor;
                    updateStatus('proctor-profile-status', 'success', 'Profile face loaded');
                } else {
                    profileDescriptor = false; // Mark as failed
                    updateStatus('proctor-profile-status', 'error', 'No face found in profile picture!');
                }
            } catch (e) {
                profileDescriptor = false; // Mark as failed
                updateStatus('proctor-profile-status', 'error', 'Failed to load profile image: ' + e.message);
                return;
            }
        }

        if (profileDescriptor) {
            const distance = faceapi.euclideanDistance(liveDescriptor, profileDescriptor);
            const threshold = config.matchThreshold || 0.50;

            if (distance < threshold) {
                updateStatus('proctor-face-status', 'success',
                    'Face matched with profile (Distance: ' + distance.toFixed(2) + ' < ' + threshold + ')');
            } else {
                updateStatus('proctor-face-status', 'error',
                    'Face does not match profile (Distance: ' + distance.toFixed(2) + ' > ' + threshold + ')');
            }
        }
    }

    /**
     * Load an image from URL.
     *
     * @param {string} url
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
            img.onerror = function () { reject(new Error('Failed to load image')); };
            img.src = url;
        });
    }

    /**
     * Update a preflight status item.
     *
     * @param {string} elementId DOM element ID.
     * @param {string} status 'success', 'warning', or 'error'.
     * @param {string} message Status message text.
     */
    function updateStatus(elementId, status, message) {
        const el = document.getElementById(elementId);
        if (!el) {
            return;
        }

        const icon = el.querySelector('.proctor-status-icon');
        const text = el.querySelector('span:last-child');

        if (icon) {
            icon.textContent = ''; // Ensure no emojis are injected, CSS handles graphics
        }
        if (text) {
            text.textContent = message;
        }

        // Update element class for styling.
        el.className = 'proctor-status-item proctor-status-' + status;
    }

    return {
        init: init
    };
});
