// The TLS panel on an Ingress or a Gateway: which hosts are served by which
// Secret, which Certificate keeps that Secret filled and how it stands, and
// whether the issuer the cert-manager annotation names exists and is ready --
// "this Ingress's TLS is healthy", or what is wrong with it. Where cert-manager
// could take over, one control offers to.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var M = window.CertManager;
    var K = window.CertManagerKit;
    var el = K.el;
    var add = K.add;
    var POLL = 5000;

    var state = { ctx: null, sig: '' };

    var $ = function (id) {
        return document.getElementById(id);
    };

    function fail(err) {
        $('error').textContent = (err && err.message) || String(err);
        $('error').hidden = false;
    }

    function open(ref) {
        sdk.open(ref).catch(fail);
    }

    function held() {
        var active = document.activeElement;
        return active && $('root').contains(active) && active.tagName === 'SELECT';
    }

    function flash(text) {
        var note = el('div', 'notice');
        add(note, K.icon('check'), el('span', '', text));
        $('root').insertBefore(note, $('root').firstChild);
        setTimeout(function () {
            note.remove();
        }, 5000);
    }

    var VERDICT_ICONS = { ok: 'check', info: 'check', warn: 'alert', error: 'alert', muted: 'info' };

    function block(model, entry, b) {
        var now = model.now;
        // A valid certificate that leaves out one of the hosts still fails
        // for that host, so the row reads amber however healthy it is.
        var tone = b.cert ? M.STATES[b.cert.state].tone : 'unmanaged';
        if (b.cert && b.uncovered.length && M.rankTone(tone) > M.rankTone('warn')) tone = 'warn';
        var node = el('div', 'tls-row ' + tone);
        var hosts = el('div', 'tls-hosts');
        (b.hosts.length ? b.hosts : ['(every host)']).forEach(function (hn) {
            var c = el('code', 'name-chip small' + (b.uncovered.indexOf(hn) >= 0 ? ' bad' : ''), hn);
            if (b.uncovered.indexOf(hn) >= 0) c.title = 'Not in the certificate';
            hosts.appendChild(c);
        });
        var secret = el('div', 'tls-secret');
        add(secret, K.icon('lock'), el('code', '', b.secretName || '—'));
        secret.title = 'The Secret holding the certificate. Its contents are never read here.';

        var cert = el('div', 'tls-cert');
        if (b.cert) {
            var c = b.cert;
            var line = el('div', 'tls-cert-line');
            add(
                line,
                K.stateDot(c.state, M.STATES[c.state].label),
                K.link(c.name, function () {
                    open(M.ref.cert(c));
                }, 'Open the Certificate'),
            );
            var left = K.bigLeft(c, now);
            line.appendChild(el('span', 'tls-left ' + K.leftTone(c, now), c.notAfter === null ? 'not issued yet' : left.n + ' ' + left.unit));
            cert.appendChild(line);
            cert.appendChild(K.validityBar(c, now));
            var d = M.describe(c, now);
            if (d.tone !== 'ok') cert.appendChild(el('div', 'tls-says ' + d.tone, d.text));
        } else {
            add(cert, el('span', 'faint', entry.wanted ? 'no Certificate yet' : 'not managed by cert-manager'));
        }
        // Hosts into the Secret on the first line; what keeps that Secret
        // filled, with room for its name and state, under them.
        add(node, hosts, K.icon('arrow', 'tls-arrow'), secret, cert);
        return node;
    }

    function controls(model, entry) {
        if (!state.ctx.write || !model.installed || !model.issuers.length) return null;
        var issuer = entry.issuer;
        var wanted = entry.wanted;
        var broken = wanted && !wanted.legacy && wanted.group === M.GROUP && (!issuer || issuer.ready !== 'True');
        var box = el('div', 'tls-control');
        var picker = K.issuerPicker(model, entry.namespace, issuer);
        if (!entry.blocks.length) {
            if (entry.kind !== 'Ingress' || !entry.ruleHosts.length) return null;
            add(
                box,
                el('span', 'control-text', 'Serve ' + entry.ruleHosts.join(', ') + ' over HTTPS: cert-manager gets a certificate into Secret ' + entry.name + '-tls.'),
                picker,
                K.button('Serve over HTTPS', 'small', 'lock', function () {
                    var chosen = picker.pick();
                    if (!chosen) return;
                    K.apply(sdk, M.ref.owner(entry), K.patches.serveHttps(entry, chosen))
                        .then(function (done) {
                            if (done) flash('Asked for a certificate from ' + chosen.name + '.');
                        })
                        .catch(fail);
                }),
            );
            return box;
        }
        if (wanted && !broken) return null;
        add(
            box,
            el('span', 'control-text', broken ? 'Point it at an issuer that works:' : 'Let cert-manager keep this TLS filled, from:'),
            picker,
            K.button(broken ? 'Switch issuer' : 'Manage with cert-manager', 'small', 'arrow', function () {
                var chosen = picker.pick();
                if (!chosen) return;
                K.apply(sdk, M.ref.owner(entry), K.patches.shimIssuer(entry, chosen))
                    .then(function (done) {
                        if (done) flash('Asked cert-manager to use ' + chosen.name + ' for this ' + entry.kind + '.');
                    })
                    .catch(fail);
            }),
        );
        return box;
    }

    function draw(model, entry) {
        var root = $('root');
        root.textContent = '';
        var tls = entry.tls;

        var head = el('div', 'tls-verdict ' + tls.tone);
        add(head, K.icon(VERDICT_ICONS[tls.tone] || 'info'), el('span', '', tls.text));
        root.appendChild(head);

        if (entry.wanted) {
            var ask = el('div', 'tls-ask');
            ask.appendChild(el('code', 'faint small', entry.wanted.annotation));
            if (entry.wanted.legacy) {
                ask.appendChild(el('span', 'small', 'the controller’s default issuer'));
            } else {
                var i = entry.issuer;
                ask.appendChild(K.issuerTile(i ? i.type : entry.wanted.group !== M.GROUP ? 'external' : 'other', i && i.ready === 'True' ? '' : entry.wanted.group !== M.GROUP ? '' : 'error'));
                if (i) {
                    add(
                        ask,
                        K.link(i.name, function () {
                            open(M.ref.issuer(i));
                        }, 'Open ' + i.kind + ' ' + i.name),
                        el('span', 'faint small', i.kind),
                        K.readyChip(i),
                        i.acme && i.acme.staging ? K.stagingBadge() : null,
                    );
                } else {
                    add(ask, el('span', '', entry.wanted.name), el('span', 'faint small', entry.wanted.kind), entry.wanted.group !== M.GROUP ? el('span', 'faint small', entry.wanted.group) : K.chip('does not exist', 'error', 'failed'));
                }
            }
            root.appendChild(ask);
        }

        if (entry.blocks.length) {
            var list = el('div', 'tls-rows');
            entry.blocks.forEach(function (b) {
                list.appendChild(block(model, entry, b));
            });
            root.appendChild(list);
        }

        if (tls.notes.length) {
            var notes = el('ul', 'tls-notes');
            tls.notes.forEach(function (n) {
                var li = el('li', n.tone);
                add(li, K.icon(n.tone === 'error' || n.tone === 'warn' ? 'alert' : 'info'), el('span', '', n.text));
                notes.appendChild(li);
            });
            root.appendChild(notes);
        }

        var ctl = controls(model, entry);
        if (ctl) root.appendChild(ctl);
    }

    function tick() {
        M.load(sdk)
            .then(function (model) {
                $('error').hidden = true;
                var obj = state.ctx.object;
                if (!model.installed) {
                    if (state.sig !== 'absent') {
                        state.sig = 'absent';
                        var root = $('root');
                        root.textContent = '';
                        var line = el('div', 'tls-verdict muted');
                        add(line, K.icon('info'), el('span', '', 'cert-manager is not installed in this cluster.'));
                        root.appendChild(line);
                    }
                    return;
                }
                var kind = obj.kind === M.KINDS.gateways ? 'Gateway' : 'Ingress';
                var entry = model.owners.filter(function (e) {
                    return e.kind === kind && e.namespace === obj.namespace && e.name === obj.name;
                })[0];
                if (!entry) {
                    if (state.sig !== 'missing') {
                        state.sig = 'missing';
                        $('root').textContent = '';
                        $('root').appendChild(el('p', 'faint', 'This ' + kind + ' could not be read.'));
                    }
                    return;
                }
                var sig = model.sig + '|' + Math.floor(Date.now() / 60000);
                if (sig === state.sig || held()) return;
                state.sig = sig;
                draw(model, entry);
            })
            .catch(fail)
            .then(function () {
                setTimeout(tick, POLL);
            });
    }

    sdk.ready()
        .then(function (context) {
            state.ctx = context;
            if (!context.object) {
                fail(new Error('This page is a panel, drawn for one Ingress or Gateway.'));
                return;
            }
            tick();
        })
        .catch(fail);
})();
