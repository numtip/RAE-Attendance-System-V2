# MJU SSO subject contract — administrator response

**Application:** RAE Attendance System V2  
**Date received:** ____________________  
**Respondent (name / role):** ____________________  
**Contact:** ____________________

Do not paste live secrets, real user ids, or raw callback `ac` values into git. Store sensitive samples in an operator-controlled vault; reference an internal ticket id below.

---

| Field | MJU answer |
|---|---|
| **Subject field** | (Exact claim name and JSON/query path) |
| **Subject stability** | (Immutable for account lifetime? Format? Reassignment rules?) |
| **`ac` meaning** | |
| **Validation / exchange of `ac`** | (Steps, endpoints, TTL, replay protection) |
| **Token endpoint** | (URL, method, auth, or “none”) |
| **Userinfo endpoint** | (URL, method, auth, or “none”) |
| **Client secret** | (Required yes/no; which step; rotation) |
| **Callback signature** | (Algorithm, header/field name, or “none”) |
| **Email semantics** | (Returned? Stable? Relation to subject?) |
| **Sample payload** | (Reference id or description of sanitized sample location — not raw PII in git) |
| **Notes** | |

---

## Post-processing (V2 operators)

- [ ] Answers reviewed by two operators  
- [ ] [`SSO_SUBJECT_CONTRACT_INTEGRATION_CHECKLIST.md`](./SSO_SUBJECT_CONTRACT_INTEGRATION_CHECKLIST.md) updated (CONFIRMED / UNKNOWN)  
- [ ] [`MJU_SSO_SUBJECT_EVIDENCE_PACK.md`](./MJU_SSO_SUBJECT_EVIDENCE_PACK.md) appendix updated if needed (docs only)  
- [ ] `SSO_SUBJECT_CONTRACT_CONFIRMED=true` **not** set until extraction code matches written contract  
- [ ] HTTP callback wiring **not** enabled until separate approved change  

**Internal reference / ticket:** ____________________
