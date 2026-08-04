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
 * External function to store a proctoring snapshot result.
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

/**
 * External function to store face detection snapshot results from the client.
 */
class store_snapshot extends external_api {

    /**
     * Define the parameters for the external function.
     *
     * @return external_function_parameters
     */
    public static function execute_parameters(): external_function_parameters {
        return new external_function_parameters([
            'attemptid'  => new external_value(PARAM_INT, 'Quiz attempt ID'),
            'quizid'     => new external_value(PARAM_INT, 'Quiz ID'),
            'courseid'   => new external_value(PARAM_INT, 'Course ID'),
            'status'     => new external_value(PARAM_ALPHANUMEXT, 'Detection status: match, mismatch, no_face, multiple_faces, phone_detected, error'),
            'confidence' => new external_value(PARAM_FLOAT, 'Face match confidence score (Euclidean distance)', VALUE_DEFAULT, 0),
            'imagedata'  => new external_value(PARAM_RAW, 'Base64 encoded snapshot image', VALUE_DEFAULT, ''),
            'objectsdetected' => new external_value(PARAM_TEXT, 'Comma-separated list of detected prohibited objects', VALUE_DEFAULT, ''),
            'timestamp'  => new external_value(PARAM_INT, 'Client-side UNIX timestamp of snapshot (in seconds)', VALUE_DEFAULT, 0),
        ]);
    }

    /**
     * Store a face detection snapshot result.
     *
     * @param int $attemptid Quiz attempt ID.
     * @param int $quizid Quiz ID.
     * @param int $courseid Course ID.
     * @param string $status Detection status.
     * @param float $confidence Face match confidence score.
     * @param string $imagedata Base64 encoded image.
     * @param string $objectsdetected Comma-separated list of prohibited objects.
     * @param int $timestamp Client-side UNIX timestamp (seconds).
     * @return array Result with success status.
     */
    public static function execute(
        int $attemptid,
        int $quizid,
        int $courseid,
        string $status,
        float $confidence = 0,
        string $imagedata = '',
        string $objectsdetected = '',
        int $timestamp = 0
    ): array {
        global $DB, $USER;

        // Validate parameters.
        $params = self::validate_parameters(self::execute_parameters(), [
            'attemptid'  => $attemptid,
            'quizid'     => $quizid,
            'courseid'   => $courseid,
            'status'     => $status,
            'confidence' => $confidence,
            'imagedata'  => $imagedata,
            'objectsdetected' => $objectsdetected,
            'timestamp'  => $timestamp,
        ]);

        // Validate the status value.
        $validstatuses = ['match', 'mismatch', 'no_face', 'multiple_faces', 'phone_detected', 'error', 'active'];
        if (!in_array($params['status'], $validstatuses)) {
            $params['status'] = 'error';
        }

        // Validate context — the user must be logged in.
        $context = \context_system::instance();
        self::validate_context($context);

        // Limit image data size (max 500KB base64).
        if (strlen($params['imagedata']) > 500000) {
            $params['imagedata'] = '';
        }

        // Determine creation timestamp (prefer client timestamp if valid and reasonable).
        $now = time();
        $timecreated = $now;
        if (!empty($params['timestamp']) && $params['timestamp'] > ($now - 86400) && $params['timestamp'] < ($now + 300)) {
            $timecreated = (int) $params['timestamp'];
        }

        // Insert the log record.
        $record = (object) [
            'courseid'         => $params['courseid'],
            'quizid'           => $params['quizid'],
            'userid'           => $USER->id,
            'attemptid'        => $params['attemptid'],
            'status'           => $params['status'],
            'confidence'       => $params['confidence'],
            'image_data'       => $params['imagedata'],
            'objects_detected' => clean_param(substr($params['objectsdetected'], 0, 255), PARAM_TEXT),
            'timecreated'      => $timecreated,
        ];

        $logid = $DB->insert_record('quizaccess_proctor_logs', $record);

        return [
            'success' => true,
            'logid'   => $logid,
        ];
    }

    /**
     * Define the return structure for the external function.
     *
     * @return external_single_structure
     */
    public static function execute_returns(): external_single_structure {
        return new external_single_structure([
            'success' => new external_value(PARAM_BOOL, 'Whether the snapshot was stored successfully'),
            'logid'   => new external_value(PARAM_INT, 'The ID of the stored log entry'),
        ]);
    }
}
