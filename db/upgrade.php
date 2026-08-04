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

    return true;
}
