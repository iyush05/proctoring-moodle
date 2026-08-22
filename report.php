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
 * Proctoring report page for teachers.
 *
 * Students are listed first, each collapsed to a one-line summary; clicking
 * a student expands their individual flags. Each flag can be marked
 * confirmed or dismissed, and a filter bar narrows the list by review status
 * or detection type. All of this runs client-side against the page's own
 * data (amd/src/report.js) rather than reloading, since a quiz's flags for
 * one report view are already capped at 500 rows.
 *
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

require_once(__DIR__ . '/../../../../config.php');

$cmid     = required_param('cmid', PARAM_INT);
$courseid = required_param('courseid', PARAM_INT);
$userid   = optional_param('userid', 0, PARAM_INT);

// Get the course module and course.
$cm = get_coursemodule_from_id('quiz', $cmid, 0, false, MUST_EXIST);
$course = $DB->get_record('course', ['id' => $courseid], '*', MUST_EXIST);
$quiz = $DB->get_record('quiz', ['id' => $cm->instance], '*', MUST_EXIST);

// Require login and capability check.
require_login($course, false, $cm);
$context = context_module::instance($cmid);
require_capability('quizaccess/proctor:viewreport', $context);

// Page setup.
$PAGE->set_url(new moodle_url('/mod/quiz/accessrule/proctor/report.php', [
    'cmid'     => $cmid,
    'courseid' => $courseid,
    'userid'   => $userid,
]));
$PAGE->set_title(get_string('report_title', 'quizaccess_proctor'));
$PAGE->set_heading($course->fullname);
$PAGE->set_context($context);

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

echo $OUTPUT->header();
echo $OUTPUT->heading(get_string('report_title', 'quizaccess_proctor') . ': ' . $quiz->name);

// Build the query for logs.
$params = ['quizid' => $quiz->id];
$userwhere = '';
if ($userid) {
    $userwhere = ' AND l.userid = :userid';
    $params['userid'] = $userid;
}

/**
 * @var int Most flag rows fetched per student for the expandable detail
 * panel. A flat "most recent 500 flags overall" cap — what this report used
 * before being restructured — silently drops entire students from the page
 * once a single prolific one fills the cap with recent activity: verified
 * against real data where one student's 875 flags left a second student's
 * 61 completely invisible, with nothing on the page indicating a student had
 * been left out. Capping per student instead means every student who has
 * any flag is guaranteed to appear (see the aggregate query below, which is
 * unbounded), and a notice is shown if that student's own history was
 * truncated (see the flag-list rendering below).
 */
const REPORT_MAX_FLAGS_PER_STUDENT = 200;

// Phase 1: an unbounded per-student aggregate. This alone decides which
// students appear on the page, so it must never be capped — counts and last-
// activity time are cheap to compute in SQL across every matching row,
// regardless of how many there are.
$aggsql = "SELECT l.userid,
                  COUNT(l.id) AS total,
                  SUM(CASE WHEN l.review_status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
                  SUM(CASE WHEN l.review_status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed,
                  MAX(l.timecreated) AS lasttime
           FROM {quizaccess_proctor_logs} l
           WHERE l.quizid = :quizid AND l.status != 'active' {$userwhere}
           GROUP BY l.userid";
$aggregates = $DB->get_records_sql($aggsql, $params);

// Overall summary statistics, computed from every matching row via SQL
// rather than by iterating a capped PHP array, so the summary cards stay
// correct regardless of how many flags any one student has.
$totalchecks = 0;
$pendingcount = 0;
$confirmedcount = 0;
$dismissedcount = 0;
foreach ($aggregates as $agg) {
    $totalchecks += (int) $agg->total;
    $confirmedcount += (int) $agg->confirmed;
    $dismissedcount += (int) $agg->dismissed;
    $pendingcount += (int) $agg->total - (int) $agg->confirmed - (int) $agg->dismissed;
}

$statussql = "SELECT status, COUNT(*) AS c
              FROM {quizaccess_proctor_logs} l
              WHERE l.quizid = :quizid AND l.status != 'active' {$userwhere}
              GROUP BY status";
$statuscounts = [];
foreach ($DB->get_records_sql($statussql, $params) as $row) {
    $statuscounts[$row->status] = (int) $row->c;
}
$mismatches = $statuscounts['mismatch'] ?? 0;
$noface = $statuscounts['no_face'] ?? 0;
$multiface = $statuscounts['multiple_faces'] ?? 0;
$phonedetected = $statuscounts['phone_detected'] ?? 0;
$lookingaway = $statuscounts['looking_away'] ?? 0;
$talkingdetected = $statuscounts['talking_detected'] ?? 0;
$violations = $mismatches + $noface + $multiface + $phonedetected + $lookingaway + $talkingdetected;

// Phase 2: batch-fetch the picture/name fields for exactly the students who
// have at least one flag — one query regardless of how many students that
// is, rather than joining {user} into the (already-correct, unbounded)
// aggregate query above and repeating every user column in GROUP BY to
// satisfy stricter SQL modes.
$byuser = [];
if ($aggregates) {
    // for_userpic() already includes 'id' among its fields, so $selects on
    // its own is the complete column list get_records_list() needs.
    $picturefields = \core_user\fields::for_userpic()->get_sql('', false, '', '', false);
    $students = $DB->get_records_list('user', 'id', array_keys($aggregates), '', $picturefields->selects);

    foreach ($aggregates as $uid => $agg) {
        if (!isset($students[$uid])) {
            // The user record is gone (deleted account) but their flags
            // remain — skip rather than fail the whole report over one
            // orphaned row.
            continue;
        }
        $byuser[$uid] = (object) [
            'user'      => $students[$uid],
            'logs'      => [],
            'total'     => (int) $agg->total,
            'confirmed' => (int) $agg->confirmed,
            'dismissed' => (int) $agg->dismissed,
            'pending'   => (int) $agg->total - (int) $agg->confirmed - (int) $agg->dismissed,
            'lasttime'  => (int) $agg->lasttime,
        ];
    }
}

// Alphabetical by name: the report's job here is "find a specific student
// and see their history", which alphabetical order supports directly. Most
// recent flag time is still shown per student and drives the sort within
// that student's own flag list.
uasort($byuser, function ($a, $b) {
    return strcasecmp(fullname($a->user), fullname($b->user));
});

// Phase 3: fetch each student's own flag detail rows, most recent first,
// capped per student rather than globally (see REPORT_MAX_FLAGS_PER_STUDENT
// above). One query per student rather than a single windowed query,
// because the number of students on one quiz's report is bounded by class
// size — the thing that was NOT safe to leave unbounded was the query in
// phase 1 that decides which students appear at all.
foreach ($byuser as $uid => $group) {
    $detailsql = "SELECT l.*, ru.firstname AS reviewer_firstname, ru.lastname AS reviewer_lastname,
                         qa.timestart AS attempt_timestart, qa.attempt AS attempt_number
                  FROM {quizaccess_proctor_logs} l
                  LEFT JOIN {user} ru ON ru.id = l.reviewed_by
                  LEFT JOIN {quiz_attempts} qa ON qa.id = l.attemptid
                  WHERE l.quizid = :quizid AND l.status != 'active' AND l.userid = :studentid
                  ORDER BY l.timecreated DESC";
    $byuser[$uid]->logs = array_values($DB->get_records_sql(
        $detailsql,
        ['quizid' => $quiz->id, 'studentid' => $uid],
        0,
        REPORT_MAX_FLAGS_PER_STUDENT
    ));
}

// Display summary cards.
echo '<div class="proctor-report-container">';
echo '<div class="proctor-report-summary">';

echo '<div class="proctor-summary-card">';
echo '<div class="card-value">' . $totalchecks . '</div>';
echo '<div class="card-label">' . get_string('report_total_checks', 'quizaccess_proctor') . '</div>';
echo '</div>';

echo '<div class="proctor-summary-card card-danger">';
echo '<div class="card-value">' . $violations . '</div>';
echo '<div class="card-label">' . get_string('report_violations', 'quizaccess_proctor') . '</div>';
echo '</div>';

echo '<div class="proctor-summary-card card-warning">';
echo '<div class="card-value">' . $pendingcount . '</div>';
echo '<div class="card-label">' . get_string('review_pending', 'quizaccess_proctor') . '</div>';
echo '</div>';

echo '<div class="proctor-summary-card card-success">';
echo '<div class="card-value">' . $confirmedcount . '</div>';
echo '<div class="card-label">' . get_string('review_confirmed', 'quizaccess_proctor') . '</div>';
echo '</div>';

echo '<div class="proctor-summary-card" style="border-left: 3px solid #78909c;">';
echo '<div class="card-value" style="color: #78909c;">' . $dismissedcount . '</div>';
echo '<div class="card-label">' . get_string('review_dismissed', 'quizaccess_proctor') . '</div>';
echo '</div>';

echo '</div>'; // End summary.

// Filter bar.
echo '<div class="proctor-filter-bar">';
echo '<div class="proctor-filter-group">';
echo '<label for="proctor-filter-review">' . get_string('filter_review_label', 'quizaccess_proctor') . '</label>';
echo '<select id="proctor-filter-review" class="form-select">';
echo '<option value="all">' . get_string('filter_all', 'quizaccess_proctor') . '</option>';
echo '<option value="pending">' . get_string('review_pending', 'quizaccess_proctor') . '</option>';
echo '<option value="confirmed">' . get_string('review_confirmed', 'quizaccess_proctor') . '</option>';
echo '<option value="dismissed">' . get_string('review_dismissed', 'quizaccess_proctor') . '</option>';
echo '</select>';
echo '</div>';

echo '<div class="proctor-filter-group">';
echo '<label for="proctor-filter-type">' . get_string('filter_type_label', 'quizaccess_proctor') . '</label>';
echo '<select id="proctor-filter-type" class="form-select">';
echo '<option value="all">' . get_string('filter_all', 'quizaccess_proctor') . '</option>';
echo '<option value="face">' . get_string('filter_type_face', 'quizaccess_proctor') . '</option>';
echo '<option value="gaze">' . get_string('filter_type_gaze', 'quizaccess_proctor') . '</option>';
echo '<option value="object">' . get_string('filter_type_object', 'quizaccess_proctor') . '</option>';
echo '<option value="voice">' . get_string('filter_type_voice', 'quizaccess_proctor') . '</option>';
echo '<option value="other">' . get_string('filter_type_other', 'quizaccess_proctor') . '</option>';
echo '</select>';
echo '</div>';

echo '<span id="proctor-filter-count" class="proctor-filter-count"></span>';
echo '</div>'; // End filter bar.

// Student list.
if (empty($byuser)) {
    echo '<div class="alert alert-info">' . get_string('report_no_logs', 'quizaccess_proctor') . '</div>';
} else {
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

    echo '<div class="proctor-student-list" id="proctor-student-list">';

    foreach ($byuser as $group) {
        // $student is a plain {user} record (id, name, and picture fields —
        // see the batch fetch above), so it already has everything
        // user_picture needs without being rebuilt into a stdClass.
        $student = $group->user;
        $fullname = fullname($student);
        $userpicture = new user_picture($student);
        $userpicture->size = 35;
        $avatarhtml = $OUTPUT->render($userpicture);

        echo '<div class="proctor-student-group" data-userid="' . $student->id . '">';

        echo '<div class="proctor-student-header" role="button" tabindex="0" aria-expanded="false">';
        echo '<span class="proctor-student-toggle-icon">&#9656;</span>';
        echo '<span class="proctor-student-avatar">' . $avatarhtml . '</span>';
        echo '<span class="proctor-student-name">' . s($fullname) . '</span>';
        echo '<span class="proctor-student-counts">';
        echo '<span class="proctor-count-badge proctor-count-total" data-count-role="total">'
            . $group->total . ' ' . get_string('report_flags_count', 'quizaccess_proctor') . '</span>';
        echo '<span class="proctor-count-badge proctor-count-pending" data-count-role="pending">'
            . $group->pending . ' ' . get_string('review_pending', 'quizaccess_proctor') . '</span>';
        echo '<span class="proctor-count-badge proctor-count-confirmed" data-count-role="confirmed">'
            . $group->confirmed . ' ' . get_string('review_confirmed', 'quizaccess_proctor') . '</span>';
        echo '<span class="proctor-count-badge proctor-count-dismissed" data-count-role="dismissed">'
            . $group->dismissed . ' ' . get_string('review_dismissed', 'quizaccess_proctor') . '</span>';
        echo '</span>';
        echo '<span class="proctor-student-lastseen">' . userdate($group->lasttime, '%d %b, %H:%M') . '</span>';
        echo '</div>'; // End header.

        echo '<div class="proctor-student-flags" style="display:none;">';

        if ($group->total > count($group->logs)) {
            echo '<div class="proctor-truncation-notice">' . get_string(
                'flags_truncated',
                'quizaccess_proctor',
                (object) ['shown' => count($group->logs), 'total' => $group->total]
            ) . '</div>';
        }

        foreach ($group->logs as $log) {
            $type = quizaccess_proctor_flag_type($log->status);
            $reviewstatus = $log->review_status ?: 'pending';
            $badge = $statusmap[$log->status] ?? $statusmap['error'];

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
        }

        echo '</div>'; // End proctor-student-flags.
        echo '</div>'; // End proctor-student-group.
    }

    echo '</div>'; // End proctor-student-list.
}

// Back button.
$quizurl = new moodle_url('/mod/quiz/view.php', ['id' => $cmid]);
echo '<div class="mt-3">';
echo '<a href="' . $quizurl . '" class="btn btn-secondary">';
echo get_string('report_back', 'quizaccess_proctor');
echo '</a>';
echo '</div>';

echo '</div>'; // End container.

// Lightbox modal for snapshot images.
echo '
<div id="proctor-modal" class="proctor-modal-backdrop">
    <span class="proctor-modal-close">&times;</span>
    <img id="proctor-modal-img" class="proctor-modal-img" alt="" />
</div>
';

$PAGE->requires->js_call_amd('quizaccess_proctor/report', 'init', [[
    'cmid' => $cmid,
]]);

echo $OUTPUT->footer();
