/**
 * Teacher report page — student grouping, filtering, and the flag review
 * workflow (confirm / dismiss / undo).
 *
 * Everything here operates on data already in the page. The report caps at
 * 500 log rows per view (see report.php), so filtering and expand/collapse
 * are done by toggling visibility in the existing DOM rather than reloading
 * or re-querying — the only network call this module makes is the one that
 * actually changes data, marking a flag's review status.
 *
 * @module     quizaccess_proctor/report
 * @package    quizaccess_proctor
 * @copyright  2026 Ayush Kannaujiya
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
define(['core/ajax', 'core/str', 'core/notification'], function (Ajax, Str, Notification) {

    /** @type {Object} Configuration from PHP: { cmid }. */
    let config = {};

    /**
     * Initialize the report page.
     *
     * @param {Object} cfg Configuration object from PHP.
     */
    function init(cfg) {
        config = cfg || {};

        initStudentToggles();
        initFilters();
        initReviewActions();
        initModal();
        localizeTimestamps();
    }

    /**
     * Wire up expand/collapse for each student's header row.
     */
    function initStudentToggles() {
        document.querySelectorAll('.proctor-student-header').forEach(function (header) {
            const toggle = function () {
                const group = header.closest('.proctor-student-group');
                const flags = group.querySelector('.proctor-student-flags');
                const icon = header.querySelector('.proctor-student-toggle-icon');
                const expanded = header.getAttribute('aria-expanded') === 'true';

                header.setAttribute('aria-expanded', expanded ? 'false' : 'true');
                flags.style.display = expanded ? 'none' : 'block';
                if (icon) {
                    icon.innerHTML = expanded ? '&#9656;' : '&#9662;';
                }
            };

            header.addEventListener('click', toggle);
            header.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle();
                }
            });
        });
    }

    /**
     * Wire up the review-status and detection-type filter selects.
     */
    function initFilters() {
        const reviewSelect = document.getElementById('proctor-filter-review');
        const typeSelect = document.getElementById('proctor-filter-type');

        if (!reviewSelect || !typeSelect) {
            return;
        }

        reviewSelect.addEventListener('change', applyFilters);
        typeSelect.addEventListener('change', applyFilters);

        applyFilters();
    }

    /**
     * Show/hide flag cards according to the current filter selection, hide
     * any student group left with nothing visible, and update the count.
     */
    function applyFilters() {
        const reviewFilter = document.getElementById('proctor-filter-review').value;
        const typeFilter = document.getElementById('proctor-filter-type').value;

        let totalFlags = 0;
        let shownFlags = 0;

        document.querySelectorAll('.proctor-student-group').forEach(function (group) {
            let visibleInGroup = 0;

            group.querySelectorAll('.proctor-flag-card').forEach(function (card) {
                totalFlags++;

                const reviewOk = (reviewFilter === 'all') || (card.dataset.review === reviewFilter);
                const typeOk = (typeFilter === 'all') || (card.dataset.type === typeFilter);
                const visible = reviewOk && typeOk;

                card.style.display = visible ? '' : 'none';
                if (visible) {
                    visibleInGroup++;
                    shownFlags++;
                }
            });

            group.style.display = (visibleInGroup > 0) ? '' : 'none';
        });

        const countEl = document.getElementById('proctor-filter-count');
        if (countEl) {
            Str.get_string('filter_count_showing', 'quizaccess_proctor', { shown: shownFlags, total: totalFlags })
                .then(function (str) {
                    countEl.textContent = str;
                    return null;
                })
                .catch(Notification.exception);
        }
    }

    /**
     * Wire up the confirm/dismiss/undo buttons on every flag card.
     */
    function initReviewActions() {
        document.querySelectorAll('.proctor-flag-card').forEach(function (card) {
            card.querySelectorAll('[data-action]').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    markLog(card, btn.dataset.action, btn);
                });
            });
        });
    }

    /**
     * Send a review-status update for one flag and reflect the result in the
     * DOM once the server confirms it — the card is not updated optimistically,
     * since a stale count on the student header would be worse than a brief
     * delay on a low-frequency action like this.
     *
     * @param {HTMLElement} card The .proctor-flag-card element.
     * @param {string} status 'confirmed', 'dismissed', or 'pending'.
     * @param {HTMLElement} btn The button that was clicked, disabled while in flight.
     */
    function markLog(card, status, btn) {
        const logId = parseInt(card.dataset.logid, 10);
        const previousStatus = card.dataset.review;

        if (previousStatus === status) {
            return;
        }

        card.querySelectorAll('[data-action]').forEach(function (b) {
            b.disabled = true;
        });

        Ajax.call([{
            methodname: 'quizaccess_proctor_mark_log',
            args: {
                logid: logId,
                cmid: config.cmid,
                status: status,
            }
        }])[0].then(function (result) {
            card.dataset.review = result.status;

            const label = card.querySelector('[data-review-label]');
            if (label) {
                label.textContent = (result.status !== 'pending' && result.reviewedby)
                    ? result.reviewedby + ', ' + new Date(result.reviewedat * 1000).toLocaleString()
                    : '';
            }

            updateGroupCounts(card.closest('.proctor-student-group'), previousStatus, result.status);
            applyFilters();
            return null;
        }).catch(function (err) {
            Notification.exception(err);
        }).finally(function () {
            card.querySelectorAll('[data-action]').forEach(function (b) {
                b.disabled = false;
            });
        });
    }

    /**
     * Adjust a student group's pending/confirmed/dismissed header counts
     * after one of their flags changed review status.
     *
     * @param {HTMLElement} group The .proctor-student-group element.
     * @param {string} fromStatus Previous review status.
     * @param {string} toStatus New review status.
     */
    function updateGroupCounts(group, fromStatus, toStatus) {
        if (!group || fromStatus === toStatus) {
            return;
        }

        const fromBadge = group.querySelector('[data-count-role="' + fromStatus + '"]');
        const toBadge = group.querySelector('[data-count-role="' + toStatus + '"]');

        [[fromBadge, -1], [toBadge, 1]].forEach(function (pair) {
            const el = pair[0];
            const delta = pair[1];
            if (!el) {
                return;
            }
            const current = parseInt(el.textContent, 10) || 0;
            const next = Math.max(0, current + delta);
            el.textContent = el.textContent.replace(/^\d+/, String(next));
        });
    }

    /**
     * Wire up the snapshot lightbox modal.
     */
    function initModal() {
        const modal = document.getElementById('proctor-modal');
        const modalImg = document.getElementById('proctor-modal-img');
        const closeBtn = modal ? modal.querySelector('.proctor-modal-close') : null;

        if (!modal || !modalImg) {
            return;
        }

        /**
         * Open the lightbox with the given image source. Exposed on window
         * because snapshot thumbnails are rendered as plain server-side HTML
         * (report.php) with an inline onclick, the same pattern the previous
         * version of this page used — there is no per-thumbnail JS handle to
         * attach a listener to otherwise.
         *
         * @param {string} src Image data URL.
         */
        window.proctorOpenModal = function (src) {
            modalImg.src = src;
            modal.classList.add('proctor-modal-open');
            document.body.style.overflow = 'hidden';
        };

        const close = function () {
            modal.classList.remove('proctor-modal-open');
            document.body.style.overflow = '';
        };

        if (closeBtn) {
            closeBtn.addEventListener('click', close);
        }
        modal.addEventListener('click', function (e) {
            if (e.target === modal) {
                close();
            }
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                close();
            }
        });
    }

    /**
     * Render every flag timestamp in the viewer's local timezone. The server
     * renders them in server time initially (readable immediately even if JS
     * fails to load), and this replaces that with a locale-aware version.
     */
    function localizeTimestamps() {
        document.querySelectorAll('.proctor-flag-time[data-timestamp]').forEach(function (el) {
            const ts = parseInt(el.dataset.timestamp, 10);
            if (!ts) {
                return;
            }
            const d = new Date(ts * 1000);
            if (isNaN(d.getTime())) {
                return;
            }
            const datePart = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
            const timePart = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
            el.textContent = datePart + ', ' + timePart;
        });
    }

    return {
        init: init
    };
});
