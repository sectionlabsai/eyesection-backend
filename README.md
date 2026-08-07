# eyesection-api

Backend for **EyeSection** — an AI eye-area aesthetics & eye-comfort wellness app.

> **Cosmetic & wellness only.** This service never diagnoses, names, or screens
> for any eye/vision condition. GPT-4o Vision classifies into discrete levels;
> all scores are computed in code.

## Stack
Node.js · Express · TypeScript · MongoDB (Mongoose) · Redis (BullMQ) · S3 · Firebase Admin · OpenAI (GPT-4o Vision) · RevenueCat

## Getting started
```bash
cd server
npm install
cp .env.example .env      # then fill in the values
npm run dev               # ts-node-dev with reload
curl localhost:4000/health
```

Only the **core** vars (`MONGODB_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `REDIS_URL`)
are required to boot. External integration keys (AWS/OpenAI/Firebase/RevenueCat)
can be filled in later — the server warns about missing ones at startup and the
dependent feature only errors when actually used.

## Scripts
| Script | Purpose |
|--------|---------|
| `npm run dev` | Dev server with reload |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run compiled server |
| `npm run lint` | ESLint |
| `npm run seed:iris` | Seed the iris-colour reference collection |
| `npm run seed:exercises` | Seed the relaxation exercise catalog |
| `npm run seed:admin` | Create the first superadmin (env-driven) |

## Module progress
See [`../BACKEND_IMPLEMENTATION.md`](../BACKEND_IMPLEMENTATION.md) for the full EB-01…EB-13 plan.

- [x] **EB-01** Project setup, Express & TypeScript
- [x] **EB-02** MongoDB schemas & iris colour seed
- [x] **EB-03** Auth, JWT, Firebase & rate limiting
- [x] **EB-04** S3 storage, Sharp & BullMQ + retention
- [x] **EB-05** Eye appearance analysis pipeline (LAB + GPT-4o)
- [x] **EB-06** Freshness score & iris colour engine
- [x] **EB-07** Comfort score & habits engine
- [x] **EB-08** Break coach & reminder engine
- [x] **EB-09** Exercises, progress & reports
- [x] **EB-10** Subscriptions via RevenueCat
- [x] **EB-11** GDPR & notifications
- [x] **EB-12** Admin API
- [x] **EB-13** Anonymous session, profile & notification prefs

## API (key routes)
Not exhaustive — see [`../BACKEND_IMPLEMENTATION.md`](../BACKEND_IMPLEMENTATION.md) for the full surface (comfort, coach, exercises, progress, reports, subscription, consent, gdpr, devices, admin).

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/health` | — | Liveness |
| POST | `/auth/register` | — | email + password (min 8) |
| POST | `/auth/login` | — | generic 401 on failure |
| POST | `/auth/social` | — | Firebase idToken (google/apple) |
| POST | `/auth/anonymous` | — | mint an anonymous-first session (tokens + user) |
| POST | `/auth/upgrade` | Bearer | attach email/social to current anon user; preserves `_id` |
| POST | `/auth/refresh` | — | rotate access token |
| POST | `/auth/forgot-password` | — | always 200 (no email leak) |
| POST | `/auth/reset-password` | — | token + new password |
| GET | `/auth/me` | Bearer | current user |
| PATCH | `/account/profile` | Bearer | persist quiz/profile (`goal`, `careProducts`, `baselineComfort`, `concerns`, `screenProfile`, …) |
| PATCH | `/account/notifications` | Bearer | update `notificationPrefs` (toggles, quiet hours, timezone) |
| DELETE | `/account` | Bearer | GDPR account deletion (re-auth) |
| POST | `/scans/upload` | optional | base64 `front` + optional `closeup` + `geometry` |
| GET | `/scans/:id` | optional | signed thumbnail URLs only |
| GET | `/exercises` | optional | catalog; premium routines locked (no steps) for free users |
| POST | `/coach/exercise-session` | Bearer | log a session; validates id + premium |
| GET | `/coach/streak` | Bearer | current daily-engagement streak |

Auth routes (incl. `/auth/anonymous`, `/auth/upgrade`) are limited to 10/min/IP; the rest of the API to 100/min/IP.
