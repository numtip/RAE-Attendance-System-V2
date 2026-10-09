# SSO live probe plan

Superseded by the shorter MVP document: see [`SSO_MVP.md`](./SSO_MVP.md) ("Start testing with the real MJU login") for the flow and the shortest path, and [`SSO_PROTOCOL_EVIDENCE.md`](./SSO_PROTOCOL_EVIDENCE.md) for what is CONFIRMED / INFERRED / UNKNOWN and the questions for MJU IT.

Approvals still required before any probe against a real MJU or a non-local host: MJU written answers; a test callback URL registered for the client; secrets provisioned by their owner (client secret if required, HMAC key, JWT secret); migration approval for the test database; deploy approval if the host is not local; consent of the named test account owner; SSH approval for any VPS inspection. Nothing here is implied approved.
