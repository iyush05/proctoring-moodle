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
 * External function for a teacher to mark a proctoring flag as reviewed.
 *
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

namespace quizaccess_proctor\external;

defined('MOODLE_INTERNAL') || die();

use core_external\external_api;
use core_external\external_function_parameters;
use core_external\external_value;
use core_external\external_single_structure;
use context_module;
use invalid_parameter_exception;

/**
 * Sets the review status (pending/confirmed/dismissed) on a single flag.
 *
 * Marking is scoped to the same capability as viewing the report
 * (quizaccess/proctor:viewreport) rather than a separate capability — for
 * this plugin reviewing a flag is part of what viewing the report is for,
 * and every role that can currently see the report is a teacher role that
 * should be able to act on what it sees.
 */
class mark_log extends external_api {

    /**
     * Define the parameters for the external function.
     *
     * @return external_function_parameters
     */
    public static function execute_parameters(): external_function_parameters {
        return new external_function_parameters([
            'logid'  => new external_value(PARAM_INT, 'ID of the quizaccess_proctor_logs row to mark'),
            'cmid'   => new external_value(PARAM_INT, 'Course module ID of the quiz, for capability checking'),
            'status' => new external_value(PARAM_ALPHA, 'New review status: pending, confirmed, or dismissed'),
        ]);
    }

    /**
     * Mark a log entry's review status.
     *
     * @param int $logid The quizaccess_proctor_logs row to update.
     * @param int $cmid Course module ID of the quiz this log belongs to.
     * @param string $status New review status.
     * @return array Result with the applied status and reviewer display data.
     */
    public static function execute(int $logid, int $cmid, string $status): array {
        global $DB, $USER;

        $params = self::validate_parameters(self::execute_parameters(), [
            'logid'  => $logid,
            'cmid'   => $cmid,
            'status' => $status,
        ]);

        $validstatuses = ['pending', 'confirmed', 'dismissed'];
        if (!in_array($params['status'], $validstatuses, true)) {
            throw new invalid_parameter_exception('Invalid review status: ' . $params['status']);
        }

        // Capability is checked against the specific quiz's module context,
        // not the system context store_snapshot uses — marking is a
        // teacher-only action, unlike a student reporting their own webcam
        // frame, so it needs the real scoped check.
        $cm = get_coursemodule_from_id('quiz', $params['cmid'], 0, false, MUST_EXIST);
        $context = context_module::instance($cm->id);
        self::validate_context($context);
        require_capability('quizaccess/proctor:viewreport', $context);

        $log = $DB->get_record('quizaccess_proctor_logs', ['id' => $params['logid']], '*', MUST_EXIST);

        // The capability check above only proves the caller may view reports
        // for the quiz named by cmid — without this, they could mark a log
        // row belonging to a different quiz they have no access to by
        // guessing/incrementing logid.
        if ((int) $log->quizid !== (int) $cm->instance) {
            throw new invalid_parameter_exception('Log entry does not belong to the specified quiz');
        }

        $update = (object) [
            'id'            => $log->id,
            'review_status' => $params['status'],
        ];

        if ($params['status'] === 'pending') {
            // Reverting to pending clears attribution — a stale reviewer name
            // on an unreviewed flag would be misleading.
            $update->reviewed_by = null;
            $update->reviewed_at = null;
        } else {
            $update->reviewed_by = $USER->id;
            $update->reviewed_at = time();
        }

        $DB->update_record('quizaccess_proctor_logs', $update);

        $reviewer = null;
        if ($update->reviewed_by) {
            $reviewer = fullname($DB->get_record('user', ['id' => $update->reviewed_by], '*', MUST_EXIST));
        }

        return [
            'success'    => true,
            'logid'      => $log->id,
            'status'     => $params['status'],
            'reviewedby' => $reviewer ?? '',
            'reviewedat' => $update->reviewed_at ?? 0,
        ];
    }

    /**
     * Define the return structure for the external function.
     *
     * @return external_single_structure
     */
    public static function execute_returns(): external_single_structure {
        return new external_single_structure([
            'success'    => new external_value(PARAM_BOOL, 'Whether the update succeeded'),
            'logid'      => new external_value(PARAM_INT, 'The log entry that was updated'),
            'status'     => new external_value(PARAM_ALPHA, 'The review status now applied'),
            'reviewedby' => new external_value(PARAM_TEXT, 'Display name of the reviewer, empty if pending'),
            'reviewedat' => new external_value(PARAM_INT, 'Unix timestamp of the review, 0 if pending'),
        ]);
    }
}
