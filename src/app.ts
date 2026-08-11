import express, { Application, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env';
import { pingDB } from './config/db';
import { pingRedis } from './config/redis';
import { buildCorsOptions } from './config/cors';
import { requestId } from './middleware/requestId';
import { errorHandler, notFoundHandler } from './middleware/error';
import { defaultRateLimit } from './middleware/rateLimit';
import authRoutes from './routes/auth.routes';
import scanRoutes from './routes/scan.routes';
import comfortRoutes from './routes/comfort.routes';
import coachRoutes from './routes/coach.routes';
import chatRoutes from './routes/chat.routes';
import exerciseRoutes from './routes/exercise.routes';
import progressRoutes from './routes/progress.routes';
import reportRoutes from './routes/report.routes';
import subscriptionRoutes from './routes/subscription.routes';
import webhookRoutes from './routes/webhook.routes';
import consentRoutes from './routes/consent.routes';
import gdprRoutes from './routes/gdpr.routes';
import accountRoutes from './routes/account.routes';
import deviceRoutes from './routes/device.routes';
import adminRoutes from './routes/admin.routes';

/**
 * Express `trust proxy` accepts a number (hop count), boolean, or string
 * (subnet list / preset). Parse the env string into the right shape so a pure
 * integer becomes a hop count rather than being treated as a single-host list.
 */
function parseTrustProxy(value: string): boolean | number | string {
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

// Base64 eye scans need a large body cap (see EB-04); every other endpoint gets
// a small cap so they don't inherit a multi-megabyte request DoS surface.
const SCAN_BODY_LIMIT = '12mb';
const DEFAULT_BODY_LIMIT = '256kb';

export function createApp(): Application {
  const app = express();

  // Must match the real number of proxy hops in front of the app, or req.ip
  // (the rate-limit key) becomes spoofable via X-Forwarded-For. Configurable
  // via TRUST_PROXY to match the deployment topology.
  app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));
  app.use(helmet());
  app.use(cors(buildCorsOptions()));
  app.use(requestId);

  // Liveness: is the process up and serving? Never touches dependencies, so a
  // dependency blip can't trigger a container restart.
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'eyesection-api',
      time: new Date().toISOString(),
    });
  });

  // Readiness: should this instance receive traffic? Verifies dependencies and
  // returns 503 when any are unreachable so the load balancer routes elsewhere.
  // Both Mongo and Redis are required to boot (see config/env), so both gate
  // readiness — Redis backs the scan queue, chat quota, rate limiting and more.
  app.get('/ready', async (_req: Request, res: Response) => {
    const [mongo, redis] = await Promise.all([pingDB(), pingRedis()]);
    const ready = mongo && redis;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      checks: { mongo, redis },
      time: new Date().toISOString(),
    });
  });

  // Scans mount FIRST with the large body parser, scoped to this router only.
  // Its requests are fully handled here and never fall through to the small
  // default parser registered below, so the 12mb cap stays contained to /scans.
  app.use(
    '/scans',
    express.json({ limit: SCAN_BODY_LIMIT }),
    defaultRateLimit,
    scanRoutes,
  ); // EB-04 / EB-05

  // Small default body parser for every other route.
  app.use(express.json({ limit: DEFAULT_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT }));

  // Default limit (100/min/IP) on the API surface; /health stays unmetered.
  // Auth routes apply their own stricter limit (10/min/IP).
  app.use('/auth', authRoutes); // EB-03
  app.use('/comfort', defaultRateLimit, comfortRoutes); // EB-07
  app.use('/coach', defaultRateLimit, coachRoutes); // EB-08
  app.use('/chat', defaultRateLimit, chatRoutes); // EB-13
  app.use('/exercises', defaultRateLimit, exerciseRoutes); // EB-09
  app.use('/progress', defaultRateLimit, progressRoutes); // EB-09
  app.use('/reports', defaultRateLimit, reportRoutes); // EB-09
  app.use('/subscription', defaultRateLimit, subscriptionRoutes); // EB-10
  app.use('/webhooks', webhookRoutes); // EB-10 — secret-authenticated, no IP limit
  app.use('/consent', defaultRateLimit, consentRoutes); // EB-11
  app.use('/gdpr', defaultRateLimit, gdprRoutes); // EB-11
  app.use('/account', defaultRateLimit, accountRoutes); // EB-11
  app.use('/devices', defaultRateLimit, deviceRoutes); // EB-11
  app.use('/admin', defaultRateLimit, adminRoutes); // EB-12 — separate admin JWT

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
