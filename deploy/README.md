# Deploy

Nothing in this directory is applied to the legacy host.

V2 is not deployed. When a later release is approved, the public API prefix is `/api/v1/` only. Do not reuse the legacy mix of `/api/` and `/attendance/api/`.

Local API default is `127.0.0.1:3210`. That avoids the legacy port `3000` and the port `3100`, which is already in use on the legacy host.
