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
 * External function for paginated, filtered fetches of one student's flags.
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
 * Fetches one page of one student's flags for the report's expandable panel.
 *
 * The report page itself only ever renders the student list (name, avatar,
 * and aggregate counts) — no flag detail rows. Expanding a student, paging
 * through their history, and changing a filter while a panel is open all
 * come through here instead, so the initial page load stays small regardless
 * of how many flags a quiz has accumulated.
 */
class get_student_flags extends external_api {

    /** @var int Flags returned per page. */
    const PERPAGE = 50;

    /**
     * Define the parameters for the external function.
     *
     * @return external_function_parameters
     */
    public static function execute_parameters(): external_function_parameters {
        return new external_function_parameters([
            'cmid'         => new external_value(PARAM_INT, 'Course module ID of the quiz'),
            'userid'       => new external_value(PARAM_INT, 'Student whose flags to fetch'),
            'page'         => new external_value(PARAM_INT, 'Zero-based page number', VALUE_DEFAULT, 0),
            'reviewstatus' => new external_value(PARAM_ALPHA, 'Filter: all, pending, confirmed, or dismissed', VALUE_DEFAULT, 'all'),
            'type'         => new external_value(PARAM_ALPHA, 'Filter: all, face, gaze, object, voice, or other', VALUE_DEFAULT, 'all'),
        ]);
    }

    /**
     * Fetch one page of a student's flags, rendered as ready-to-insert HTML.
     *
     * @param int $cmid Course module ID of the quiz.
     * @param int $userid Student whose flags to fetch.
     * @param int $page Zero-based page number; clamped into range.
     * @param string $reviewstatus 'all', 'pending', 'confirmed', or 'dismissed'.
     * @param string $type 'all', 'face', 'gaze', 'object', 'voice', or 'other'.
     * @return array Rendered HTML plus pagination state.
     */
    public static function execute(
        int $cmid,
        int $userid,
        int $page = 0,
        string $reviewstatus = 'all',
        string $type = 'all'
    ): array {
        global $DB;

        $params = self::validate_parameters(self::execute_parameters(), [
            'cmid'         => $cmid,
            'userid'       => $userid,
            'page'         => $page,
            'reviewstatus' => $reviewstatus,
            'type'         => $type,
        ]);

        // The quiz is derived from cmid server-side, never taken from the
        // client — every query below is scoped to l.quizid = $cm->instance,
        // so whatever $userid is requested, only flags belonging to THIS
        // quiz can ever come back. Passing an arbitrary in-quiz userid is
        // not a privilege escalation: viewreport already exposes every
        // student's flags for this quiz through the report page itself.
        $cm = get_coursemodule_from_id('quiz', $params['cmid'], 0, false, MUST_EXIST);
        $context = context_module::instance($cm->id);
        self::validate_context($context);
        require_capability('quizaccess/proctor:viewreport', $context);

        require_once(__DIR__ . '/../../lib.php');

        $where = 'l.quizid = :quizid AND l.userid = :userid AND l.status != \'active\'';
        $sqlparams = ['quizid' => $cm->instance, 'userid' => $params['userid']];

        if ($params['reviewstatus'] !== 'all') {
            if (!in_array($params['reviewstatus'], ['pending', 'confirmed', 'dismissed'], true)) {
                throw new invalid_parameter_exception('Invalid reviewstatus filter: ' . $params['reviewstatus']);
            }
            $where .= ' AND l.review_status = :reviewstatus';
            $sqlparams['reviewstatus'] = $params['reviewstatus'];
        }

        if ($params['type'] !== 'all') {
            $statuses = quizaccess_proctor_type_statuses($params['type']);
            if (empty($statuses)) {
                throw new invalid_parameter_exception('Invalid type filter: ' . $params['type']);
            }
            [$insql, $inparams] = $DB->get_in_or_equal($statuses, SQL_PARAMS_NAMED, 'tp');
            $where .= " AND l.status {$insql}";
            $sqlparams += $inparams;
        }

        $total = (int) $DB->get_field_sql(
            "SELECT COUNT(*) FROM {quizaccess_proctor_logs} l WHERE {$where}",
            $sqlparams
        );

        $perpage = self::PERPAGE;
        $totalpages = max(1, (int) ceil($total / $perpage));
        // Clamped rather than trusted: the requested page can be stale if a
        // filter change or a review-status update shrank the result set out
        // from under a page the client still thinks is valid.
        $pagenum = max(0, min($params['page'], $totalpages - 1));

        $detailsql = "SELECT l.*, ru.firstname AS reviewer_firstname, ru.lastname AS reviewer_lastname,
                             qa.timestart AS attempt_timestart, qa.attempt AS attempt_number
                      FROM {quizaccess_proctor_logs} l
                      LEFT JOIN {user} ru ON ru.id = l.reviewed_by
                      LEFT JOIN {quiz_attempts} qa ON qa.id = l.attemptid
                      WHERE {$where}
                      ORDER BY l.timecreated DESC";
        $logs = $DB->get_records_sql($detailsql, $sqlparams, $pagenum * $perpage, $perpage);

        $html = '';
        foreach ($logs as $log) {
            $html .= quizaccess_proctor_render_flag_card($log);
        }

        return [
            'html'       => $html,
            'page'       => $pagenum,
            'totalpages' => $totalpages,
            'total'      => $total,
        ];
    }

    /**
     * Define the return structure for the external function.
     *
     * @return external_single_structure
     */
    public static function execute_returns(): external_single_structure {
        return new external_single_structure([
            'html'       => new external_value(PARAM_RAW, 'Rendered HTML for this page of flag cards'),
            'page'       => new external_value(PARAM_INT, 'Page actually returned (clamped into range)'),
            'totalpages' => new external_value(PARAM_INT, 'Total pages available for this filter'),
            'total'      => new external_value(PARAM_INT, 'Total flags matching this filter'),
        ]);
    }
}
