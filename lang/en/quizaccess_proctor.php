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
$string['privacy:metadata'] = 'The AI Proctoring plugin captures webcam snapshots and face detection data during quiz attempts for identity verification. When voice detection is enabled it also analyses microphone input in the browser to detect continuous speech; no audio is recorded, transmitted, or stored, and only the duration and confidence of a flagged speech episode are saved.';

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
$string['status_phone'] = 'Phone/object detected';
$string['status_phone_detected'] = 'Phone/object detected';
$string['snapshotstatus_error'] = 'Detection Error';
$string['snapshotstatus_looking_away'] = 'Looking Away';
$string['objectdetected'] = 'Prohibited Object Detected';
$string['objectdetected_help'] = 'A prohibited object (e.g., cell phone, book) was detected in the webcam feed.';

// Gaze Tracking strings.
$string['gazewarning'] = 'Please look at the screen';
$string['gazestatus'] = 'Gaze: {$a}';
$string['direction_center'] = 'Looking Forward';
$string['direction_left'] = 'Looking Left';
$string['direction_right'] = 'Looking Right';
$string['direction_up'] = 'Looking Up';
$string['direction_down'] = 'Looking Down';
$string['gazeviolations'] = 'Gaze Violations';
$string['gaze_data_log'] = 'Gaze: {$a->direction} (Y:{$a->yaw}°, P:{$a->pitch}°)';
$string['loading_object_detection'] = 'Loading object detection model...';
$string['object_detection_ready'] = 'Object detection active';
$string['report_objects'] = 'Objects';
$string['report_object_detections'] = 'Object detections';

// Gaze thresholds settings.
$string['gaze_yaw_left_threshold'] = 'Gaze Yaw Left Threshold (degrees)';
$string['gaze_yaw_left_threshold_help'] = 'How far left a student can look before a gaze violation is triggered. This is a ceiling: a student\'s own calibration at the start of their attempt may tighten this for their setup, but can never exceed it. Default is 30 degrees.';
$string['gaze_yaw_right_threshold'] = 'Gaze Yaw Right Threshold (degrees)';
$string['gaze_yaw_right_threshold_help'] = 'How far right a student can look before a gaze violation is triggered. This is a ceiling: a student\'s own calibration at the start of their attempt may tighten this for their setup, but can never exceed it. Default is 30 degrees.';
$string['gaze_pitch_up_threshold'] = 'Gaze Pitch Up Threshold (degrees)';
$string['gaze_pitch_up_threshold_help'] = 'How far up a student can look before a gaze violation is triggered. This is a ceiling — see the yaw threshold help for how student calibration interacts with it. Default is 20 degrees.';
$string['gaze_pitch_down_threshold'] = 'Gaze Pitch Down Threshold (degrees)';
$string['gaze_pitch_down_threshold_help'] = 'How far down a student can look before a gaze violation is triggered. Set slightly higher to allow looking at the keyboard. This is a ceiling — see the yaw threshold help for how student calibration interacts with it. Default is 25 degrees.';
$string['gaze_calibration_helper'] = 'Camera calibration';
$string['gaze_calibration_helper_help'] = 'Optional: instead of guessing reasonable degree values for the four thresholds above, run this camera-based calibration once (using your own webcam) and it will fill them in for you. It measures how far you need to look to reach the edges of your screen — the same way each student is calibrated at the start of their own attempt — and adds a safety margin on top, since this becomes a ceiling shared by every student taking the quiz, not a personal setting.';
$string['gaze_run_calibration'] = 'Run camera calibration';

// Voice detection settings.
$string['enable_voice_detection'] = 'Enable voice detection';
$string['enable_voice_detection_help'] = 'When enabled, students must allow microphone access during the attempt, and continuous speech longer than the limit below is flagged. Detection runs entirely in the student\'s browser: no audio is recorded, transmitted, or stored, and no voice identification is performed — only the duration of a flagged episode is logged.';
$string['voice_max_continuous_speech'] = 'Maximum continuous speech (seconds)';
$string['voice_max_continuous_speech_help'] = 'How long a student may speak without a meaningful pause before a violation is flagged. Brief pauses between words and sentences do not reset the timer, so this measures a genuine stretch of talking. Keep it high enough that a cough or a single short remark can never reach it — the default of 8 seconds catches reading a question or answer aloud while ignoring incidental noise.';

// Voice detection status and reporting.
$string['status_mic_init'] = 'Initialising microphone...';
$string['mic_consent_label'] = 'I understand and consent to microphone monitoring for speech detection during this quiz attempt';
$string['mic_consent_required'] = 'You must agree to microphone monitoring to start this quiz.';
$string['snapshotstatus_talking_detected'] = 'Talking Detected';
$string['voicewarning'] = 'Continuous speech detected — please do not talk during the quiz.';
$string['voiceviolations'] = 'Voice Violations';
$string['report_voice'] = 'Voice';
$string['voice_data_log'] = 'Spoke for {$a->duration}s (confidence {$a->confidence})';

// Report page: student grouping, filters, review workflow.
$string['report_flags_count'] = 'flags';
$string['filter_review_label'] = 'Review status';
$string['filter_type_label'] = 'Detection type';
$string['filter_all'] = 'All';
$string['filter_type_face'] = 'Face';
$string['filter_type_gaze'] = 'Gaze';
$string['filter_type_object'] = 'Object';
$string['filter_type_voice'] = 'Voice';
$string['filter_type_other'] = 'Other';
$string['review_pending'] = 'Pending';
$string['review_confirmed'] = 'Confirmed';
$string['review_dismissed'] = 'Dismissed';
$string['reviewed_by_at'] = '{$a->name}, {$a->time}';
$string['action_confirm'] = 'Confirm';
$string['action_dismiss'] = 'Dismiss';
$string['action_undo'] = 'Undo';
$string['elapsed_since_start'] = 'Elapsed time since attempt start';
$string['mark_review_error'] = 'Could not update the review status — please try again.';
$string['pagination_prev'] = 'Previous';
$string['pagination_next'] = 'Next';
$string['pagination_page_info'] = 'Page {$a->page} of {$a->totalpages} ({$a->total} flags)';
$string['flags_loading'] = 'Loading flags…';
$string['flags_none_match_filter'] = 'No flags match the current filter.';
$string['flags_load_error'] = 'Could not load flags — please try again.';

// Errors.
$string['error_no_camera'] = 'Unable to access webcam. Please ensure your camera is connected and you have granted permission.';
$string['error_no_microphone'] = 'Unable to access the microphone. Please ensure it is connected and you have granted permission.';
$string['error_model_load'] = 'Failed to load face detection models. Please refresh the page and try again.';

