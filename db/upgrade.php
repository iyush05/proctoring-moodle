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
 * Database upgrade steps for quizaccess_proctor.
 *
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

/**
 * Upgrade the quizaccess_proctor plugin database schema.
 *
 * @param int $oldversion The old version of the plugin.
 * @return bool Always true.
 */
function xmldb_quizaccess_proctor_upgrade($oldversion) {
    global $DB;

    $dbman = $DB->get_manager();

    if ($oldversion < 2026080400) {
        // Add 'objects_detected' field to quizaccess_proctor_logs table.
        $table = new xmldb_table('quizaccess_proctor_logs');
        $field = new xmldb_field(
            'objects_detected',
            XMLDB_TYPE_CHAR,
            '255',
            null,
            null,
            null,
            null,
            'image_data'
        );

        if (!$dbman->field_exists($table, $field)) {
            $dbman->add_field($table, $field);
        }

        upgrade_plugin_savepoint(true, 2026080400, 'quizaccess', 'proctor');
    }

    if ($oldversion < 2026081200) {
        // Add 'gaze_data' field to quizaccess_proctor_logs table.
        $table = new xmldb_table('quizaccess_proctor_logs');
        $field = new xmldb_field(
            'gaze_data',
            XMLDB_TYPE_CHAR,
            '100',
            null,
            null,
            null,
            null,
            'objects_detected'
        );

        if (!$dbman->field_exists($table, $field)) {
            $dbman->add_field($table, $field);
        }

        upgrade_plugin_savepoint(true, 2026081200, 'quizaccess', 'proctor');
    }

    if ($oldversion < 2026081300) {
        $table = new xmldb_table('quizaccess_proctor');

        $field = new xmldb_field('gaze_yaw_threshold', XMLDB_TYPE_INTEGER, '3', null, XMLDB_NOTNULL, null, '30', 'proctor_enabled');
        if (!$dbman->field_exists($table, $field)) {
            $dbman->add_field($table, $field);
        }

        $field = new xmldb_field('gaze_pitch_up_threshold', XMLDB_TYPE_INTEGER, '3', null, XMLDB_NOTNULL, null, '20', 'gaze_yaw_threshold');
        if (!$dbman->field_exists($table, $field)) {
            $dbman->add_field($table, $field);
        }

        $field = new xmldb_field('gaze_pitch_down_threshold', XMLDB_TYPE_INTEGER, '3', null, XMLDB_NOTNULL, null, '15', 'gaze_pitch_up_threshold');
        if (!$dbman->field_exists($table, $field)) {
            $dbman->add_field($table, $field);
        }

        upgrade_plugin_savepoint(true, 2026081300, 'quizaccess', 'proctor');
    }

    if ($oldversion < 2026081602) {
        // Split the single gaze_yaw_threshold into independent left/right
        // thresholds (a shared symmetric threshold doesn't correctly represent
        // asymmetric setups — off-center camera, a second monitor to one
        // side, etc.). gaze_yaw_threshold is left in place (unused going
        // forward) rather than dropped, since existing quizzes may have a
        // deliberately-configured value and dropping it risks silent data
        // loss for no functional benefit.
        $table = new xmldb_table('quizaccess_proctor');

        $field = new xmldb_field(
            'gaze_yaw_left_threshold',
            XMLDB_TYPE_INTEGER,
            '3',
            null,
            XMLDB_NOTNULL,
            null,
            '30',
            'gaze_yaw_threshold'
        );
        if (!$dbman->field_exists($table, $field)) {
            $dbman->add_field($table, $field);
        }

        $field = new xmldb_field(
            'gaze_yaw_right_threshold',
            XMLDB_TYPE_INTEGER,
            '3',
            null,
            XMLDB_NOTNULL,
            null,
            '30',
            'gaze_yaw_left_threshold'
        );
        if (!$dbman->field_exists($table, $field)) {
            $dbman->add_field($table, $field);
        }

        // Migrate any existing per-quiz value forward so quizzes that already
        // had a customized yaw threshold keep the same effective behavior
        // instead of silently reverting to the default on upgrade.
        $DB->execute(
            'UPDATE {quizaccess_proctor}
                SET gaze_yaw_left_threshold = gaze_yaw_threshold,
                    gaze_yaw_right_threshold = gaze_yaw_threshold'
        );

        upgrade_plugin_savepoint(true, 2026081602, 'quizaccess', 'proctor');
    }

    return true;
}
