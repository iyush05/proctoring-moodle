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
 * External function definitions for quizaccess_proctor.
 *
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

$functions = [
    'quizaccess_proctor_store_snapshot' => [
        'classname'   => 'quizaccess_proctor\external\store_snapshot',
        'methodname'  => 'execute',
        'description' => 'Store a proctoring face detection snapshot result',
        'type'        => 'write',
        'ajax'        => true,
        'capabilities' => '',
    ],
    'quizaccess_proctor_mark_log' => [
        'classname'   => 'quizaccess_proctor\external\mark_log',
        'methodname'  => 'execute',
        'description' => 'Mark a proctoring log entry as confirmed, dismissed, or pending review',
        'type'        => 'write',
        'ajax'        => true,
        'capabilities' => 'quizaccess/proctor:viewreport',
    ],
    'quizaccess_proctor_get_student_flags' => [
        'classname'   => 'quizaccess_proctor\external\get_student_flags',
        'methodname'  => 'execute',
        'description' => 'Fetch one page of one student\'s proctoring flags for the report page',
        'type'        => 'read',
        'ajax'        => true,
        'capabilities' => 'quizaccess/proctor:viewreport',
    ],
];
