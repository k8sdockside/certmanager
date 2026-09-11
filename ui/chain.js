// The panel on a CertificateRequest, an ACME Order or a Challenge: the
// certificate it is part of issuing, the whole chain from certificate to
// challenge with this object ringed in it, and -- when the chain is stuck --
// where and why. One of these objects alone rarely explains itself; the
// chain around it does.
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

    // The object this panel is drawn for, found in the model, and the
    // certificate it leads back to.
    function locate(model, ref) {
        function find(list) {
            return (
                list.filter(function (x) {
                    return x.namespace === ref.namespace && x.name === ref.name;
                })[0] || null
            );
        }
        if (ref.kind === M.KINDS.requests) {
            var r = find(model.requests);
            return r ? { what: 'request', obj: r, request: r, cert: r.cert } : null;
        }
        if (ref.kind === M.KINDS.orders) {
            var o = find(model.orders);
            return o ? { what: 'order', obj: o, request: o.request, cert: o.request && o.request.cert } : null;
        }
        var c = find(model.challenges);
        if (!c) return null;
        var req = c.order && c.order.request;
        return { what: 'challenge', obj: c, request: req, cert: req && req.cert };
    }

    // What the object says about itself, whatever the chain around it does.
    function ownStatus(found) {
        var o = found.obj;
        var box = el('div', 'own');
        var line = el('div', 'own-line');
        if (found.what === 'challenge') {
            add(line, el('strong', '', o.type), el('code', 'name-chip small', (o.wildcard ? '*.' : '') + o.dnsName), K.chip(o.state || 'pending', o.state === 'valid' ? 'ok' : o.state === 'invalid' || o.state === 'errored' || o.state === 'expired' ? 'error' : 'warn'), K.chip(o.presented ? 'presented' : 'not presented yet', o.presented ? 'muted' : 'warn'), o.processing ? K.chip('processing', 'info', 'refresh') : null);
        } else if (found.what === 'order') {
            add(line, el('strong', '', 'ACME order'), K.chip(o.state || 'pending', o.state === 'valid' ? 'ok' : o.state === 'invalid' || o.state === 'errored' ? 'error' : 'warn'));
            o.dnsNames.forEach(function (n) {
                line.appendChild(el('code', 'name-chip small', n));
            });
        } else {
            var r = o;
            add(line, el('strong', '', 'Revision ' + (r.revision || '?')), K.chip(r.approved ? 'approved' : r.denied ? 'denied' : 'not approved yet', r.approved ? 'ok' : r.denied ? 'error' : 'warn'), K.chip(M.isTrue(r.ready) ? 'issued' : (r.ready && r.ready.reason) || 'pending', M.isTrue(r.ready) ? 'ok' : r.ready && r.ready.reason === 'Failed' ? 'error' : 'warn'));
        }
        box.appendChild(line);
        return box;
    }

    function draw(model, found) {
        var root = $('root');
        root.textContent = '';
        var cert = found.cert;
        root.appendChild(ownStatus(found));

        if (!cert) {
            root.appendChild(el('p', 'faint small', 'It is not linked to any Certificate cert-manager is keeping — it may have been made by hand, or be left over from one since deleted.'));
            var raw = found.obj.reason || (found.obj.ready && found.obj.ready.message) || '';
            if (raw) {
                var hint = M.diagnose(raw, { type: found.obj.type, host: found.obj.dnsName, step: found.what });
                var why = el('div', 'why ' + (M.errorish(raw) ? 'error' : 'info'));
                why.appendChild(K.icon('info'));
                var body = el('div', 'why-body');
                if (hint) body.appendChild(el('div', 'why-hint', hint));
                body.appendChild(el('code', 'why-raw', raw));
                why.appendChild(body);
                root.appendChild(why);
            }
            return;
        }

        var part = el('div', 'part-of');
        var current = found.request && cert.chain.request === found.request;
        add(
            part,
            el('span', 'faint', current ? 'Part of issuing ' : 'An earlier attempt at issuing '),
            K.link(cert.name, function () {
                open(M.ref.cert(cert));
            }, 'Open the Certificate'),
            el('span', 'faint', current ? '' : ' (revision ' + (found.request ? found.request.revision : '?') + '). The certificate has moved on; this is where it is now:'),
            K.stateChip(cert),
        );
        root.appendChild(part);

        root.appendChild(K.chainSteps(cert.chain, h, { compact: true, current: state.ctx.object }));
        var w = K.why(cert.chain, { headline: true });
        if (w) root.appendChild(w);
    }

    function tick() {
        M.load(sdk)
            .then(function (model) {
                $('error').hidden = true;
                var found = locate(model, state.ctx.object);
                if (!found) {
                    if (state.sig !== 'missing') {
                        state.sig = 'missing';
                        $('root').textContent = '';
                        $('root').appendChild(el('p', 'faint', model.installed ? 'This object could not be read.' : 'cert-manager is not installed in this cluster.'));
                    }
                    return;
                }
                var sig = model.sig + '|' + Math.floor(Date.now() / 60000);
                if (sig === state.sig) return;
                state.sig = sig;
                draw(model, found);
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
                fail(new Error('This page is a panel, drawn for one CertificateRequest, Order or Challenge.'));
                return;
            }
            tick();
        })
        .catch(fail);
})();
