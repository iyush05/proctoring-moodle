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
 * Displays proctoring logs, detection results, and summary statistics
 * for a specific quiz.
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

echo $OUTPUT->header();
echo $OUTPUT->heading(get_string('report_title', 'quizaccess_proctor') . ': ' . $quiz->name);

// Build the query for logs.
$params = ['quizid' => $quiz->id];
$userwhere = '';
if ($userid) {
    $userwhere = ' AND l.userid = :userid';
    $params['userid'] = $userid;
}

// Fetch logs with attempt information, excluding 'active' status (those are just session init records).
$sql = "SELECT l.*, u.firstname, u.lastname, u.email, u.picture, u.imagealt,
               qa.timestart AS attempt_timestart, qa.attempt AS attempt_number
        FROM {quizaccess_proctor_logs} l
        JOIN {user} u ON u.id = l.userid
        LEFT JOIN {quiz_attempts} qa ON qa.id = l.attemptid
        WHERE l.quizid = :quizid AND l.status != 'active' {$userwhere}
        ORDER BY l.timecreated DESC";
$logs = $DB->get_records_sql($sql, $params, 0, 500);

// Calculate summary statistics.
$totalchecks = count($logs);
$matches = 0;
$mismatches = 0;
$noface = 0;
$multiface = 0;
$phonedetected = 0;
$lookingaway = 0;
$errors = 0;

foreach ($logs as $log) {
    switch ($log->status) {
        case 'match':
            $matches++;
            break;
        case 'mismatch':
            $mismatches++;
            break;
        case 'no_face':
            $noface++;
            break;
        case 'multiple_faces':
            $multiface++;
            break;
        case 'phone_detected':
            $phonedetected++;
            break;
        case 'looking_away':
            $lookingaway++;
            break;
        case 'error':
            $errors++;
            break;
    }
}

$matchrate = $totalchecks > 0 ? round(($matches / $totalchecks) * 100, 1) : 0;
$violations = $mismatches + $noface + $multiface + $phonedetected + $lookingaway;

// Display summary cards.
echo '<div class="proctor-report-container">';
echo '<div class="proctor-report-summary">';

echo '<div class="proctor-summary-card">';
echo '<div class="card-value">' . $totalchecks . '</div>';
echo '<div class="card-label">' . get_string('report_total_checks', 'quizaccess_proctor') . '</div>';
echo '</div>';

echo '<div class="proctor-summary-card card-success">';
echo '<div class="card-value">' . $matchrate . '%</div>';
echo '<div class="card-label">' . get_string('report_match_rate', 'quizaccess_proctor') . '</div>';
echo '</div>';

echo '<div class="proctor-summary-card card-danger">';
echo '<div class="card-value">' . $violations . '</div>';
echo '<div class="card-label">' . get_string('report_violations', 'quizaccess_proctor') . '</div>';
echo '</div>';

echo '<div class="proctor-summary-card card-warning">';
echo '<div class="card-value">' . $noface . '</div>';
echo '<div class="card-label">' . get_string('status_noface', 'quizaccess_proctor') . '</div>';
echo '</div>';

echo '<div class="proctor-summary-card" style="border-left: 3px solid #ff6d00;">';
echo '<div class="card-value" style="color: #ff6d00;">' . $phonedetected . '</div>';
echo '<div class="card-label">' . get_string('report_object_detections', 'quizaccess_proctor') . '</div>';
echo '</div>';

echo '<div class="proctor-summary-card" style="border-left: 3px solid #d500f9;">';
echo '<div class="card-value" style="color: #d500f9;">' . $lookingaway . '</div>';
echo '<div class="card-label">' . get_string('gazeviolations', 'quizaccess_proctor') . '</div>';
echo '</div>';

echo '</div>'; // End summary.

// Display logs table.
if (empty($logs)) {
    echo '<div class="alert alert-info">' . get_string('report_no_logs', 'quizaccess_proctor') . '</div>';
} else {
    echo '<table class="proctor-log-table table table-striped">';
    echo '<thead><tr>';
    echo '<th>' . get_string('report_student', 'quizaccess_proctor') . '</th>';
    echo '<th>' . get_string('report_attempt', 'quizaccess_proctor') . '</th>';
    echo '<th>' . get_string('report_time', 'quizaccess_proctor') . '</th>';
    echo '<th>' . get_string('report_status', 'quizaccess_proctor') . '</th>';
    echo '<th>' . get_string('report_confidence', 'quizaccess_proctor') . '</th>';
    echo '<th>' . get_string('report_objects', 'quizaccess_proctor') . '</th>';
    echo '<th>' . get_string('gazeviolations', 'quizaccess_proctor') . '</th>';
    echo '<th>' . get_string('report_snapshot', 'quizaccess_proctor') . '</th>';
    echo '</tr></thead>';
    echo '<tbody>';

    foreach ($logs as $log) {
        $fullname = fullname($log);
        $servertimestr = userdate($log->timecreated, '%d %b %Y, %H:%M:%S');

        // Calculate attempt elapsed time offset.
        $elapsedhtml = '';
        if (!empty($log->attempt_timestart) && $log->timecreated >= $log->attempt_timestart) {
            $elapsed = $log->timecreated - $log->attempt_timestart;
            $mins = floor($elapsed / 60);
            $secs = $elapsed % 60;
            $elapsedstr = sprintf('+%02d:%02d into attempt', $mins, $secs);
            $elapsedhtml = '<div class="proctor-time-elapsed"><span class="badge proctor-badge-elapsed" style="background:#e2e8f0; color:#1e293b; border:1px solid #94a3b8; font-weight:600; padding:3px 8px; border-radius:6px; display:inline-block;" title="Elapsed time since attempt start">' . s($elapsedstr) . '</span></div>';
        }

        $timehtml = '<div class="proctor-time-cell" data-timestamp="' . $log->timecreated . '">';
        $timehtml .= '<div class="proctor-time-primary" title="Server time: ' . s($servertimestr) . '">' . s($servertimestr) . '</div>';
        $timehtml .= $elapsedhtml;
        $timehtml .= '</div>';

        // Attempt number and link to review.
        $attemptlabel = !empty($log->attempt_number) ? get_string('attempt', 'quiz', $log->attempt_number) : '#' . $log->attemptid;
        $attempturl = new moodle_url('/mod/quiz/review.php', ['attempt' => $log->attemptid]);
        $attempthtml = '<a href="' . $attempturl . '" target="_blank" title="' . s(get_string('review', 'quiz')) . '"><strong>' . s($attemptlabel) . '</strong></a>';

        // Status badge.
        $statusmap = [
            'match'          => ['class' => 'proctor-badge-match',     'label' => get_string('status_match', 'quizaccess_proctor')],
            'mismatch'       => ['class' => 'proctor-badge-mismatch',  'label' => get_string('status_mismatch', 'quizaccess_proctor')],
            'no_face'        => ['class' => 'proctor-badge-noface',    'label' => get_string('status_noface', 'quizaccess_proctor')],
            'multiple_faces' => ['class' => 'proctor-badge-multiface', 'label' => get_string('status_multiface', 'quizaccess_proctor')],
            'phone_detected' => ['class' => 'proctor-badge-phone',     'label' => get_string('status_phone', 'quizaccess_proctor')],
            'looking_away'   => ['class' => 'proctor-badge-gaze',      'label' => get_string('snapshotstatus_looking_away', 'quizaccess_proctor')],
            'error'          => ['class' => 'proctor-badge-error',     'label' => get_string('status_error', 'quizaccess_proctor')],
            'active'         => ['class' => 'proctor-badge-active',    'label' => get_string('status_active', 'quizaccess_proctor')],
        ];

        $badge = $statusmap[$log->status] ?? $statusmap['error'];
        $badgehtml = '<span class="proctor-badge ' . $badge['class'] . '">' . $badge['label'] . '</span>';

        // Confidence display.
        $confidencestr = '-';
        if ($log->confidence > 0) {
            $percent = round((1 - $log->confidence) * 100, 1);
            $confidencestr = $percent . '% (d=' . round($log->confidence, 3) . ')';
        }

        // Snapshot thumbnail.
        $snapshothtml = '-';
        if (!empty($log->image_data)) {
            $snapshothtml = '<img src="' . s($log->image_data) . '" class="proctor-snapshot-thumb" alt="Snapshot" style="cursor: pointer; max-width: 120px; border-radius: 4px; border: 1px solid #ccc; transition: transform 0.2s;" onmouseover="this.style.transform=\'scale(1.05)\'" onmouseout="this.style.transform=\'scale(1)\'" onclick="openProctorModal(this.src)" />';
        }

        echo '<tr>';
        echo '<td>' . s($fullname) . '</td>';
        echo '<td>' . $attempthtml . '</td>';
        echo '<td>' . $timehtml . '</td>';
        echo '<td>' . $badgehtml . '</td>';
        echo '<td>' . $confidencestr . '</td>';

        // Objects detected.
        $objectshtml = '-';
        if (!empty($log->objects_detected)) {
            $objecticons = [
                'cell phone' => '📱',
                'book'       => '📖',
                'laptop'     => '💻',
                'remote'     => '🎮',
                'tv'         => '📺',
            ];
            $objects = explode(',', $log->objects_detected);
            $objectshtml = '<div class="proctor-object-pills">';
            foreach ($objects as $obj) {
                $obj = trim($obj);
                if (empty($obj)) {
                    continue;
                }
                $icon = isset($objecticons[$obj]) ? $objecticons[$obj] : '⚠';
                $objectshtml .= '<span class="proctor-object-pill">';
                $objectshtml .= '<span class="proctor-pill-icon">' . $icon . '</span>';
                $objectshtml .= s(ucfirst($obj));
                $objectshtml .= '</span>';
            }
            $objectshtml .= '</div>';
        }
        echo '<td>' . $objectshtml . '</td>';

        // Gaze data.
        $gazehtml = '-';
        if (!empty($log->gaze_data)) {
            $gaze = explode(',', $log->gaze_data);
            if (count($gaze) >= 3) {
                $dir = get_string('direction_' . trim($gaze[0]), 'quizaccess_proctor');
                $gazeobj = (object)['direction' => $dir, 'yaw' => trim($gaze[1]), 'pitch' => trim($gaze[2])];
                $gazehtml = '<span style="font-size:0.85rem;">' . get_string('gaze_data_log', 'quizaccess_proctor', $gazeobj) . '</span>';
            }
        }
        echo '<td>' . $gazehtml . '</td>';

        echo '<td>' . $snapshothtml . '</td>';
        echo '</tr>';
    }

    echo '</tbody></table>';
}

// Back button.
$quizurl = new moodle_url('/mod/quiz/view.php', ['id' => $cmid]);
echo '<div class="mt-3">';
echo '<a href="' . $quizurl . '" class="btn btn-secondary">';
echo get_string('report_back', 'quizaccess_proctor');
echo '</a>';
echo '</div>';

echo '</div>'; // End container.

// Add Lightbox Modal HTML, CSS, and JS directly into the report page
echo '
<div id="proctor-modal" style="display:none; position:fixed; z-index:99999; left:0; top:0; width:100%; height:100%; overflow:auto; background-color:rgba(0,0,0,0.85); backdrop-filter:blur(5px); justify-content:center; align-items:center;">
    <span style="position:absolute; top:20px; right:35px; color:#f1f1f1; font-size:40px; font-weight:bold; cursor:pointer;" onclick="closeProctorModal()">&times;</span>
    <img id="proctor-modal-img" style="max-width:90%; max-height:90%; border-radius:8px; box-shadow:0 10px 30px rgba(0,0,0,0.5);" />
</div>
<script>
function openProctorModal(src) {
    document.getElementById("proctor-modal-img").src = src;
    document.getElementById("proctor-modal").style.display = "flex";
    document.body.style.overflow = "hidden"; // Prevent scrolling
}
function closeProctorModal() {
    document.getElementById("proctor-modal").style.display = "none";
    document.body.style.overflow = "auto";
}
// Close modal on background click
document.getElementById("proctor-modal").addEventListener("click", function(e) {
    if (e.target.id === "proctor-modal") {
        closeProctorModal();
    }
});
// Close modal on escape key
document.addEventListener("keydown", function(e) {
    if (e.key === "Escape") {
        closeProctorModal();
    }
});

// Automatically format all timestamps in the teacher/viewer\'s local browser timezone with seconds
document.addEventListener("DOMContentLoaded", function() {
    document.querySelectorAll(".proctor-time-cell").forEach(function(el) {
        var ts = parseInt(el.getAttribute("data-timestamp"), 10);
        if (ts) {
            var d = new Date(ts * 1000);
            var primary = el.querySelector(".proctor-time-primary");
            if (primary && !isNaN(d.getTime())) {
                var datePart = d.toLocaleDateString(undefined, {
                    day: "numeric", month: "short", year: "numeric"
                });
                var timePart = d.toLocaleTimeString(undefined, {
                    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true
                });
                primary.textContent = datePart + ", " + timePart;
            }
        }
    });
});
// Also run immediately in case DOM is already loaded
(function() {
    document.querySelectorAll(".proctor-time-cell").forEach(function(el) {
        var ts = parseInt(el.getAttribute("data-timestamp"), 10);
        if (ts) {
            var d = new Date(ts * 1000);
            var primary = el.querySelector(".proctor-time-primary");
            if (primary && !isNaN(d.getTime())) {
                var datePart = d.toLocaleDateString(undefined, {
                    day: "numeric", month: "short", year: "numeric"
                });
                var timePart = d.toLocaleTimeString(undefined, {
                    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true
                });
                primary.textContent = datePart + ", " + timePart;
            }
        }
    });
})();
</script>
';

echo $OUTPUT->footer();
