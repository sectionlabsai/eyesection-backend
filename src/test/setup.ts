/**
 * Loaded via `--require` before any test file so config/env validates against a
 * known, dependency-free configuration. Values are set on process.env FIRST;
 * dotenv (called inside config/env) does not override already-set vars, so these
 * win over any local .env. No test in this suite opens a real DB/Redis/S3/network
 * connection — these values only need to satisfy the env schema.
 */
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI ??= 'mongodb://localhost:27017/eyesection-test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_SECRET ??= 'test-jwt-secret';
process.env.JWT_REFRESH_SECRET ??= 'test-jwt-refresh-secret';
process.env.ADMIN_JWT_SECRET ??= 'test-admin-secret';
// Non-empty allowlist forces the strict CORS branch regardless of NODE_ENV.
process.env.CORS_ORIGINS ??= 'https://admin.eyesection.com';
