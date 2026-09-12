// The drawing kit the pages share: icons, chips and buttons, the ways time is
// written, a certificate's validity drawn as a bar, the issuance chain drawn
// as steps, and the patches the few controls ask the app to make.
//
// Everything that came from the cluster is written with textContent, never
// innerHTML: the frame is sandboxed, but a page that let a certificate's name
// or a CA's error message run as markup would be handing it the bridge.
(function () {
    'use strict';

    var M = window.CertManager;
    var SVG = 'http://www.w3.org/2000/svg';
    var MINUTE = M.MINUTE;
    var HOUR = M.HOUR;
    var DAY = M.DAY;
    var YEAR = 365.25 * DAY;

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function add(parent) {
        for (var i = 1; i < arguments.length; i++) {
            var child = arguments[i];
            if (child === null || child === undefined || child === false) continue;
            parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        }
        return parent;
    }

    function svg(tag, attrs) {
        var node = document.createElementNS(SVG, tag);
        Object.keys(attrs || {}).forEach(function (k) {
            node.setAttribute(k, attrs[k]);
        });
        return node;
    }

    // Single-stroke icons on a 24-unit grid.
    var ICONS = {
        logo: ['M12 2.8l7.5 3.1v5.6c0 4.6-3.2 8.4-7.5 9.9-4.3-1.5-7.5-5.3-7.5-9.9V5.9z', 'M9.3 11.2V9.6a2.7 2.7 0 0 1 5.4 0v1.6', 'M8.6 11.2h6.8v4.6H8.6z'],
        lock: ['M7 11h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3', 'M12 14.5v2'],
        cert: ['M13 3H6.5a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 6.5 21H11', 'M13 3l5 5v2.5', 'M13 3v5h5', 'M8.5 12h4', 'M8.5 15.5h2', 'M16.5 12.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M15 18.2l-.6 3.3 2.1-1.1 2.1 1.1-.6-3.3'],
        request: ['M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5z', 'M14 3v4.5h4.5', 'M9 14h6', 'M12.5 11.5L15 14l-2.5 2.5'],
        order: ['M6 3h12v18l-3-1.8-3 1.8-3-1.8L6 21z', 'M9 8h6', 'M9 11.5h6', 'M9 15h3.5'],
        challenge: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z', 'M12 12.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z'],
        issuer: ['M10 13V9.5a2 2 0 1 1 4 0V13', 'M5 13h14v3.5H5z', 'M4 20.5h16'],
        acme: ['M13 2.5L5 13.5h6l-1 8 8-11h-6z'],
        ca: ['M12 14a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M8.6 12.7L7 21l5-2.6 5 2.6-1.6-8.3'],
        selfsigned: ['M17 2.5l3 3-3 3', 'M4 11.5v-2a4 4 0 0 1 4-4h12', 'M7 21.5l-3-3 3-3', 'M20 12.5v2a4 4 0 0 1-4 4H4'],
        vault: ['M4 4.5h16v14H4z', 'M12 15a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M12 11.5h.01', 'M7 18.5v2', 'M17 18.5v2'],
        venafi: ['M4 5l8 14.5L20 5'],
        external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5.5H4.5V6H10'],
        calendar: ['M5 5.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
        clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3.2 2'],
        hourglass: ['M7 3h10', 'M7 21h10', 'M8 3c0 5 8 5 8 9s-8 4-8 9', 'M16 3c0 5-8 5-8 9s8 4 8 9'],
        globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18', 'M12 3a14 14 0 0 0 0 18'],
        dns: ['M12 3v18', 'M5 5.5h10.5l3 3-3 3H5z', 'M19 13.5H8.5l-3 3 3 3H19z'],
        key: ['M8 15.5a4 4 0 1 1 0-8 4 4 0 0 1 0 8z', 'M12 11.5h9', 'M18 11.5v3', 'M21 11.5v2'],
        ingress: ['M3.5 21V9l8.5-5.5L20.5 9v12', 'M9 21v-6.5h6V21', 'M3.5 21h17'],
        pod: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12L4 7.5'],
        alert: ['M12 3.5l9.5 17h-19z', 'M12 10v4', 'M12 17.2h.01'],
        check: ['M4.5 12.5l5 5L19.5 7'],
        close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
        failed: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9 9l6 6', 'M15 9l-6 6'],
        info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v6', 'M12 7.5h.01'],
        search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
        arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
        chevron: ['M9.5 6l6 6-6 6'],
        edit: ['M4 20h4L19 9l-4-4L4 16z', 'M14 6l4 4'],
        open: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
        chart: ['M4 4v16h16', 'M8 15l3-4 3 2 5-6'],
        activity: ['M3 12h4l3-8 4 16 3-8h4'],
        refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4.5v6.5h-6.5'],
        copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
        terminal: ['M4 5h16v14H4z', 'M7.5 9.5l3 2.5-3 2.5', 'M12.5 15h4'],
        runway: ['M3 7h10', 'M3 12h14', 'M3 17h7', 'M19 4v16'],
        dot: ['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'],
        stamp: ['M10 13V9.5a2 2 0 1 1 4 0V13', 'M5 13h14v3.5H5z', 'M4 20.5h16'],
        grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
        rows: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
    };

    function icon(name, className) {
        var node = svg('svg', { viewBox: '0 0 24 24', class: 'ico' + (className ? ' ' + className : ''), 'aria-hidden': 'true' });
        (ICONS[name] || ICONS.info).forEach(function (d) {
            node.appendChild(svg('path', { d: d }));
        });
        return node;
    }

    function chip(text, tone, iconName, title) {
        var node = el('span', 'chip' + (tone ? ' ' + tone : ''));
        if (iconName) node.appendChild(icon(iconName));
        node.appendChild(el('span', '', text));
        if (title) node.title = title;
        return node;
    }

    function button(text, className, iconName, onClick) {
        var node = el('button', className || '');
        node.type = 'button';
        if (iconName) node.appendChild(icon(iconName));
        if (text) node.appendChild(el('span', '', text));
        if (onClick) node.addEventListener('click', onClick);
        return node;
    }

    function link(text, onClick, title) {
        var node = el('button', 'link', text);
        node.type = 'button';
        if (title) node.title = title;
        node.addEventListener('click', onClick);
        return node;
    }

    // What the plugin is about, from its manifest's links: a row of links,
    // each opened in the user's browser. Null when the app did not say or the
    // manifest has none.
    function about(sdk, plugin, onError) {
        if (!plugin || !plugin.links || !plugin.links.length) return null;
        var row = el('div', 'about');
        row.appendChild(el('span', 'about-label', plugin.version ? 'Plugin ' + plugin.version + ' ·' : 'About'));
        plugin.links.forEach(function (l) {
            row.appendChild(
                link(
                    l.label,
                    function () {
                        sdk.openUrl(l.url).catch(onError || function () {});
                    },
                    l.url,
                ),
            );
        });
        return row;
    }

    // ----- time, written for a person ----------------------------------------

    function plural(n, one, many) {
        return n + ' ' + (n === 1 ? one : many || one + 's');
    }

    // A length of time in words: "40 seconds", "12 minutes", "23 hours",
    // "45 days", "3 months", "9 years".
    function span(ms) {
        var a = Math.abs(ms);
        if (a < MINUTE) return plural(Math.max(1, Math.round(a / 1000)), 'second');
        if (a < HOUR) return plural(Math.round(a / MINUTE), 'minute');
        if (a < 2 * DAY) return plural(Math.round(a / HOUR), 'hour');
        if (a < 120 * DAY) return plural(Math.round(a / DAY), 'day');
        if (a < 2 * YEAR) return plural(Math.round(a / (YEAR / 12)), 'month');
        return plural(Math.round(a / YEAR), 'year');
    }

    // The same, as short as it goes: "40s", "12m", "23h", "45d", "3mo", "9y".
    function short(ms) {
        var a = Math.abs(ms);
        if (a < MINUTE) return Math.max(1, Math.round(a / 1000)) + 's';
        if (a < HOUR) return Math.round(a / MINUTE) + 'm';
        if (a < 2 * DAY) return Math.round(a / HOUR) + 'h';
        if (a < 120 * DAY) return Math.round(a / DAY) + 'd';
        if (a < 2 * YEAR) return Math.round(a / (YEAR / 12)) + 'mo';
        return Math.round(a / YEAR) + 'y';
    }

    function relative(t, now) {
        if (t === null || t === undefined) return '';
        return t >= now ? 'in ' + span(t - now) : span(now - t) + ' ago';
    }

    function ago(t, now) {
        if (!t) return '';
        now = now || Date.now();
        if (now - t < 10000) return 'just now';
        return short(now - t) + ' ago';
    }

    // "16 Sep", with the year when it is not this one.
    function date(t) {
        if (t === null || t === undefined) return '—';
        var d = new Date(t);
        var opts = { day: 'numeric', month: 'short' };
        if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
        return d.toLocaleDateString(undefined, opts);
    }

    // "Wed 16 Sep, 14:02".
    function dateTime(t) {
        if (t === null || t === undefined) return '—';
        var d = new Date(t);
        var opts = { weekday: 'short', day: 'numeric', month: 'short' };
        if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
        return d.toLocaleDateString(undefined, opts) + ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }

    // Time left as one big number and its unit, for the places the number is
    // the point: { n: '45', unit: 'days left' }.
    function bigLeft(cert, now) {
        if (cert.notAfter === null) return { n: '—', unit: 'not issued yet' };
        var left = cert.notAfter - now;
        var a = Math.abs(left);
        var n;
        var unit;
        if (a >= 2 * YEAR) {
            n = Math.floor(a / YEAR);
            unit = 'years';
        } else if (a >= 2 * DAY) {
            n = Math.floor(a / DAY);
            unit = 'days';
        } else if (a >= 2 * HOUR) {
            n = Math.floor(a / HOUR);
            unit = 'hours';
        } else {
            n = Math.max(1, Math.floor(a / MINUTE));
            unit = 'minutes';
        }
        return { n: String(n), unit: left > 0 ? unit + ' left' : unit + ' ago' };
    }

    // How a time left reads, whatever the certificate's state: red under a
    // week, amber under the fourteen days a healthy renewal never lets it
    // get to.
    function leftTone(cert, now) {
        if (cert.notAfter === null) return 'muted';
        var left = cert.notAfter - now;
        if (left <= 7 * DAY) return 'error';
        if (cert.soon) return 'warn';
        return 'ok';
    }

    // ----- the state of a certificate ----------------------------------------

    function stateChip(cert) {
        var s = M.STATES[cert.state];
        var icons = { expired: 'failed', failed: 'failed', stuck: 'alert', notready: 'alert', expiring: 'clock', issuing: 'refresh', valid: 'check' };
        return chip(s.label, s.tone, icons[cert.state]);
    }

    function stateDot(state, title) {
        var node = el('i', 'sdot ' + M.STATES[state].tone + (state === 'issuing' ? ' spin' : ''));
        if (title) node.title = title;
        return node;
    }

    // A certificate's life as a bar: the stretch it has been valid, the
    // stretch it has left, where cert-manager means to renew it and where
    // now is. With labels, the three dates are written under it.
    function validityBar(cert, now, opts) {
        opts = opts || {};
        var node = el('div', 'vbar ' + M.STATES[cert.state].tone + (opts.big ? ' big' : ''));
        var track = el('div', 'vbar-track');
        node.appendChild(track);
        if (cert.notAfter === null || cert.notBefore === null || cert.notAfter <= cert.notBefore) {
            node.classList.add('unissued');
            track.appendChild(el('span', 'vbar-none', cert.notAfter === null ? 'not issued yet' : ''));
            return node;
        }
        var life = cert.notAfter - cert.notBefore;
        var pos = function (t) {
            return Math.max(0, Math.min(100, ((t - cert.notBefore) / life) * 100));
        };
        var at = pos(now);
        var used = el('i', 'vbar-used');
        used.style.width = at + '%';
        var left = el('i', 'vbar-left');
        left.style.left = at + '%';
        left.style.width = 100 - at + '%';
        add(track, used, left);
        var renewWord = renewalWord(cert, now);
        if (cert.renewalTime !== null && cert.renewalTime > cert.notBefore && cert.renewalTime < cert.notAfter) {
            var late = cert.renewalTime < now && (cert.overdue || M.STATES[cert.state].tone === 'error');
            var tick = el('i', 'vbar-renew' + (late ? ' overdue' : ''));
            tick.style.left = pos(cert.renewalTime) + '%';
            tick.title = renewWord.charAt(0).toUpperCase() + renewWord.slice(1) + ' ' + dateTime(cert.renewalTime);
            track.appendChild(tick);
        }
        var mark = el('i', 'vbar-now');
        mark.style.left = at + '%';
        track.appendChild(mark);

        if (opts.labels) {
            var labels = el('div', 'vbar-labels');
            add(labels, dateLabel('issued', cert.notBefore), cert.renewalTime !== null ? dateLabel(renewWord, cert.renewalTime, 'mid') : el('span'), dateLabel(cert.notAfter > now ? 'expires' : 'expired', cert.notAfter, 'end'));
            node.appendChild(labels);
        }
        return node;
    }

    // What the renewal time is called: ahead of now, when it renews; behind
    // it, when renewal began -- or, if nothing is renewing it, when it was
    // due.
    function renewalWord(cert, now) {
        if (cert.renewalTime === null || cert.renewalTime > now) return 'renews';
        return M.isTrue(cert.issuing) ? 'renewal began' : 'renewal was due';
    }

    function dateLabel(what, t, className) {
        var node = el('span', 'vbar-label' + (className ? ' ' + className : ''));
        add(node, el('span', 'faint', what + ' '), el('strong', '', date(t)));
        node.title = dateTime(t);
        return node;
    }

    // ----- issuers -------------------------------------------------------------

    var ISSUER_ICONS = { acme: 'acme', ca: 'ca', selfsigned: 'selfsigned', vault: 'vault', venafi: 'venafi', other: 'issuer', external: 'external' };

    function issuerTile(type, tone) {
        var node = el('span', 'itile t-' + type + (tone ? ' ' + tone : ''));
        node.appendChild(icon(ISSUER_ICONS[type] || 'issuer'));
        return node;
    }

    function readyChip(issuer) {
        if (!issuer) return chip('missing', 'error', 'failed');
        if (issuer.ready === 'True') return chip('Ready', 'ok', 'check');
        if (issuer.ready === 'False') return chip('Not ready', 'error', 'alert', issuer.readyMessage);
        return chip(issuer.ready ? 'Unknown' : 'no status yet', 'warn', 'clock', issuer.readyMessage);
    }

    function stagingBadge() {
        var node = el('span', 'badge-staging', 'staging');
        node.title = "Let's Encrypt's staging server: certificates no browser trusts, for testing without rate limits";
        return node;
    }

    // ----- the issuance chain ----------------------------------------------------

    var STEP_ICONS = { certificate: 'cert', request: 'request', order: 'order', challenges: 'challenge', issuer: 'stamp' };
    var MARKS = { done: 'check', active: 'hourglass', stuck: 'alert', failed: 'close', idle: 'dot' };

    // The steps of one issuance, left to right (or top to bottom with
    // vertical): each a button opening the object it stands for. `current`
    // rings the step for the object a panel is drawn for.
    // h: { open(ref) }
    function chainSteps(chain, h, opts) {
        opts = opts || {};
        var list = el('ol', 'steps' + (opts.vertical ? ' vertical' : '') + (opts.compact ? ' compact' : ''));
        chain.steps.forEach(function (step, i) {
            var item = el('li', 'step s-' + step.state + (i === chain.focus ? ' focus' : ''));
            var isCurrent = opts.current && step.ref && step.ref.kind === opts.current.kind && step.ref.name === opts.current.name;
            if (step.items && opts.current) {
                step.items.forEach(function (it) {
                    if (it.ref.name === opts.current.name && it.ref.kind === opts.current.kind) isCurrent = true;
                });
            }
            if (isCurrent) item.classList.add('current');

            var head = step.ref ? el('button', 'step-head') : el('div', 'step-head');
            if (step.ref) {
                head.type = 'button';
                head.title = 'Open ' + step.name;
                head.addEventListener('click', function () {
                    h.open(step.ref);
                });
            }
            var mark = el('span', 'step-mark');
            mark.appendChild(icon(STEP_ICONS[step.kind]));
            var badge = el('span', 'step-badge');
            badge.appendChild(icon(MARKS[step.state]));
            mark.appendChild(badge);
            var text = el('span', 'step-text');
            add(text, el('span', 'step-kind', step.label), el('span', 'step-name', step.name || (step.items && step.items.length > 1 ? plural(step.items.length, 'name') : '—')), el('span', 'step-note', step.note));
            add(head, mark, text);
            item.appendChild(head);

            if (step.items && step.items.length > 1) {
                var sub = el('ul', 'step-items');
                step.items.forEach(function (it) {
                    var row = el('li');
                    var b = el('button', 'step-item s-' + it.state);
                    b.type = 'button';
                    b.title = it.name + (it.reason ? '\n' + it.reason : '');
                    b.addEventListener('click', function () {
                        h.open(it.ref);
                    });
                    add(b, el('i', 'sdot ' + stepTone(it.state)), el('span', 'step-item-name', it.dnsName), el('span', 'faint', it.note));
                    row.appendChild(b);
                    sub.appendChild(row);
                });
                item.appendChild(sub);
            } else if (step.items && step.items.length === 1) {
                text.querySelector('.step-name').textContent = step.items[0].dnsName;
                text.querySelector('.step-note').textContent = step.items[0].type + ' · ' + step.items[0].note;
            }
            list.appendChild(item);
        });
        return list;
    }

    function stepTone(state) {
        return { done: 'ok', active: 'info', stuck: 'error', failed: 'error', idle: 'muted' }[state] || 'muted';
    }

    // What the chain is waiting on, and what to do about it: the status text
    // as cert-manager wrote it, and the plain-words reading of it.
    function why(chain, opts) {
        opts = opts || {};
        if (!chain || chain.focus < 0 || (!chain.reason && !chain.hint)) return null;
        var box = el('div', 'why ' + chain.tone);
        box.appendChild(icon(chain.tone === 'error' ? 'alert' : 'info'));
        var body = el('div', 'why-body');
        if (opts.headline) body.appendChild(el('div', 'why-head', chain.headline));
        if (chain.hint) body.appendChild(el('div', 'why-hint', chain.hint));
        if (chain.reason) {
            var raw = el('code', 'why-raw', chain.reason);
            raw.title = 'As cert-manager wrote it';
            body.appendChild(raw);
        }
        box.appendChild(body);
        return box;
    }

    // ----- renewing by hand ------------------------------------------------------

    // There is no API a plugin could call to renew a certificate -- cmctl
    // writes the Issuing condition through the status subresource -- so the
    // command is offered as text to select and paste instead of a button.
    function cmctl(cert) {
        var box = el('div', 'cmctl');
        var line = el('div', 'cmctl-line');
        line.appendChild(icon('terminal'));
        var code = el('code', 'cmctl-code', 'cmctl renew ' + cert.name + ' -n ' + cert.namespace);
        code.title = 'Click to select, then copy';
        line.appendChild(code);
        box.appendChild(line);
        box.appendChild(el('div', 'cmctl-note', 'Renews it now, whatever its schedule. The kubectl plugin takes the same words: kubectl cert-manager renew ' + cert.name + ' -n ' + cert.namespace + '.'));
        return box;
    }

    // ----- events ------------------------------------------------------------------

    var EVENT_ICONS = { Certificate: 'cert', CertificateRequest: 'request', Order: 'order', Challenge: 'challenge', Issuer: 'stamp', ClusterIssuer: 'stamp', Ingress: 'ingress', Gateway: 'ingress' };

    // A log of events down the page: when, what, and who it was about.
    // h: { open(ref) }; opts: { name: false to leave the object's name out }
    function eventLog(events, h, opts) {
        opts = opts || {};
        var now = Date.now();
        var list = el('ol', 'elog');
        events.forEach(function (ev) {
            var item = el('li', 'elog-row' + (ev.type === 'Warning' ? ' warn' : ''));
            var when = el('span', 'elog-when', ago(ev.when, now));
            when.title = dateTime(ev.when);
            var mark = el('span', 'elog-mark');
            mark.appendChild(icon(ev.type === 'Warning' ? 'alert' : EVENT_ICONS[ev.kind] || 'activity'));
            var body = el('div', 'elog-body');
            var line = el('div', 'elog-line');
            if (opts.name !== false) {
                add(
                    line,
                    link(ev.name, function () {
                        h.open({ kind: ev.appKind, namespace: ev.kind === 'ClusterIssuer' ? '' : ev.namespace, name: ev.name });
                    }, ev.kind + (ev.namespace ? ' in ' + ev.namespace : '')),
                    ' ',
                );
            }
            line.appendChild(el('span', '', M.eventText(ev)));
            body.appendChild(line);
            body.appendChild(el('div', 'elog-meta', [ev.kind, ev.namespace, ev.reason, ev.count > 1 ? ev.count + '×' : ''].filter(Boolean).join(' · ')));
            add(item, when, mark, body);
            list.appendChild(item);
        });
        return list;
    }

    // ----- the tooltip -----------------------------------------------------------

    // One floating tip for the page, filled by `describe` for whatever element
    // matching `selector` is under the pointer.
    function tooltip(root, selector, describe) {
        var tip = el('div', 'tip');
        tip.hidden = true;
        tip.setAttribute('role', 'tooltip');
        document.body.appendChild(tip);

        function place(event) {
            var pad = 14;
            var w = tip.offsetWidth;
            var h = tip.offsetHeight;
            var x = event.clientX + pad;
            var y = event.clientY + pad;
            if (x + w > window.innerWidth - 8) x = event.clientX - w - pad;
            if (y + h > window.innerHeight - 8) y = event.clientY - h - pad;
            tip.style.left = Math.max(8, x) + 'px';
            tip.style.top = Math.max(8, y) + 'px';
        }

        root.addEventListener('pointerover', function (event) {
            var target = event.target.closest && event.target.closest(selector);
            if (!target || !root.contains(target)) return;
            tip.textContent = '';
            if (!describe(target, tip)) {
                tip.hidden = true;
                return;
            }
            tip.hidden = false;
            place(event);
        });
        root.addEventListener('pointermove', function (event) {
            if (!tip.hidden) place(event);
        });
        root.addEventListener('pointerout', function (event) {
            var target = event.target.closest && event.target.closest(selector);
            if (target && !target.contains(event.relatedTarget)) tip.hidden = true;
        });
        return tip;
    }

    // What the tip says about one certificate.
    function describeCert(cert, now, into) {
        var head = el('div', 'tip-head');
        add(head, stateDot(cert.state), el('strong', '', cert.name), el('span', 'faint', ' · ' + cert.namespace));
        into.appendChild(head);
        var d = M.describe(cert, now);
        into.appendChild(el('div', 'tip-line ' + d.tone, d.text));
        if (cert.notAfter !== null) {
            into.appendChild(el('div', 'tip-line', 'Valid ' + date(cert.notBefore) + ' → ' + date(cert.notAfter) + ' (' + relative(cert.notAfter, now) + ')'));
        }
        if (cert.renewalTime !== null) into.appendChild(el('div', 'tip-line', (cert.overdue ? 'Renewal was due ' : 'Renews ') + dateTime(cert.renewalTime)));
        into.appendChild(el('div', 'tip-note', cert.issuerRef.kind + ' ' + cert.issuerRef.name + (cert.hosts.length ? ' · ' + cert.hosts.slice(0, 3).join(', ') + (cert.hosts.length > 3 ? ' …' : '') : '')));
        return true;
    }

    // ----- patches -----------------------------------------------------------------

    // Asks the app to apply a patch. The app shows it to the user first; a
    // "no" is not an error worth showing.
    function apply(sdk, ref, patch) {
        return sdk.patch({ kind: ref.kind, namespace: ref.namespace, name: ref.name, patch: patch }).then(
            function () {
                return true;
            },
            function (err) {
                if (/declined/.test(err.message)) return false;
                throw err;
            },
        );
    }

    var patches = {
        // Points ingress-shim at an issuer, clearing the other annotation so
        // the two cannot disagree.
        shimIssuer: function (entry, issuer) {
            var have = (entry.obj.metadata && entry.obj.metadata.annotations) || {};
            var annotations = {};
            if (issuer.cluster) {
                annotations[M.ANN.clusterIssuer] = issuer.name;
                if (have[M.ANN.issuer] !== undefined) annotations[M.ANN.issuer] = null;
            } else {
                annotations[M.ANN.issuer] = issuer.name;
                if (have[M.ANN.clusterIssuer] !== undefined) annotations[M.ANN.clusterIssuer] = null;
            }
            if (have[M.ANN.issuerKind] !== undefined) annotations[M.ANN.issuerKind] = null;
            if (have[M.ANN.issuerGroup] !== undefined) annotations[M.ANN.issuerGroup] = null;
            return { metadata: { annotations: annotations } };
        },
        // Also gives an Ingress without TLS a tls entry for every host it
        // routes, into a Secret named after it, for ingress-shim to fill.
        serveHttps: function (entry, issuer) {
            var patch = patches.shimIssuer(entry, issuer);
            patch.spec = { tls: [{ hosts: entry.ruleHosts, secretName: entry.name + '-tls' }] };
            return patch;
        },
        certIssuer: function (issuer) {
            return { spec: { issuerRef: { name: issuer.name, kind: issuer.kind, group: M.GROUP } } };
        },
    };

    // A <select> of the issuers a certificate or an Ingress in `namespace`
    // could use: every ClusterIssuer, and the Issuers in that namespace.
    // Ready ones first; a not-ready one is offered but says so.
    function issuerPicker(model, namespace, current) {
        var select = el('select', 'picker');
        var usable = model.issuers
            .filter(function (i) {
                return i.cluster || i.namespace === namespace;
            })
            .sort(function (a, b) {
                return (b.ready === 'True') - (a.ready === 'True') || (a.acme && a.acme.staging) - (b.acme && b.acme.staging) || a.name.localeCompare(b.name);
            });
        usable.forEach(function (i) {
            var label = i.name + ' — ' + (i.cluster ? 'ClusterIssuer' : 'Issuer') + ' · ' + (i.acme ? i.acme.provider + (i.acme.staging ? ' staging' : '') : M.ISSUER_TYPES[i.type]) + (i.ready === 'True' ? '' : ' (not ready)');
            var option = el('option', '', label);
            option.value = i.key;
            if (current && current.key === i.key) option.selected = true;
            select.appendChild(option);
        });
        select.issuers = usable;
        select.pick = function () {
            for (var k = 0; k < usable.length; k++) if (usable[k].key === select.value) return usable[k];
            return null;
        };
        return select;
    }

    // ----- the grip ----------------------------------------------------------

    // A grab strip on the inner edge of a panel on the right: drag it, or
    // focus it and use the arrow keys, to make the panel wider or narrower; a
    // double-click puts it back. The width is a custom property on the root,
    // so the panel and whatever makes room for it read the one value -- unset,
    // the stylesheet's own width stands. The page places the strip, and keeps
    // the width wherever it keeps the rest of its state.
    // opts: { panel, prop, min, room, initial, label, className, onResize(px, done) }
    //   room      what the panel always leaves of the window
    //   onResize  px is 0 once the panel is back to the stylesheet's width;
    //             done is false while a drag goes on, true when it ends
    function grip(opts) {
        var root = document.documentElement;
        var node = el('div', 'grip' + (opts.className ? ' ' + opts.className : ''));
        node.tabIndex = 0;
        node.title = 'Drag to resize · double-click to reset';
        node.setAttribute('role', 'separator');
        node.setAttribute('aria-orientation', 'vertical');
        node.setAttribute('aria-label', opts.label || 'Resize the panel');
        var wanted = opts.initial > 0 ? opts.initial : 0;
        var drag = null;
        var frame = 0;

        function fit(px) {
            return Math.round(Math.max(opts.min, Math.min(px, window.innerWidth - opts.room)));
        }

        // The width asked for is kept as asked: a smaller window takes what it
        // must from the panel and gives it back when it grows again.
        function apply() {
            if (wanted) root.style.setProperty(opts.prop, fit(wanted) + 'px');
            else root.style.removeProperty(opts.prop);
        }

        // While a drag goes on the page hears of it once a frame at most.
        function tell(done) {
            if (!opts.onResize) return;
            cancelAnimationFrame(frame);
            frame = 0;
            if (done) opts.onResize(wanted, true);
            else
                frame = requestAnimationFrame(function () {
                    frame = 0;
                    opts.onResize(wanted, false);
                });
        }

        function resize(px, done) {
            wanted = px ? fit(px) : 0;
            apply();
            tell(done);
        }

        function release(event) {
            if (!drag) return;
            drag = null;
            document.body.classList.remove('gripping');
            if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
            tell(true);
        }

        node.addEventListener('pointerdown', function (event) {
            if (event.button !== 0) return;
            event.preventDefault();
            node.setPointerCapture(event.pointerId);
            drag = { x: event.clientX, from: opts.panel.getBoundingClientRect().width };
            document.body.classList.add('gripping');
        });
        node.addEventListener('pointermove', function (event) {
            // The panel is on the right: it grows as the pointer goes left.
            if (drag) resize(drag.from + drag.x - event.clientX, false);
        });
        node.addEventListener('pointerup', release);
        node.addEventListener('pointercancel', release);
        node.addEventListener('dblclick', function () {
            resize(0, true);
        });
        node.addEventListener('keydown', function (event) {
            var step = event.shiftKey ? 48 : 16;
            var now = wanted || opts.panel.getBoundingClientRect().width;
            if (event.key === 'ArrowLeft') resize(now + step, true);
            else if (event.key === 'ArrowRight') resize(now - step, true);
            else return;
            event.preventDefault();
        });
        window.addEventListener('resize', function () {
            if (!wanted) return;
            apply();
            tell(false);
        });
        apply();
        return node;
    }

    window.CertManagerKit = {
        el: el,
        add: add,
        svg: svg,
        icon: icon,
        chip: chip,
        button: button,
        link: link,
        about: about,
        plural: plural,
        span: span,
        short: short,
        relative: relative,
        ago: ago,
        date: date,
        dateTime: dateTime,
        bigLeft: bigLeft,
        leftTone: leftTone,
        stateChip: stateChip,
        stateDot: stateDot,
        validityBar: validityBar,
        issuerTile: issuerTile,
        readyChip: readyChip,
        stagingBadge: stagingBadge,
        chainSteps: chainSteps,
        stepTone: stepTone,
        why: why,
        cmctl: cmctl,
        eventLog: eventLog,
        tooltip: tooltip,
        describeCert: describeCert,
        apply: apply,
        patches: patches,
        issuerPicker: issuerPicker,
        ISSUER_ICONS: ISSUER_ICONS,
        grip: grip,
    };
})();
