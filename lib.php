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
 * Shared helper functions for quizaccess_proctor.
 *
 * Holds logic used by both report.php (rendering the student list) and
 * classes/external/get_student_flags.php (paginated AJAX fetches of one
 * student's flags) — a single place for the status/type mapping and the
 * per-flag-card HTML, so the two can never drift apart.
 *
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

/**
 * Map a detection status onto one of the report's filterable type buckets.
 *
 * @param string $status Raw log status (e.g. 'looking_away').
 * @return string One of 'face', 'gaze', 'object', 'voice', 'other'.
 */
function quizaccess_proctor_flag_type(string $status): string {
    switch ($status) {
        case 'match':
        case 'mismatch':
        case 'no_face':
        case 'multiple_faces':
            return 'face';
        case 'looking_away':
            return 'gaze';
        case 'phone_detected':
            return 'object';
        case 'talking_detected':
            return 'voice';
        default:
            return 'other';
    }
}

/**
 * The inverse of quizaccess_proctor_flag_type(): every raw status belonging
 * to a given type bucket, for building a SQL status filter.
 *
 * @param string $type One of 'face', 'gaze', 'object', 'voice', 'other'.
 * @return array<string> Raw statuses in that bucket, empty if $type is unknown.
 */
function quizaccess_proctor_type_statuses(string $type): array {
    switch ($type) {
        case 'face':
            return ['match', 'mismatch', 'no_face', 'multiple_faces'];
        case 'gaze':
            return ['looking_away'];
        case 'object':
            return ['phone_detected'];
        case 'voice':
            return ['talking_detected'];
        case 'other':
            return ['error'];
        default:
            return [];
    }
}

/**
 * Render one flag as the HTML card used in the report's expandable
 * per-student flag list.
 *
 * Expects $log to carry every quizaccess_proctor_logs column plus
 * reviewer_firstname, reviewer_lastname, attempt_timestart, and
 * attempt_number — the same shape both report.php's (now removed) inline
 * rendering and classes/external/get_student_flags.php's detail query
 * produce.
 *
 * @param stdClass $log One log row with the joined reviewer/attempt fields.
 * @return string HTML for one .proctor-flag-card.
 */
function quizaccess_proctor_render_flag_card(stdClass $log): string {
    static $statusmap = null;
    static $objecticons = null;

    if ($statusmap === null) {
        $statusmap = [
            'match'          => ['class' => 'proctor-badge-match',     'label' => get_string('status_match', 'quizaccess_proctor')],
            'mismatch'       => ['class' => 'proctor-badge-mismatch',  'label' => get_string('status_mismatch', 'quizaccess_proctor')],
            'no_face'        => ['class' => 'proctor-badge-noface',    'label' => get_string('status_noface', 'quizaccess_proctor')],
            'multiple_faces' => ['class' => 'proctor-badge-multiface', 'label' => get_string('status_multiface', 'quizaccess_proctor')],
            'phone_detected' => ['class' => 'proctor-badge-phone',     'label' => get_string('status_phone', 'quizaccess_proctor')],
            'looking_away'   => ['class' => 'proctor-badge-gaze',      'label' => get_string('snapshotstatus_looking_away', 'quizaccess_proctor')],
            'talking_detected' => ['class' => 'proctor-badge-talking', 'label' => get_string('snapshotstatus_talking_detected', 'quizaccess_proctor')],
            'error'          => ['class' => 'proctor-badge-error',     'label' => get_string('status_error', 'quizaccess_proctor')],
            'active'         => ['class' => 'proctor-badge-active',    'label' => get_string('status_active', 'quizaccess_proctor')],
        ];
        $objecticons = [
            'cell phone' => '📱',
            'book'       => '📖',
            'laptop'     => '💻',
            'remote'     => '🎮',
            'tv'         => '📺',
        ];
    }

    $type = quizaccess_proctor_flag_type($log->status);
    $reviewstatus = $log->review_status ?: 'pending';
    $badge = $statusmap[$log->status] ?? $statusmap['error'];

    ob_start();

    echo '<div class="proctor-flag-card" data-logid="' . $log->id . '" data-type="' . $type
        . '" data-review="' . $reviewstatus . '">';

    echo '<div class="proctor-flag-main">';
    echo '<span class="proctor-badge ' . $badge['class'] . '">' . $badge['label'] . '</span>';

    $servertimestr = userdate($log->timecreated, '%d %b %Y, %H:%M:%S');
    echo '<span class="proctor-flag-time" data-timestamp="' . $log->timecreated . '" title="'
        . s($servertimestr) . '">' . s($servertimestr) . '</span>';

    if (!empty($log->attempt_timestart) && $log->timecreated >= $log->attempt_timestart) {
        $elapsed = $log->timecreated - $log->attempt_timestart;
        $elapsedstr = sprintf('+%02d:%02d', floor($elapsed / 60), $elapsed % 60);
        echo '<span class="proctor-badge-elapsed" title="' . get_string('elapsed_since_start', 'quizaccess_proctor') . '">'
            . s($elapsedstr) . '</span>';
    }

    $attemptlabel = !empty($log->attempt_number) ? get_string('attempt', 'quiz', $log->attempt_number) : '#' . $log->attemptid;
    $attempturl = new moodle_url('/mod/quiz/review.php', ['attempt' => $log->attemptid]);
    echo '<a href="' . $attempturl . '" target="_blank" class="proctor-flag-attempt-link">' . s($attemptlabel) . '</a>';

    if ($log->confidence > 0) {
        $percent = round((1 - $log->confidence) * 100, 1);
        echo '<span class="proctor-flag-detail">' . $percent . '% (d=' . round($log->confidence, 3) . ')</span>';
    }

    if (!empty($log->objects_detected)) {
        foreach (explode(',', $log->objects_detected) as $obj) {
            $obj = trim($obj);
            if ($obj === '') {
                continue;
            }
            $icon = $objecticons[$obj] ?? '⚠';
            echo '<span class="proctor-object-pill"><span class="proctor-pill-icon">' . $icon . '</span>'
                . s(ucfirst($obj)) . '</span>';
        }
    }

    if (!empty($log->gaze_data)) {
        $gaze = explode(',', $log->gaze_data);
        if (count($gaze) >= 3) {
            $dir = get_string('direction_' . trim($gaze[0]), 'quizaccess_proctor');
            $gazeobj = (object) ['direction' => $dir, 'yaw' => trim($gaze[1]), 'pitch' => trim($gaze[2])];
            echo '<span class="proctor-flag-detail">' . get_string('gaze_data_log', 'quizaccess_proctor', $gazeobj) . '</span>';
        }
    }

    if (!empty($log->voice_data)) {
        $voice = explode(',', $log->voice_data);
        if (count($voice) >= 3) {
            $voiceobj = (object) [
                'duration'   => format_float((float) trim($voice[1]), 1),
                'confidence' => format_float((float) trim($voice[2]), 2),
            ];
            echo '<span class="proctor-flag-detail">' . get_string('voice_data_log', 'quizaccess_proctor', $voiceobj) . '</span>';
        }
    }

    if (!empty($log->image_data)) {
        echo '<img src="' . s($log->image_data) . '" class="proctor-snapshot-thumb" alt="Snapshot" '
            . 'onclick="window.proctorOpenModal && window.proctorOpenModal(this.src)" />';
    }

    echo '</div>'; // End proctor-flag-main.

    echo '<div class="proctor-flag-review" data-review-panel>';

    $reviewerlabel = '';
    if ($reviewstatus !== 'pending' && !empty($log->reviewer_firstname)) {
        $reviewer = fullname((object) [
            'firstname' => $log->reviewer_firstname, 'lastname' => $log->reviewer_lastname,
        ]);
        $reviewerlabel = get_string('reviewed_by_at', 'quizaccess_proctor', (object) [
            'name' => $reviewer,
            'time' => userdate($log->reviewed_at, '%d %b, %H:%M'),
        ]);
    }

    echo '<span class="proctor-review-label" data-review-label>' . s($reviewerlabel) . '</span>';
    echo '<button type="button" class="btn btn-sm btn-outline-success proctor-btn-confirm" data-action="confirmed">'
        . get_string('action_confirm', 'quizaccess_proctor') . '</button>';
    echo '<button type="button" class="btn btn-sm btn-outline-secondary proctor-btn-dismiss" data-action="dismissed">'
        . get_string('action_dismiss', 'quizaccess_proctor') . '</button>';
    echo '<button type="button" class="btn btn-sm btn-link proctor-btn-undo" data-action="pending">'
        . get_string('action_undo', 'quizaccess_proctor') . '</button>';

    echo '</div>'; // End proctor-flag-review.
    echo '</div>'; // End proctor-flag-card.

    return ob_get_clean();
}
