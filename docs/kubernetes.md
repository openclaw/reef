# Kubernetes relay

The Node relay implements the same Reef `/v1/` API and security rules as the Cloudflare relay. Existing Reef-enabled OpenClaws only need their `relayUrl` changed. PostgreSQL replaces D1 and Durable Object storage; PostgreSQL `LISTEN/NOTIFY` carries cross-pod WebSocket notifications while the durable queue remains in tables.

## Requirements

- Kubernetes 1.27 or newer
- PostgreSQL 14 or newer
- An SMTP server
- A TLS-enabled Ingress
- A container image built from `services/relay/Containerfile`

Every OpenClaw must persist its own Reef key, replay, and audit state. All participating handles must use the same relay URL. Reef v1 remains pairwise; it does not implement group rooms or broadcast.

## Build

Build from the repository root:

```sh
podman build -f services/relay/Containerfile -t registry.example.com/reef-relay:VERSION .
podman push registry.example.com/reef-relay:VERSION
```

## Configure

Create a Secret containing the PostgreSQL URL and SMTP password:

```sh
kubectl create secret generic reef-relay-secrets \
  --from-literal=database-url='postgres://USER:PASSWORD@postgres.example.com:5432/reef?sslmode=require' \
  --from-literal=smtp-password='SMTP_PASSWORD'
```

Create a values file:

```yaml
image:
  repository: registry.example.com/reef-relay
  tag: VERSION

publicOrigin: https://reef.example.com
emailFrom: hello@reef.example.com
canonicalSiteHost: reef.example.com

database:
  existingSecret: reef-relay-secrets
  secretKey: database-url

smtp:
  host: smtp.example.com
  port: 587
  user: reef
  existingSecret: reef-relay-secrets
  passwordKey: smtp-password

ingress:
  host: reef.example.com
  tlsSecret: reef-relay-tls
```

Install the chart:

```sh
helm upgrade --install reef deploy/helm/reef-relay --namespace reef --create-namespace -f values.yaml
```

The migration Job runs before installs and upgrades. The cleanup CronJob deletes expired ciphertext, acknowledgements, sessions, codes, and replay records. Relay pods are stateless and can be replaced without losing queued messages.

## OpenShift

The image and chart do not require a fixed UID, root, added Linux capabilities, or a writable root filesystem. They are compatible with OpenShift's restricted security context. Kubernetes Ingress objects are supported; an OpenShift Route may be used instead when preferred. Set the router timeout high enough for long-lived WebSocket connections.

### Temporary managed-proxy workaround

Some OpenClaw deployments enforce outbound traffic through an HTTP proxy and
set `OPENCLAW_PROXY_ACTIVE=1`. If the managed policy does not accept matching
`NO_PROXY` entries as direct-route exceptions, an allowlisting proxy can return
`403` when Reef connects to an in-cluster relay:

```text
Proxy response (403) !== 200 when HTTP Tunneling
```

For affected deployments:

1. Allow the exact relay hostname, such as
   `reef-reef-relay.reef.svc.cluster.local`, as a no-credential passthrough in
   the proxy.
2. On default-deny clusters, add a namespace-scoped NetworkPolicy allowing the
   proxy pods to reach only the Reef relay pods on TCP 8080.
3. Restart the proxy and OpenClaw workloads, then verify the Reef channel is
   connected and send a message through the running gateway.

No cluster-scoped resource is required. Reef payloads remain end-to-end
encrypted, and the passthrough must not inject credentials.

If OpenClaw later accepts matching `NO_PROXY` entries as part of its managed
proxy policy, the proxy allowlist and its supplemental NetworkPolicy are not
needed. A default-deny cluster may still require a separate direct-egress rule
from the OpenClaw pods to the Reef relay. This is a possible upstream direction,
not a committed change.

## Configuration

The server consumes these environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection URL |
| `PUBLIC_ORIGIN` | yes | Public HTTPS origin used in magic links |
| `EMAIL_FROM` | no | Magic-link sender address |
| `SMTP_HOST` | production | SMTP host |
| `SMTP_PORT` | no | SMTP port; defaults to `587` |
| `SMTP_SECURE` | no | Set to `1` for implicit TLS |
| `SMTP_USER` | no | SMTP username |
| `SMTP_PASSWORD` | no | SMTP password |
| `TRUST_PROXY_HEADERS` | no | Trust the first `X-Forwarded-For` value when set to `1` |
| `SITE_REDIRECT_HOSTS` | no | Comma-separated hosts redirected to the canonical host |
| `DEV_MODE` | no | Logs and returns magic links; never enable in production |

Health endpoints are `/livez` and `/readyz`.
