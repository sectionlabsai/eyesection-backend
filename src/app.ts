import express, { Application, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
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

export function createApp(): Application {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors(buildCorsOptions()));
  app.use(requestId);

  // 12mb body limit — eye scans can be posted as base64 (see EB-04).
  app.use(express.json({ limit: '12mb' }));
  app.use(express.urlencoded({ extended: true, limit: '12mb' }));

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

  // Default limit (100/min/IP) on the API surface; /health stays unmetered.
  // Auth routes apply their own stricter limit (10/min/IP).
  app.use('/auth', authRoutes); // EB-03
  app.use('/scans', defaultRateLimit, scanRoutes); // EB-04 / EB-05
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
