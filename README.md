# cert-manager for K8s Dockside

A plugin for the [K8s Dockside](https://github.com/k8sdockside/k8sdockside)
desktop app that shows [cert-manager](https://cert-manager.io/) as what it looks
after: TLS certificates, and when each one runs out.

It answers the questions you have when TLS breaks, in plain words rather than as
rows of custom resources: which certificate expires next, which renewals are
stuck, and exactly where — the certificate request, the ACME order or the
challenge — and why.

Plain HTML and script, no build step: the repository is the plugin.

Needs **K8s Dockside 0.0.15 or newer** and cert-manager in the cluster.
Prometheus is optional, for the charts.

## What it shows

**Overview** — replaces the app's generated overview page.

- A verdict ("All 23 certificates are valid", "2 certificates are failing to
  renew", "grafana-tls expires in 5 days"), a sentence on the state of things,
  and cert-manager's own components (controller, webhook, cainjector) as dots.
- A **countdown dial** to the next moment that matters: the certificate's whole
  life drawn as one turn of a clock face, what is left of it in colour, the
  renewal as a notch, a live countdown under it, and what comes up after.
- An **expiry runway**: every certificate's validity on one 90-day timeline,
  with today, the next two weeks shaded, and a ◆ where cert-manager renews it.
  Hover a row for the details, click to open it.
- **Issuance**: every certificate that is not ready or is being issued, drawn
  as steps — Certificate → CertificateRequest → ACME Order → Challenge(s), or
  Certificate → request → issuer for CA, self-signed, Vault and Venafi issuers.
  The step that is stuck is marked, with cert-manager's own status text and a
  plain reading of it ("the CA fetched http://blog.example.com/.well-known/…
  and got a 404 …"). After a failed attempt it says when cert-manager will try
  again. Anything else worth a look — an issuer that is not ready, an Ingress
  whose annotation names an issuer that does not exist, a host the certificate
  does not cover, certificates from a Let's Encrypt staging server — is listed
  under it.
- **Issuers**: each Issuer and ClusterIssuer as a card — ACME (with the CA, a
  staging badge, the account email and how it proves control: HTTP-01 through
  which ingress class, DNS-01 through which provider), CA, self-signed, Vault
  or Venafi — whether it is ready, and the certificates that depend on it.
- **Recent activity** from cert-manager's events, in plain words.
- **History** from the cluster's Prometheus when there is one — certificates
  by Ready condition, time to the soonest expiry, ACME requests by status — and
  a quiet note when there is not.
- When the cluster does not have cert-manager, or cannot be reached, it says
  which, and which of the kinds it looked for are served.

**Certificates** — the working page.

- A calendar of the next thirteen weeks, a square a day, filled where a
  certificate expires and dotted where one renews. Click a day to see only
  those.
- Every certificate as a row with its validity bar, time left and what it is
  doing, grouped by issuer, by namespace, or simply by what runs out first.
  Search by name, host, Secret name or issuer; filter by *Expiring soon*,
  *Not ready*, *Issuing* or *Healthy*.
- Click a certificate for the inspector: its validity and dates, the issuance
  chain and where it is stuck, its DNS names, issuer, Secret (by name only),
  private key, what it asks for, conditions, recent events, which Ingresses
  and Gateways it serves — and the command to renew it by hand:
  `cmctl renew <name> -n <namespace>`.
- With the issuer picker you can switch a certificate to another issuer. A
  certificate made by ingress-shim is changed on its Ingress's annotation
  instead, since ingress-shim would undo a change to the Certificate itself.

**Panels in detail views**

- **Certificate** — time left, the validity bar, where it comes from, and the
  issuance chain when it is being issued or stuck.
- **Ingress** and **Gateway** — "this Ingress's TLS is healthy", or what is
  wrong with it: which hosts go to which Secret, which Certificate keeps that
  Secret filled and how it stands, hosts the certificate does not cover, and
  whether the issuer the `cert-manager.io/cluster-issuer` or
  `cert-manager.io/issuer` annotation names exists and is ready. An Ingress
  cert-manager does not manage can be handed to it, one with a broken issuer
  pointed at a working one, and one without TLS served over HTTPS.
- **Issuer / ClusterIssuer** — what it is, whether it is ready and why not,
  and every certificate that depends on it.
- **CertificateRequest, Order, Challenge** — the whole chain the object is
  part of, with it ringed, and where that chain is stuck.

**Tables** for Certificates, CertificateRequests, Issuers, ClusterIssuers,
ACME Orders and Challenges, and cert-manager's own pods.

## There is no Renew button

cert-manager renews a certificate on demand by setting its `Issuing` condition,
which is written through the status subresource. A plugin can only ask for a
merge patch of an object, so the pages show the `cmctl renew` command as text to
select and paste instead of pretending to offer a button.

## Installing

In K8s Dockside, go to **Settings → Plugins**. cert-manager is in the list of
known plugins with an **Install** button, and the sidebar suggests it for any
cluster that runs cert-manager. You can also use **From a repository** with
either of these addresses:

```
https://github.com/k8sdockside/certmanager.git
git@github.com:k8sdockside/certmanager.git
```

The app clones it into its plugins folder, and the plugin's card gets an
**Update from repository** button.

To work on it, clone it anywhere and add the folder that *contains* it with
**Settings → Plugins → Watch another folder**. Press **Reload** after changing
`plugin.json`; files under `ui/` are read fresh whenever a view is opened.

## Checking it

The app checks the plugin when it loads it. To run the same checks without the
app, for example in CI:

```
go run github.com/k8sdockside/k8sdockside/cmd/plugincheck@main .
```

`.github/workflows/check.yml` does this on every push.

## What it reads, and what it never does

The pages read, through the app's bridge and only in the cluster of the tab they
are in:

- Certificates, CertificateRequests, Issuers and ClusterIssuers
  (`cert-manager.io`), and ACME Orders and Challenges (`acme.cert-manager.io`)
  where the cluster has them
- Ingresses, and Gateways where the Gateway API is installed
- cert-manager's own pods, by `app.kubernetes.io/instance=cert-manager` or by
  what each component calls itself
- Events, filtered to cert-manager's own
- The plugin's charts, from the Prometheus the app finds for the cluster

**It never reads Secrets.** It does not declare them, and the app would refuse
them if it did. Where a Secret matters — the one a certificate is written to,
the one an Ingress serves — only its name is shown, taken from the Certificate
or the Ingress.

The only changes it can ask for are the issuer controls above: an Ingress's or
Gateway's cert-manager annotations (and, to serve an Ingress over HTTPS, its
`spec.tls`), or a Certificate's `spec.issuerRef`. The app shows every change to
you before it is made, and applies it only when you say so.

## Charts

The charts assume cert-manager's metrics are scraped with their own `namespace`
and `name` labels — `honorLabels: true` on the ServiceMonitor. If yours show
`exported_namespace` instead, copy this plugin and change the two per-certificate
queries in `plugin.json`.

## Layout

```
plugin.json          the manifest: kinds, views, cards, charts, panels, links
ui/
├── model.js         reads everything once per poll and works it out
├── kit.js           shared drawing: validity bars, the chain, events, icons
├── certmanager.css  one stylesheet, on the app's theme tokens
├── overview.html    the overview                 → overview.js
├── index.html       the Certificates page        → board.js
├── certificate.html the Certificate panel        → certificate.js
├── tls.html         the Ingress and Gateway panel → tls.js
├── issuer.html      the Issuer panel             → issuer.js
└── chain.html       the request/order/challenge panel → chain.js
```

See the app's [plugin documentation](https://github.com/k8sdockside/k8sdockside/blob/main/docs/plugins.md)
for the format.
