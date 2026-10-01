# Questions for the MJU SSO admin

Client: RAE Attendance System V2  
Client ID: `a46a0b5374b4404a9f71a2397dcab283`  
Webhook: `https://raeservice.mju.ac.th/api/v1/auth/sso/callback`  
After signout: `https://raeservice.mju.ac.th/attendance-v2/`

Please answer from the registered client, not from the older Attendance client.

1. After a successful sign-in, what exactly is sent to the webhook URL? (method, query string, form body, or redirect)
2. Which query or form field names are returned?
3. Is there a ticket, code, or token exchange after that redirect?
4. Is there a token endpoint? If yes, what is the URL and the request shape?
5. Is there a userinfo endpoint? If yes, what is the URL and the request shape?
6. Is a client secret or API key required? If yes, which request uses it?
7. Which field is the authoritative user identity?
8. Is email always present? What is the claim or field name?
9. Is the callback signed or hashed? Which field carries the signature, and how is it verified?
10. Is there a test account, sandbox, or sample callback payload we can use without a production password?
