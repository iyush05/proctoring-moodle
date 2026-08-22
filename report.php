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
 * a student expands their individual flags, fetched on demand and paginated
 * (amd/src/report.js, classes/external/get_student_flags.php) rather than
 * rendered inline here — a quiz's total flag count is unbounded, and this
 * page only ever needs to render the student list itself plus whichever one
 * or two panels a teacher currently has open. A filter bar narrows each
 * open panel by review status or detection type, re-fetching that panel's
 * current page through the same endpoint.
 *
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

require_once(__DIR__ . '/../../../../config.php');
require_once(__DIR__ . '/lib.php');

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

echo $OUTPUT->header();
echo $OUTPUT->heading(get_string('report_title', 'quizaccess_proctor') . ': ' . $quiz->name);

// Build the query for logs.
$params = ['quizid' => $quiz->id];
$userwhere = '';
if ($userid) {
    $userwhere = ' AND l.userid = :userid';
    $params['userid'] = $userid;
}

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

// Flag detail rows are deliberately not fetched here at all — each
// student's flags are loaded through quizaccess_proctor_get_student_flags
// on demand (first expand, page change, or filter change), rendered via the
// same quizaccess_proctor_render_flag_card() this page would otherwise call
// inline. See lib.php.

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

echo '</div>'; // End filter bar.

// Student list.
if (empty($byuser)) {
    echo '<div class="alert alert-info">' . get_string('report_no_logs', 'quizaccess_proctor') . '</div>';
} else {
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

        // Empty until expanded: amd/src/report.js fetches this student's
        // first page through quizaccess_proctor_get_student_flags and
        // injects the returned HTML (built by the same
        // quizaccess_proctor_render_flag_card() this page would otherwise
        // call here) into .proctor-flags-container. Re-fetched on page
        // change or filter change while the panel is open.
        echo '<div class="proctor-student-flags" style="display:none;" data-loaded="0">';
        echo '<div class="proctor-flags-container"></div>';
        echo '<div class="proctor-pagination" style="display:none;">';
        echo '<button type="button" class="btn btn-sm btn-outline-secondary proctor-page-prev">'
            . get_string('pagination_prev', 'quizaccess_proctor') . '</button>';
        echo '<span class="proctor-page-info"></span>';
        echo '<button type="button" class="btn btn-sm btn-outline-secondary proctor-page-next">'
            . get_string('pagination_next', 'quizaccess_proctor') . '</button>';
        echo '</div>';
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
