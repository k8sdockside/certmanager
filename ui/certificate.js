// A Certificate's panel in its detail view: how much of its life is left and
// when it renews, where it comes from, and -- when it is being issued or has
// stalled -- the chain of objects cert-manager made to issue it and which one
// is holding it up. The command to renew it by hand sits at the bottom.
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

    var h = { open: open };

    function draw(model, cert) {
        var root = $('root');
        root.textContent = '';
        var now = model.now;

        var head = el('div', 'p-head');
        var d = M.describe(cert, now);
        add(head, K.stateChip(cert), el('span', 'p-says ' + d.tone, d.text));
        var left = K.bigLeft(cert, now);
        var big = el('span', 'p-left ' + K.leftTone(cert, now));
        add(big, el('strong', '', left.n), el('span', '', ' ' + left.unit));
        head.appendChild(big);
        root.appendChild(head);

        root.appendChild(K.validityBar(cert, now, { labels: true }));

        var meta = el('div', 'p-meta');
        var from = el('span', 'p-fact');
        if (cert.issuer) {
            add(
                from,
                K.issuerTile(cert.issuer.type, cert.issuer.ready === 'True' ? '' : 'error'),
                K.link(cert.issuer.name, function () {
                    open(M.ref.issuer(cert.issuer));
                }, 'Open ' + cert.issuer.kind + ' ' + cert.issuer.name),
                cert.issuer.ready === 'True' ? null : K.readyChip(cert.issuer),
                cert.issuer.acme && cert.issuer.acme.staging ? K.stagingBadge() : null,
            );
        } else {
            add(from, K.issuerTile(cert.issuerRef.group !== M.GROUP ? 'external' : 'other', cert.issuerRef.group !== M.GROUP ? '' : 'error'), el('span', '', cert.issuerRef.name), cert.issuerRef.group !== M.GROUP ? null : K.chip('does not exist', 'error', 'failed'));
        }
        var secret = el('span', 'p-fact');
        secret.title = 'The Secret it is written to. Its contents are never read here.';
        add(secret, K.icon('lock'), el('code', '', cert.secretName || '—'));
        add(meta, from, secret);
        var names = el('span', 'p-fact p-names');
        cert.hosts.slice(0, 3).forEach(function (n) {
            names.appendChild(el('code', 'name-chip small', n));
        });
        if (cert.hosts.length > 3) names.appendChild(el('span', 'faint small', '+' + (cert.hosts.length - 3) + ' more'));
        if (cert.hosts.length) meta.appendChild(names);
        root.appendChild(meta);

        // The chain only when it has something to say: a settled certificate
        // is its bar.
        if (cert.chain.open || cert.state !== 'valid') {
            root.appendChild(K.chainSteps(cert.chain, h, { compact: true }));
            var why = K.why(cert.chain, { headline: true });
            if (why) root.appendChild(why);
            if (cert.retryAt) {
                root.appendChild(el('div', 'd-retry', 'After ' + K.plural(cert.failedAttempts, 'failed attempt') + ', cert-manager tries again ' + (cert.retryAt > now ? K.relative(cert.retryAt, now) + ' — ' + K.dateTime(cert.retryAt) : 'any moment now') + '.'));
            }
        }

        if (cert.usedBy.length) {
            var used = el('div', 'p-used');
            used.appendChild(el('span', 'faint small', 'Served by '));
            cert.usedBy.forEach(function (u, i) {
                if (i > 0) used.appendChild(document.createTextNode(', '));
                used.appendChild(
                    K.link(u.kind + ' ' + u.name, function () {
                        open({ kind: u.appKind, namespace: u.namespace, name: u.name });
                    }),
                );
            });
            root.appendChild(used);
        }

        root.appendChild(K.cmctl(cert));
    }

    function tick() {
        M.load(sdk)
            .then(function (model) {
                $('error').hidden = true;
                var obj = state.ctx.object;
                var cert = model.certNamed(obj.namespace, obj.name);
                if (!cert) {
                    if (state.sig !== 'missing') {
                        state.sig = 'missing';
                        $('root').textContent = '';
                        $('root').appendChild(el('p', 'faint', model.installed ? 'This certificate could not be read.' : 'cert-manager is not installed in this cluster.'));
                    }
                    return;
                }
                var sig = model.sig + '|' + Math.floor(Date.now() / 60000);
                if (sig === state.sig) return;
                state.sig = sig;
                draw(model, cert);
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
                fail(new Error('This page is a panel, drawn for one Certificate.'));
                return;
            }
            tick();
        })
        .catch(fail);
})();
