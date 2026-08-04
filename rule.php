<?php
// This file is part of Moodle - http://moodle.org/
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <http://www.gnu.org/licenses/>.

/**
 * Implementation of the quizaccess_proctor plugin.
 *
 * This access rule plugin integrates AI-powered face detection proctoring
 * into Moodle quiz attempts. It uses client-side face-api.js to continuously
 * detect and match the student's face against their profile picture.
 *
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

use mod_quiz\local\access_rule_base;
use mod_quiz\form\preflight_check_form;

/**
 * Quiz access rule that implements AI proctoring with face detection.
 */
class quizaccess_proctor extends access_rule_base {

    /**
     * Return an appropriately configured instance of this rule, if applicable.
     *
     * @param \mod_quiz\quiz_settings $quizobj information about the quiz.
     * @param int $timenow the time that should be considered as 'now'.
     * @param bool $canignoretimelimits whether the user is exempt from time limits.
     * @return access_rule_base|null the rule, if applicable, else null.
     */
    public static function make(\mod_quiz\quiz_settings $quizobj, $timenow, $canignoretimelimits) {
        if (empty($quizobj->get_quiz()->proctor_enabled)) {
            return null;
        }
        return new self($quizobj, $timenow);
    }

    /**
     * Whether a preflight check is required before the quiz attempt.
     *
     * @param int|null $attemptid the attempt ID.
     * @return bool true if preflight check is required.
     */
    public function is_preflight_check_required($attemptid) {
        // Only require preflight on the quiz view page (before starting attempt).
        $script = $this->get_topmost_script();
        $base = basename($script);
        return ($base === 'view.php');
    }

    /**
     * Get the file path of the topmost script in the call stack.
     *
     * @return string The file path of the topmost script.
     */
    private function get_topmost_script() {
        $backtrace = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS);
        $topframe = array_pop($backtrace);
        return $topframe['file'];
    }

    /**
     * Add preflight check form fields for webcam consent.
     *
     * @param preflight_check_form $quizform the preflight form instance.
     * @param MoodleQuickForm $mform the Moodle form object.
     * @param int $attemptid the quiz attempt ID.
     */
    public function add_preflight_check_form_fields(
        preflight_check_form $quizform,
        MoodleQuickForm $mform,
        $attemptid
    ) {
        global $PAGE, $USER, $CFG;

        // Get the user's profile picture URL.
        $userpicture = new user_picture($USER);
        $userpicture->size = 1; // Large size (f1).
        $profileimageurl = $userpicture->get_url($PAGE)->out(false);

        // Model URL for face-api.js.
        $modelurl = $CFG->wwwroot . '/mod/quiz/accessrule/proctor/thirdparty/models';

        // Load face-api.js library.
        $PAGE->requires->js(
            new moodle_url('/mod/quiz/accessrule/proctor/thirdparty/face-api.min.js'),
            true
        );

        // Prepare config for the JS preflight module.
        $jsconfig = [
            'profileImageUrl' => $profileimageurl,
            'modelUrl'        => $modelurl,
            'hasProfilePic'   => !empty($USER->picture),
            'matchThreshold'  => 0.50,
        ];

        $PAGE->requires->js_call_amd('quizaccess_proctor/preflight', 'init', [$jsconfig]);

        // Add the webcam preview and consent form elements.
        $mform->addElement('html', '<div class="proctor-preflight-container">');

        // Header.
        $mform->addElement('html', '<div class="proctor-preflight-header">');
        $mform->addElement('html', '<h4>' . get_string('preflight_header', 'quizaccess_proctor') . '</h4>');
        $mform->addElement('html', '<p>' . get_string('preflight_description', 'quizaccess_proctor') . '</p>');
        $mform->addElement('html', '</div>');

        // Webcam preview area.
        $mform->addElement('html', '
            <div class="proctor-webcam-setup" id="proctor-webcam-setup">
                <div class="proctor-video-container">
                    <video id="proctor-preflight-video" autoplay muted playsinline></video>
                    <canvas id="proctor-preflight-canvas" style="display:none;"></canvas>
                    <div class="proctor-face-overlay" id="proctor-face-overlay">
                        <div class="proctor-face-guide"></div>
                    </div>
                </div>
                <div class="proctor-status-panel" id="proctor-preflight-status">
                    <div class="proctor-status-item" id="proctor-camera-status">
                        <span class="proctor-status-icon"></span>
                        <span>' . get_string('status_camera_init', 'quizaccess_proctor') . '</span>
                    </div>
                    <div class="proctor-status-item" id="proctor-model-status">
                        <span class="proctor-status-icon"></span>
                        <span>' . get_string('status_model_loading', 'quizaccess_proctor') . '</span>
                    </div>
                    <div class="proctor-status-item" id="proctor-face-status">
                        <span class="proctor-status-icon"></span>
                        <span>' . get_string('status_face_waiting', 'quizaccess_proctor') . '</span>
                    </div>
                    <div class="proctor-status-item" id="proctor-profile-status">
                        <span class="proctor-status-icon"></span>
                        <span>Checking profile picture...</span>
                    </div>
                </div>
            </div>
        ');

        // Hidden field to store the reference face descriptor.
        $mform->addElement('html', '<input type="hidden" id="proctor-reference-descriptor" name="proctor_reference_descriptor" value="" />');
        $mform->addElement('html', '<input type="hidden" id="proctor-profile-image" value="' . s($profileimageurl) . '" />');

        // Consent checkbox wrapper.
        $mform->addElement('html', '<div class="proctor-consent-box">');

        // Consent checkbox.
        $mform->addElement(
            'checkbox',
            'proctor_consent',
            '',
            get_string('consent_label', 'quizaccess_proctor')
        );
        $mform->addRule(
            'proctor_consent',
            get_string('consent_required', 'quizaccess_proctor'),
            'required',
            null,
            'client'
        );

        $mform->addElement('html', '</div>'); // End consent wrapper

        $mform->addElement('html', '</div>'); // End proctor-preflight-container
    }

    /**
     * Validate the preflight check form submission.
     *
     * @param array $data form data submitted by the user.
     * @param array $files files uploaded during form submission.
     * @param array $errors existing validation errors.
     * @param int $attemptid the quiz attempt ID.
     * @return array updated errors array.
     */
    public function validate_preflight_check($data, $files, $errors, $attemptid) {
        if (empty($data['proctor_consent'])) {
            $errors['proctor_consent'] = get_string('consent_required', 'quizaccess_proctor');
        }
        return $errors;
    }

    /**
     * Set up the attempt page with proctoring JavaScript.
     *
     * This is called when the quiz attempt page is being prepared.
     * We inject the face detection JavaScript engine here.
     *
     * @param moodle_page $page the page object to initialise.
     */
    public function setup_attempt_page($page) {
        global $CFG, $DB, $COURSE, $USER;

        $cmid = optional_param('cmid', 0, PARAM_INT);
        $attempt = optional_param('attempt', 0, PARAM_INT);

        $page->set_title($this->quizobj->get_course()->shortname . ': ' . $page->title);
        $page->set_popup_notification_allowed(false);
        $page->set_heading($page->title);

        if ($cmid) {
            // Get the user's profile picture URL.
            $userpicture = new user_picture($USER);
            $userpicture->size = 1;
            $profileimageurl = $userpicture->get_url($page)->out(false);

            // Model URL for face-api.js.
            $modelurl = $CFG->wwwroot . '/mod/quiz/accessrule/proctor/thirdparty/models';

            // Load face-api.js library.
            $page->requires->js(
                new moodle_url('/mod/quiz/accessrule/proctor/thirdparty/face-api.min.js'),
                true
            );

            // Load TensorFlow.js and COCO-SSD for object detection.
            $page->requires->js(
                new moodle_url('/mod/quiz/accessrule/proctor/thirdparty/tf.min.js'),
                true
            );
            $page->requires->js(
                new moodle_url('/mod/quiz/accessrule/proctor/thirdparty/coco-ssd.min.js'),
                true
            );

            // Insert a proctoring session log.
            $record = (object) [
                'courseid'    => $COURSE->id,
                'quizid'      => $this->quiz->id,
                'userid'      => $USER->id,
                'attemptid'   => $attempt,
                'status'      => 'active',
                'confidence'  => 0,
                'timecreated' => time(),
            ];
            $logid = $DB->insert_record('quizaccess_proctor_logs', $record);

            // Prepare config for the proctoring JS.
            $jsconfig = [
                'logId'           => $logid,
                'attemptId'       => $attempt,
                'quizId'          => $this->quiz->id,
                'courseId'        => $COURSE->id,
                'cmId'            => $cmid,
                'profileImageUrl' => $profileimageurl,
                'hasProfilePic'   => !empty($USER->picture),
                'modelUrl'        => $modelurl,
                'captureInterval' => 2000,  // Face detection every 2 seconds.
                'reportInterval'  => 15000, // Send report to server every 15 seconds.
                'matchThreshold'  => 0.50,  // Stricter Euclidean distance threshold (default was 0.6).
                'quizUrl'         => (new moodle_url('/mod/quiz/view.php', ['id' => $cmid]))->out(),
                // Object detection config.
                'objectDetectionEnabled'     => true,
                'cocoModelUrl'               => $CFG->wwwroot
                    . '/mod/quiz/accessrule/proctor/thirdparty/coco-ssd-model/model.json',
                'objectDetectionInterval'    => 3000,  // Object detection every 3 seconds.
                'objectPersistenceThreshold' => 2,     // Must appear in 2 consecutive frames.
                'objectScoreThreshold'       => 0.5,   // 50% minimum confidence.
                'prohibitedObjects'          => ['cell phone', 'book', 'laptop'],
            ];

            $page->requires->js_call_amd('quizaccess_proctor/proctoring', 'init', [$jsconfig]);
        }
    }

    /**
     * Add settings form fields to the quiz settings form.
     *
     * @param mod_quiz_mod_form $quizform the quiz settings form.
     * @param MoodleQuickForm $mform the Moodle form wrapper.
     */
    public static function add_settings_form_fields($quizform, MoodleQuickForm $mform) {
        $mform->addElement(
            'select',
            'proctor_enabled',
            get_string('enable_proctoring', 'quizaccess_proctor'),
            [
                0 => get_string('no'),
                1 => get_string('yes'),
            ]
        );
        $mform->addHelpButton('proctor_enabled', 'enable_proctoring', 'quizaccess_proctor');
        $mform->setDefault('proctor_enabled', 0);
    }

    /**
     * Save quiz-level proctoring settings.
     *
     * @param stdClass $quiz the quiz data from the form.
     */
    public static function save_settings($quiz) {
        global $DB;

        if (empty($quiz->proctor_enabled)) {
            $DB->delete_records('quizaccess_proctor', ['quizid' => $quiz->id]);
        } else {
            if (!$DB->record_exists('quizaccess_proctor', ['quizid' => $quiz->id])) {
                $record = (object) [
                    'quizid'          => $quiz->id,
                    'proctor_enabled' => 1,
                ];
                $DB->insert_record('quizaccess_proctor', $record);
            }
        }
    }

    /**
     * Delete quiz-level proctoring settings when the quiz is deleted.
     *
     * @param stdClass $quiz the quiz data.
     */
    public static function delete_settings($quiz) {
        global $DB;
        $DB->delete_records('quizaccess_proctor', ['quizid' => $quiz->id]);
        $DB->delete_records('quizaccess_proctor_logs', ['quizid' => $quiz->id]);
    }

    /**
     * Return SQL needed to load settings from the plugin in one query.
     *
     * @param int $quizid the quiz ID.
     * @return array fields, joins, params.
     */
    public static function get_settings_sql($quizid): array {
        return [
            'proctor.proctor_enabled AS proctor_enabled',
            'LEFT JOIN {quizaccess_proctor} proctor ON proctor.quizid = quiz.id',
            [],
        ];
    }

    /**
     * Information to display on the quiz view page about this restriction.
     *
     * @return array messages explaining the restriction.
     */
    public function description(): array {
        global $PAGE;

        $messages = [get_string('quiz_requires_proctoring', 'quizaccess_proctor')];

        // Add link to proctoring report for teachers.
        $context = context_module::instance($this->quiz->cmid, MUST_EXIST);
        if (has_capability('quizaccess/proctor:viewreport', $context)) {
            $reporturl = new moodle_url(
                '/mod/quiz/accessrule/proctor/report.php',
                [
                    'cmid'     => $this->quiz->cmid,
                    'courseid' => $this->quiz->course,
                ]
            );
            $messages[] = \html_writer::link(
                $reporturl,
                get_string('view_report', 'quizaccess_proctor'),
                ['class' => 'btn btn-secondary btn-sm']
            );
        }

        return $messages;
    }

    /**
     * This is called when the current attempt at the quiz is finished.
     */
    public function current_attempt_finished() {
        // The JS module will handle cleanup on the client side.
    }
}
