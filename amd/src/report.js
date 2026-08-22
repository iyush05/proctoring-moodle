/**
 * Teacher report page — student list, lazy-loaded paginated flags, and the
 * flag review workflow (confirm / dismiss / undo).
 *
 * The page itself only ever renders the student list (name, avatar,
 * aggregate counts) — no flag detail rows. A student's flags are fetched
 * through quizaccess_proctor_get_student_flags on first expand, on
 * pagination, and on filter change, and the returned HTML (built server-side
 * by the same renderer the page would otherwise call inline — see lib.php)
 * is injected into that student's panel. This keeps the initial page load
 * small regardless of how many flags a quiz has accumulated, and is why
 * review-action buttons and pagination controls are wired up via delegated
 * listeners on a stable ancestor rather than bound at init time: most of the
 * DOM they act on does not exist yet when the page loads.
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
        initFilterControls();
        initDelegatedActions();
        initModal();
    }

    /**
     * The review-status/type filter pair currently selected, as a single
     * string — used both as the value sent to the server and as a cheap way
     * to tell whether a panel's cached page was loaded under a filter that
     * no longer applies.
     *
     * @returns {{reviewstatus: string, type: string, key: string}}
     */
    function currentFilter() {
        const reviewstatus = document.getElementById('proctor-filter-review').value;
        const type = document.getElementById('proctor-filter-type').value;
        return { reviewstatus: reviewstatus, type: type, key: reviewstatus + '|' + type };
    }

    /**
     * Wire up expand/collapse for each student's header row. Expanding loads
     * that student's first page if it has never been loaded, or if it was
     * loaded under a filter selection that has since changed.
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

                const filter = currentFilter();
                if (!expanded && (flags.dataset.loaded !== '1' || flags.dataset.filterkey !== filter.key)) {
                    loadPage(group, 0);
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
     *
     * A filter change immediately reloads any panel that is currently
     * expanded (from page 0, under the new filter) and marks every other
     * panel stale so it reloads the next time it is expanded, rather than
     * eagerly re-fetching panels nobody is looking at.
     */
    function initFilterControls() {
        const reviewSelect = document.getElementById('proctor-filter-review');
        const typeSelect = document.getElementById('proctor-filter-type');

        if (!reviewSelect || !typeSelect) {
            return;
        }

        const onChange = function () {
            document.querySelectorAll('.proctor-student-group').forEach(function (group) {
                const header = group.querySelector('.proctor-student-header');
                const flags = group.querySelector('.proctor-student-flags');
                if (header.getAttribute('aria-expanded') === 'true') {
                    loadPage(group, 0);
                } else {
                    flags.dataset.loaded = '0';
                }
            });
        };

        reviewSelect.addEventListener('change', onChange);
        typeSelect.addEventListener('change', onChange);
    }

    /**
     * Fetch and render one page of one student's flags.
     *
     * @param {HTMLElement} group The .proctor-student-group element.
     * @param {number} page Zero-based page number to load.
     */
    function loadPage(group, page) {
        const userid = parseInt(group.dataset.userid, 10);
        const flags = group.querySelector('.proctor-student-flags');
        const container = flags.querySelector('.proctor-flags-container');
        const pagination = flags.querySelector('.proctor-pagination');
        const filter = currentFilter();

        pagination.style.display = 'none';
        setMessage(container, 'flags_loading', false);

        Ajax.call([{
            methodname: 'quizaccess_proctor_get_student_flags',
            args: {
                cmid: config.cmid,
                userid: userid,
                page: page,
                reviewstatus: filter.reviewstatus,
                type: filter.type,
            }
        }])[0].then(function (result) {
            flags.dataset.loaded = '1';
            flags.dataset.filterkey = filter.key;
            flags.dataset.page = String(result.page);
            flags.dataset.totalpages = String(result.totalpages);

            if (result.total === 0) {
                setMessage(container, 'flags_none_match_filter', false);
            } else {
                container.innerHTML = result.html;
                localizeTimestamps(container);
            }

            updatePaginationControls(flags, result.page, result.totalpages, result.total);
            return null;
        }).catch(function (err) {
            setMessage(container, 'flags_load_error', true);
            Notification.exception(err);
        });
    }

    /**
     * Show a single centred message in a flags container, replacing any
     * cards currently in it — used for the loading, empty, and error states.
     *
     * @param {HTMLElement} container The .proctor-flags-container element.
     * @param {string} stringKey Language string identifier.
     * @param {boolean} isError Whether to style this as an error.
     */
    function setMessage(container, stringKey, isError) {
        Str.get_string(stringKey, 'quizaccess_proctor').then(function (str) {
            container.innerHTML = '<div class="proctor-flags-message' + (isError ? ' proctor-flags-error' : '') + '">'
                + str.replace(/[<>&]/g, function (c) {
                    return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c];
                })
                + '</div>';
            return null;
        }).catch(Notification.exception);
    }

    /**
     * Show/hide and label the Prev/Next controls for the page just loaded.
     *
     * @param {HTMLElement} flags The .proctor-student-flags element.
     * @param {number} page Zero-based page now showing.
     * @param {number} totalpages Total pages available under the current filter.
     * @param {number} total Total flags matching the current filter.
     */
    function updatePaginationControls(flags, page, totalpages, total) {
        const pagination = flags.querySelector('.proctor-pagination');
        const info = pagination.querySelector('.proctor-page-info');
        const prevBtn = pagination.querySelector('.proctor-page-prev');
        const nextBtn = pagination.querySelector('.proctor-page-next');

        pagination.style.display = (totalpages > 1) ? 'flex' : 'none';
        prevBtn.disabled = (page <= 0);
        nextBtn.disabled = (page >= totalpages - 1);

        Str.get_string('pagination_page_info', 'quizaccess_proctor', {
            page: page + 1, totalpages: totalpages, total: total
        }).then(function (str) {
            info.textContent = str;
            return null;
        }).catch(Notification.exception);
    }

    /**
     * Delegated click handling for pagination and review-action buttons.
     * Delegated, rather than bound per-button at init time, because both
     * kinds of button live inside content injected long after page load.
     */
    function initDelegatedActions() {
        const list = document.getElementById('proctor-student-list');
        if (!list) {
            return;
        }

        list.addEventListener('click', function (e) {
            const pageBtn = e.target.closest('.proctor-page-prev, .proctor-page-next');
            if (pageBtn) {
                if (pageBtn.disabled) {
                    return;
                }
                const group = pageBtn.closest('.proctor-student-group');
                const flags = group.querySelector('.proctor-student-flags');
                const current = parseInt(flags.dataset.page || '0', 10);
                const delta = pageBtn.classList.contains('proctor-page-next') ? 1 : -1;
                loadPage(group, current + delta);
                return;
            }

            const actionBtn = e.target.closest('[data-action]');
            if (actionBtn) {
                e.stopPropagation();
                const card = actionBtn.closest('.proctor-flag-card');
                markLog(card, actionBtn.dataset.action);
            }
        });
    }

    /**
     * Send a review-status update for one flag. On success, update that
     * student's header counts and reload the panel's current page — rather
     * than patching the single card in place — since marking a flag can
     * change which page it belongs to under the active filter (it may no
     * longer match at all), and reloading is simpler and more reliably
     * correct than trying to replicate that logic in the client.
     *
     * @param {HTMLElement} card The .proctor-flag-card element.
     * @param {string} status 'confirmed', 'dismissed', or 'pending'.
     */
    function markLog(card, status) {
        const logId = parseInt(card.dataset.logid, 10);
        const previousStatus = card.dataset.review;

        if (previousStatus === status) {
            return;
        }

        const group = card.closest('.proctor-student-group');
        const flags = group.querySelector('.proctor-student-flags');
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
            updateGroupCounts(group, previousStatus, result.status);
            loadPage(group, parseInt(flags.dataset.page || '0', 10));
            return null;
        }).catch(function (err) {
            Notification.exception(err);
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
         * because snapshot thumbnails arrive as server-rendered HTML
         * (lib.php's quizaccess_proctor_render_flag_card()) with an inline
         * onclick — there is no per-thumbnail JS handle to attach a listener
         * to otherwise, and that HTML is injected long after this module's
         * own init() runs.
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
     * Render flag timestamps within the given scope in the viewer's local
     * timezone. The server renders them in server time initially (readable
     * immediately even before this runs), and this replaces that with a
     * locale-aware version. Scoped to newly injected content rather than the
     * whole document, since it is called again after every page load.
     *
     * @param {HTMLElement} scope Container to search within.
     */
    function localizeTimestamps(scope) {
        scope.querySelectorAll('.proctor-flag-time[data-timestamp]').forEach(function (el) {
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
