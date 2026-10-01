# Request to MJU SSO administrator — RAE Attendance System V2

**Application:** RAE Attendance System V2  
**Registered callback (Webhook URL):** `https://raeservice.mju.ac.th/api/v1/auth/sso/callback`  
**Registered sign-in:** `https://sso.mju.ac.th/signin.aspx?cid=<client id>`  
**Registered sign-out:** `https://sso.mju.ac.th/signout.aspx?cid=<client id>`

We are preparing a fail-closed integration. We will **not** enable SSO in production until your answers are documented. We do **not** use the callback query field `ac` as a user identity unless you explicitly define it as the immutable subject (our current policy rejects `ac` as identity).

Please reply in writing (or complete the attached response template).

---

## Questions

1. **After a successful sign-in, what exactly does MJU send to our Webhook URL?**  
   (HTTP method, query parameters, headers, body, redirects.)

2. **What does the query parameter `ac` represent?**  
   (One-time ticket, session reference, opaque token, something else.)

3. **How must our server validate or exchange `ac`?**  
   (Server-to-server call, redirect follow-up, TTL, replay rules.)

4. **Is there a token or ticket exchange endpoint?**  
   If yes: URL, method, request/response shape, authentication.

5. **Is there a userinfo or profile endpoint?**  
   If yes: URL, method, required credentials, field list.

6. **What is the authoritative, immutable user subject we should store long-term?**  
   (Exact field name and where it appears: callback, token response, or userinfo.)

7. **Is email returned, guaranteed, and stable for the same person over time?**  
   How does it relate to the subject in (6)?

8. **Is a client secret or API key required for any step?**  
   If yes: which step, how transmitted, rotation policy.

9. **Is the callback or token payload signed or hashed?**  
   If yes: algorithm, key distribution, verification steps.

10. **Can MJU provide a sanitized sample** (no real user data) of a callback request and any follow-up API response, or an official integration document?

---

## What we will do with your answers

- Fill in [`MJU_SSO_SUBJECT_CONTRACT_RESPONSE_TEMPLATE.md`](./MJU_SSO_SUBJECT_CONTRACT_RESPONSE_TEMPLATE.md)
- Update [`SSO_SUBJECT_CONTRACT_INTEGRATION_CHECKLIST.md`](./SSO_SUBJECT_CONTRACT_INTEGRATION_CHECKLIST.md)
- Implement subject extraction only to match your contract (no guessing)
- Keep SSO disabled until a controlled non-production test passes

Thank you.
