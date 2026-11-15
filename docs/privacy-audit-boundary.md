# Privacy audit boundary

`npm run test:privacy` checks selected persistence, migration, diagnostic and request boundaries. It runs in CI. Its passing result does not establish that a Cloudflare administrator cannot inspect user data.

The application sends the unlocked vault key and Google access token to its Cloudflare API on authenticated requests. The API uses the key to open encrypted account metadata and uses the token to access Drive; diary content and search terms also pass through the API. A storage-only snapshot is a different threat from access to request processing. An administrator who can change the deployed code could capture these values or deliver modified browser code. Encryption at rest and tests of the current code cannot prevent that. The privacy test documenting the key's ability to open metadata is an exposure regression record, not a security guarantee.

The tests use simulated data and do not inspect production configuration, logs, historical backups, account permissions, or deployed code. Review those separately. Preventing an active deployment administrator from reading content requires a different trust architecture, including client-side encryption and a trustworthy way to deliver verified client code; encrypting storage alone is insufficient.
