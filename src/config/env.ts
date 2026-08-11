import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Central, validated configuration.
 *
 * Vars are split into two groups:
 *  - CORE: required for the server to boot at all. Missing => fail fast.
 *  - EXTERNAL: third-party integrations wired up in later modules
 *    (S3/EB-04, OpenAI/EB-05, Firebase/EB-03, RevenueCat/EB-10). These are
 *    optional so the server still boots during early development; a warning is
 *    logged when one is missing and the dependent feature will throw a clear
 *    error only when actually used.
 */
const schema = z.object({
  // Server
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // 'inline' runs the BullMQ workers inside the API process (dev / single node);
  // 'separate' runs them only in the dedicated worker entrypoint (src/worker.ts).
  WORKER_MODE: z.enum(['inline', 'separate']).default('inline'),

  // How many scans the analyze worker processes at once. Each scan fires 3
  // parallel OpenAI vision calls (SAMPLES), so peak concurrent OpenAI requests
  // = ANALYZE_CONCURRENCY × 3. Raise to increase throughput, but keep
  // (value × 3) under your OpenAI rate limit (RPM/TPM) and DB pool headroom.
  ANALYZE_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(10),

  // Global cap (across ALL worker replicas, enforced via Redis) on scans the
  // analyze queue processes per minute — a fleet-wide ceiling that protects the
  // OpenAI budget/rate-limit from a queue flood or over-scaled worker pool. Each
  // scan is ~3 vision calls, so effective vision RPM ≈ this × 3. Set 0 to
  // disable the limiter entirely.
  ANALYZE_MAX_PER_MIN: z.coerce.number().int().min(0).default(180),

  // MongoDB connection pool + timeout tuning (per process). The driver default
  // pool is 100, which — multiplied across replicas — can exhaust an Atlas
  // tier's connection cap; 20 is ample for ANALYZE_CONCURRENCY + HTTP traffic.
  // Raise for high-throughput single instances, lower for many small replicas.
  MONGO_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(500).default(20),
  MONGO_MIN_POOL_SIZE: z.coerce.number().int().min(0).default(0),
  // Fail fast instead of hanging when no primary is reachable / a socket stalls.
  MONGO_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
  MONGO_SOCKET_TIMEOUT_MS: z.coerce.number().int().min(1000).default(45000),

  // Days a never-upgraded anonymous-first user (EB-13) is kept before the daily
  // cleanup job purges it via the GDPR cascade.
  ANON_TTL_DAYS: z.coerce.number().int().min(1).default(30),

  // Max eye scans an UNAUTHENTICATED caller may submit per rolling 24h, keyed by
  // client IP. Each scan fans out to several OpenAI vision calls, so this caps
  // anonymous cost-abuse. Registered free users are separately limited to one
  // scan (FREE_SCAN_LIMIT in scan.service). Set 0 to block anonymous scans.
  ANON_SCAN_DAILY_LIMIT: z.coerce.number().int().min(0).default(3),

  // Express `trust proxy` setting — must match how many reverse proxies sit in
  // front of the app, or `req.ip` (the rate-limit key) becomes client-spoofable
  // via X-Forwarded-For. A plain integer is a hop count (e.g. '1' for one proxy);
  // 'true'/'false' toggle full/no trust; anything else is passed through verbatim
  // (e.g. a comma-separated subnet list or 'loopback'). See app.ts.
  TRUST_PROXY: z.string().default('1'),

  // Comma-separated allowlist of browser origins permitted for cross-origin
  // requests (e.g. the admin web panel). Native mobile clients send no Origin
  // header and are always allowed. Empty in production => browser CORS is denied.
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  // Core — required
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // Core — has a safe default so early modules boot before EB-12
  ADMIN_JWT_SECRET: z.string().min(1).default('dev-admin-secret-change-me'),

  // External — optional until their module is built / keys are provisioned
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  // Vision model used for eye-area appearance rating (EB-05/EB-14). Default
  // 'gpt-5.6-sol' — OpenAI's flagship multimodal model, chosen for the fine-grained
  // appearance grading on the high-detail eye crop and for its Structured
  // Outputs support (json_schema, strict) used by the ensemble. Step down to
  // 'gpt-5.6-terra' / 'gpt-5.6-luna' if scans go high-volume and cost-sensitive.
  OPENAI_MODEL: z.string().default('gpt-5.6-sol'),
  // Text-only model for the routine "tips" generator and the AI chat (EB-13).
  // These paths need no vision acuity; 'gpt-5.6-luna' is the cost-efficient
  // GPT-5.6 tier (supports Structured Outputs / Chat Completions) — much
  // cheaper than the vision flagship above for high-volume chat turns.
  OPENAI_TEXT_MODEL: z.string().default('gpt-5.6-luna'),
  // Optional ascending "a,b,c" cutoff overrides for the code-measured LAB metrics
  // (EB-05/EB-14); produced by `npm run calibrate:thresholds`.
  DARK_CIRCLE_THRESHOLDS: z.string().optional(),
  REDNESS_THRESHOLDS: z.string().optional(),
  FINELINES_THRESHOLDS: z.string().optional(),
  RADIANCE_THRESHOLDS: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
  REVENUECAT_WEBHOOK_AUTH: z.string().optional(),
  REVENUECAT_API_KEY: z.string().optional(),

  // First superadmin, seeded via `npm run seed:admin` (EB-12).
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\n❌ Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

export const env = parsed.data;

const DEV_ADMIN_SECRET = 'dev-admin-secret-change-me';

// Fail fast in production if the admin secret was never overridden — otherwise
// admin tokens would be forgeable with a public default.
if (env.NODE_ENV === 'production' && env.ADMIN_JWT_SECRET === DEV_ADMIN_SECRET) {
  // eslint-disable-next-line no-console
  console.error('\n❌ ADMIN_JWT_SECRET must be set to a strong secret in production.\n');
  process.exit(1);
}

// Minimum-strength gate for the JWT signing secrets. The Zod schema only checks
// they're non-empty (so early dev can boot), but a short/guessable HMAC secret
// makes tokens forgeable — so in production we hard-fail on weak or reused
// secrets. Outside production we warn, to keep the failure visible without
// blocking local work.
const MIN_SECRET_LEN = 32;
{
  const weak: string[] = [];
  if (env.JWT_SECRET.length < MIN_SECRET_LEN) weak.push('JWT_SECRET');
  if (env.JWT_REFRESH_SECRET.length < MIN_SECRET_LEN) weak.push('JWT_REFRESH_SECRET');
  if (env.ADMIN_JWT_SECRET.length < MIN_SECRET_LEN) weak.push('ADMIN_JWT_SECRET');

  // Reusing one secret for both access and refresh tokens collapses the
  // secret/type separation the two-secret design relies on.
  const reused = env.JWT_SECRET === env.JWT_REFRESH_SECRET;

  if (weak.length > 0 || reused) {
    const problems = [
      weak.length > 0 ? `must be at least ${MIN_SECRET_LEN} chars: ${weak.join(', ')}` : '',
      reused ? 'JWT_SECRET and JWT_REFRESH_SECRET must differ' : '',
    ]
      .filter(Boolean)
      .join('; ');
    if (env.NODE_ENV === 'production') {
      // eslint-disable-next-line no-console
      console.error(`\n❌ Weak JWT secret configuration — ${problems}.\n`);
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.warn(`⚠️  Weak JWT secret configuration — ${problems}. Required in production.`);
  }
}

// Warn (don't crash) in production if the datastore connection strings don't use
// an encrypted scheme. We only warn — some secure transports are legitimately
// non-TLS (e.g. Railway's private IPv6 network uses redis://), so hard-failing
// here would break valid deployments. Review the warning against your topology.
if (env.NODE_ENV === 'production') {
  const mongoTls =
    /^mongodb\+srv:\/\//.test(env.MONGODB_URI) || /[?&](tls|ssl)=true/i.test(env.MONGODB_URI);
  const redisTls = /^rediss:\/\//.test(env.REDIS_URL);
  const insecure: string[] = [];
  if (!mongoTls) insecure.push('MONGODB_URI (expected mongodb+srv:// or tls=true)');
  if (!redisTls) insecure.push('REDIS_URL (expected rediss://)');
  if (insecure.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `⚠️  Datastore connection(s) not using TLS in production: ${insecure.join(', ')}. ` +
        `Ensure traffic is on a trusted private network or switch to a TLS scheme.`,
    );
  }
}

/** Warn (don't crash) about external integrations that aren't configured yet. */
const externalChecks: Array<[string, unknown]> = [
  ['AWS_ACCESS_KEY_ID', env.AWS_ACCESS_KEY_ID],
  ['AWS_SECRET_ACCESS_KEY', env.AWS_SECRET_ACCESS_KEY],
  ['S3_BUCKET', env.S3_BUCKET],
  ['OPENAI_API_KEY', env.OPENAI_API_KEY],
  ['FIREBASE_SERVICE_ACCOUNT', env.FIREBASE_SERVICE_ACCOUNT],
  ['REVENUECAT_WEBHOOK_AUTH', env.REVENUECAT_WEBHOOK_AUTH],
];

const missingExternal = externalChecks.filter(([, v]) => !v).map(([k]) => k);
if (missingExternal.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(
    `⚠️  External integrations not yet configured: ${missingExternal.join(', ')}. ` +
      `Dependent features will error only when used.`,
  );
}

export const isProd = env.NODE_ENV === 'production';
