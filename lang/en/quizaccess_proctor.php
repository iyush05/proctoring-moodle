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
 * Language strings for quizaccess_proctor.
 *
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

// Plugin metadata.
$string['pluginname'] = 'AI Proctoring (Face Detection)';
$string['privacy:metadata'] = 'The AI Proctoring plugin captures webcam snapshots and face detection data during quiz attempts for identity verification.';

// Quiz settings.
$string['enable_proctoring'] = 'Enable AI proctoring';
$string['enable_proctoring_help'] = 'When enabled, students will be required to allow webcam access during quiz attempts. The system will continuously verify their identity using face detection and matching against their profile picture.';

// Quiz view page.
$string['quiz_requires_proctoring'] = 'This quiz requires AI proctoring. Your webcam will be used to verify your identity during the attempt.';
$string['view_report'] = 'View proctoring report';

// Preflight check.
$string['preflight_header'] = 'AI Proctoring — Webcam Setup';
$string['preflight_description'] = 'This quiz requires webcam proctoring. Please allow camera access and ensure your face is clearly visible. Your identity will be verified against your profile picture throughout the quiz.';
$string['consent_label'] = 'I understand and consent to webcam monitoring during this quiz attempt';
$string['consent_required'] = 'You must agree to webcam proctoring to start this quiz.';

// Status messages.
$string['status_camera_init'] = 'Initialising camera...';
$string['status_camera_ready'] = 'Camera ready';
$string['status_camera_error'] = 'Camera access denied';
$string['status_model_loading'] = 'Loading face detection models...';
$string['status_model_ready'] = 'Face detection models loaded';
$string['status_model_error'] = 'Failed to load face detection models';
$string['status_face_waiting'] = 'Waiting for face detection...';
$string['status_face_detected'] = 'Face detected';
$string['status_face_matched'] = 'Identity verified';
$string['status_face_mismatch'] = 'Face does not match profile';
$string['status_no_face'] = 'No face detected — please look at the camera';
$string['status_multiple_faces'] = 'Multiple faces detected — only one person allowed';
$string['status_no_profile_pic'] = 'No profile picture — face matching unavailable';

// Proctoring overlay.
$string['proctoring_active'] = 'Proctoring Active';
$string['face_matched'] = 'Identity Verified';
$string['face_mismatch_warning'] = 'Warning: Face mismatch detected';
$string['no_face_warning'] = 'Warning: No face detected';
$string['multiple_faces_warning'] = 'Warning: Multiple faces detected';

// Report page.
$string['report_title'] = 'Proctoring Report';
$string['report_student'] = 'Student';
$string['report_attempt'] = 'Attempt';
$string['report_time'] = 'Time';
$string['report_status'] = 'Status';
$string['report_confidence'] = 'Confidence';
$string['report_snapshot'] = 'Snapshot';
$string['report_summary'] = 'Summary';
$string['report_total_checks'] = 'Total checks';
$string['report_match_rate'] = 'Match rate';
$string['report_violations'] = 'Violations';
$string['report_no_logs'] = 'No proctoring logs found for this quiz.';
$string['report_back'] = 'Back to quiz';

// Status labels for report.
$string['status_match'] = 'Match';
$string['status_mismatch'] = 'Mismatch';
$string['status_noface'] = 'No face';
$string['status_multiface'] = 'Multiple faces';
$string['status_error'] = 'Error';
$string['status_active'] = 'Active';

// Errors.
$string['error_no_camera'] = 'Unable to access webcam. Please ensure your camera is connected and you have granted permission.';
$string['error_model_load'] = 'Failed to load face detection models. Please refresh the page and try again.';
