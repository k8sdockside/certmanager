// An Issuer's or ClusterIssuer's panel: what kind of issuer it is and where it
// gets certificates from -- for ACME the server, whether that is a staging
// one, the account and how it proves control of a name -- whether it is
// ready and why not, and every certificate that depends on it.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var M = window.CertManager;
    var K = window.CertManagerKit;
    var el = K.el;
    var add = K.add;
    var POLL = 5000;
    var MAX_ROWS = 12;

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

    function fact(dl, label, value) {
        add(dl, el('dt', '', label), add(el('dd'), value));
    }

    function draw(model, issuer) {
        var root = $('root');
        root.textContent = '';
        var now = model.now;
        var ready = issuer.ready === 'True';

        var head = el('div', 'p-head');
        var names = el('div', 'p-issuer');
        add(names, el('strong', '', issuer.acme ? 'ACME · ' + issuer.acme.provider : M.ISSUER_TYPES[issuer.type]), el('span', 'faint small', issuer.cluster ? 'for every namespace' : 'for namespace ' + issuer.namespace));
        add(head, K.issuerTile(issuer.type, ready ? '' : 'error'), names, issuer.acme && issuer.acme.staging ? K.stagingBadge() : null, K.readyChip(issuer));
        root.appendChild(head);

        if (!ready) {
            var why = el('div', 'why error');
            why.appendChild(K.icon('alert'));
            var body = el('div', 'why-body');
            add(body, el('div', 'why-head', issuer.ready === 'False' ? 'Not ready' + (issuer.readyReason ? ' — ' + issuer.readyReason : '') : 'No Ready condition yet'), el('div', 'why-hint', issuer.certs.length ? 'Nothing it signs is issued or renewed until it is — ' + K.plural(issuer.certs.length, 'certificate depends', 'certificates depend') + ' on it.' : 'Nothing uses it yet.'));
            if (issuer.readyMessage) body.appendChild(el('code', 'why-raw', issuer.readyMessage));
            why.appendChild(body);
            root.appendChild(why);
        }

        var dl = el('dl', 'facts compact');
        if (issuer.acme) {
            fact(dl, 'Server', el('code', 'small', issuer.acme.server));
            if (issuer.acme.email) fact(dl, 'Account email', issuer.acme.email);
            if (issuer.acme.eab) fact(dl, 'Account', 'bound to an external account (EAB)');
            var solvers = el('span', 'issuer-solvers');
            issuer.acme.solvers.forEach(function (s) {
                solvers.appendChild(K.chip(s.type + (s.detail ? ' · ' + s.detail : '') + (s.zones.length ? ' · ' + s.zones.join(', ') : ''), s.type === 'DNS-01' ? 'dns' : 'http', s.type === 'DNS-01' ? 'dns' : 'globe'));
            });
            if (!issuer.acme.solvers.length) solvers.appendChild(K.chip('none — it cannot prove anything', 'error', 'alert'));
            fact(dl, 'Proves control by', solvers);
        } else if (issuer.detail) {
            fact(dl, 'Signs', issuer.detail);
        }
        if (dl.childNodes.length) root.appendChild(dl);

        root.appendChild(el('h3', 'mini-title', issuer.certs.length ? 'Certificates from it · ' + issuer.certs.length : 'Certificates from it'));
        if (!issuer.certs.length) {
            root.appendChild(el('p', 'faint small', 'No certificate uses it yet.'));
            return;
        }
        var list = el('div', 'p-certs');
        issuer.certs
            .slice()
            .sort(function (a, b) {
                return M.STATES[a.state].rank - M.STATES[b.state].rank || (a.notAfter || 0) - (b.notAfter || 0);
            })
            .slice(0, MAX_ROWS)
            .forEach(function (c) {
                var row = K.button('', 'p-cert', null, function () {
                    open(M.ref.cert(c));
                });
                var left = K.bigLeft(c, now);
                add(row, K.stateDot(c.state, M.STATES[c.state].label), add(el('span', 'p-cert-who'), el('span', 'p-cert-name', c.name), el('span', 'faint small', c.namespace)), K.validityBar(c, now), el('span', 'p-cert-left ' + K.leftTone(c, now), c.notAfter === null ? '—' : left.n + ' ' + left.unit.replace(' left', '')));
                row.title = M.describe(c, now).text;
                list.appendChild(row);
            });
        root.appendChild(list);
        if (issuer.certs.length > MAX_ROWS) {
            root.appendChild(
                K.button('All ' + issuer.certs.length + ' in Certificates', 'ghost small', 'arrow', function () {
                    sdk.openView('certificates').catch(fail);
                }),
            );
        }
    }

    function tick() {
        M.load(sdk)
            .then(function (model) {
                $('error').hidden = true;
                var obj = state.ctx.object;
                var cluster = obj.kind === M.KINDS.clusterIssuers;
                var issuer = model.issuerFor(cluster ? 'ClusterIssuer' : 'Issuer', obj.namespace, obj.name);
                if (!issuer) {
                    if (state.sig !== 'missing') {
                        state.sig = 'missing';
                        $('root').textContent = '';
                        $('root').appendChild(el('p', 'faint', model.installed ? 'This issuer could not be read.' : 'cert-manager is not installed in this cluster.'));
                    }
                    return;
                }
                var sig = model.sig + '|' + Math.floor(Date.now() / 60000);
                if (sig === state.sig) return;
                state.sig = sig;
                draw(model, issuer);
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
                fail(new Error('This page is a panel, drawn for one Issuer or ClusterIssuer.'));
                return;
            }
            tick();
        })
        .catch(fail);
})();
