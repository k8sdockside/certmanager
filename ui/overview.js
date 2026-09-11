// cert-manager's own overview, in place of the page the app generates for
// every plugin. It answers what the generated one does -- is this even
// installed here? -- and then what that page cannot: which certificate runs
// out next and when, every certificate's life on one runway, any issuance that
// has stalled and at which step, the issuers they all come from, and what
// cert-manager has been doing lately.
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
    var SUMMARY_EVERY = 30000;
    var CHARTS_EVERY = 60000;
    var HISTORY_MINUTES = 1440;
    // The runway starts two weeks back, so a certificate that expired lately
    // is still on it, and runs ninety days on -- the life of a Let's Encrypt
    // certificate, and so the span inside which every one of them renews.
    var RUNWAY_BEFORE = 14 * DAY;
    var RUNWAY_AFTER = 90 * DAY;
    var RUNWAY_ROWS = 24;
    var FALLBACK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

    var state = {
        ctx: null,
        model: null,
        sig: '',
        summary: null,
        panel: null,
        events: null,
        error: '',
        allRows: false,
        focus: null,
    };

    var $ = function (id) {
        return document.getElementById(id);
    };

    function fail(err) {
        state.error = (err && err.message) || String(err);
        $('error').textContent = state.error;
        $('error').hidden = false;
    }

    function clearError() {
        state.error = '';
        $('error').hidden = true;
    }

    function open(ref) {
        sdk.open(ref).catch(fail);
    }

    function openView(id) {
        sdk.openView(id).catch(fail);
    }

    var h = { open: open };

    function plural(n, one, many) {
        return K.plural(n, one, many);
    }

    function tone(name) {
        return M.STATES[name].tone;
    }

    // ----- the hero ----------------------------------------------------------

    function verdict(model) {
        var c = model.counts;
        var total = model.certs.length;
        var broken = c.expired + c.failed + c.stuck + c.notready;
        if (total === 0) return { tone: 'ok', icon: 'check', text: 'No certificates yet' };
        if (broken) {
            if (broken === c.expired) return { tone: 'error', icon: 'alert', text: plural(c.expired, 'certificate has', 'certificates have') + ' expired' };
            if (c.expired === 0 && c.notready === 0) {
                var list = model.certs.filter(function (x) {
                    return x.state === 'stuck' || x.state === 'failed';
                });
                var issued = list.filter(function (x) {
                    return x.notAfter !== null;
                }).length;
                var verb = issued === list.length ? 'renew' : issued === 0 ? 'issue' : 'issue or renew';
                return { tone: 'error', icon: 'alert', text: plural(broken, 'certificate is', 'certificates are') + ' failing to ' + verb };
            }
            return { tone: 'error', icon: 'alert', text: plural(broken, 'certificate needs', 'certificates need') + ' attention' };
        }
        var soon = model.certs
            .filter(function (x) {
                return x.facets.expiring;
            })
            .sort(function (a, b) {
                return a.notAfter - b.notAfter;
            });
        if (soon.length === 1) return { tone: 'warn', icon: 'clock', text: soon[0].name + ' expires in ' + K.span(soon[0].left) };
        if (soon.length > 1) return { tone: 'warn', icon: 'clock', text: plural(soon.length, 'certificate expires', 'certificates expire') + ' within two weeks' };
        if (c.issuing) return { tone: 'info', icon: 'refresh', text: 'All valid — ' + plural(c.issuing, 'renewal', 'renewals') + ' under way' };
        return { tone: 'ok', icon: 'check', text: total === 1 ? 'The one certificate is valid' : 'All ' + total + ' certificates are valid' };
    }

    // The sentence under the verdict, with the numbers in bold.
    function story(model) {
        var p = el('p', 'ov-story');
        function b(text, className) {
            return el('strong', className || '', text);
        }
        var c = model.counts;
        var namespaces = {};
        model.certs.forEach(function (x) {
            namespaces[x.namespace] = true;
        });
        var used = model.issuers.filter(function (i) {
            return i.certs.length > 0;
        }).length;
        if (!model.certs.length) {
            add(p, 'cert-manager is running with ', b(plural(model.issuers.length, 'issuer')), ', and nothing has asked it for a certificate yet. Add a Certificate, or annotate an Ingress with cert-manager.io/cluster-issuer.');
            return p;
        }
        add(p, 'cert-manager' + (model.version ? ' ' + model.version : '') + ' looks after ', b(plural(model.certs.length, 'certificate')), ' from ', b(plural(used, 'issuer')), ' in ', b(plural(Object.keys(namespaces).length, 'namespace')), '. ');

        var parts = [];
        if (c.valid) parts.push([c.valid + (c.valid === 1 ? ' is' : ' are') + ' valid', 'ok']);
        if (c.issuing) parts.push([c.issuing + (c.issuing === 1 ? ' is' : ' are') + ' being renewed', '']);
        if (c.expiring) parts.push([c.expiring + ' expire' + (c.expiring === 1 ? 's' : '') + ' soon', 'warnish']);
        if (c.notready) parts.push([c.notready + (c.notready === 1 ? ' is' : ' are') + ' not ready', 'bad']);
        if (c.stuck) parts.push([c.stuck + (c.stuck === 1 ? ' is' : ' are') + ' stuck', 'bad']);
        if (c.failed) parts.push([c.failed + ' failed', 'bad']);
        if (c.expired) parts.push([c.expired + (c.expired === 1 ? ' has' : ' have') + ' expired', 'bad']);
        parts.forEach(function (part, i) {
            if (i > 0) add(p, i === parts.length - 1 ? ' and ' : ', ');
            p.appendChild(b(part[0], part[1]));
        });
        add(p, '.');

        var next = nextRenewal(model);
        if (next) add(p, ' The next renewal is ', b(next.name), ' ' + K.relative(next.renewalTime, model.now) + '.');
        return p;
    }

    function nextRenewal(model) {
        return (
            model.certs
                .filter(function (x) {
                    return x.renewalTime !== null && x.renewalTime > model.now && x.state !== 'issuing';
                })
                .sort(function (a, b) {
                    return a.renewalTime - b.renewalTime;
                })[0] || null
        );
    }

    // Every certificate's state as one bar, good to bad left to right.
    function healthBar(model) {
        var wrap = el('div', 'hbar-wrap');
        var bar = el('div', 'hbar');
        var legend = el('div', 'hbar-legend');
        var order = ['valid', 'issuing', 'expiring', 'notready', 'stuck', 'failed', 'expired'];
        var total = model.certs.length || 1;
        order.forEach(function (s) {
            var n = model.counts[s];
            if (!n) return;
            var seg = el('i', 'hbar-seg ' + tone(s) + (s === 'issuing' ? ' moving' : ''));
            seg.style.flexGrow = String(n);
            seg.title = n + ' ' + M.STATES[s].label.toLowerCase();
            bar.appendChild(seg);
            var key = K.button('', 'hbar-key', null, function () {
                openView('certificates');
            });
            key.title = 'Open certificates';
            add(key, el('i', 'sdot ' + tone(s)), el('strong', '', String(n)), el('span', '', M.STATES[s].label.toLowerCase()));
            legend.appendChild(key);
        });
        bar.setAttribute('role', 'img');
        bar.setAttribute('aria-label', order.filter(function (s) {
            return model.counts[s];
        }).map(function (s) {
            return model.counts[s] + ' ' + M.STATES[s].label.toLowerCase();
        }).join(', ') + ' of ' + total);
        add(wrap, bar, legend);
        return wrap;
    }

    // Which moment the big dial counts down to: the soonest expiry when one is
    // near, else the next renewal cert-manager has scheduled, else the soonest
    // expiry however far off.
    function focusOf(model) {
        var now = model.now;
        var dated = model.certs.filter(function (c) {
            return c.notAfter !== null && c.notAfter > now;
        });
        var byExpiry = dated.slice().sort(function (a, b) {
            return a.notAfter - b.notAfter;
        });
        var urgent = byExpiry.filter(function (c) {
            return c.soon;
        })[0];
        if (urgent) return { cert: urgent, mode: 'expires', at: urgent.notAfter };
        var renewals = dated
            .filter(function (c) {
                return c.renewalTime !== null && c.renewalTime > now && c.state !== 'issuing';
            })
            .sort(function (a, b) {
                return a.renewalTime - b.renewalTime;
            });
        if (renewals.length) return { cert: renewals[0], mode: 'renews', at: renewals[0].renewalTime };
        return byExpiry.length ? { cert: byExpiry[0], mode: 'expires', at: byExpiry[0].notAfter } : null;
    }

    // What comes after it, over the next two months.
    function upNext(model, focus) {
        var now = model.now;
        var out = [];
        model.certs.forEach(function (c) {
            if (c.renewalTime !== null && c.renewalTime > now && c.state !== 'issuing') out.push({ cert: c, mode: 'renews', at: c.renewalTime });
            if (c.notAfter !== null && c.notAfter > now && c.soon) out.push({ cert: c, mode: 'expires', at: c.notAfter });
        });
        return out
            .filter(function (m) {
                return !(focus && m.cert === focus.cert && m.mode === focus.mode) && m.at - now < 60 * DAY;
            })
            .sort(function (a, b) {
                return a.at - b.at;
            })
            .slice(0, 4);
    }

    // The centrepiece: the certificate's whole life as one turn of a clock
    // face, what is left of it in colour, the renewal as a notch, and a
    // countdown to the moment that matters under it.
    function dial(model, focus) {
        var wrap = el('div', 'dial-wrap');
        var cert = focus.cert;
        var t = focus.mode === 'expires' ? K.leftTone(cert, model.now) : 'info';
        var face = el('div', 'dial ' + t);
        var size = 228;
        var mid = size / 2;
        var r = 92;
        var c = 2 * Math.PI * r;
        var s = K.svg('svg', { viewBox: '0 0 ' + size + ' ' + size, class: 'dial-svg', role: 'img' });
        s.setAttribute('aria-label', cert.name + ' ' + focus.mode + ' ' + K.relative(focus.at, model.now));

        // The minute marks of a clock, sixty of them, every fifth longer.
        for (var i = 0; i < 60; i++) {
            var a = (i / 60) * 2 * Math.PI;
            var long = i % 5 === 0;
            var r1 = r + 13;
            var r2 = r + (long ? 19 : 16);
            s.appendChild(K.svg('line', { x1: mid + r1 * Math.sin(a), y1: mid - r1 * Math.cos(a), x2: mid + r2 * Math.sin(a), y2: mid - r2 * Math.cos(a), class: 'dial-tick' + (long ? ' long' : '') }));
        }
        s.appendChild(K.svg('circle', { cx: mid, cy: mid, r: r, class: 'dial-track' }));

        var life = cert.notAfter - cert.notBefore;
        var frac = function (x) {
            return Math.max(0, Math.min(1, (x - cert.notBefore) / life));
        };
        var elapsed = frac(model.now);
        var rotate = 'rotate(-90 ' + mid + ' ' + mid + ')';
        s.appendChild(K.svg('circle', { cx: mid, cy: mid, r: r, class: 'dial-used', 'stroke-dasharray': elapsed * c + ' ' + c, transform: rotate }));
        s.appendChild(K.svg('circle', { cx: mid, cy: mid, r: r, class: 'dial-left', 'stroke-dasharray': Math.max(0.5, (1 - elapsed) * c) + ' ' + c, 'stroke-dashoffset': String(-elapsed * c), transform: rotate }));

        function at(fraction, radius) {
            var ang = fraction * 2 * Math.PI;
            return { x: mid + radius * Math.sin(ang), y: mid - radius * Math.cos(ang) };
        }
        if (cert.renewalTime !== null && cert.renewalTime > cert.notBefore && cert.renewalTime < cert.notAfter) {
            var rf = frac(cert.renewalTime);
            var p1 = at(rf, r - 13);
            var p2 = at(rf, r + 10);
            var late = cert.renewalTime < model.now && (cert.overdue || M.STATES[cert.state].tone === 'error');
            var notch = K.svg('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: 'dial-renew' + (late ? ' overdue' : '') });
            var nt = K.svg('title', {});
            nt.textContent = (cert.renewalTime < model.now ? 'Renewal was due ' : 'Renews ') + K.dateTime(cert.renewalTime);
            notch.appendChild(nt);
            s.appendChild(notch);
        }
        var knob = at(elapsed, r);
        s.appendChild(K.svg('circle', { cx: knob.x, cy: knob.y, r: 8, class: 'dial-now' }));
        face.appendChild(s);

        var big = K.bigLeft({ notAfter: focus.at }, model.now);
        var centre = el('div', 'dial-centre');
        add(centre, el('div', 'dial-eyebrow', focus.mode === 'expires' ? 'expires in' : 'renews in'), el('div', 'dial-big', big.n), el('div', 'dial-unit', big.unit.replace(/ left$/, '')));
        face.appendChild(centre);
        wrap.appendChild(face);

        var caption = el('div', 'dial-caption');
        var who = K.link(cert.name, function () {
            open(M.ref.cert(cert));
        }, 'Open the certificate');
        who.classList.add('dial-name');
        add(caption, who, el('span', 'faint', ' · ' + cert.namespace));
        wrap.appendChild(caption);

        var clock = el('div', 'dial-clock');
        var count = el('code', 'countdown', countdown(focus.at - Date.now()));
        count.id = 'countdown';
        add(clock, count);
        wrap.appendChild(clock);

        var when = el('div', 'dial-when');
        if (focus.mode === 'expires') {
            add(when, el('span', '', 'Expires ' + K.dateTime(cert.notAfter)));
            var renewing = cert.chain && cert.chain.inflight;
            if (renewing) {
                var since = cert.chain.since || cert.renewalTime;
                when.appendChild(el('span', cert.state === 'stuck' ? 'bad' : 'faint', (cert.state === 'stuck' ? 'renewal stuck, started ' : 'renewing, started ') + (since ? K.relative(since, model.now) : 'just now')));
            } else if (cert.renewalTime !== null) {
                when.appendChild(el('span', cert.overdue ? 'bad' : 'faint', cert.overdue ? 'renewal was due ' + K.relative(cert.renewalTime, model.now) : 'renews ' + K.relative(cert.renewalTime, model.now)));
            }
        } else {
            add(when, el('span', '', 'Renews ' + K.dateTime(cert.renewalTime)), el('span', 'faint', 'expires ' + K.date(cert.notAfter) + ' · ' + K.span(cert.notAfter - cert.renewalTime) + ' of slack'));
        }
        wrap.appendChild(when);
        return wrap;
    }

    // "4d 23:12:05" -- the countdown under the dial, redrawn every second.
    function countdown(ms) {
        if (ms <= 0) return 'now';
        var s = Math.floor(ms / 1000);
        var d = Math.floor(s / 86400);
        var hh = Math.floor((s % 86400) / 3600);
        var mm = Math.floor((s % 3600) / 60);
        var ss = s % 60;
        var pad = function (n) {
            return (n < 10 ? '0' : '') + n;
        };
        return (d ? d + 'd ' : '') + pad(hh) + ':' + pad(mm) + ':' + pad(ss);
    }

    function drawHero(model) {
        var hero = $('hero');
        hero.textContent = '';
        hero.className = 'ov-hero';
        var v = verdict(model);
        hero.classList.add(v.tone);

        var main = el('div', 'ov-hero-main');
        var eyebrow = el('div', 'ov-eyebrow');
        var logo = el('span', 'logo');
        logo.appendChild(K.icon('logo'));
        add(eyebrow, logo, el('span', '', 'cert-manager' + (model.version ? ' ' + model.version : '')), el('span', 'faint', '· ' + state.ctx.contextName + (model.namespace ? ' · ' + model.namespace : '')));
        if (model.componentsKnown) {
            var parts = el('span', 'ov-parts');
            ['controller', 'webhook', 'cainjector'].forEach(function (name) {
                var comp = model.components[name];
                if (!comp.pods.length && name !== 'controller') return;
                var ok = comp.ready > 0;
                var part = K.button('', 'ov-part ' + (ok ? 'ok' : 'error'), null, function () {
                    openView('components');
                });
                part.title = name + ': ' + comp.ready + ' of ' + comp.pods.length + ' ready';
                add(part, el('i', 'sdot ' + (ok ? 'ok' : 'error')), el('span', '', name));
                parts.appendChild(part);
            });
            eyebrow.appendChild(parts);
        }
        main.appendChild(eyebrow);

        var head = el('h1', 'ov-verdict ' + v.tone);
        add(head, K.icon(v.icon), el('span', '', v.text));
        main.appendChild(head);
        main.appendChild(story(model));
        if (model.certs.length) main.appendChild(healthBar(model));

        var cta = el('div', 'ov-cta');
        add(
            cta,
            K.button('Open certificates', 'primary', 'cert', function () {
                openView('certificates');
            }),
            K.button('Certificate list', 'ghost', 'rows', function () {
                openView('certificate-list');
            }),
        );
        main.appendChild(cta);
        hero.appendChild(main);

        var focus = focusOf(model);
        state.focus = focus;
        if (focus) {
            var side = el('div', 'ov-hero-side');
            side.appendChild(dial(model, focus));
            var next = upNext(model, focus);
            if (next.length) {
                var list = el('div', 'upnext');
                list.appendChild(el('div', 'upnext-title', 'Up next'));
                next.forEach(function (m) {
                    var row = K.button('', 'upnext-row', null, function () {
                        open(M.ref.cert(m.cert));
                    });
                    var t = m.mode === 'expires' ? K.leftTone(m.cert, model.now) : 'info';
                    add(row, el('i', 'sdot ' + t), el('span', 'upnext-name', m.cert.name), el('span', 'upnext-what ' + t, m.mode), el('span', 'upnext-when', K.relative(m.at, model.now)));
                    row.title = m.cert.namespace + '/' + m.cert.name + ' ' + m.mode + ' ' + K.dateTime(m.at);
                    list.appendChild(row);
                });
                side.appendChild(list);
            }
            hero.appendChild(side);
        }
    }

    // ----- the runway ----------------------------------------------------------

    function drawRunway(model) {
        var box = $('runway');
        box.textContent = '';
        box.hidden = model.certs.length === 0;
        if (box.hidden) return;
        var now = model.now;
        var start = now - RUNWAY_BEFORE;
        var end = now + RUNWAY_AFTER;
        var width = end - start;
        var pct = function (t) {
            return Math.max(0, Math.min(100, ((t - start) / width) * 100));
        };

        var head = el('div', 'card-head');
        add(head, K.icon('runway'), el('h2', '', 'Expiry runway'), el('span', 'card-sub', 'Every certificate’s validity over the next 90 days. ◆ is when cert-manager renews it; the shaded band is the next two weeks.'));
        var legend = el('div', 'rw-legend');
        [
            ['ok', 'valid'],
            ['info', 'renewing'],
            ['warn', 'expiring soon'],
            ['error', 'failing or expired'],
        ].forEach(function (k) {
            add(legend, add(el('span', 'rw-key'), el('i', 'rw-swatch ' + k[0]), el('span', '', k[1])));
        });
        head.appendChild(legend);
        box.appendChild(head);

        var body = el('div', 'rw-body');
        // The dates along the top, a week apart from today.
        var axis = el('div', 'rw-axis');
        axis.appendChild(el('span', 'rw-axis-spacer'));
        var scale = el('div', 'rw-scale');
        for (var w = 0; w <= 12; w++) {
            var t = now + w * 7 * DAY;
            var label = el('span', 'rw-tick' + (w === 0 ? ' today' : '') + (w % 2 ? ' odd' : ''), w === 0 ? 'today' : K.date(t));
            label.style.left = pct(t) + '%';
            scale.appendChild(label);
        }
        axis.appendChild(scale);
        body.appendChild(axis);

        var rows = el('div', 'rw-rows');
        var overlay = el('div', 'rw-overlay');
        var band = el('i', 'rw-band');
        band.style.left = pct(now) + '%';
        band.style.width = pct(now + M.SOON) - pct(now) + '%';
        overlay.appendChild(band);
        for (var g = 1; g <= 12; g++) {
            var line = el('i', 'rw-grid');
            line.style.left = pct(now + g * 7 * DAY) + '%';
            overlay.appendChild(line);
        }
        var today = el('i', 'rw-today');
        today.style.left = pct(now) + '%';
        overlay.appendChild(today);
        rows.appendChild(overlay);

        var sorted = model.certs.slice().sort(function (a, b) {
            var ta = a.notAfter === null ? -Infinity : a.notAfter;
            var tb = b.notAfter === null ? -Infinity : b.notAfter;
            return ta - tb || a.key.localeCompare(b.key);
        });
        var shown = state.allRows ? sorted : sorted.slice(0, RUNWAY_ROWS);
        shown.forEach(function (cert) {
            var row = K.button('', 'rw-row', null, function () {
                open(M.ref.cert(cert));
            });
            row.dataset.key = cert.key;
            var label = el('span', 'rw-label');
            add(label, K.stateDot(cert.state), el('span', 'rw-name', cert.name), el('span', 'rw-ns', cert.namespace));
            var lane = el('span', 'rw-lane');
            var tn = M.STATES[cert.state].tone;
            if (cert.notAfter === null) {
                var pend = el('i', 'rw-pending ' + tn);
                pend.style.left = pct(now) + '%';
                lane.appendChild(pend);
                var pl = el('span', 'rw-note ' + tn, 'not issued yet');
                pl.style.left = 'calc(' + pct(now) + '% + 58px)';
                lane.appendChild(pl);
            } else if (cert.notAfter < start) {
                var stub = el('i', 'rw-stub ' + tn);
                lane.appendChild(stub);
                var sl = el('span', 'rw-note ' + tn, 'expired ' + K.date(cert.notAfter));
                sl.style.left = '14px';
                lane.appendChild(sl);
            } else {
                var from = cert.notBefore !== null ? Math.max(cert.notBefore, start) : start;
                var to = Math.min(cert.notAfter, end);
                var bar = el('i', 'rw-bar ' + tn + (cert.notBefore !== null && cert.notBefore < start ? ' open-start' : '') + (cert.notAfter > end ? ' open-end' : ''));
                bar.style.left = pct(from) + '%';
                bar.style.width = Math.max(0.6, pct(to) - pct(from)) + '%';
                // Behind today it has been lived; ahead of it, it is left.
                var past = Math.max(0, Math.min(100, ((now - from) / (to - from)) * 100));
                bar.style.setProperty('--past', past + '%');
                lane.appendChild(bar);
                if (cert.notAfter <= now) {
                    var ex = el('span', 'rw-note error', 'expired ' + K.relative(cert.notAfter, now));
                    ex.style.left = 'calc(' + pct(cert.notAfter) + '% + 8px)';
                    lane.appendChild(ex);
                } else if (cert.notAfter > end) {
                    var more = el('span', 'rw-beyond', '→ ' + K.date(cert.notAfter));
                    lane.appendChild(more);
                } else if (cert.soon) {
                    var bl = K.bigLeft(cert, now);
                    var sn = el('span', 'rw-note ' + K.leftTone(cert, now), bl.n + ' ' + bl.unit);
                    sn.style.left = 'calc(' + pct(cert.notAfter) + '% + 8px)';
                    lane.appendChild(sn);
                }
                if (cert.renewalTime !== null && cert.renewalTime >= start && cert.renewalTime <= end) {
                    // Past its renewal time a certificate is either renewing
                    // (blue), or should be and is not (red).
                    var late = cert.renewalTime < now && (cert.overdue || M.STATES[cert.state].tone === 'error');
                    var dia = el('i', 'rw-renew' + (late ? ' overdue' : cert.state === 'issuing' ? ' due' : ''));
                    dia.style.left = pct(cert.renewalTime) + '%';
                    lane.appendChild(dia);
                }
            }
            add(row, label, lane);
            rows.appendChild(row);
        });
        body.appendChild(rows);
        box.appendChild(body);

        if (sorted.length > RUNWAY_ROWS) {
            var more = K.button(state.allRows ? 'Show the first ' + RUNWAY_ROWS : 'Show all ' + sorted.length, 'ghost small', 'rows', function () {
                state.allRows = !state.allRows;
                drawRunway(state.model);
            });
            box.appendChild(more);
        }
    }

    // ----- issuance ----------------------------------------------------------------

    function drawIssuance(model) {
        var box = $('issuance');
        box.textContent = '';
        box.hidden = false;
        var flights = model.certs.filter(function (c) {
            return !M.isTrue(c.ready) || M.isTrue(c.issuing) || c.state === 'failed';
        });
        var findings = model.findings;
        var bad = flights.filter(function (c) {
            return M.STATES[c.state].tone === 'error';
        }).length;

        var head = el('div', 'card-head');
        add(head, K.icon(bad || findings.length ? 'alert' : 'check'), el('h2', '', 'Issuance'));
        if (flights.length) head.appendChild(el('span', 'count ' + (bad ? 'error' : 'info'), String(flights.length)));
        head.appendChild(el('span', 'card-sub', flights.length ? 'Every certificate that is not ready, or is being issued right now, and how far it has got.' : ''));
        box.appendChild(head);
        box.className = 'card issuance' + (bad ? ' has-error' : findings.length ? ' has-warn' : ' clear');

        if (!flights.length) {
            box.appendChild(el('p', 'quiet', 'Nothing is being issued and every certificate is ready. When cert-manager renews one, its request, ACME order and challenges show up here step by step.'));
        }
        var list = el('div', 'flights');
        flights.forEach(function (cert) {
            var item = el('article', 'flight ' + M.STATES[cert.state].tone);
            var who = el('div', 'flight-who');
            var name = K.link(cert.name, function () {
                open(M.ref.cert(cert));
            });
            name.classList.add('flight-name');
            var left = K.bigLeft(cert, model.now);
            add(who, K.stateChip(cert), name, el('span', 'faint small', cert.namespace + ' · ' + cert.issuerRef.name), el('span', 'flight-left ' + K.leftTone(cert, model.now), cert.notAfter === null ? 'not issued yet' : left.n + ' ' + left.unit));
            item.appendChild(who);
            var track = el('div', 'flight-track');
            track.appendChild(K.chainSteps(cert.chain, h, {}));
            var why = K.why(cert.chain, { headline: true });
            if (why) track.appendChild(why);
            if (cert.retryAt) {
                var retry = el('div', 'flight-retry');
                retry.appendChild(K.icon('clock'));
                retry.appendChild(el('span', '', 'After ' + plural(cert.failedAttempts, 'failed attempt') + ', cert-manager tries again ' + (cert.retryAt > model.now ? K.relative(cert.retryAt, model.now) + ' (' + K.dateTime(cert.retryAt) + ')' : 'any moment now') + '.'));
                track.appendChild(retry);
            }
            item.appendChild(track);
            list.appendChild(item);
        });
        box.appendChild(list);

        if (findings.length) {
            var more = el('div', 'findings');
            more.appendChild(el('h3', 'mini-title', flights.length ? 'Also worth a look' : 'Worth a look'));
            var ul = el('ul', 'issues');
            findings.forEach(function (f) {
                var li = el('li', 'issue ' + f.tone);
                var text = el('div', 'issue-text');
                if (f.owner) {
                    add(
                        text,
                        K.link(f.owner.kind + ' ' + f.owner.namespace + '/' + f.owner.name, function () {
                            open(f.ref);
                        }),
                        el('span', 'faint', ' — '),
                    );
                }
                text.appendChild(document.createTextNode(f.text));
                li.appendChild(text);
                if (f.ref || f.view) {
                    var go = K.button('', 'icon-button', 'open', function () {
                        if (f.ref) open(f.ref);
                        else openView(f.view);
                    });
                    go.title = 'Open';
                    go.setAttribute('aria-label', 'Open');
                    li.appendChild(go);
                }
                ul.appendChild(li);
            });
            more.appendChild(ul);
            box.appendChild(more);
        }
    }

    // ----- issuers ---------------------------------------------------------------

    function miniStates(certs) {
        var bar = el('div', 'mini-states');
        var counts = {};
        certs.forEach(function (c) {
            counts[c.state] = (counts[c.state] || 0) + 1;
        });
        ['valid', 'issuing', 'expiring', 'notready', 'stuck', 'failed', 'expired'].forEach(function (s) {
            if (!counts[s]) return;
            var seg = el('i', tone(s));
            seg.style.flexGrow = String(counts[s]);
            seg.title = counts[s] + ' ' + M.STATES[s].label.toLowerCase();
            bar.appendChild(seg);
        });
        return bar;
    }

    function drawIssuers(model) {
        var box = $('issuers');
        box.textContent = '';
        var head = el('div', 'card-head');
        add(head, K.icon('stamp'), el('h2', '', 'Issuers'), el('span', 'count muted', String(model.issuers.length)));
        box.appendChild(head);
        if (!model.issuers.length) {
            box.appendChild(el('p', 'quiet', 'There is no Issuer or ClusterIssuer yet, so cert-manager has nowhere to get a certificate from. A ClusterIssuer for Let’s Encrypt is the usual first one.'));
            box.appendChild(
                K.button('Setting up an issuer', 'ghost small', 'open', function () {
                    sdk.openUrl('https://cert-manager.io/docs/configuration/').catch(fail);
                }),
            );
            return;
        }
        var grid = el('div', 'issuer-grid');
        model.issuers
            .slice()
            .sort(function (a, b) {
                return (a.ready === 'True') - (b.ready === 'True') || b.certs.length - a.certs.length || a.name.localeCompare(b.name);
            })
            .forEach(function (i) {
                var ready = i.ready === 'True';
                var card = K.button('', 'issuer-card' + (ready ? '' : ' not-ready'), null, function () {
                    open(M.ref.issuer(i));
                });
                card.title = 'Open ' + i.kind + ' ' + i.name;
                var top = el('div', 'issuer-top');
                var names = el('div', 'issuer-names');
                add(names, el('span', 'issuer-name', i.name), el('span', 'issuer-kind', (i.cluster ? 'ClusterIssuer' : 'Issuer · ' + i.namespace) + ' · ' + M.ISSUER_TYPES[i.type]));
                add(top, K.issuerTile(i.type, ready ? '' : 'error'), names, K.readyChip(i));
                card.appendChild(top);

                var body = el('div', 'issuer-body');
                if (i.acme) {
                    var line = el('div', 'issuer-line');
                    add(line, el('strong', '', i.acme.provider), i.acme.staging ? K.stagingBadge() : null, i.acme.email ? el('span', 'faint', i.acme.email) : null);
                    body.appendChild(line);
                    if (i.acme.solvers.length) {
                        var solvers = el('div', 'issuer-solvers');
                        i.acme.solvers.forEach(function (s) {
                            solvers.appendChild(K.chip(s.type + (s.detail ? ' · ' + s.detail : '') + (s.zones.length ? ' · ' + s.zones.join(', ') : ''), s.type === 'DNS-01' ? 'dns' : 'http', s.type === 'DNS-01' ? 'dns' : 'globe'));
                        });
                        body.appendChild(solvers);
                    }
                } else if (i.detail) {
                    body.appendChild(el('div', 'issuer-line faint', i.detail));
                }
                if (!ready && i.readyMessage) body.appendChild(el('div', 'issuer-error', i.readyMessage));
                card.appendChild(body);

                var foot = el('div', 'issuer-foot');
                if (i.certs.length) foot.appendChild(miniStates(i.certs));
                foot.appendChild(el('span', 'faint small', i.certs.length ? plural(i.certs.length, 'certificate') : 'no certificates yet'));
                card.appendChild(foot);
                grid.appendChild(card);
            });
        box.appendChild(grid);
    }

    // ----- activity ------------------------------------------------------------

    function drawActivity() {
        var box = $('activity');
        box.textContent = '';
        var head = el('div', 'card-head');
        add(head, K.icon('activity'), el('h2', '', 'Recent activity'));
        box.appendChild(head);
        if (state.events === null) {
            box.appendChild(el('p', 'quiet', 'Reading events…'));
            return;
        }
        if (state.events.length === 0) {
            box.appendChild(el('p', 'quiet', 'Nothing from cert-manager lately. Kubernetes keeps events for about an hour, so a quiet cluster reads as an empty list.'));
            return;
        }
        box.appendChild(K.eventLog(state.events.slice(0, 12), h));
    }

    // ----- history ---------------------------------------------------------------

    function colour(i) {
        return 'var(--chart-' + Math.min(i + 1, 8) + ', ' + FALLBACK[Math.min(i, 7)] + ')';
    }

    // The Ready condition's values wear the tones they mean rather than the
    // next series colour: True is never drawn red.
    function seriesColour(chart, name, i) {
        if (chart.id === 'ready-by-condition') {
            if (name === 'True') return 'var(--ok, #5fd39b)';
            if (name === 'False') return 'var(--error, #f4787f)';
            if (name === 'Unknown') return 'var(--warn, #efb567)';
        }
        return colour(i);
    }

    function formatValue(v, unit) {
        if (!isFinite(v)) return '—';
        if (unit === 'count') return String(Math.round(v));
        if (unit === 'seconds') return (v < 0 ? '−' : '') + K.span(v * 1000);
        if (unit === 'ops/s') return (Math.round(v * 1000) / 1000).toString() + '/s';
        return Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 100) / 100);
    }

    // One chart as a line per series from zero, a gap where Prometheus had
    // no sample, the top of the scale written in the corner and each
    // series' latest value in the legend.
    function lineChart(chart) {
        var card = el('article', 'chart');
        var head = el('div', 'chart-head');
        head.appendChild(el('h3', '', chart.label));
        if (chart.description) head.title = chart.description;
        card.appendChild(head);

        var series = chart.series.filter(function (s) {
            return s.points.length > 0;
        });
        if (chart.error || series.length === 0) {
            card.appendChild(el('p', 'quiet', chart.error || 'No data for this window. ' + (chart.description || '')));
            return card;
        }
        var minT = Infinity;
        var maxT = -Infinity;
        var maxV = 0;
        series.forEach(function (s) {
            s.points.forEach(function (p) {
                minT = Math.min(minT, p.t);
                maxT = Math.max(maxT, p.t);
                if (isFinite(p.v)) maxV = Math.max(maxV, p.v);
            });
        });
        if (maxT === minT) maxT = minT + 1;
        var top = maxV > 0 ? maxV * 1.15 : 1;
        var W = 600;
        var H = 130;
        var x = function (t) {
            return ((t - minT) / (maxT - minT)) * W;
        };
        var y = function (v) {
            return H - (Math.max(0, v) / top) * H;
        };
        var step = (maxT - minT) / 60;
        var plot = el('div', 'chart-plot');
        var s = K.svg('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', class: 'chart-svg' });
        [0.25, 0.5, 0.75, 1].forEach(function (f) {
            s.appendChild(K.svg('line', { x1: 0, x2: W, y1: H * (1 - f / 1.15), y2: H * (1 - f / 1.15), class: 'chart-grid' }));
        });
        series.forEach(function (sr, i) {
            var runs = [];
            var run = [];
            sr.points.forEach(function (p, j) {
                var gap = j > 0 && p.t - sr.points[j - 1].t > step * 3;
                if (!isFinite(p.v) || gap) {
                    if (run.length) runs.push(run);
                    run = [];
                    if (!isFinite(p.v)) return;
                }
                run.push(p);
            });
            if (run.length) runs.push(run);
            var c = seriesColour(chart, sr.name, i);
            runs.forEach(function (r) {
                var d = r
                    .map(function (p, j) {
                        return (j ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1);
                    })
                    .join(' ');
                var area = K.svg('path', { d: d + ' L' + x(r[r.length - 1].t).toFixed(1) + ' ' + H + ' L' + x(r[0].t).toFixed(1) + ' ' + H + ' Z', class: 'chart-area' });
                area.style.fill = c;
                s.appendChild(area);
                var line = K.svg('path', { d: d, class: 'chart-line' });
                line.style.stroke = c;
                s.appendChild(line);
            });
        });
        plot.appendChild(s);
        plot.appendChild(el('span', 'chart-top', formatValue(maxV, chart.unit)));
        card.appendChild(plot);

        var legend = el('div', 'chart-legend');
        series.forEach(function (sr, i) {
            var last = sr.points[sr.points.length - 1];
            var key = el('span', 'chart-key');
            var dot = el('i', 'dot');
            dot.style.background = seriesColour(chart, sr.name, i);
            add(key, dot, el('span', '', sr.name || chart.label), el('strong', '', formatValue(last.v, chart.unit)));
            legend.appendChild(key);
        });
        card.appendChild(legend);
        return card;
    }

    function drawHistory() {
        var box = $('history');
        box.textContent = '';
        var panel = state.panel;
        box.hidden = !panel || !panel.attached;
        if (box.hidden) return;
        var head = el('div', 'section-head');
        add(head, K.icon('chart'), el('h2', '', 'Over the last ' + Math.round(HISTORY_MINUTES / 60) + ' hours'));
        box.appendChild(head);
        if (!panel.source.available) {
            box.appendChild(el('p', 'quiet', 'No Prometheus was found in this cluster, so there is no history to draw — everything above comes from the API server. ' + (panel.source.error || 'Set one in the cluster settings panel if it lives somewhere the app did not look.')));
            return;
        }
        var row = el('div', 'chart-row');
        panel.charts.forEach(function (chart) {
            row.appendChild(lineChart(chart));
        });
        box.appendChild(row);
        if (panel.source.describe) box.appendChild(el('p', 'source', 'From ' + panel.source.describe));
    }

    // ----- the foot ------------------------------------------------------------

    var DESTINATIONS = [
        { id: 'certificates', label: 'Certificates', icon: 'cert' },
        { id: 'certificate-list', label: 'Certificate list', icon: 'rows' },
        { id: 'requests', label: 'Certificate requests', icon: 'request' },
        { id: 'issuers', label: 'Issuers', icon: 'stamp' },
        { id: 'cluster-issuers', label: 'Cluster issuers', icon: 'globe' },
        { id: 'orders', label: 'ACME orders', icon: 'order' },
        { id: 'challenges', label: 'ACME challenges', icon: 'challenge' },
        { id: 'components', label: "cert-manager's pods", icon: 'pod' },
    ];

    function drawFoot() {
        var box = $('foot');
        box.textContent = '';
        box.hidden = false;
        var go = el('div', 'go');
        DESTINATIONS.forEach(function (d) {
            go.appendChild(
                K.button(d.label, 'go-tile', d.icon, function () {
                    openView(d.id);
                }),
            );
        });
        box.appendChild(go);

        if (state.summary && state.summary.requirements.length) {
            var reqs = el('div', 'reqs');
            reqs.appendChild(el('span', 'reqs-label', 'This cluster serves'));
            state.summary.requirements.forEach(function (r) {
                var t = r.error ? 'warn' : r.served ? 'ok' : r.optional ? 'muted' : 'error';
                reqs.appendChild(K.chip(r.label, t, r.error ? 'alert' : r.served ? 'check' : 'close', r.error || r.kind));
            });
            box.appendChild(reqs);
        }
        add(box, K.about(sdk, state.ctx && state.ctx.plugin, fail));
    }

    // ----- not here, or not reachable --------------------------------------------

    function drawAbsent(summary, model) {
        var hero = $('hero');
        hero.textContent = '';
        hero.className = 'ov-hero absent';
        ['runway', 'issuance', 'columns', 'history', 'foot'].forEach(function (id) {
            $(id).hidden = true;
        });
        state.focus = null;

        var main = el('div', 'ov-hero-main');
        var art = el('div', 'empty-art');
        art.appendChild(K.icon('logo'));
        main.appendChild(art);

        var unreachable = summary && !summary.checked;
        main.appendChild(el('h1', 'ov-verdict', unreachable ? 'This cluster did not answer' : 'cert-manager is not installed in ' + state.ctx.contextName));
        main.appendChild(
            el(
                'p',
                'ov-story',
                unreachable
                    ? 'Whether cert-manager is here could not be checked, which is not the same as it being absent. ' + (summary.error || '')
                    : 'This cluster does not serve the kinds every cert-manager install has, so any TLS certificate here is looked after by something else — or by hand.',
            ),
        );
        if (summary && summary.requirements.length) {
            var list = el('ul', 'req-list');
            summary.requirements.forEach(function (r) {
                var item = el('li', r.served ? 'ok' : r.optional ? 'muted' : 'error');
                add(item, K.icon(r.served ? 'check' : 'close'), el('span', '', r.label), el('code', 'faint', r.kind.replace(/^crd:/, '')));
                if (r.optional) item.appendChild(el('span', 'faint small', 'optional'));
                list.appendChild(item);
            });
            main.appendChild(list);
        } else if (model && model.missing && !(unreachable && summary.error && model.missing.indexOf(summary.error) >= 0)) {
            main.appendChild(el('p', 'faint small', model.missing));
        }
        if (!unreachable) {
            var cta = el('div', 'ov-cta');
            cta.appendChild(
                K.button('How to install cert-manager', 'primary', 'open', function () {
                    sdk.openUrl('https://cert-manager.io/docs/installation/').catch(fail);
                }),
            );
            main.appendChild(cta);
        }
        add(main, K.about(sdk, state.ctx && state.ctx.plugin, fail));
        hero.appendChild(main);
    }

    // ----- putting it together -----------------------------------------------

    function render() {
        var model = state.model;
        var summary = state.summary;
        if (summary && (!summary.checked || !summary.installed)) {
            drawAbsent(summary, model);
            return;
        }
        if (!model) return;
        if (!model.installed) {
            drawAbsent(summary, model);
            return;
        }
        $('columns').hidden = false;
        drawHero(model);
        drawRunway(model);
        drawIssuance(model);
        drawIssuers(model);
        drawActivity();
        drawHistory();
        drawFoot();
    }

    function every(ms, fn) {
        function run() {
            Promise.resolve()
                .then(fn)
                .catch(fail)
                .then(function () {
                    setTimeout(run, ms);
                });
        }
        run();
    }

    // Relative times -- "in 3 days", "5m ago" -- go stale without anything
    // in the cluster changing, so the minute is part of what decides a redraw.
    function stamp(model) {
        return model.sig + '|' + Math.floor(Date.now() / 60000);
    }

    function tick() {
        var c = $('countdown');
        if (c && state.focus) c.textContent = countdown(state.focus.at - Date.now());
    }

    // One tip for every runway row, however often the runway is redrawn.
    K.tooltip($('runway'), '.rw-row', function (row, into) {
        var cert = state.model && state.model.certs.filter(function (c) {
            return c.key === row.dataset.key;
        })[0];
        return cert ? K.describeCert(cert, state.model.now, into) : false;
    });

    sdk.ready()
        .then(function (context) {
            state.ctx = context;

            every(POLL, function () {
                return M.load(sdk).then(function (model) {
                    clearError();
                    var sig = stamp(model);
                    if (sig === state.sig) return;
                    var first = !state.model;
                    state.model = model;
                    state.sig = sig;
                    render();
                    if (first) refreshEvents();
                });
            });
            every(SUMMARY_EVERY, function () {
                return sdk.summary().then(function (summary) {
                    var changed = JSON.stringify(summary) !== JSON.stringify(state.summary);
                    state.summary = summary;
                    if (changed) render();
                });
            });
            every(CHARTS_EVERY, function () {
                if (!sdk.charts) return null;
                return sdk.charts({ minutes: HISTORY_MINUTES }).then(function (panel) {
                    state.panel = panel;
                    if (state.model && state.model.installed && !(state.summary && !state.summary.installed)) drawHistory();
                });
            });
            setInterval(refreshEvents, EVENTS_EVERY);
            setInterval(tick, 1000);
        })
        .catch(fail);

    function refreshEvents() {
        if (!state.model || !state.model.installed) return;
        M.loadEvents(sdk)
            .then(function (events) {
                var changed = JSON.stringify(events) !== JSON.stringify(state.events);
                state.events = events;
                if (changed && !$('columns').hidden) drawActivity();
            })
            .catch(fail);
    }
})();
