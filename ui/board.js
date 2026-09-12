// Certificates: the working page. A calendar of the next thirteen weeks with
// every expiry and renewal on its day, every certificate as a row with its
// validity and time left -- grouped by the issuer it comes from, by
// namespace, or simply by what runs out first -- and an inspector with the
// whole picture of the one picked: its names, its issuer, the issuance chain
// and where it is stuck, its events, and the command to renew it by hand.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var M = window.CertManager;
    var K = window.CertManagerKit;
    var el = K.el;
    var add = K.add;
    var DAY = M.DAY;
    var POLL = 5000;
    var EVENTS_EVERY = 15000;
    var WEEKS = 13;

    var FILTERS = [
        { id: 'all', label: 'All', test: null },
        { id: 'expiring', label: 'Expiring soon', tone: 'warn', test: 'expiring' },
        { id: 'not-ready', label: 'Not ready', tone: 'error', test: 'notReady' },
        { id: 'issuing', label: 'Issuing', tone: 'info', test: 'issuing' },
        { id: 'healthy', label: 'Healthy', tone: 'ok', test: 'healthy' },
    ];
    var GROUPS = [
        { id: 'issuer', label: 'Issuer' },
        { id: 'namespace', label: 'Namespace' },
        { id: 'expiry', label: 'Time left' },
    ];

    var state = {
        ctx: null,
        model: null,
        sig: '',
        events: null,
        error: '',
        query: '',
        filter: 'all',
        group: 'issuer',
        day: '',
        selected: '',
        notice: '',
        // How wide the inspector was dragged; 0 is the stylesheet's width.
        width: 0,
    };

    var $ = function (id) {
        return document.getElementById(id);
    };

    function fail(err) {
        state.error = (err && err.message) || String(err);
        drawError();
    }

    function drawError() {
        $('error').textContent = state.error;
        $('error').hidden = !state.error;
    }

    function open(ref) {
        sdk.open(ref).catch(fail);
    }

    var h = { open: open };

    // The drawer has a control in it; a poll's redraw leaves it alone while
    // the user is working in it, and catches up once focus has left.
    var stale = false;

    function held(section, force) {
        if (force) return false;
        var active = document.activeElement;
        if (active && section.contains(active) && /^(SELECT|INPUT|TEXTAREA)$/.test(active.tagName)) {
            stale = true;
            return true;
        }
        return false;
    }

    // ----- what is kept in the address ----------------------------------------

    // Switching tabs unloads the page; the pick, the filter and the grouping
    // live in the hash so coming back finds them where they were.
    function readHash() {
        var parts = {};
        String(location.hash || '')
            .replace(/^#/, '')
            .split('&')
            .forEach(function (kv) {
                var cut = kv.indexOf('=');
                if (cut > 0) parts[kv.slice(0, cut)] = decodeURIComponent(kv.slice(cut + 1));
            });
        if (parts.cert) state.selected = parts.cert;
        if (FILTERS.some(function (f) {
            return f.id === parts.filter;
        })) state.filter = parts.filter;
        if (GROUPS.some(function (g) {
            return g.id === parts.group;
        })) state.group = parts.group;
        if (Number(parts.width) > 0) state.width = Number(parts.width);
    }

    function writeHash() {
        var parts = [];
        if (state.selected) parts.push('cert=' + encodeURIComponent(state.selected));
        if (state.filter !== 'all') parts.push('filter=' + state.filter);
        if (state.group !== 'issuer') parts.push('group=' + state.group);
        if (state.width) parts.push('width=' + state.width);
        try {
            history.replaceState(null, '', '#' + parts.join('&'));
        } catch (e) {
            // A frame that may not touch its history keeps the state in memory.
        }
    }

    // ----- reading the model for this page ----------------------------------

    function dayKey(t) {
        var d = new Date(t);
        return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    }

    function matchesQuery(cert) {
        var q = state.query.trim().toLowerCase();
        if (!q) return true;
        return [cert.name, cert.namespace, cert.secretName, cert.issuerRef.name]
            .concat(cert.hosts)
            .some(function (s) {
                return String(s || '')
                    .toLowerCase()
                    .indexOf(q) >= 0;
            });
    }

    function matchesFilter(cert, id) {
        var f = FILTERS.filter(function (x) {
            return x.id === id;
        })[0];
        return !f || !f.test || cert.facets[f.test];
    }

    function matchesDay(cert) {
        if (!state.day) return true;
        return (cert.notAfter !== null && dayKey(cert.notAfter) === state.day) || (cert.renewalTime !== null && dayKey(cert.renewalTime) === state.day);
    }

    function visible(model) {
        return model.certs.filter(function (c) {
            return matchesQuery(c) && matchesFilter(c, state.filter) && matchesDay(c);
        });
    }

    function selectedCert(model) {
        if (!state.selected) return null;
        return (
            model.certs.filter(function (c) {
                return c.key === state.selected;
            })[0] || null
        );
    }

    // ----- the calendar -------------------------------------------------------

    // Thirteen weeks from this Monday, one square a day: filled where a
    // certificate expires, dotted where one renews. Click a day to see only
    // those.
    function drawCalendar(model) {
        var card = el('div', 'cal-card');
        var head = el('div', 'card-head');
        add(head, K.icon('calendar'), el('h2', '', 'Next 13 weeks'));
        card.appendChild(head);

        var today = new Date(model.now);
        today.setHours(0, 0, 0, 0);
        var monday = new Date(today);
        monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
        var last = new Date(monday);
        last.setDate(monday.getDate() + WEEKS * 7);

        var byDay = {};
        function put(t, cert, what) {
            if (t === null) return;
            var k = dayKey(t);
            (byDay[k] = byDay[k] || { exp: [], ren: [] })[what].push(cert);
        }
        var later = 0;
        var gone = 0;
        model.certs.forEach(function (c) {
            if (c.notAfter !== null) {
                if (c.notAfter >= last.getTime()) later++;
                else if (c.notAfter < monday.getTime()) gone++;
                else put(c.notAfter, c, 'exp');
            }
            if (c.renewalTime !== null && c.renewalTime >= model.now && c.renewalTime < last.getTime() && c.state !== 'issuing') put(c.renewalTime, c, 'ren');
        });

        var cal = el('div', 'cal');
        cal.style.setProperty('--weeks', String(WEEKS));
        // Month names over the week each month starts in.
        var months = el('div', 'cal-months');
        months.appendChild(el('span'));
        var lastMonth = -1;
        for (var w = 0; w < WEEKS; w++) {
            var first = new Date(monday);
            first.setDate(monday.getDate() + w * 7);
            var end = new Date(first);
            end.setDate(first.getDate() + 6);
            var m = w === 0 ? first.getMonth() : end.getMonth();
            months.appendChild(el('span', 'cal-month', m !== lastMonth ? (w === 0 ? first : end).toLocaleDateString(undefined, { month: 'short' }) : ''));
            lastMonth = m;
        }
        cal.appendChild(months);

        var grid = el('div', 'cal-grid');
        ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].forEach(function (d, row) {
            var label = el('span', 'cal-wd', d);
            label.style.gridRow = String(row + 1);
            label.style.gridColumn = '1';
            grid.appendChild(label);
        });
        for (var i = 0; i < WEEKS * 7; i++) {
            var day = new Date(monday);
            day.setDate(monday.getDate() + i);
            var key = dayKey(day.getTime());
            var info = byDay[key];
            var cell = el('button', 'cal-day');
            cell.type = 'button';
            cell.style.gridColumn = String(Math.floor(i / 7) + 2);
            cell.style.gridRow = String((i % 7) + 1);
            cell.dataset.day = key;
            cell.dataset.t = String(day.getTime());
            if (day < today) cell.classList.add('past');
            if (day.getTime() === today.getTime()) cell.classList.add('today');
            if (state.day === key) cell.classList.add('sel');
            if (info && info.exp.length) {
                var worst = info.exp.slice().sort(function (a, b) {
                    return M.STATES[a.state].rank - M.STATES[b.state].rank;
                })[0];
                cell.classList.add('exp', M.STATES[worst.state].tone, 'n' + Math.min(3, info.exp.length));
            }
            if (info && info.ren.length) cell.appendChild(el('i', 'cal-ren'));
            if (!info) cell.tabIndex = -1;
            cell.setAttribute('aria-label', day.toDateString() + (info ? ': ' + info.exp.length + ' expiring, ' + info.ren.length + ' renewing' : ''));
            grid.appendChild(cell);
        }
        cal.appendChild(grid);
        card.appendChild(cal);

        var foot = el('div', 'cal-foot');
        add(foot, add(el('span', 'cal-key'), el('i', 'cal-sw exp ok'), 'expires'), add(el('span', 'cal-key'), el('i', 'cal-sw ren'), 'renews'), add(el('span', 'cal-key'), el('i', 'cal-sw today'), 'today'));
        var notes = [];
        if (gone) notes.push(gone + ' already expired');
        if (later) notes.push(later + ' expire' + (later === 1 ? 's' : '') + ' later');
        if (notes.length) foot.appendChild(el('span', 'faint push', notes.join(' · ')));
        card.appendChild(foot);
        calendarDays = byDay;
        return card;
    }

    var calendarDays = {};

    function stat(label, value, sub, tone, onClick) {
        var node = onClick ? K.button('', 'stat link-stat', null, onClick) : el('div', 'stat');
        add(node, el('span', 'stat-label', label), el('span', 'stat-value' + (tone ? ' ' + tone : ''), value));
        if (sub) node.appendChild(sub);
        return node;
    }

    function drawSummary(model) {
        var box = $('summary');
        box.textContent = '';
        box.appendChild(drawCalendar(model));

        var stats = el('div', 'stats');
        var c = model.counts;
        var attention = c.expired + c.failed + c.stuck + c.notready;
        var sub = el('span', 'stat-sub');
        add(sub, el('span', 'ok-text', c.valid + ' valid'), c.issuing ? ' · ' + c.issuing + ' renewing' : '', attention ? el('span', 'bad-text', ' · ' + attention + ' need' + (attention === 1 ? 's' : '') + ' attention') : '');
        stats.appendChild(stat('Certificates', String(model.certs.length), sub));

        var now = model.now;
        var next = model.certs
            .filter(function (x) {
                return x.notAfter !== null && x.notAfter > now;
            })
            .sort(function (a, b) {
                return a.notAfter - b.notAfter;
            })[0];
        if (next) {
            stats.appendChild(
                stat('Next to expire', next.name, el('span', 'stat-sub ' + K.leftTone(next, now), K.relative(next.notAfter, now) + ' · ' + K.date(next.notAfter)), '', function () {
                    pick(next.key);
                }),
            );
        }
        var ren = model.certs
            .filter(function (x) {
                return x.renewalTime !== null && x.renewalTime > now && x.state !== 'issuing';
            })
            .sort(function (a, b) {
                return a.renewalTime - b.renewalTime;
            })[0];
        if (ren) {
            stats.appendChild(
                stat('Next renewal', ren.name, el('span', 'stat-sub', K.relative(ren.renewalTime, now) + ' · ' + K.date(ren.renewalTime)), '', function () {
                    pick(ren.key);
                }),
            );
        }
        var hosts = {};
        model.certs.forEach(function (x) {
            x.hosts.forEach(function (n) {
                hosts[n] = true;
            });
        });
        stats.appendChild(stat('Names covered', String(Object.keys(hosts).length), el('span', 'stat-sub', 'hosts, wildcards and addresses')));
        box.appendChild(stats);
    }

    // ----- the filters -----------------------------------------------------------

    function drawFilters(model) {
        var box = $('filters');
        box.textContent = '';
        var base = model.certs.filter(function (c) {
            return matchesQuery(c) && matchesDay(c);
        });
        FILTERS.forEach(function (f) {
            var n = base.filter(function (c) {
                return matchesFilter(c, f.id);
            }).length;
            var b = K.button('', 'fchip' + (f.tone ? ' ' + f.tone : '') + (state.filter === f.id ? ' on' : ''), null, function () {
                state.filter = state.filter === f.id ? 'all' : f.id;
                writeHash();
                render(true);
            });
            b.dataset.filter = f.id;
            b.setAttribute('aria-pressed', String(state.filter === f.id));
            if (f.tone) b.appendChild(el('i', 'sdot ' + f.tone));
            add(b, el('span', '', f.label), el('span', 'fchip-n', String(n)));
            box.appendChild(b);
        });
        if (state.day) {
            var t = Number(
                (
                    document.querySelector('.cal-day[data-day="' + state.day + '"]') || { dataset: { t: '0' } }
                ).dataset.t,
            );
            var dayChip = K.button('', 'fchip day on', 'calendar', function () {
                state.day = '';
                render(true);
            });
            add(dayChip, el('span', '', t ? K.date(t) : state.day), el('span', 'fchip-x', '×'));
            dayChip.title = 'Show every day again';
            box.appendChild(dayChip);
        }
        var shown = visible(model).length;
        box.appendChild(el('span', 'faint push small', shown === model.certs.length ? K.plural(shown, 'certificate') : 'Showing ' + shown + ' of ' + model.certs.length));
    }

    // ----- the rows ----------------------------------------------------------------

    function groupsOf(model, certs) {
        var out = [];
        var by = {};
        function into(key, make) {
            if (!by[key]) {
                by[key] = make();
                by[key].certs = [];
                out.push(by[key]);
            }
            return by[key];
        }
        if (state.group === 'expiry') {
            var g = { key: 'all', title: 'By time left', certs: certs.slice() };
            g.certs.sort(function (a, b) {
                var ta = a.notAfter === null ? -Infinity : a.notAfter;
                var tb = b.notAfter === null ? -Infinity : b.notAfter;
                return ta - tb;
            });
            return [g];
        }
        certs.forEach(function (c) {
            var group;
            if (state.group === 'namespace') {
                group = into('ns:' + c.namespace, function () {
                    return { key: 'ns:' + c.namespace, kind: 'namespace', title: c.namespace };
                });
            } else {
                var ref = c.issuerRef;
                var key = ref.kind + '/' + (ref.kind === 'ClusterIssuer' ? '' : c.namespace) + '/' + ref.name + '/' + ref.group;
                group = into(key, function () {
                    return { key: key, kind: 'issuer', issuer: c.issuer, ref: ref, namespace: c.namespace, title: ref.name };
                });
            }
            group.certs.push(c);
        });
        out.forEach(function (grp) {
            grp.worst = Math.min.apply(
                null,
                grp.certs.map(function (c) {
                    return M.STATES[c.state].rank;
                }),
            );
        });
        return out.sort(function (a, b) {
            return a.worst - b.worst || b.certs.length - a.certs.length || a.title.localeCompare(b.title);
        });
    }

    function groupHead(model, g) {
        var head = el('header', 'group-head');
        if (g.kind === 'issuer') {
            var i = g.issuer;
            var external = g.ref.group !== M.GROUP;
            var type = i ? i.type : external ? 'external' : 'other';
            var tile = K.issuerTile(type, i && i.ready !== 'True' ? 'error' : !i && !external ? 'error' : '');
            var names = el('div', 'group-names');
            var title = i
                ? K.link(g.title, function () {
                      open(M.ref.issuer(i));
                  }, 'Open ' + i.kind + ' ' + i.name)
                : el('span', '', g.title);
            title.classList.add('group-title');
            var sub = [g.ref.kind + (g.ref.kind === 'Issuer' ? ' · ' + g.namespace : '')];
            if (i && i.acme) sub.push(i.acme.provider);
            else if (i) sub.push(M.ISSUER_TYPES[i.type]);
            else if (external) sub.push('external issuer · ' + g.ref.group);
            else sub.push('does not exist');
            add(names, title, el('span', 'group-sub', sub.join(' · ')));
            add(head, tile, names);
            if (i && i.acme && i.acme.staging) head.appendChild(K.stagingBadge());
            if (i) head.appendChild(K.readyChip(i));
            else if (!external) head.appendChild(K.chip('missing', 'error', 'failed', 'No ' + g.ref.kind + ' called ' + g.ref.name));
        } else if (g.kind === 'namespace') {
            var nsTile = el('span', 'itile t-ns');
            nsTile.appendChild(K.icon('grid'));
            var nsNames = el('div', 'group-names');
            add(nsNames, el('span', 'group-title', g.title), el('span', 'group-sub', 'namespace'));
            add(head, nsTile, nsNames);
        } else {
            var tTile = el('span', 'itile t-ns');
            tTile.appendChild(K.icon('clock'));
            var tNames = el('div', 'group-names');
            add(tNames, el('span', 'group-title', 'Soonest first'), el('span', 'group-sub', 'every certificate, by when it runs out'));
            add(head, tTile, tNames);
        }
        // Counted by how they read rather than by state: an expired and a
        // stuck certificate are both red, and two red dots side by side
        // would ask to be told apart.
        var counts = {};
        var names = {};
        g.certs.forEach(function (c) {
            var t = M.STATES[c.state].tone;
            counts[t] = (counts[t] || 0) + 1;
            (names[t] = names[t] || []).push(M.STATES[c.state].label.toLowerCase());
        });
        var summary = el('span', 'group-count');
        ['error', 'warn', 'info', 'ok'].forEach(function (t) {
            if (!counts[t]) return;
            var n = add(el('span', 'group-n'), el('i', 'sdot ' + t), String(counts[t]));
            n.title = names[t]
                .filter(function (v, i, all) {
                    return all.indexOf(v) === i;
                })
                .join(', ');
            summary.appendChild(n);
        });
        head.appendChild(summary);
        return head;
    }

    function row(model, cert) {
        var now = model.now;
        var b = el('button', 'cert-row' + (state.selected === cert.key ? ' sel' : ''));
        b.type = 'button';
        b.dataset.key = cert.key;
        b.addEventListener('click', function () {
            pick(state.selected === cert.key ? '' : cert.key);
        });

        var who = el('span', 'cr-who');
        var sub = state.group === 'namespace' ? cert.issuerRef.name : cert.namespace;
        add(who, el('span', 'cr-name', cert.name), el('span', 'cr-sub', sub + (cert.isCA ? ' · CA' : '')));

        var hosts = el('span', 'cr-hosts');
        if (cert.hosts.length) {
            hosts.appendChild(el('span', 'cr-host', cert.hosts[0]));
            if (cert.hosts.length > 1) hosts.appendChild(el('span', 'cr-more', '+' + (cert.hosts.length - 1)));
            hosts.title = cert.hosts.join('\n');
        } else {
            hosts.appendChild(el('span', 'faint', 'no names'));
        }

        var life = el('span', 'cr-life');
        life.appendChild(K.validityBar(cert, now));
        var d = M.describe(cert, now);
        life.appendChild(el('span', 'cr-says ' + d.tone, d.text));

        var left = K.bigLeft(cert, now);
        var leftBox = el('span', 'cr-left ' + K.leftTone(cert, now));
        add(leftBox, el('span', 'cr-left-n', left.n), el('span', 'cr-left-u', left.unit));

        add(b, K.stateDot(cert.state, M.STATES[cert.state].label), who, hosts, life, leftBox, K.icon('chevron', 'cr-chev'));
        return b;
    }

    function drawGroups(model) {
        var root = $('groups');
        tip.hidden = true;
        root.textContent = '';
        var certs = visible(model);
        if (!model.certs.length) {
            root.appendChild(gettingStarted(model));
            return;
        }
        if (!certs.length) {
            var none = el('div', 'nothing');
            add(none, K.icon('search'), el('span', '', state.query.trim() ? 'No certificate matches “' + state.query.trim() + '”' + (state.filter !== 'all' || state.day ? ' with these filters.' : '.') : 'No certificate is in this state right now.'));
            if (state.filter !== 'all' || state.day || state.query) {
                none.appendChild(
                    K.button('Show everything', 'ghost small', null, function () {
                        state.filter = 'all';
                        state.day = '';
                        state.query = '';
                        $('query').value = '';
                        writeHash();
                        render(true);
                    }),
                );
            }
            root.appendChild(none);
            return;
        }
        groupsOf(model, certs).forEach(function (g) {
            var section = el('section', 'group');
            section.appendChild(groupHead(model, g));
            var list = el('div', 'rows');
            g.certs.forEach(function (c) {
                list.appendChild(row(model, c));
            });
            section.appendChild(list);
            root.appendChild(section);
        });
    }

    function gettingStarted(model) {
        var box = el('div', 'getting-started');
        add(box, el('h2', '', 'No certificates yet'), el('p', '', 'cert-manager is installed' + (model.issuers.length ? ' with ' + K.plural(model.issuers.length, 'issuer') : ', but there is no issuer yet') + '. The quickest way to a certificate is to annotate an Ingress that has a tls section, and ingress-shim makes the Certificate for you:'));
        var pre = el('pre', 'snippet');
        var first = model.issuers.filter(function (i) {
            return i.cluster;
        })[0];
        pre.textContent = ['metadata:', '  annotations:', '    cert-manager.io/cluster-issuer: ' + (first ? first.name : 'letsencrypt-prod'), 'spec:', '  tls:', '    - hosts: [app.example.com]', '      secretName: app-tls'].join('\n');
        box.appendChild(pre);
        box.appendChild(
            K.button('cert-manager: securing Ingresses', 'ghost', 'open', function () {
                sdk.openUrl('https://cert-manager.io/docs/usage/ingress/').catch(fail);
            }),
        );
        return box;
    }

    // ----- the inspector -----------------------------------------------------------

    function pick(key) {
        state.selected = key;
        writeHash();
        render(true);
        if (key) {
            var drawer = $('drawer');
            drawer.scrollTop = 0;
        }
    }

    function section(title, body, className) {
        var node = el('section', 'dsec' + (className ? ' ' + className : ''));
        node.appendChild(el('h3', 'mini-title', title));
        add(node, body);
        return node;
    }

    function fact(label, value) {
        var dt = el('dt', '', label);
        var dd = el('dd');
        add(dd, value);
        return [dt, dd];
    }

    function durationWords(ms) {
        if (!ms) return '';
        return K.span(ms);
    }

    function drawDrawer(model, force) {
        var box = $('drawer');
        var cert = selectedCert(model);
        document.body.classList.toggle('drawer-open', !!cert);
        if (!cert) {
            box.hidden = true;
            box.textContent = '';
            return;
        }
        if (held(box, force)) return;
        stale = false;
        var scroll = box.scrollTop;
        box.textContent = '';
        box.hidden = false;
        var now = model.now;

        var top = el('div', 'd-top');
        var close = K.button('', 'icon-button', 'close', function () {
            pick('');
        });
        close.title = 'Close (Esc)';
        close.setAttribute('aria-label', 'Close');
        var tools = el('div', 'd-tools');
        add(
            tools,
            K.button('Open', 'ghost small', 'open', function () {
                open(M.ref.cert(cert));
            }),
            K.button('YAML', 'ghost small', 'edit', function () {
                sdk.edit(M.ref.cert(cert)).catch(fail);
            }),
            close,
        );
        add(top, K.stateChip(cert), tools);
        box.appendChild(top);

        var title = el('h2', 'd-title', cert.name);
        box.appendChild(title);
        var d = M.describe(cert, now);
        var sub = el('div', 'd-sub');
        add(sub, el('span', 'faint', cert.namespace), el('span', 'd-says ' + d.tone, d.text));
        box.appendChild(sub);

        if (state.notice) {
            var note = el('div', 'notice');
            add(note, K.icon('check'), el('span', '', state.notice));
            box.appendChild(note);
        }

        // Validity: the number, the bar, the three dates.
        var validity = el('div', 'd-validity');
        var left = K.bigLeft(cert, now);
        var big = el('div', 'd-left ' + K.leftTone(cert, now));
        add(big, el('span', 'd-left-n', left.n), el('span', 'd-left-u', left.unit));
        validity.appendChild(big);
        validity.appendChild(K.validityBar(cert, now, { labels: true, big: true }));
        var lifeNote = [];
        if (cert.lifetime) lifeNote.push('valid for ' + K.span(cert.lifetime));
        if (cert.renewalTime !== null && cert.notAfter !== null) lifeNote.push('renewed ' + K.span(cert.notAfter - cert.renewalTime) + ' before it expires');
        if (lifeNote.length) validity.appendChild(el('div', 'd-life', lifeNote.join(', ')));
        box.appendChild(section('Validity', validity));

        var why = K.why(cert.chain, { headline: true });
        var chainBox = el('div');
        chainBox.appendChild(K.chainSteps(cert.chain, h, { vertical: true }));
        if (why) chainBox.appendChild(why);
        if (cert.retryAt) {
            chainBox.appendChild(el('div', 'd-retry', 'After ' + K.plural(cert.failedAttempts, 'failed attempt') + ', cert-manager tries again ' + (cert.retryAt > now ? K.relative(cert.retryAt, now) + ' — ' + K.dateTime(cert.retryAt) : 'any moment now') + '.'));
        }
        box.appendChild(section(cert.chain.inflight ? 'Issuance in progress' : cert.chain.open ? 'The attempt that failed' : 'Last issuance', chainBox));

        // Names.
        var names = el('div', 'd-names');
        cert.hosts.forEach(function (n) {
            var c = el('code', 'name-chip', n);
            c.title = 'Click to select';
            names.appendChild(c);
        });
        cert.uris.concat(cert.emails).forEach(function (n) {
            names.appendChild(el('code', 'name-chip', n));
        });
        if (!names.childNodes.length) names.appendChild(el('span', 'faint', 'No DNS names — ' + (cert.isCA ? 'a CA certificate, identified by its subject.' : 'identified by its subject only.')));
        box.appendChild(section('Names', names));

        // Details.
        var dl = el('dl', 'facts');
        var issuerVal = el('span', 'fact-issuer');
        if (cert.issuer) {
            add(
                issuerVal,
                K.issuerTile(cert.issuer.type, cert.issuer.ready === 'True' ? '' : 'error'),
                K.link(cert.issuer.name, function () {
                    open(M.ref.issuer(cert.issuer));
                }),
                el('span', 'faint', ' ' + cert.issuer.kind),
                K.readyChip(cert.issuer),
                cert.issuer.acme && cert.issuer.acme.staging ? K.stagingBadge() : null,
            );
        } else {
            add(issuerVal, el('span', '', cert.issuerRef.kind + ' ' + cert.issuerRef.name), cert.issuerRef.group !== M.GROUP ? el('span', 'faint', ' (' + cert.issuerRef.group + ')') : K.chip('does not exist', 'error', 'failed'));
        }
        add.apply(null, [dl].concat(fact('Issuer', issuerVal)));
        var secret = el('span', 'fact-secret');
        add(secret, K.icon('lock'), el('code', '', cert.secretName || '—'), el('span', 'faint small', 'its contents are never read here'));
        add.apply(null, [dl].concat(fact('Secret', secret)));
        var key = cert.privateKey;
        if (key.algorithm || key.size || key.rotationPolicy) {
            add.apply(null, [dl].concat(fact('Private key', [key.algorithm || 'RSA', key.size ? String(key.size) : '', key.rotationPolicy ? 'rotation ' + key.rotationPolicy : ''].filter(Boolean).join(' · '))));
        }
        var asked = [];
        if (cert.duration) asked.push(durationWords(cert.duration));
        if (cert.renewBefore) asked.push('renew ' + durationWords(cert.renewBefore) + ' before');
        if (cert.renewBeforePercentage) asked.push('renew with ' + cert.renewBeforePercentage + '% left');
        add.apply(null, [dl].concat(fact('Asks for', asked.length ? asked.join(', ') : 'the defaults — 90 days, renewed with a third left')));
        add.apply(null, [dl].concat(fact('Revision', cert.revision ? String(cert.revision) + (cert.chain.open ? ' → ' + (cert.revision + 1) + ' being issued' : '') : 'not issued yet')));
        if (cert.failedAttempts) {
            add.apply(null, [dl].concat(fact('Failed attempts', el('span', 'bad-text', cert.failedAttempts + (cert.lastFailure ? ' · last ' + K.relative(cert.lastFailure, now) : '')))));
        }
        if (cert.usedBy.length || cert.owner) {
            var used = el('span', 'fact-used');
            var seen = {};
            cert.usedBy.forEach(function (u) {
                seen[u.kind + '/' + u.name] = true;
                add(
                    used,
                    add(
                        el('span', 'used-item'),
                        K.icon('ingress'),
                        K.link(u.kind + ' ' + u.name, function () {
                            open({ kind: u.appKind, namespace: u.namespace, name: u.name });
                        }),
                    ),
                );
            });
            if (cert.owner && !seen[cert.owner.kind + '/' + cert.owner.name]) {
                add(used, add(el('span', 'used-item'), K.icon('ingress'), el('span', '', cert.owner.kind + ' ' + cert.owner.name)));
            }
            add.apply(null, [dl].concat(fact('Served by', used)));
        }
        box.appendChild(section('Details', dl));

        // Conditions.
        var conds = el('ul', 'conds');
        ((cert.obj.status && cert.obj.status.conditions) || []).forEach(function (c) {
            var t = c.status === 'True' ? (c.type === 'Issuing' ? 'info' : 'ok') : c.status === 'False' ? (c.type === 'Issuing' && c.reason !== 'Failed' ? 'muted' : 'error') : 'warn';
            var li = el('li', 'cond ' + t);
            var line = el('div', 'cond-line');
            add(line, el('i', 'sdot ' + t), el('strong', '', c.type), el('span', 'cond-status', c.status), c.reason ? el('span', 'faint', c.reason) : null, el('span', 'faint push small', K.ago(Date.parse(c.lastTransitionTime), now)));
            li.appendChild(line);
            if (c.message) li.appendChild(el('div', 'cond-msg', c.message));
            conds.appendChild(li);
        });
        if (!conds.childNodes.length) conds.appendChild(el('li', 'faint', 'No conditions yet — cert-manager has not looked at it.'));
        box.appendChild(section('Conditions', conds));

        // Events about it and everything made to issue it.
        var mine = {};
        mine['Certificate/' + cert.name] = true;
        cert.requests.forEach(function (r) {
            mine['CertificateRequest/' + r.name] = true;
            r.orders.forEach(function (o) {
                mine['Order/' + o.name] = true;
                o.challenges.forEach(function (c) {
                    mine['Challenge/' + c.name] = true;
                });
            });
        });
        var evs = (state.events || []).filter(function (e) {
            return e.namespace === cert.namespace && mine[e.kind + '/' + e.name];
        });
        var evBox = el('div');
        if (state.events === null) evBox.appendChild(el('p', 'quiet', 'Reading events…'));
        else if (!evs.length) evBox.appendChild(el('p', 'quiet', 'No recent events. Kubernetes keeps them for about an hour.'));
        else evBox.appendChild(K.eventLog(evs.slice(0, 10), h));
        box.appendChild(section('Recent events', evBox));

        box.appendChild(section('Renew by hand', K.cmctl(cert)));

        if (state.ctx.write && model.issuers.length) box.appendChild(section('Change issuer', issuerControl(model, cert)));
        box.scrollTop = scroll;
    }

    // A certificate made by ingress-shim is rewritten from its Ingress or
    // Gateway, so a change to the certificate would be undone: the change
    // goes on the owner's annotation instead.
    function issuerControl(model, cert) {
        var box = el('div', 'd-change');
        var owner = null;
        if (cert.owner) {
            owner =
                model.owners.filter(function (e) {
                    return e.kind === cert.owner.kind && e.name === cert.owner.name && e.namespace === cert.namespace;
                })[0] || null;
        }
        box.appendChild(
            el(
                'p',
                'quiet',
                owner
                    ? 'This certificate is made by ingress-shim from ' + owner.kind + ' ' + owner.name + ', so the issuer is changed on its annotation. cert-manager then issues a new certificate from the new issuer.'
                    : 'cert-manager notices the change and issues a new certificate from the new issuer. The current one keeps serving until then.',
            ),
        );
        var picker = K.issuerPicker(model, cert.namespace, cert.issuer);
        var go = K.button('Switch', 'small', 'arrow', function () {
            var issuer = picker.pick();
            if (!issuer || issuer === cert.issuer) return;
            var ref = owner ? M.ref.owner(owner) : M.ref.cert(cert);
            var patch = owner ? K.patches.shimIssuer(owner, issuer) : K.patches.certIssuer(issuer);
            K.apply(sdk, ref, patch)
                .then(function (done) {
                    if (done) notice('Asked cert-manager to issue ' + cert.name + ' from ' + issuer.name + '.');
                })
                .catch(fail);
        });
        var line = el('div', 'control');
        add(line, picker, go);
        box.appendChild(line);
        return box;
    }

    function notice(text) {
        state.notice = text;
        drawDrawer(state.model, true);
        setTimeout(function () {
            if (state.notice === text) {
                state.notice = '';
                if (state.model) drawDrawer(state.model);
            }
        }, 6000);
    }

    // ----- not installed -------------------------------------------------------

    function drawEmpty(model) {
        var box = $('empty');
        box.textContent = '';
        box.hidden = false;
        var art = el('div', 'empty-art');
        art.appendChild(K.icon('logo'));
        add(box, art, el('h2', '', 'cert-manager is not installed in ' + state.ctx.contextName), el('p', 'faint', 'This cluster does not serve Certificates, which every cert-manager install has. TLS here is looked after by something else, or by hand.'));
        if (model.missing) box.appendChild(el('p', 'faint small', model.missing));
        box.appendChild(
            K.button('How to install cert-manager', 'primary', 'open', function () {
                sdk.openUrl('https://cert-manager.io/docs/installation/').catch(fail);
            }),
        );
    }

    // ----- putting it together ---------------------------------------------------

    function drawTop() {
        var group = $('group');
        group.textContent = '';
        GROUPS.forEach(function (g) {
            var b = K.button(g.label, 'seg-btn' + (state.group === g.id ? ' on' : ''), null, function () {
                state.group = g.id;
                writeHash();
                render(true);
            });
            b.dataset.group = g.id;
            b.setAttribute('aria-pressed', String(state.group === g.id));
            group.appendChild(b);
        });
    }

    // force is for a redraw the user asked for by clicking; a poll's redraw
    // leaves the drawer alone while they are working in it.
    function render(force) {
        var model = state.model;
        if (!model) return;
        drawError();
        var where = state.ctx.contextName;
        if (model.version) where += ' · cert-manager ' + model.version;
        if (model.namespace) where += ' in ' + model.namespace;
        $('where').textContent = where;

        if (!model.installed) {
            drawEmpty(model);
            $('board').hidden = true;
            $('drawer').hidden = true;
            document.body.classList.remove('drawer-open');
            return;
        }
        $('empty').hidden = true;
        $('board').hidden = false;
        drawTop();
        drawSummary(model);
        drawFilters(model);
        drawGroups(model);
        drawDrawer(model, force);
    }

    function stamp(model) {
        return model.sig + '|' + Math.floor(Date.now() / 60000);
    }

    function tick() {
        M.load(sdk)
            .then(function (model) {
                if (state.error) {
                    state.error = '';
                    drawError();
                }
                var sig = stamp(model);
                if (sig !== state.sig) {
                    var first = !state.model;
                    state.model = model;
                    state.sig = sig;
                    render();
                    if (first) refreshEvents();
                }
            })
            .catch(fail)
            .then(function () {
                setTimeout(tick, POLL);
            });
    }

    function refreshEvents() {
        if (!state.model || !state.model.installed) return;
        M.loadEvents(sdk)
            .then(function (events) {
                var changed = JSON.stringify(events) !== JSON.stringify(state.events);
                state.events = events;
                if (changed && state.selected) drawDrawer(state.model);
            })
            .catch(fail);
    }

    // One tip for every row and calendar day, however often they are redrawn.
    var tip = K.tooltip(document.body, '.cert-row, .cal-day', function (node, into) {
        var model = state.model;
        if (!model) return false;
        if (node.classList.contains('cal-day')) {
            var info = calendarDays[node.dataset.day];
            if (!info) return false;
            into.appendChild(el('div', 'tip-head', K.dateTime(Number(node.dataset.t)).replace(/,.*$/, '')));
            info.exp.forEach(function (c) {
                add(into, add(el('div', 'tip-line'), K.stateDot(c.state), el('strong', '', c.name), el('span', 'faint', ' expires')));
            });
            info.ren.forEach(function (c) {
                add(into, add(el('div', 'tip-line'), el('i', 'sdot info'), el('strong', '', c.name), el('span', 'faint', ' renews')));
            });
            into.appendChild(el('div', 'tip-note', 'Click to show only these'));
            return true;
        }
        var cert = model.certs.filter(function (c) {
            return c.key === node.dataset.key;
        })[0];
        return cert ? K.describeCert(cert, model.now, into) : false;
    });

    $('scrim').addEventListener('click', function () {
        pick('');
    });

    $('summary').addEventListener('click', function (event) {
        var day = event.target.closest && event.target.closest('.cal-day');
        if (!day || !calendarDays[day.dataset.day]) return;
        state.day = state.day === day.dataset.day ? '' : day.dataset.day;
        render(true);
    });

    $('logo').appendChild(K.icon('logo'));
    $('search-icon').appendChild(K.icon('search'));
    $('query').addEventListener('input', function () {
        state.query = $('query').value;
        render(true);
    });
    $('query').addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
            $('query').value = '';
            state.query = '';
            render(true);
        }
    });
    document.addEventListener('keydown', function (event) {
        if (event.key === '/' && (document.activeElement === document.body || !document.activeElement)) {
            event.preventDefault();
            $('query').focus();
        } else if (event.key === 'Escape' && state.selected && document.activeElement !== $('query')) {
            pick('');
        }
    });
    document.addEventListener('focusout', function () {
        setTimeout(function () {
            if (stale && state.model && state.model.installed) drawDrawer(state.model);
        }, 0);
    });

    $('top-actions').appendChild(
        K.button('Overview', 'ghost', 'logo', function () {
            sdk.openView('overview').catch(fail);
        }),
    );

    readHash();
    // The inspector is as wide as it was left: the width is kept in the hash
    // with the rest of the page's state.
    document.body.appendChild(
        K.grip({
            panel: $('drawer'),
            prop: '--drawer-w',
            className: 'drawer-grip',
            min: 360,
            room: 420,
            initial: state.width,
            label: 'Resize the inspector',
            onResize: function (px, done) {
                if (!done) return;
                state.width = px;
                writeHash();
            },
        }),
    );
    sdk.ready()
        .then(function (context) {
            state.ctx = context;
            $('where').textContent = context.contextName;
            tick();
            setInterval(refreshEvents, EVENTS_EVERY);
        })
        .catch(fail);
})();
