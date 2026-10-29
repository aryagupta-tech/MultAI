# Fresh cloud resources

## Google · sign-in only

Created 29 October 2026 through the owner's signed-in Google Chrome session:

- Project: **MultAI Development**
- Project ID: `multai-dev-20261029-7c3a`
- Project number: `1010754660034`
- Organisation: none
- Billing: console explicitly verified **“This project has no billing account”** and **“This project is not linked to a billing account.”**
- Purpose: Google OAuth/OpenID Connect sign-in only. No Google hosting, compute, storage or managed database was provisioned; do not link billing to this project.
- OAuth branding: **MultAI**, external testing, one owner-selected Google test account.
- Web OAuth client: **MultAI Development Backend**, created and configured with exactly `http://127.0.0.1:4310/v1/auth/google/callback`; no browser JavaScript origins or Google-agent access.
- Backend requests basic `openid profile` sign-in. Newly issued credentials are in the ignored local `.env` with mode `0600`; no credential value belongs in this inventory.
- Local backend readiness verified: database ready, identity `configured_unverified`, inference `host_local`. Identity readiness is a configuration probe, not live attestation.
- Real Google sign-in succeeded in the packaged macOS app on 29 October 2026: the owner confirmed success; local database metadata showed one Google user, one consumed Google flow and one active Google sign-in. Real OS `multai-dev://` delivery and the service-scoped OS-encrypted credential write are verified. Cold restart/decryption and live refresh remain pending; see [verification](verification.md). No credential values are recorded here.

## AWS · deployment preparation

The owner authorizes AWS for backend hosting, with modest CPU resources. AWS console access is authenticated. The instance form is prepared for one Ubuntu 24.04 LTS, general-purpose dual-stack **Small-2GB** instance in Mumbai, named `multai-collab-dev-20261029`; automatic paid snapshots are off. No instance or backup bucket has been created. The reviewed proposal is `$12/month` for the instance plus `$1/month` for a private backup bucket before tax, domain and overage costs; see [the deployment plan](aws-deployment.md).

The owner supplied the existing Namecheap-registered **multai.si** domain. The intended backend hostname is **api.multai.si**, preserving the website's apex address. Public DNS and the signed-in Namecheap settings both confirm custom Cloudflare nameservers. The available Cloudflare account does not contain this zone. No DNS record or nameserver was changed; zone access and the final resource/cost approval remain pending.

Record instance identity, region, resource tags and recurring cost here only after actual provisioning and verification. Do not describe a prepared deployment as running.
