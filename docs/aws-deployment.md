# Proposed AWS deployment · 29 October 2026

**Prepared, not deployed.** No AWS resource, public listener, cloud credential, DNS record or image publication was created by this work. The implementation's product requirements require approval before provisioning: “Provision fresh resources only after the owner approves the target architecture and costs.” See [MultAI.md, section 19](MultAI.md#19-fresh-infrastructure-plan).

## Concrete small-instance proposal

Use one **Amazon Lightsail Linux Small-2GB instance with public IPv4 in Mumbai (`ap-south-1`)**: 2 burstable vCPUs, 2 GB memory and 60 GB SSD. It hosts only synchronization, identity and the private database. Inference and actual project/tool execution stay on the original desktop host. No GPU, high-end CPU, Google compute, managed database, load balancer, NAT gateway, Redis or Kubernetes is included.

| Recurring resource | Included capacity | USD/month before tax |
| --- | --- | ---: |
| Lightsail Linux Small-2GB, public IPv4 | 2 vCPUs, 2 GB RAM, 60 GB SSD, attached public IPv4; Mumbai transfer allowance 1.5 TB | $12.00 |
| Private Lightsail object-storage bundle | 5 GB encrypted-backup storage, 25 GB transfer | $1.00 |
| **Baseline total** | One instance plus one private backup bucket | **$13.00** |

The instance bundle and its public IPv4/storage are one price; they are not extra EC2 line items. Its advertised 3 TB allowance is halved in Mumbai. Prices were checked against the [official bundle table](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html), [Lightsail pricing](https://aws.amazon.com/lightsail/pricing/) and [object-storage FAQ](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-buckets.html). No free trial or credits are assumed.

Use an existing owner-controlled domain with its current DNS provider and an attached static IP. If a new zone is explicitly delegated to Lightsail, DNS within its included allowance and an attached static IP add no baseline fee; an unattached static IPv4 can incur `$0.005/hour`, and snapshots cost extra. Never replace unrelated nameservers or records to add this service. [AWS billing details](https://docs.aws.amazon.com/en_en/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html)

The owner selected **multai.si**, registered at Namecheap. Use the new **api.multai.si** subdomain for this service. Its current custom nameservers are Cloudflare; Namecheap's registrar panel does not manage records under that delegation. The currently available Cloudflare account does not contain this zone. Obtain access to the existing zone before adding the new record; do not replace nameservers or rebuild the website's DNS as a shortcut.

**Excluded:** taxes, new domain registration, transfer/storage overages, optional snapshots, paid support and the desktop owner's chosen inference-provider usage. Set an initial **$15/month AWS alert target before tax**, while understanding that an alert is not a spending cap. Growing beyond 5 GB of backup storage needs review; the script limits each dump to 256 MiB and retains at most seven daily/four weekly named copies. The baseline does not promise capacity for arbitrary team size or sustained traffic.

EC2 would bill compute, EBS and public IPv4 separately. One EC2 public IPv4 alone is about `$3.65` for 730 hours, before compute or disk; its final region/architecture quote needs the AWS calculator. The fixed Lightsail bundle is the proposed first choice for this small service. [VPC IPv4 pricing](https://aws.amazon.com/vpc/pricing/), [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/), [EBS pricing](https://aws.amazon.com/ebs/pricing/)

## Runtime and network shape

```text
Desktop hosts ── HTTPS/WSS :443 ── Caddy ── private HTTP ── collaboration API
                                      :80 ACME/redirect          │
                                                       private PostgreSQL
                                      private encrypted backups ── Lightsail bucket
```

`deploy/compose.production.yaml` provides three independently bounded containers. Only Caddy maps host ports: TCP 443 for HTTPS/WSS and TCP 80 for ACME/HTTPS redirects. PostgreSQL and backend ports have **no host mapping**. Database and API/proxy networks are internal Docker networks; separate egress bridges allow the API's fixed Google identity endpoints and Caddy's certificate authorities. The Compose file does not implement an outbound hostname firewall; tighter host egress policy remains an operator task.

The API runs as UID 1000 with a read-only root filesystem, no Linux capabilities, no-new-privileges, bounded tmpfs, CPU/memory/process limits and only its selected secret mounts. Its final image contains compiled backend code, migration files and locked production dependencies. Desktop assets, native inference runtimes, source profiles, `.env`, tests, TypeScript and provider keys are excluded by a Docker-context allowlist and package guard.

PostgreSQL runs as its unprivileged `postgres` user. The application connects with a separate non-superuser role that owns its migration-created tables. Persistent database and certificate volumes are private to the new Compose project. Caddy runs as UID 10001 on internal high ports with its unnecessary low-port file capability removed. Default access logging is disabled; its runtime log filter removes request URI/headers, and all container logs rotate at three 10 MB files each. PostgreSQL does not log query statements or statement text on errors.

The backend transactionally verifies/applies migration checksums before listening. One service holds a database advisory lock. Restart does not dispatch work: it makes interrupted execution uncertain, pauses affected sessions and invalidates the previous runtime epoch. Readiness distinguishes database availability from `identity: configured_unverified`; real Google consent and native callbacks must pass separately.

Local verification is recorded in [deploy/VERIFICATION.md](../deploy/VERIFICATION.md). It covers actual unprivileged image startup/restart and synthetic encrypted database restoration; it does not establish AWS, public TLS or production Google acceptance.

## Requirements before creating resources

Record the intended AWS account, operator, approved `$13/month` baseline, alert owner, fresh resource identifier and owner-controlled domain. Obtain AWS console/IAM access and DNS-change authorization through the owner's normal login/MFA flow; do not place cloud keys in a chat or repository. Confirm a standard Linux/amd64 small instance matching the quoted bundle at creation time. Keep an inventory using `deploy/resource-inventory.example.json`, saved privately as `resource-inventory.local.json` after filling real IDs.

Authorize only TCP 443/80 from the internet. If SSH administration is used, restrict TCP 22 to the owner's specific current administrator IP, use a fresh key, and keep password/root SSH login disabled. Do not expose PostgreSQL, the API port, Docker API or Caddy administration. Check actual volume encryption behavior in the selected account/instance; the application does not claim that a database volume is encrypted merely because credential files use encryption on desktops.

Create a new private backup bucket in the same region, keep its public-access mode private, and verify unauthenticated access is denied. Prefer Lightsail resource access attached only to this new instance/bucket instead of broad AWS access keys. Do not change unrelated account-wide bucket policies. Configure no automatic snapshots, extra disks, CDN or managed database unless their extra cost is reviewed. [Lightsail bucket permissions](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-understanding-bucket-permissions.html)

Google is used only for sign-in. Configure a fresh production web OAuth client with the exact new callback `https://<collaboration-domain>/v1/auth/google/callback`. Do not enable Google compute, storage or model services. Its client ID/secret remain private server secret files. Changing the domain/client invalidates pending sign-in attempts; existing local-development callback acceptance is not production acceptance.

## Build, transfer and configure after approval

Commit/review one clean source revision first. On the build machine, run:

```sh
bash deploy/scripts/build-images.sh <full-reviewed-source-commit>
```

This builds Linux/amd64 images locally and never pushes them. Capture the resulting image IDs/digests and manifest in the inventory. Transfer the exact private image archive to the approved server through the owner's reviewed secure transport, verify its SHA-256 and load it locally. No registry, upload or cloud resource is selected automatically.

On the server, install the reviewed Docker/Compose version and operator tools (`python3`, `age`, AWS CLI v2 and `sha256sum`) through approved package sources. Keep their package/version/license evidence. Create `/etc/multai` as a private operator-owned directory, then generate independent database passwords and enter fresh Google OAuth values interactively:

```sh
bash deploy/scripts/prepare-secrets.sh /etc/multai/secrets
```

The new secret directory must not exist yet; the helper never replaces existing credentials. Its host directory is mode 0700. Individual read-only files are mode 0444 so the different unprivileged container UIDs can read their explicitly mounted files while other host accounts cannot traverse the private directory. Secrets are not Docker build arguments or Compose environment values. Losing/replacing a database password file does not rotate the existing database password: rotation needs a separate deliberate procedure.

Copy `deploy/.env.example` to an ignored private deployment env file and fill the approved domain, operator contact, images, full source commit and secret directory. Check it without evaluating shell or contacting AWS:

```sh
python3 deploy/scripts/validate-config.py /etc/multai/production.env
docker compose --env-file /etc/multai/production.env -f deploy/compose.production.yaml config --quiet
```

After the approved host, DNS and exact images are ready, explicitly starting that Compose configuration is the publication step. Start the private database/API first, inspect their health, then enable the proxy; validate the actual certificate, OAuth callback, WebSocket replay, role denial and two-client task on the public origin before calling it ready. Build-time validation is not live deployment evidence.

## Backup and restore policy

Generate a new age identity **off the server**, keep the private identity in the owner's private offline vault, and place only its public `age1...` recipient in the backup configuration. age is [BSD-3-Clause licensed](https://github.com/FiloSottile/age/blob/main/LICENSE); verify its packaged version before operating it. AWS CLI uses its [Apache-2.0 license](https://github.com/aws/aws-cli/blob/v2/LICENSE.txt). Client-side age encryption is independent of the bucket's server-side encryption.

After bucket access is explicitly configured, an operator can run:

```sh
bash deploy/scripts/backup.sh /etc/multai/production.env <new-private-bucket> <new-resource-id> <public-age-recipient>
```

The helper streams a consistent `pg_dump` through a 256 MiB bound directly into age encryption; it creates no plaintext dump file. It uploads the encrypted daily file and SHA-256, plus a weekly copy on Sunday UTC. One named copy per day/week is replaced on same-period reruns; bucket versioning is intentionally excluded from the `$1` plan because noncurrent versions would need their own retention/budget. A failed upload exits nonzero; no success is claimed for unknown completion. Only exact resource-scoped dated keys older than seven days/four weeks are eligible for deletion; truncated listings fail closed. Existing unrelated prefixes are untouched.

Saving this configuration does not schedule a job. After a first verified upload and restore, the owner can explicitly enable one daily operator-managed backup schedule with failure alerting. Review it in the same resource inventory. Keep a verified offline copy periodically; an instance with read/write bucket access can also delete bucket contents if compromised, so this low-cost tier is not immutable-ransomware storage.

Download a specific encrypted backup and its `.sha256`, then test on a separate machine with enough memory, using the matching private identity:

```sh
bash deploy/scripts/restore-drill.sh /private/backup.dump.age /private/offline/age-identity.key
```

The drill verifies the encrypted checksum, decrypts only into a disposable network-none PostgreSQL container with no published ports/live volumes, restores the schema, revokes restored account/device/runtime authority, checks migration evidence, and discards the database. It uses a bounded 1 GiB database tmpfs and can require roughly 1.5 GiB RAM, so do not run it on the active 2 GB production host. Failure reports contain no raw SQL, credential or conversation data.

This is an **isolated restore drill**, not a production promotion mechanism. A historical database backup can predate participant revocation or permanent deletion. Public recovery requires reconciling post-backup deletion/revocation evidence and a reviewed original-host recovery policy; blindly promoting the restored snapshot would risk reviving private data/access. That reconciliation is not implemented here. Do not claim production disaster recovery is complete until the matching-key drill and recovery policy have been tested with the actual deployment.

## Remaining live acceptance and teardown

Before publication, verify actual resource ownership/cost, firewall rules, private database reachability, TLS issuance/renewal, fresh Google login, native protocol callbacks, two installed clients, refresh/revocation, process restart with no automatic effects, complete backups and a matching-key restore. Observe memory, CPU burst capacity, disk/WAL/log growth and HTTP rate limits under a small-team load. In particular, a proxy can make clients share one server-side IP rate-limit key unless the backend deliberately uses authenticated scope or a constrained trusted-proxy setting; do not trust arbitrary forwarded headers.

Teardown follows the private inventory: review retention/export needs, stop the service, remove only its new instance/attached static IP/DNS entry/private bucket and retained objects, revoke its selected Google client and backup access, and remove the matching deployment secrets after archival policy is satisfied. Stopping an instance alone does not remove billable disks, snapshots, unused static IPs or object storage. Do not search/delete unrelated resources by a similar name.
