# OAuth privacy boundary

The privacy requirement is that persisted application data must not give the host
operator credentials to Google Drive. OAuth access, refresh, and identity tokens
must not be written to D1, KV, Durable Object storage, Workflow parameters or
results, browser storage, or application logs. AWS temporary credentials must not
be persisted either: a Google identity token can authorize access to the user's
optional S3 backup.

Short-lived Google credentials belong in browser memory. A request may pass them
to the backend for an operation the user authorizes. The backend may use them in
request memory and synchronous service calls, but may persist only session and
sync metadata. A session cookie or a database dump alone must not authorize a
Drive operation. Server-side refresh tokens are no longer part of this design.

Session storage does not retain Google email addresses. The session endpoint reads
the email for display from the verified request-scoped identity token. RISC events
with a Google subject revoke matching sessions; email-only events cannot be mapped
without retaining an email index and receive a retryable error. Migration 0004
clears existing D1 emails; scheduled cleanup removes legacy KV email index keys.
Historical backups and logs require separate retention and deletion review.

Reloading or closing the page discards its credentials. Expired tokens require
another Google authorization. S3 work advances while the app is open and the
user's authorization remains valid; progress metadata can survive a pause, but
credentials cannot be placed in a durable job to keep it running unattended.

Diary text still passes through the backend. This change is not end-to-end
encryption. An operator who can alter the running backend or frontend can capture
credentials or content during an authorized operation. The public GitHub source
and deployment commit provide transparency, not a cryptographic proof that the
running code is identical. Protecting against a malicious code publisher requires
an independently trusted client distribution mechanism.

## Diagnostics and deployment checks

Application logs and persisted error summaries must not contain diary text,
OAuth credentials, AWS temporary credentials, request bodies, or raw provider
errors. Search requests carry their query in the request body rather than the
application URL. Authentication and API responses containing private data must
not be cached. Do not add sensitive values to logs, traces, error reports, or
Workflow step outputs. Keep error summaries to fixed text or bounded HTTP status.

CI's `npm run test:privacy` exercises selected D1, KV, Durable Object, browser,
request and diagnostic boundaries with sentinel values. It is a regression check,
not proof that all code paths or provider configurations comply. Before release,
review Pages and Workers invocation logs, query-string and header capture,
traces, Logpush, Tail Workers, analytics, and any third-party error reporting in
the actual Cloudflare account. In particular the OAuth callback URL carries an
authorization code and state: verify that URLs and credentials are not retained
or exported by those settings. Do not use real user tokens or diary text in the
review. Audit and remediate any historical logs, backups, or deployments separately;
source changes cannot erase them. Document the settings and repeat this review
when observability or hosting configuration changes.

## Existing credentials and rollout

Removing a token from a live database does not revoke its Google authorization.
Previously stored tokens can remain in KV, exported backups, D1 Time Travel,
old deployments, or other historical copies. A deployment must not claim those
credentials are inaccessible merely because a migration cleared live rows.

The production release remains gated on real Google and S3 staging acceptance.
The staging deployment is a rehearsal; it does not establish that production
credentials have been invalidated.

Before declaring the production migration complete:

1. Rehearse Google authorization, access to preexisting diary files and the folder,
   two tabs, saves, account switching, logout, and S3 pause/resume on staging. Use a
   dedicated account and isolated S3 target. Check the existing S3 role's Google
   audience and subject binding; changing OAuth clients can change that audience.
2. Freeze the old Pages/Worker deployments, scheduled jobs, and Workflow consumers
   and producers during the cutover. Prevent automatic or manual rollback to code
   that can use or write persistent credentials.
3. **Before applying migration 0002 to production**, invalidate the old Google
   grants. Prefer revoking the existing grants while retaining the current OAuth
   client and project. A controlled one-time process must read legacy D1 session
   payloads and legacy KV `session:*` records in memory, extract the refresh tokens
   (or access tokens where no refresh token exists), and POST each credential to
   `https://oauth2.googleapis.com/revoke`. Do not export the database or write
   credentials, response bodies, or request bodies to a file, log, trace, or CI
   artifact. Record aggregate counts and sanitized outcomes only. Stop on unresolved
   failures; do not silently discard the only live records needed for revocation.
4. Allow for Google's revocation propagation, and verify representative old refresh
   tokens fail to refresh and old access tokens fail a Drive request. Google says
   revocation applies to that user's grants for the **Google Cloud project**, across
   its OAuth clients; rehearse without revoking a production user's grant from a
   staging test. Clearing a session or rotating a client secret is not revocation.
5. Apply migration 0002 to tombstone old D1 sessions, deploy the metadata-only code,
   disable legacy imports, and remove credential-bearing KV records and exports.
   Reauthorize with the existing client and verify access to preexisting Drive
   content plus S3. A new client/project must not be substituted without verifying
   existing Drive file access and updating the user's S3 audience configuration.
6. Treat D1 Time Travel and exports as historical credential-bearing copies. Restrict
   access and never use them as a credential rollback. Keep them restricted until
   expiry/deletion, and reapply the metadata-only migration before serving a restored
   database. KV deletion can propagate asynchronously; it is cleanup, not an instant
   credential-invalidation boundary.

Do not use OAuth-client deletion as the default revocation method. Retiring a client
has broader consequences and is not evidence that every previously issued access
token has become unusable. Verify invalidation through the applicable Google OAuth
service and preserve the existing client unless its replacement has been rehearsed.

If migration 0002 already ran before revocation, do not restore Time Travel over
production to recover the lost credential payloads. Use an authorized isolated copy
if one exists, or have account owners revoke access in Google Account permissions.
Block legacy runtimes throughout; access-token expiry alone does not invalidate a
still-valid refresh token. Never claim a historical copy is safe merely because the
live database has been scrubbed.

Google sign-in and consent must be completed by the account owner. Operators must
not request passwords or copied OAuth tokens for the acceptance test. Production
revocation and rollout proceed only after staging acceptance and a verified
revocation mechanism; this document does not mean those operations have run.

### Historical S3 credentials

Google OAuth grant revocation must not be treated as revoking already-issued Google
identity JWTs or AWS STS credentials. Treat an old identity JWT as potentially usable
at AWS until its signed expiry. The app requests STS sessions of up to 12 hours.
Stop legacy issuance and account for the last possible session issuance before
waiting out that duration. If immediate invalidation is required, the AWS role
owner must use the documented role-session revocation or permissions controls;
this affects other active users of the role and requires separate coordination.
Changing only the role's maximum future session duration does not shorten an
already-issued session. No AWS role or session is changed by this source release.

References: [Google OAuth grant revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke),
[Drive authorization scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[KV deletion](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/),
[Google ID-token claims](https://developers.google.com/identity/openid-connect/openid-connect),
[AWS STS session duration](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html),
[AWS role-session revocation](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html),
[Google's browser token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model),
[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
[D1 retention limits](https://developers.cloudflare.com/d1/platform/limits/).
