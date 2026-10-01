# Architecture

```text
browser
  -> Vue 3 client
  -> /api/v1/*
  -> Express app
       routes
       controllers
       services
       repositories
       MariaDB (existing production schema, later, read through a reviewed connection)
```

## Backend

- `backend/src/app.js` builds the Express app.
- `backend/src/server.js` binds `127.0.0.1` and port `3210` by default. On the legacy host, `3000` is the old attendance port and `3100` is already taken by another service.
- `backend/src/api/v1` is the only HTTP namespace.
- Controllers, services, and repositories are reserved directories. Release 1 routes other than health return `501`.

## Frontend

Vue 3, Vite, and TypeScript. The bootstrap screen does not call the legacy API.

## What is intentionally absent

- No copy of the legacy tree.
- No Docker runtime of `docker-raeserver-attendance-api`.
- No production nginx change.
- No database driver connection in this bootstrap. Config names exist so a later release can connect without inventing a second schema first.

## Response envelope

Success:

```json
{ "success": true, "data": {}, "message": "API is running" }
```

Failure:

```json
{ "success": false, "error": { "code": "NOT_IMPLEMENTED", "message": "..." } }
```

`GET /api/v1/health` uses the success envelope. Reserved routes use `NOT_IMPLEMENTED`. Unknown paths use `NOT_FOUND`.
