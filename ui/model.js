// The cert-manager model every page of this plugin draws from: each
// certificate with its validity and the state it is in, the issuer it comes
// from, the chain of objects cert-manager makes to issue it -- request, ACME
// order, challenges -- and where that chain has stalled, and the Ingresses and
// Gateways whose TLS it serves. Read once per poll through the k8sdockside
// bridge and worked out here, so the pages only have to draw.
//
// Times are milliseconds since the epoch throughout, all worked out against
// one `now` per read, so that everything drawn from one read agrees about
// what "in 3 days" means.
(function () {
    'use strict';

    var KINDS = {
        certificates: 'crd:certificates.cert-manager.io',
        requests: 'crd:certificaterequests.cert-manager.io',
        issuers: 'crd:issuers.cert-manager.io',
        clusterIssuers: 'crd:clusterissuers.cert-manager.io',
        orders: 'crd:orders.acme.cert-manager.io',
        challenges: 'crd:challenges.acme.cert-manager.io',
        ingresses: 'ingresses',
        gateways: 'gateways',
        pods: 'pods',
        events: 'events',
    };

    // The Kubernetes kind an event names, and the app kind that opens it.
    var APP_KINDS = {
        Certificate: KINDS.certificates,
        CertificateRequest: KINDS.requests,
        Issuer: KINDS.issuers,
        ClusterIssuer: KINDS.clusterIssuers,
        Order: KINDS.orders,
        Challenge: KINDS.challenges,
        Ingress: KINDS.ingresses,
        Gateway: KINDS.gateways,
    };

    var ANN = {
        clusterIssuer: 'cert-manager.io/cluster-issuer',
        issuer: 'cert-manager.io/issuer',
        issuerKind: 'cert-manager.io/issuer-kind',
        issuerGroup: 'cert-manager.io/issuer-group',
        tlsAcme: 'kubernetes.io/tls-acme',
        certName: 'cert-manager.io/certificate-name',
        revision: 'cert-manager.io/certificate-revision',
    };

    var GROUP = 'cert-manager.io';

    var SECOND = 1000;
    var MINUTE = 60 * SECOND;
    var HOUR = 60 * MINUTE;
    var DAY = 24 * HOUR;

    // A certificate this close to its end is called out, however healthy it
    // looks: cert-manager renews a Let's Encrypt certificate with thirty days
    // left, so one with fewer than fourteen is a renewal that did not happen.
    // Short-lived certificates get a third of their lifetime instead, or a
    // day-long one would always read as about to expire.
    var SOON = 14 * DAY;

    // An issuance still in flight after this long is stuck, whatever the
    // objects along the way say about it. DNS-01 propagation can take a few
    // minutes; nothing healthy takes an hour.
    var STUCK_AFTER = HOUR;

    // What each certificate state is called and how it reads, worst first.
    // The order is the order everything is sorted in: one expired certificate
    // among forty valid ones is the reason anybody opened the page.
    var STATES = {
        expired: { label: 'Expired', tone: 'error', rank: 0 },
        failed: { label: 'Failed', tone: 'error', rank: 1 },
        stuck: { label: 'Stuck', tone: 'error', rank: 2 },
        notready: { label: 'Not ready', tone: 'warn', rank: 3 },
        expiring: { label: 'Expiring soon', tone: 'warn', rank: 4 },
        issuing: { label: 'Issuing', tone: 'info', rank: 5 },
        valid: { label: 'Valid', tone: 'ok', rank: 6 },
    };
    var STATE_ORDER = ['expired', 'failed', 'stuck', 'notready', 'expiring', 'issuing', 'valid'];

    // ----- small readers -----------------------------------------------------

    function dig(obj, path) {
        var at = obj;
        var keys = path.split('.');
        for (var i = 0; i < keys.length; i++) {
            if (at === null || at === undefined) return undefined;
            at = at[keys[i]];
        }
        return at;
    }

    function ts(value) {
        if (!value) return null;
        var t = Date.parse(value);
        return isFinite(t) ? t : null;
    }

    function keyOf(obj) {
        return (obj.metadata.namespace || '') + '/' + obj.metadata.name;
    }

    function annotationsOf(obj) {
        return (obj && obj.metadata && obj.metadata.annotations) || {};
    }

    function labelsOf(obj) {
        return (obj && obj.metadata && obj.metadata.labels) || {};
    }

    function ownerOf(obj, kind) {
        var refs = (obj.metadata && obj.metadata.ownerReferences) || [];
        for (var i = 0; i < refs.length; i++) {
            if (refs[i].kind === kind) return refs[i];
        }
        return null;
    }

    function condition(obj, type) {
        var list = dig(obj, 'status.conditions') || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i].type === type) {
                return {
                    type: type,
                    status: list[i].status || '',
                    reason: list[i].reason || '',
                    message: list[i].message || '',
                    since: ts(list[i].lastTransitionTime),
                };
            }
        }
        return null;
    }

    function isTrue(c) {
        return !!c && c.status === 'True';
    }

    function isFalse(c) {
        return !!c && c.status === 'False';
    }

    function unique(list) {
        var seen = {};
        return list.filter(function (v) {
            if (!v || seen[v]) return false;
            seen[v] = true;
            return true;
        });
    }

    function newest(a, b) {
        return (b.created || 0) - (a.created || 0);
    }

    // A Go duration as the API writes one -- "2160h0m0s", "720h", "90m" -- in
    // milliseconds, or null.
    function parseDuration(text) {
        if (!text) return null;
        var units = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: SECOND, m: MINUTE, h: HOUR };
        var re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
        var total = 0;
        var found = false;
        var m;
        while ((m = re.exec(String(text)))) {
            total += parseFloat(m[1]) * units[m[2]];
            found = true;
        }
        return found ? total : null;
    }

    // Does a certificate name cover a host? A wildcard covers exactly one
    // label: *.example.com covers www.example.com, not example.com and not
    // a.b.example.com.
    function covers(pattern, host) {
        pattern = String(pattern || '').toLowerCase();
        host = String(host || '').toLowerCase();
        if (!pattern || !host) return false;
        if (pattern === host) return true;
        if (pattern.indexOf('*.') !== 0) return false;
        var rest = pattern.slice(1);
        if (host.length <= rest.length || host.slice(-rest.length) !== rest) return false;
        return host.slice(0, -rest.length).indexOf('.') < 0;
    }

    // Anything in a status message that says something went wrong, rather
    // than that cert-manager is simply waiting. "Waiting for DNS-01 challenge
    // propagation: DNS record not yet propagated" is patience; "wrong status
    // code '404'" is not.
    var ERRORISH = /wrong status code|error|fail|refused|timeout|timed out|deadline exceeded|no such host|nxdomain|servfail|unauthori[sz]ed|forbidden|denied|not found|does not have a ready|not ready|invalid|rate.?limit|too many|rejected|caa|\b[45]\d\d\b/i;

    function errorish(text) {
        return !!text && ERRORISH.test(text);
    }

    // ----- issuers -----------------------------------------------------------

    function providerOf(server) {
        var s = String(server || '').toLowerCase();
        if (s.indexOf('letsencrypt.org') >= 0) return "Let's Encrypt";
        if (s.indexOf('zerossl') >= 0) return 'ZeroSSL';
        if (s.indexOf('buypass') >= 0) return 'Buypass';
        if (s.indexOf('pki.goog') >= 0) return 'Google Trust Services';
        if (s.indexOf('sectigo') >= 0) return 'Sectigo';
        if (s.indexOf('digicert') >= 0) return 'DigiCert';
        var host = /^https?:\/\/([^/:]+)/.exec(s);
        return host ? host[1] : s || 'ACME';
    }

    // Let's Encrypt's staging server hands out certificates no browser
    // trusts, which is the point of it and the reason it is worth a badge.
    function isStaging(server) {
        return /staging/i.test(String(server || ''));
    }

    var DNS_PROVIDERS = {
        cloudflare: 'Cloudflare',
        route53: 'Route 53',
        cloudDNS: 'Google Cloud DNS',
        azureDNS: 'Azure DNS',
        digitalocean: 'DigitalOcean',
        akamai: 'Akamai',
        acmeDNS: 'acme-dns',
        rfc2136: 'RFC 2136',
    };

    function solverOf(s) {
        var out = { type: '', detail: '', zones: [] };
        if (s.http01) {
            out.type = 'HTTP-01';
            var ing = s.http01.ingress;
            if (ing) {
                out.detail = ing.ingressClassName ? 'ingress class ' + ing.ingressClassName : ing['class'] ? 'ingress class ' + ing['class'] : ing.name ? 'ingress ' + ing.name : 'ingress';
            } else if (s.http01.gatewayHTTPRoute) {
                out.detail = 'Gateway API route';
            }
        } else if (s.dns01) {
            out.type = 'DNS-01';
            Object.keys(DNS_PROVIDERS).some(function (k) {
                if (s.dns01[k]) out.detail = DNS_PROVIDERS[k];
                return !!s.dns01[k];
            });
            if (!out.detail && s.dns01.webhook) {
                out.detail = 'webhook ' + (s.dns01.webhook.solverName || s.dns01.webhook.groupName || '');
            }
        }
        var sel = s.selector || {};
        out.zones = (sel.dnsZones || []).concat(sel.dnsNames || []);
        return out;
    }

    function issuerKey(kind, namespace, name) {
        return kind === 'ClusterIssuer' ? 'ClusterIssuer//' + name : 'Issuer/' + (namespace || '') + '/' + name;
    }

    function buildIssuer(obj, cluster) {
        var spec = obj.spec || {};
        var ready = condition(obj, 'Ready');
        var type = spec.acme ? 'acme' : spec.ca ? 'ca' : spec.selfSigned ? 'selfsigned' : spec.vault ? 'vault' : spec.venafi ? 'venafi' : 'other';
        var issuer = {
            key: issuerKey(cluster ? 'ClusterIssuer' : 'Issuer', obj.metadata.namespace, obj.metadata.name),
            kind: cluster ? 'ClusterIssuer' : 'Issuer',
            cluster: cluster,
            name: obj.metadata.name,
            namespace: cluster ? '' : obj.metadata.namespace || '',
            obj: obj,
            type: type,
            ready: ready ? ready.status : '',
            readyReason: ready ? ready.reason : '',
            readyMessage: ready ? ready.message : '',
            acme: null,
            detail: '',
            certs: [],
        };
        if (spec.acme) {
            issuer.acme = {
                server: spec.acme.server || '',
                email: spec.acme.email || '',
                staging: isStaging(spec.acme.server),
                provider: providerOf(spec.acme.server),
                solvers: (spec.acme.solvers || []).map(solverOf),
                account: dig(obj, 'status.acme.uri') || '',
                eab: !!spec.acme.externalAccountBinding,
            };
        } else if (spec.ca) {
            issuer.detail = 'Signs with the key pair in Secret ' + (spec.ca.secretName || '?');
        } else if (spec.selfSigned) {
            issuer.detail = 'Each certificate signs itself — usually the root of a CA issuer.';
        } else if (spec.vault) {
            issuer.detail = (spec.vault.server || 'Vault') + (spec.vault.path ? ' · ' + spec.vault.path : '');
        } else if (spec.venafi) {
            issuer.detail = 'Venafi ' + (spec.venafi.cloud ? 'Cloud' : spec.venafi.tpp ? 'TPP' : '') + (spec.venafi.zone ? ' · zone ' + spec.venafi.zone : '');
        }
        return issuer;
    }

    var ISSUER_TYPES = {
        acme: 'ACME',
        ca: 'CA',
        selfsigned: 'Self-signed',
        vault: 'Vault',
        venafi: 'Venafi',
        other: 'Other',
        external: 'External',
    };

    // ----- certificates and the objects made to issue them ------------------

    function buildCert(obj) {
        var spec = obj.spec || {};
        var status = obj.status || {};
        var refIn = spec.issuerRef || {};
        var owner = ownerOf(obj, 'Ingress') || ownerOf(obj, 'Gateway');
        return {
            key: keyOf(obj),
            uid: obj.metadata.uid,
            name: obj.metadata.name,
            namespace: obj.metadata.namespace || '',
            obj: obj,
            secretName: spec.secretName || '',
            dnsNames: spec.dnsNames || [],
            commonName: spec.commonName || '',
            ips: spec.ipAddresses || [],
            uris: spec.uris || [],
            emails: spec.emailAddresses || [],
            hosts: unique([spec.commonName].concat(spec.dnsNames || [], spec.ipAddresses || [])),
            issuerRef: { name: refIn.name || '', kind: refIn.kind || 'Issuer', group: refIn.group || GROUP },
            isCA: spec.isCA === true,
            duration: parseDuration(spec.duration),
            renewBefore: parseDuration(spec.renewBefore),
            renewBeforePercentage: spec.renewBeforePercentage,
            privateKey: spec.privateKey || {},
            notBefore: ts(status.notBefore),
            notAfter: ts(status.notAfter),
            renewalTime: ts(status.renewalTime),
            revision: status.revision || 0,
            failedAttempts: status.failedIssuanceAttempts || 0,
            lastFailure: ts(status.lastFailureTime),
            nextKey: status.nextPrivateKeySecretName || '',
            ready: condition(obj, 'Ready'),
            issuing: condition(obj, 'Issuing'),
            owner: owner ? { kind: owner.kind, name: owner.name } : null,
            created: ts(obj.metadata.creationTimestamp),
            requests: [],
            usedBy: [],
            issuer: null,
            chain: null,
            state: 'valid',
            left: null,
        };
    }

    function buildRequest(obj) {
        var ann = annotationsOf(obj);
        var owner = ownerOf(obj, 'Certificate');
        return {
            key: keyOf(obj),
            uid: obj.metadata.uid,
            name: obj.metadata.name,
            namespace: obj.metadata.namespace || '',
            obj: obj,
            created: ts(obj.metadata.creationTimestamp),
            certName: ann[ANN.certName] || (owner && owner.name) || '',
            ownerUid: owner ? owner.uid : '',
            revision: parseInt(ann[ANN.revision], 10) || 0,
            ready: condition(obj, 'Ready'),
            approved: isTrue(condition(obj, 'Approved')),
            denied: isTrue(condition(obj, 'Denied')) ? condition(obj, 'Denied') : null,
            invalid: isTrue(condition(obj, 'InvalidRequest')) ? condition(obj, 'InvalidRequest') : null,
            failureTime: ts(dig(obj, 'status.failureTime')),
            orders: [],
            cert: null,
        };
    }

    function buildOrder(obj) {
        var owner = ownerOf(obj, 'CertificateRequest');
        return {
            key: keyOf(obj),
            uid: obj.metadata.uid,
            name: obj.metadata.name,
            namespace: obj.metadata.namespace || '',
            obj: obj,
            created: ts(obj.metadata.creationTimestamp),
            ownerName: owner ? owner.name : '',
            ownerUid: owner ? owner.uid : '',
            state: dig(obj, 'status.state') || '',
            reason: dig(obj, 'status.reason') || '',
            dnsNames: dig(obj, 'spec.dnsNames') || [],
            failureTime: ts(dig(obj, 'status.failureTime')),
            challenges: [],
            request: null,
        };
    }

    function buildChallenge(obj) {
        var owner = ownerOf(obj, 'Order');
        var spec = obj.spec || {};
        var solver = spec.solver || {};
        return {
            key: keyOf(obj),
            uid: obj.metadata.uid,
            name: obj.metadata.name,
            namespace: obj.metadata.namespace || '',
            obj: obj,
            created: ts(obj.metadata.creationTimestamp),
            ownerName: owner ? owner.name : '',
            ownerUid: owner ? owner.uid : '',
            type: spec.type || (solver.dns01 ? 'DNS-01' : 'HTTP-01'),
            dnsName: spec.dnsName || '',
            wildcard: spec.wildcard === true,
            token: spec.token || '',
            state: dig(obj, 'status.state') || '',
            presented: dig(obj, 'status.presented') === true,
            processing: dig(obj, 'status.processing') === true,
            reason: dig(obj, 'status.reason') || '',
            order: null,
        };
    }

    // ----- what went wrong, in words ------------------------------------------

    // Most specific first. Each turns the terse status text cert-manager (or
    // the CA behind it) wrote into what to go and look at.
    var HINTS = [
        {
            test: /wrong status code '404'|invalid response from \S+: 404/i,
            text: function (ctx) {
                var host = ctx.host || 'the name';
                return 'The CA fetched http://' + (ctx.host || '<host>') + "/.well-known/acme-challenge/… and got a 404, so the request never reached cert-manager's solver. Check that " + host + " resolves to this cluster's ingress, and that no other Ingress, redirect or login page in front of it catches /.well-known/acme-challenge/.";
            },
        },
        {
            test: /wrong status code '3\d\d'/i,
            text: function () {
                return 'A redirect answered the challenge. HTTP-01 is checked over plain HTTP on port 80 — leave /.well-known/acme-challenge/ out of any redirect to HTTPS or to another host.';
            },
        },
        {
            test: /wrong status code '5\d\d'/i,
            text: function () {
                return "The ingress controller answered the challenge with a server error. Its logs for the solver's Ingress say why.";
            },
        },
        {
            test: /no such host|nxdomain/i,
            text: function (ctx) {
                return (ctx.host || 'The name') + ' does not resolve. Create the DNS record pointing it at this cluster before asking for a certificate.';
            },
        },
        {
            test: /not yet propagated|propagation check failed|could not find the start of authority|soa/i,
            text: function () {
                return "cert-manager has written the TXT record and is waiting to see it on the zone's authoritative nameservers. A few minutes is normal; if it lasts, check the DNS provider's credentials and that the record went into the right zone.";
            },
        },
        {
            test: /connection refused|i\/o timeout|timed out|deadline exceeded/i,
            text: function (ctx) {
                if (ctx.type === 'DNS-01') return 'The DNS provider or the nameservers could not be reached. Look for an egress policy or firewall between cert-manager and them.';
                return 'The check could not reach ' + (ctx.host || 'the name') + ' at all. Port 80 has to be open to the internet, and the name has to resolve to the load balancer in front of this cluster.';
            },
        },
        {
            test: /does not have a ready status condition|issuer.*not ready|is not ready/i,
            text: function (ctx) {
                var who = ctx.issuer ? ctx.issuer.kind + ' ' + ctx.issuer.name : 'The issuer';
                return who + ' is not ready' + (ctx.issuer && ctx.issuer.readyMessage ? ': ' + ctx.issuer.readyMessage : '.') + ' Nothing is issued until it is.';
            },
        },
        {
            test: /issuer.*not found/i,
            text: function () {
                return 'The issuer it names does not exist. Check spec.issuerRef — its name, and kind Issuer (same namespace) or ClusterIssuer.';
            },
        },
        {
            test: /ratelimit|rate limit|too many certificates|too many/i,
            text: function () {
                return "The CA is rate-limiting this account. Let's Encrypt allows five identical certificates a week — wait it out, and use a staging issuer while testing.";
            },
        },
        {
            test: /caa/i,
            text: function () {
                return "A CAA record on the domain does not allow this CA to issue for it. Add the CA to the domain's CAA records.";
            },
        },
        {
            test: /unauthori[sz]ed|\b403\b/i,
            text: function () {
                return 'The CA refused the authorisation: it could not confirm this account controls the name. Usually the same cause as a failing challenge — the token was not reachable, or the TXT record was not there.';
            },
        },
    ];

    function diagnose(text, ctx) {
        if (!text) return '';
        ctx = ctx || {};
        for (var i = 0; i < HINTS.length; i++) {
            if (HINTS[i].test.test(text)) {
                var hint = HINTS[i].text(ctx);
                if (hint) return hint;
            }
        }
        return '';
    }

    // cert-manager backs off after a failed issuance: an hour, then doubling,
    // to at most 32 hours.
    function nextRetry(cert) {
        if (!cert.lastFailure || !cert.failedAttempts) return null;
        var hours = Math.min(32, Math.pow(2, Math.max(0, cert.failedAttempts - 1)));
        return cert.lastFailure + hours * HOUR;
    }

    // "Issuing certificate as Secret does not exist" -> "Secret does not exist".
    function issuingNote(c) {
        var m = c.message || '';
        if (/renewal was scheduled/i.test(m)) return 'scheduled renewal';
        var as = /^(?:Issuing|Re-?issuing) certificate as (.*)$/i.exec(m);
        if (as) return lowerFirst(as[1].replace(/\.$/, ''));
        return c.reason ? lowerFirst(c.reason) : 'issuing';
    }

    function lowerFirst(s) {
        s = String(s || '');
        return s.charAt(0).toLowerCase() + s.slice(1);
    }

    // ----- the chain -----------------------------------------------------------

    // What the bridge's open() and edit() are given for each object.
    var refs = {};
    refs.cert = function (c) {
        return { kind: KINDS.certificates, namespace: c.namespace, name: c.name };
    };
    refs.issuer = function (i) {
        return { kind: i.cluster ? KINDS.clusterIssuers : KINDS.issuers, namespace: i.namespace, name: i.name };
    };
    refs.request = function (r) {
        return { kind: KINDS.requests, namespace: r.namespace, name: r.name };
    };
    refs.order = function (o) {
        return { kind: KINDS.orders, namespace: o.namespace, name: o.name };
    };
    refs.challenge = function (c) {
        return { kind: KINDS.challenges, namespace: c.namespace, name: c.name };
    };
    refs.owner = function (e) {
        return { kind: e.appKind, namespace: e.namespace, name: e.name };
    };

    function requestStep(r, s) {
        var ready = r.ready;
        if (r.denied) {
            s.state = 'failed';
            s.note = 'denied';
            s.reason = r.denied.message || 'The request was denied.';
        } else if (r.invalid) {
            s.state = 'failed';
            s.note = 'invalid';
            s.reason = r.invalid.message || 'The request is invalid.';
        } else if (isTrue(ready)) {
            s.state = 'done';
            s.note = 'issued';
        } else if (ready && ready.reason === 'Failed') {
            s.state = 'failed';
            s.note = 'failed';
            s.reason = ready.message;
        } else if (!r.approved) {
            s.state = 'active';
            s.note = 'waiting for approval';
            s.reason = ready ? ready.message : '';
        } else {
            s.state = 'active';
            s.note = ready && ready.reason ? lowerFirst(ready.reason) : 'pending';
            s.reason = ready ? ready.message : '';
        }
        if (s.state === 'active' && errorish(s.reason)) s.state = 'stuck';
    }

    var FINAL_BAD = { invalid: true, errored: true, expired: true };

    function challengeItem(c) {
        var item = {
            name: c.name,
            ref: refs.challenge(c),
            dnsName: (c.wildcard && c.dnsName.indexOf('*.') !== 0 ? '*.' : '') + c.dnsName,
            host: c.dnsName,
            type: c.type,
            reason: c.reason,
            state: 'active',
            note: '',
            obj: c,
        };
        if (c.state === 'valid') {
            item.state = 'done';
            item.note = 'valid';
        } else if (FINAL_BAD[c.state]) {
            item.state = 'failed';
            item.note = c.state;
        } else {
            item.note = c.state || 'pending';
            if (!c.presented) item.note += ' · not presented yet';
            if (errorish(c.reason)) item.state = 'stuck';
        }
        return item;
    }

    // The issuance of one certificate as a row of steps -- the certificate,
    // its request, then either the ACME order and its challenges or the
    // issuer signing -- each done, in progress, stuck or failed, and the one
    // that decides what the certificate is waiting for.
    function buildChain(model, cert) {
        var now = model.now;
        var inflight = isTrue(cert.issuing);
        var failedNow = isFalse(cert.issuing) && cert.issuing.reason === 'Failed';
        var open = inflight || failedNow;
        // A request in flight is for the next revision; one that issued the
        // current certificate carries the current revision.
        var wanted = open ? cert.revision + 1 : cert.revision;
        var requests = cert.requests.slice().sort(function (a, b) {
            return b.revision - a.revision || newest(a, b);
        });
        var request = null;
        for (var i = 0; i < requests.length; i++) {
            if (requests[i].revision === wanted) {
                request = requests[i];
                break;
            }
        }
        if (!request && !open && requests.length) request = requests[0];
        var order = request && request.orders.length ? request.orders.slice().sort(newest)[0] : null;
        var challenges = order
            ? order.challenges.slice().sort(function (a, b) {
                  return a.dnsName.localeCompare(b.dnsName);
              })
            : [];
        var issuer = cert.issuer;
        var acme = issuer ? issuer.type === 'acme' : !!order;
        var steps = [];

        var cs = { kind: 'certificate', label: 'Certificate', name: cert.name, ref: refs.cert(cert), state: 'done', note: '', reason: '' };
        if (failedNow) {
            cs.state = 'failed';
            cs.note = 'failed' + (cert.failedAttempts ? ' · attempt ' + cert.failedAttempts : '');
            cs.reason = cert.issuing.message;
        } else if (inflight) {
            cs.note = issuingNote(cert.issuing);
        } else {
            cs.note = isTrue(cert.ready) ? 'ready' : (cert.ready && lowerFirst(cert.ready.reason)) || 'no status yet';
        }
        steps.push(cs);

        var rs = { kind: 'request', label: 'Request', name: request ? request.name : '', ref: request ? refs.request(request) : null, state: 'idle', note: '', reason: '' };
        if (request) {
            requestStep(request, rs);
        } else if (inflight) {
            rs.state = 'active';
            rs.note = 'being created';
        } else {
            rs.note = open ? 'none' : 'none kept';
        }
        steps.push(rs);

        if (acme) {
            var os = { kind: 'order', label: 'ACME order', name: order ? order.name : '', ref: order ? refs.order(order) : null, state: 'idle', note: '', reason: '' };
            if (order) {
                if (order.state === 'valid') {
                    os.state = 'done';
                    os.note = 'valid';
                } else if (FINAL_BAD[order.state]) {
                    os.state = 'failed';
                    os.note = order.state;
                    os.reason = order.reason;
                } else {
                    os.state = errorish(order.reason) ? 'stuck' : 'active';
                    os.note = order.state === 'ready' ? 'finalizing' : order.state || 'pending';
                    os.reason = order.reason;
                }
            } else if (rs.state === 'active' && request && request.approved) {
                os.state = 'active';
                os.note = 'being created';
            } else if (rs.state === 'done') {
                os.state = 'done';
                os.note = 'cleaned up';
            } else {
                os.note = '—';
            }
            steps.push(os);

            var items = challenges.map(challengeItem);
            var ch = { kind: 'challenges', label: items.length > 1 ? 'Challenges' : 'Challenge', name: '', ref: null, state: 'idle', note: '', reason: '', items: items };
            if (items.length) {
                var any = function (st) {
                    return items.some(function (it) {
                        return it.state === st;
                    });
                };
                ch.state = any('failed') ? 'failed' : any('stuck') ? 'stuck' : any('active') ? 'active' : 'done';
                ch.note = unique(
                    items.map(function (it) {
                        return it.type;
                    }),
                ).join(' + ');
                var bad = items.filter(function (it) {
                    return it.state === 'failed' || it.state === 'stuck';
                })[0];
                var waiting = items.filter(function (it) {
                    return it.state === 'active';
                })[0];
                var lead = bad || waiting || items[0];
                ch.reason = lead.reason;
                ch.lead = lead;
                if (items.length === 1) {
                    ch.name = items[0].name;
                    ch.ref = items[0].ref;
                }
            } else if (os.state === 'active' && order) {
                ch.state = 'active';
                ch.note = 'being created';
            } else if (os.state === 'done') {
                ch.state = 'done';
                ch.note = 'solved';
            } else {
                ch.note = '—';
            }
            steps.push(ch);
        } else {
            var is = { kind: 'issuer', label: 'Issuer', name: cert.issuerRef.name, ref: issuer ? refs.issuer(issuer) : null, state: 'idle', note: '', reason: '' };
            if (cert.issuerRef.group !== GROUP) {
                is.state = rs.state === 'done' ? 'done' : rs.state === 'idle' ? 'idle' : 'active';
                is.note = 'external · ' + cert.issuerRef.group;
            } else if (!issuer) {
                is.state = open ? 'stuck' : 'failed';
                is.note = 'does not exist';
                is.reason = cert.issuerRef.kind + ' "' + cert.issuerRef.name + '" not found';
            } else if (issuer.ready !== 'True') {
                is.state = open ? 'stuck' : 'failed';
                is.note = 'not ready';
                is.reason = issuer.readyMessage || issuer.kind + ' ' + issuer.name + ' is not ready';
                // The request is only waiting on it, and saying both are
                // stuck would send the reader to the wrong one.
                if (rs.state === 'stuck') {
                    rs.state = 'active';
                    rs.note = 'waiting for the issuer';
                }
            } else if (rs.state === 'done') {
                is.state = 'done';
                is.note = 'signed';
            } else if (rs.state === 'active' || rs.state === 'stuck') {
                is.state = 'active';
                is.note = 'signing';
            } else {
                is.note = 'ready';
            }
            steps.push(is);
        }

        // Nothing healthy is still in flight after an hour, whatever the step
        // it is on says.
        var since = inflight && cert.issuing.since ? cert.issuing.since : null;
        if (since && now - since > STUCK_AFTER) {
            var slow = steps.filter(function (s) {
                return s.state === 'active';
            })[0];
            if (slow && !steps.some(isBad)) {
                slow.state = 'stuck';
                slow.slow = true;
            }
        }

        // The step that decides what the certificate is waiting for is the
        // deepest one in trouble: a failure travels up the chain, so a failed
        // challenge also fails its order, its request and the certificate,
        // and only the challenge says why. Failing nothing, it is the deepest
        // step still working.
        var focus = -1;
        for (var f = steps.length - 1; f >= 0; f--) {
            if (isBad(steps[f])) {
                focus = f;
                break;
            }
        }
        if (focus < 0) {
            for (var g = steps.length - 1; g >= 0; g--) {
                if (steps[g].state === 'active') {
                    focus = g;
                    break;
                }
            }
        }

        var chain = {
            cert: cert,
            steps: steps,
            focus: focus,
            open: open,
            inflight: inflight,
            since: since,
            request: request,
            order: order,
            challenges: challenges,
            acme: acme,
            stuck: steps.some(function (s) {
                return s.state === 'stuck';
            }),
            failed: steps.some(function (s) {
                return s.state === 'failed';
            }),
            headline: '',
            reason: '',
            hint: '',
            tone: 'ok',
        };
        if (focus >= 0) {
            var at = steps[focus];
            var lead = at.lead || null;
            chain.reason = at.reason || '';
            chain.tone = isBad(at) ? 'error' : 'info';
            chain.headline = headlineFor(at, lead, cert);
            if (at.slow && !chain.reason) chain.reason = 'No progress for ' + words(now - since) + '.';
            chain.hint = diagnose(chain.reason, {
                step: at.kind,
                type: lead ? lead.type : '',
                host: lead ? lead.host : cert.hosts[0] || '',
                issuer: issuer,
            });
            // An issuer's own message is about the issuer -- a Vault token, a
            // CA secret -- and reads wrongly through the hints above.
            if (at.kind === 'issuer') {
                chain.hint =
                    at.note === 'does not exist'
                        ? 'Check spec.issuerRef — its name, and kind Issuer (same namespace) or ClusterIssuer.'
                        : (issuer ? issuer.kind + ' ' + issuer.name : 'The issuer') + ' has to be ready before it signs anything. Its status says why it is not; once it is, cert-manager carries on by itself.';
            }
            if (!chain.hint && at.kind === 'request' && at.note === 'waiting for approval' && isBad(at)) {
                chain.hint = "Nothing has approved the request. cert-manager's own approver may be switched off, or a policy engine such as approver-policy is holding it.";
            }
        }
        return chain;
    }

    function isBad(step) {
        return step.state === 'failed' || step.state === 'stuck';
    }

    function headlineFor(step, lead, cert) {
        var bad = isBad(step);
        var failed = step.state === 'failed';
        switch (step.kind) {
            case 'certificate':
                return failed ? 'Issuance failed' + (cert.failedAttempts > 1 ? ' ' + cert.failedAttempts + ' times' : '') : 'Starting to issue';
            case 'request':
                if (step.note === 'denied') return 'The request was denied';
                if (step.note === 'waiting for approval') return bad ? 'Stuck waiting for approval' : 'Waiting for approval';
                return failed ? 'The certificate request failed' : bad ? 'Stuck at the certificate request' : 'Waiting on the certificate request';
            case 'order':
                return failed ? 'The ACME order failed' : bad ? 'Stuck at the ACME order' : 'Waiting on the ACME order';
            case 'challenges':
                var what = lead ? 'the ' + lead.type + ' challenge for ' + lead.dnsName : 'the challenges';
                return failed ? capitalise(what) + ' failed' : bad ? 'Stuck at ' + what : 'Waiting on ' + what;
            case 'issuer':
                if (step.note === 'does not exist') return 'The issuer does not exist';
                return bad ? 'The issuer is not ready' : 'Waiting for the issuer to sign';
        }
        return '';
    }

    function capitalise(s) {
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    // A length of time in words, the way the kit writes it too.
    function words(ms) {
        var a = Math.abs(ms);
        var year = 365.25 * DAY;
        if (a < HOUR) return plural(Math.max(1, Math.round(a / MINUTE)), 'minute');
        if (a < 2 * DAY) return plural(Math.round(a / HOUR), 'hour');
        if (a < 120 * DAY) return plural(Math.round(a / DAY), 'day');
        if (a < 2 * year) return plural(Math.round(a / (year / 12)), 'month');
        return plural(Math.round(a / year), 'year');
    }

    // ----- the state of one certificate ------------------------------------------

    function classify(model, cert) {
        var now = model.now;
        var ready = isTrue(cert.ready);
        var inflight = isTrue(cert.issuing);
        var failedNow = isFalse(cert.issuing) && cert.issuing.reason === 'Failed';
        var chain = cert.chain;
        cert.left = cert.notAfter !== null ? cert.notAfter - now : null;
        cert.lifetime = cert.notAfter !== null && cert.notBefore !== null ? cert.notAfter - cert.notBefore : null;
        var window = cert.lifetime ? Math.min(SOON, cert.lifetime / 3) : SOON;
        cert.soon = cert.left !== null && cert.left < window;
        cert.overdue = cert.renewalTime !== null && cert.renewalTime < now - 5 * MINUTE && !inflight;
        cert.retryAt = failedNow || (!ready && cert.failedAttempts > 0) ? nextRetry(cert) : null;

        if (cert.left !== null && cert.left <= 0) cert.state = 'expired';
        else if (failedNow || (!ready && !inflight && cert.failedAttempts > 0)) cert.state = 'failed';
        else if (inflight && chain && (chain.stuck || chain.failed)) cert.state = 'stuck';
        else if (!ready && !inflight) cert.state = 'notready';
        else if (!inflight && (cert.soon || (ready && cert.overdue))) cert.state = 'expiring';
        else if (inflight) cert.state = 'issuing';
        else cert.state = 'valid';

        // The facets the certificate board filters by. They overlap on
        // purpose: a certificate renewing with five days left is both
        // "expiring soon" and "issuing", and belongs under both.
        cert.facets = {
            expiring: cert.left !== null && (cert.left <= 0 || cert.soon),
            notReady: !ready,
            issuing: inflight,
            healthy: cert.state === 'valid',
        };
    }

    // One line on where a certificate is, for a row or a tooltip.
    function describe(cert, now) {
        var chain = cert.chain;
        switch (cert.state) {
            case 'expired':
                return { tone: 'error', text: 'Expired ' + words(now - cert.notAfter) + ' ago' + (chain && chain.headline ? ' · ' + lowerFirst(chain.headline) : '') };
            case 'failed':
                return { tone: 'error', text: (chain && chain.headline) || 'Issuance failed', retry: cert.retryAt };
            case 'stuck':
                return { tone: 'error', text: (chain && chain.headline) || 'Stuck' };
            case 'notready':
                return { tone: 'warn', text: (cert.ready && cert.ready.message) || 'Not ready, and nothing is issuing it' };
            case 'expiring':
                if (cert.overdue) return { tone: 'warn', text: 'Renewal is ' + words(now - cert.renewalTime) + ' overdue' };
                return { tone: 'warn', text: 'Expires in ' + words(cert.left) + (cert.renewalTime && cert.renewalTime > now ? ' · renews in ' + words(cert.renewalTime - now) : '') };
            case 'issuing':
                return { tone: 'info', text: cert.notAfter ? 'Renewing now' + (chain && chain.headline ? ' · ' + lowerFirst(chain.headline) : '') : (chain && chain.headline) || 'Being issued' };
        }
        if (cert.renewalTime && cert.renewalTime > now) return { tone: 'ok', text: 'Renews in ' + words(cert.renewalTime - now) };
        return { tone: 'ok', text: 'Valid' };
    }

    // ----- Ingresses and Gateways --------------------------------------------

    // The issuer an Ingress or Gateway asks ingress-shim for, by annotation.
    function wantedIssuer(obj) {
        var ann = annotationsOf(obj);
        var group = ann[ANN.issuerGroup] || GROUP;
        if (ann[ANN.clusterIssuer]) return { kind: 'ClusterIssuer', name: ann[ANN.clusterIssuer], group: GROUP, annotation: ANN.clusterIssuer };
        if (ann[ANN.issuer]) return { kind: ann[ANN.issuerKind] || 'Issuer', name: ann[ANN.issuer], group: group, annotation: ANN.issuer };
        if (String(ann[ANN.tlsAcme] || '').toLowerCase() === 'true') return { kind: '', name: '', group: '', annotation: ANN.tlsAcme, legacy: true };
        return null;
    }

    function buildIngress(obj) {
        var spec = obj.spec || {};
        var ruleHosts = unique(
            (spec.rules || []).map(function (r) {
                return r.host;
            }),
        );
        return {
            key: 'Ingress/' + keyOf(obj),
            kind: 'Ingress',
            appKind: KINDS.ingresses,
            name: obj.metadata.name,
            namespace: obj.metadata.namespace || '',
            obj: obj,
            wanted: wantedIssuer(obj),
            ruleHosts: ruleHosts,
            blocks: (spec.tls || []).map(function (t) {
                return { hosts: t.hosts || [], secretName: t.secretName || '', namespace: obj.metadata.namespace || '', cert: null, uncovered: [] };
            }),
        };
    }

    function buildGateway(obj) {
        var bySecret = {};
        var order = [];
        var hosts = [];
        ((obj.spec && obj.spec.listeners) || []).forEach(function (l) {
            if (l.hostname) hosts.push(l.hostname);
            var tls = l.tls || {};
            if (tls.mode && tls.mode !== 'Terminate') return;
            (tls.certificateRefs || []).forEach(function (r) {
                if (r.kind && r.kind !== 'Secret') return;
                var ns = r.namespace || obj.metadata.namespace || '';
                var key = ns + '/' + r.name;
                if (!bySecret[key]) {
                    bySecret[key] = { hosts: [], secretName: r.name, namespace: ns, cert: null, uncovered: [], listeners: [] };
                    order.push(key);
                }
                if (l.hostname) bySecret[key].hosts.push(l.hostname);
                bySecret[key].listeners.push(l.name);
            });
        });
        return {
            key: 'Gateway/' + keyOf(obj),
            kind: 'Gateway',
            appKind: KINDS.gateways,
            name: obj.metadata.name,
            namespace: obj.metadata.namespace || '',
            obj: obj,
            wanted: wantedIssuer(obj),
            ruleHosts: unique(hosts),
            blocks: order.map(function (k) {
                bySecret[k].hosts = unique(bySecret[k].hosts);
                return bySecret[k];
            }),
        };
    }

    // How the TLS of one Ingress or Gateway stands, in one sentence and a
    // tone, with anything specific worth saying listed under it.
    function assessTLS(model, entry) {
        var notes = [];
        var noun = 'This ' + entry.kind + "'s TLS";
        var wanted = entry.wanted;
        var issuer = entry.issuer;

        if (!entry.blocks.length) {
            if (wanted) {
                return {
                    tone: 'warn',
                    text: 'It asks cert-manager for a certificate, but has no TLS section to put one in.',
                    notes: [{ tone: 'warn', text: entry.kind === 'Ingress' ? 'Add spec.tls with the hosts and a secretName; ingress-shim then creates a Certificate for it.' : 'Give a listener tls.certificateRefs naming a Secret; cert-manager then creates a Certificate for it.' }],
                };
            }
            return { tone: 'muted', text: 'This ' + entry.kind + ' does not serve TLS.', notes: [] };
        }

        if (wanted && !wanted.legacy) {
            if (wanted.group !== GROUP) {
                notes.push({ tone: 'info', text: 'Its issuer, ' + wanted.kind + ' ' + wanted.name + ', is an external issuer (' + wanted.group + ') — its state cannot be read from here.' });
            } else if (!issuer) {
                notes.push({ tone: 'error', text: 'It names ' + wanted.kind + ' "' + wanted.name + '", which does not exist' + (wanted.kind === 'Issuer' ? ' in ' + entry.namespace : '') + '.' });
            } else if (issuer.ready !== 'True') {
                // Told on the issuer itself in the list of findings; kept
                // apart so it is not told twice.
                notes.push({ tone: 'error', issuer: true, text: issuer.kind + ' ' + issuer.name + ' is not ready' + (issuer.readyMessage ? ': ' + issuer.readyMessage : '.') });
            }
        }

        var worst = 'ok';
        var soonest = null;
        entry.blocks.forEach(function (b) {
            if (!b.cert) {
                if (wanted) notes.push({ tone: 'warn', text: 'No Certificate writes Secret ' + b.secretName + ' yet. ingress-shim makes one for each TLS entry — its events on this ' + entry.kind + ' say why it has not.' });
                return;
            }
            var tone = STATES[b.cert.state].tone;
            if (rankTone(tone) < rankTone(worst)) worst = tone;
            if (b.cert.notAfter && (soonest === null || b.cert.notAfter < soonest)) soonest = b.cert.notAfter;
            if (b.uncovered.length) notes.push({ tone: 'warn', text: b.uncovered.join(', ') + (b.uncovered.length === 1 ? ' is' : ' are') + ' not in certificate ' + b.cert.name + ', so browsers will reject ' + (b.uncovered.length === 1 ? 'it' : 'them') + '.' });
            if (b.cert.issuer && b.cert.issuer.acme && b.cert.issuer.acme.staging) notes.push({ tone: 'warn', staging: true, text: b.cert.name + ' comes from ' + b.cert.issuer.acme.provider + ' staging, which no browser trusts.' });
        });

        var managed = entry.blocks.filter(function (b) {
            return b.cert;
        });
        if (!managed.length) {
            if (!wanted) {
                return { tone: 'muted', text: noun + ' comes from ' + (entry.blocks.length === 1 ? 'a Secret' : entry.blocks.length + ' Secrets') + ' cert-manager does not manage.', notes: notes, unmanaged: true };
            }
            // The first thing in the way is the headline; the rest stay notes.
            var blocker = notes.filter(function (n) {
                return n.tone === 'error';
            })[0];
            if (blocker) {
                return {
                    tone: 'error',
                    text: noun + ' cannot be issued: ' + lowerFirst(blocker.text),
                    notes: notes.filter(function (n) {
                        return n !== blocker;
                    }),
                    lead: blocker,
                };
            }
            return { tone: 'warn', text: noun + ' is not managed yet.', notes: notes };
        }

        notes.forEach(function (n) {
            if (rankTone(n.tone) < rankTone(worst)) worst = n.tone;
        });
        var bad = managed.filter(function (b) {
            return STATES[b.cert.state].tone === 'error';
        });
        var text;
        if (worst === 'ok' || worst === 'info') {
            var hosts = unique(
                [].concat.apply(
                    [],
                    managed.map(function (b) {
                        return b.hosts;
                    }),
                ),
            );
            text = noun + ' is healthy — ' + plural(hosts.length, 'host') + ' covered' + (soonest ? ', next expiry in ' + words(soonest - model.now) : '') + '.';
        } else if (bad.length) {
            var c = bad[0].cert;
            text = noun + ' is not healthy: ' + c.name + ' ' + (c.state === 'expired' ? 'has expired' : c.state === 'failed' ? 'failed to issue' : 'is stuck') + '.';
        } else {
            // Nothing is broken, but something is off; the first thing that
            // is says more than "needs a look" would, and is not repeated.
            var lead = notes.filter(function (n) {
                return n.tone === worst;
            })[0];
            var certWarn = managed.filter(function (b) {
                return STATES[b.cert.state].tone === 'warn';
            })[0];
            if (certWarn && !lead) {
                text = noun + ' is served, but ' + certWarn.cert.name + ' ' + (certWarn.cert.overdue ? 'is overdue for renewal' : 'expires in ' + words(certWarn.cert.left)) + '.';
            } else if (lead) {
                text = noun + ' is served, but ' + lowerFirst(lead.text);
                notes = notes.filter(function (n) {
                    return n !== lead;
                });
            } else {
                text = noun + ' is served, with a caveat.';
            }
        }
        return { tone: worst, text: text, notes: notes, lead: lead || null };
    }

    var TONE_RANK = { error: 0, warn: 1, info: 2, ok: 3, muted: 4 };

    function rankTone(tone) {
        return TONE_RANK[tone] === undefined ? 4 : TONE_RANK[tone];
    }

    function plural(n, one, many) {
        return n + ' ' + (n === 1 ? one : many || one + 's');
    }

    // ----- cert-manager's own pods ---------------------------------------------

    function componentOf(pod) {
        var l = labelsOf(pod);
        var c = l['app.kubernetes.io/component'] || '';
        if (c === 'controller' || c === 'webhook' || c === 'cainjector') return c;
        var n = l['app.kubernetes.io/name'] || l.app || '';
        if (n === 'cert-manager') return 'controller';
        if (n === 'webhook' || n === 'cainjector') return n;
        return '';
    }

    function podReady(pod) {
        if (dig(pod, 'status.phase') !== 'Running') return false;
        return isTrue(condition(pod, 'Ready'));
    }

    // "quay.io/jetstack/cert-manager-controller:v1.15.3" -> "v1.15.3".
    function versionOf(pod) {
        var containers = dig(pod, 'spec.containers') || [];
        for (var i = 0; i < containers.length; i++) {
            var image = containers[i].image || '';
            var at = image.lastIndexOf(':');
            if (at > image.lastIndexOf('/') && image.indexOf('cert-manager') >= 0) return image.slice(at + 1).replace(/@.*$/, '');
        }
        return '';
    }

    // ----- reading ---------------------------------------------------------------

    function soft(promise) {
        return promise.then(
            function (items) {
                return { ok: true, items: items || [], error: '' };
            },
            function (err) {
                return { ok: false, items: [], error: (err && err.message) || String(err) };
            },
        );
    }

    function version(list) {
        return list
            .map(function (o) {
                return o.metadata.uid + '@' + o.metadata.resourceVersion;
            })
            .join(',');
    }

    function dedupe(list) {
        var seen = {};
        return list.filter(function (o) {
            if (seen[o.metadata.uid]) return false;
            seen[o.metadata.uid] = true;
            return true;
        });
    }

    // Reads everything the pages need. Only Certificates are required: a
    // cluster without the ACME kinds, without the Gateway API, or where
    // cert-manager's pods carry other labels still gets everything else.
    function load(sdk) {
        function list(kind, selector) {
            return soft(sdk.list({ kind: kind, namespace: '', selector: selector || '' }));
        }
        return Promise.all([
            list(KINDS.certificates),
            list(KINDS.requests),
            list(KINDS.issuers),
            list(KINDS.clusterIssuers),
            list(KINDS.orders),
            list(KINDS.challenges),
            list(KINDS.ingresses),
            list(KINDS.gateways),
            // The Helm chart and the static manifest both label cert-manager
            // with its release; a release under another name is still found
            // by what each component calls itself.
            list(KINDS.pods, 'app.kubernetes.io/instance=cert-manager'),
            list(KINDS.pods, 'app.kubernetes.io/name in (cert-manager,cainjector,webhook)'),
        ]).then(function (got) {
            return build({
                certs: got[0],
                requests: got[1],
                issuers: got[2],
                clusterIssuers: got[3],
                orders: got[4],
                challenges: got[5],
                ingresses: got[6],
                gateways: got[7],
                pods: { ok: got[8].ok || got[9].ok, items: dedupe(got[8].items.concat(got[9].items)) },
            });
        });
    }

    function build(raw, now) {
        now = now || Date.now();
        var model = {
            now: now,
            installed: raw.certs.ok,
            missing: raw.certs.error,
            kinds: {
                requests: raw.requests.ok,
                issuers: raw.issuers.ok,
                clusterIssuers: raw.clusterIssuers.ok,
                orders: raw.orders.ok,
                challenges: raw.challenges.ok,
                ingresses: raw.ingresses.ok,
                gateways: raw.gateways.ok,
            },
            certs: [],
            issuers: [],
            requests: [],
            orders: [],
            challenges: [],
            owners: [],
            components: {},
            componentsKnown: false,
            version: '',
            namespace: '',
            counts: {},
            facets: { expiring: 0, notReady: 0, issuing: 0, healthy: 0 },
            findings: [],
            sig: '',
        };

        model.sig = [raw.certs, raw.requests, raw.issuers, raw.clusterIssuers, raw.orders, raw.challenges, raw.ingresses, raw.gateways, raw.pods]
            .map(function (r) {
                return version(r.items);
            })
            .join('|');

        // ----- issuers
        model.issuers = raw.clusterIssuers.items
            .map(function (o) {
                return buildIssuer(o, true);
            })
            .concat(
                raw.issuers.items.map(function (o) {
                    return buildIssuer(o, false);
                }),
            );
        var issuerByKey = {};
        model.issuers.forEach(function (i) {
            issuerByKey[i.key] = i;
        });
        model.issuerFor = function (kind, namespace, name, group) {
            if (group && group !== GROUP) return null;
            return issuerByKey[issuerKey(kind === 'ClusterIssuer' ? 'ClusterIssuer' : 'Issuer', namespace, name)] || null;
        };

        // ----- certificates
        model.certs = raw.certs.items.map(buildCert);
        var certByUid = {};
        var certByKey = {};
        model.certs.forEach(function (c) {
            certByUid[c.uid] = c;
            certByKey[c.key] = c;
            c.issuer = model.issuerFor(c.issuerRef.kind, c.namespace, c.issuerRef.name, c.issuerRef.group);
            if (c.issuer) c.issuer.certs.push(c);
        });
        model.certNamed = function (namespace, name) {
            return certByKey[namespace + '/' + name] || null;
        };

        // ----- the chain, linked by owner uid where there is one and by name
        // where there is not
        model.requests = raw.requests.items.map(buildRequest);
        var reqByUid = {};
        var reqByKey = {};
        model.requests.forEach(function (r) {
            reqByUid[r.uid] = r;
            reqByKey[r.key] = r;
            var cert = certByUid[r.ownerUid] || certByKey[r.namespace + '/' + r.certName];
            if (cert) {
                r.cert = cert;
                cert.requests.push(r);
            }
        });
        model.orders = raw.orders.items.map(buildOrder);
        var orderByUid = {};
        var orderByKey = {};
        model.orders.forEach(function (o) {
            orderByUid[o.uid] = o;
            orderByKey[o.key] = o;
            var r = reqByUid[o.ownerUid] || reqByKey[o.namespace + '/' + o.ownerName];
            if (r) {
                o.request = r;
                r.orders.push(o);
            }
        });
        model.challenges = raw.challenges.items.map(buildChallenge);
        model.challenges.forEach(function (c) {
            var o = orderByUid[c.ownerUid] || orderByKey[c.namespace + '/' + c.ownerName];
            if (o) {
                c.order = o;
                o.challenges.push(c);
            }
        });

        model.certs.forEach(function (c) {
            c.chain = buildChain(model, c);
            classify(model, c);
        });
        model.certs.sort(function (a, b) {
            return STATES[a.state].rank - STATES[b.state].rank || leftOf(a) - leftOf(b) || a.key.localeCompare(b.key);
        });

        STATE_ORDER.forEach(function (s) {
            model.counts[s] = 0;
        });
        model.certs.forEach(function (c) {
            model.counts[c.state]++;
            Object.keys(c.facets).forEach(function (f) {
                if (c.facets[f]) model.facets[f]++;
            });
        });

        // ----- what serves them
        model.owners = raw.ingresses.items.map(buildIngress).concat(raw.gateways.items.map(buildGateway));
        model.owners.forEach(function (e) {
            if (e.wanted && !e.wanted.legacy) e.issuer = model.issuerFor(e.wanted.kind, e.namespace, e.wanted.name, e.wanted.group);
            e.blocks.forEach(function (b) {
                b.cert =
                    model.certs.filter(function (c) {
                        return c.namespace === b.namespace && c.secretName === b.secretName;
                    })[0] || null;
                if (b.cert) {
                    var names = b.cert.hosts;
                    b.uncovered = b.hosts.filter(function (h) {
                        return !names.some(function (n) {
                            return covers(n, h);
                        });
                    });
                    b.cert.usedBy.push({ kind: e.kind, appKind: e.appKind, name: e.name, namespace: e.namespace, entry: e });
                }
            });
            e.tls = assessTLS(model, e);
        });

        // ----- cert-manager itself
        ['controller', 'webhook', 'cainjector'].forEach(function (c) {
            model.components[c] = { name: c, pods: [], ready: 0 };
        });
        raw.pods.items.forEach(function (pod) {
            var c = componentOf(pod);
            if (!c) return;
            model.components[c].pods.push(pod);
            if (podReady(pod)) model.components[c].ready++;
        });
        var controller = model.components.controller.pods[0] || model.components.webhook.pods[0];
        if (controller) {
            model.componentsKnown = true;
            model.version = versionOf(model.components.controller.pods[0] || controller);
            model.namespace = controller.metadata.namespace || '';
        }

        model.findings = findings(model);
        return model;
    }

    function leftOf(c) {
        return c.notAfter === null ? -Infinity : c.notAfter;
    }

    // What is wrong beyond any one certificate, worst first: cert-manager's
    // own components, issuers, and the Ingresses and Gateways asking for TLS.
    function findings(model) {
        var out = [];
        if (!model.installed) return out;
        if (model.componentsKnown) {
            var ctl = model.components.controller;
            if (ctl.pods.length === 0 || ctl.ready === 0) {
                out.push({ tone: 'error', text: "cert-manager's controller is not running, so nothing is issued or renewed until it is.", view: 'components' });
            }
            var hook = model.components.webhook;
            if (hook.pods.length > 0 && hook.ready === 0) {
                out.push({ tone: 'error', text: "cert-manager's webhook is not ready. Creating or changing any cert-manager object is refused until it is.", view: 'components' });
            }
            var inj = model.components.cainjector;
            if (inj.pods.length > 0 && inj.ready === 0) {
                out.push({ tone: 'warn', text: 'The CA injector is not ready, so webhooks and API services relying on it keep stale CA bundles.', view: 'components' });
            }
        }
        model.issuers.forEach(function (i) {
            if (i.ready === 'True') return;
            var message = i.readyMessage ? ': ' + i.readyMessage.replace(/\s+$/, '') + (/[.!?]$/.test(i.readyMessage.trim()) ? '' : '.') : '.';
            out.push({
                tone: i.certs.length ? 'error' : 'warn',
                text: i.kind + ' "' + i.name + '" is not ready' + message + (i.certs.length ? ' ' + plural(i.certs.length, 'certificate depends', 'certificates depend') + ' on it.' : ''),
                ref: refs.issuer(i),
            });
        });
        model.issuers.forEach(function (i) {
            if (!i.acme || !i.acme.staging || !i.certs.length) return;
            out.push({
                tone: 'warn',
                text: plural(i.certs.length, 'certificate comes', 'certificates come') + ' from ' + i.acme.provider + ' staging (' + i.name + "). No browser trusts those — fine for testing, not for anything real.",
                ref: refs.issuer(i),
            });
        });
        model.owners.forEach(function (e) {
            // A problem with a certificate is told on the certificate; here
            // only what is wrong with the asking.
            // The note the verdict leads with is still one of them.
            var notes = (e.tls.lead ? [e.tls.lead] : []).concat(e.tls.notes).filter(function (n) {
                return !n.issuer && !n.staging && (n.tone === 'error' || n.tone === 'warn');
            });
            if (!notes.length) return;
            out.push({
                tone: notes.some(function (n) {
                    return n.tone === 'error';
                })
                    ? 'error'
                    : 'warn',
                owner: e,
                text: notes[0].text,
                ref: refs.owner(e),
            });
        });
        var rank = { error: 0, warn: 1, info: 2 };
        return out.sort(function (a, b) {
            return rank[a.tone] - rank[b.tone];
        });
    }

    // ----- events ------------------------------------------------------------------

    // cert-manager's own events, newest first. One list across the cluster:
    // the bridge reads every namespace to answer for one anyway.
    function loadEvents(sdk) {
        return sdk.list({ kind: KINDS.events, namespace: '' }).then(function (items) {
            var out = [];
            (items || []).forEach(function (ev) {
                var target = ev.involvedObject || ev.regarding || {};
                var component = (ev.source && ev.source.component) || ev.reportingController || ev.reportingComponent || '';
                var ours = /cert-manager/i.test(component) || String(target.apiVersion || '').indexOf(GROUP) >= 0;
                if (!ours || !APP_KINDS[target.kind]) return;
                out.push({
                    uid: ev.metadata.uid,
                    when: ts(ev.lastTimestamp || ev.eventTime || (ev.series && ev.series.lastObservedTime) || ev.metadata.creationTimestamp) || 0,
                    type: ev.type || 'Normal',
                    reason: ev.reason || '',
                    message: ev.message || ev.note || '',
                    count: ev.count || (ev.series && ev.series.count) || 1,
                    kind: target.kind,
                    appKind: APP_KINDS[target.kind],
                    namespace: target.namespace || ev.metadata.namespace || '',
                    name: target.name || '',
                });
            });
            return out.sort(function (a, b) {
                return b.when - a.when;
            });
        });
    }

    // What an event says, in fewer and plainer words. The object it is about
    // is named beside it, so the words start with a verb.
    function eventText(ev) {
        var m = ev.message || '';
        var q = /"([^"]+)"/.exec(m);
        switch (ev.reason) {
            case 'Issuing':
                if (/renewal was scheduled/i.test(m)) return 'started its scheduled renewal';
                var as = /as (.*)$/.exec(m);
                return as ? 'started issuing: ' + lowerFirst(as[1].replace(/\.$/, '')) : 'started issuing';
            case 'Generated':
                return 'generated a new private key';
            case 'Reused':
                return 'reused its private key';
            case 'Requested':
                return q ? 'asked for a certificate with request ' + q[1] : 'asked for a certificate';
            case 'Issued':
                return ev.kind === 'CertificateRequest' ? 'got its certificate from the issuer' : 'was issued';
            case 'OrderCreated':
                return q ? 'created ACME order ' + q[1] : 'created an ACME order';
            case 'OrderPending':
                return 'is waiting on its ACME order';
            case 'Created':
                var d = /Created Challenge resource "([^"]+)" for domain "([^"]+)"/.exec(m);
                return d ? 'opened a challenge for ' + d[2] : lowerFirst(m);
            case 'Started':
                return 'started solving the challenge';
            case 'Presented':
                var how = /using (\S+) challenge mechanism/.exec(m);
                return 'put up the ' + (how ? how[1] + ' ' : '') + 'challenge';
            case 'DomainVerified':
                var v = /Domain "([^"]+)" verified with "([^"]+)"/.exec(m);
                return v ? 'proved control of ' + v[1] + ' over ' + v[2] : 'proved control of the domain';
            case 'Complete':
                return 'completed';
            case 'CreateCertificate':
                return q ? 'got Certificate ' + q[1] + ' from ingress-shim' : 'got a Certificate from ingress-shim';
            case 'UpdateCertificate':
                return q ? 'had Certificate ' + q[1] + ' updated by ingress-shim' : 'had its Certificate updated';
            case 'cert-manager.io':
                return /approved/i.test(m) ? 'was approved' : lowerFirst(m);
            case 'Failed':
                var retried = /will be retried:\s*(.*)$/.exec(m);
                return 'failed' + (retried ? ' and will be retried: ' + retried[1].replace(/:\s*$/, '') : ': ' + m);
        }
        return lowerFirst(m);
    }

    window.CertManager = {
        KINDS: KINDS,
        APP_KINDS: APP_KINDS,
        ANN: ANN,
        GROUP: GROUP,
        STATES: STATES,
        STATE_ORDER: STATE_ORDER,
        ISSUER_TYPES: ISSUER_TYPES,
        SOON: SOON,
        SECOND: SECOND,
        MINUTE: MINUTE,
        HOUR: HOUR,
        DAY: DAY,
        load: load,
        build: build,
        loadEvents: loadEvents,
        eventText: eventText,
        describe: describe,
        diagnose: diagnose,
        covers: covers,
        errorish: errorish,
        parseDuration: parseDuration,
        nextRetry: nextRetry,
        ref: refs,
        dig: dig,
        isTrue: isTrue,
        condition: condition,
        plural: plural,
        words: words,
        podReady: podReady,
        rankTone: rankTone,
    };
})();
