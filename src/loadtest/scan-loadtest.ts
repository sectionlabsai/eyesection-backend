/**
 * Standalone load test for the SCAN INGESTION path (Phase A) — the synchronous
 * work a POST /scans/upload actually does before returning:
 *   Zod validate → sharp (EXIF strip + re-encode + thumbnail) → S3 puts →
 *   Mongo insert → BullMQ enqueue → 201.
 *
 * SAFETY: runs entirely locally. It uses a throwaway Mongo DB, stubs S3 with an
 * in-memory store (no AWS, no cost), blanks the OpenAI key, and does NOT start
 * the analysis worker — so ZERO OpenAI calls and nothing touches production.
 *
 * It measures the front-door capacity: can the server accept a burst of N
 * concurrent uploads, and what is the latency/throughput curve.
 *
 * Run:  npx ts-node --transpile-only src/loadtest/scan-loadtest.ts
 */

/* eslint-disable no-console */

// --- 1. Pin env to LOCAL + neutralize externals BEFORE any app import. -------
// dotenv (loaded by config/env) does NOT override already-set process.env vars,
// so these win over the real server/.env — keeping us off production entirely.
process.env.NODE_ENV = 'development';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/eyesection_loadtest';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.JWT_SECRET = 'loadtest-secret';
process.env.JWT_REFRESH_SECRET = 'loadtest-refresh-secret';
process.env.OPENAI_API_KEY = ''; // no vision calls even if a worker ran
process.env.AWS_REGION = 'us-east-1'; // dummy; S3 is stubbed below
process.env.AWS_ACCESS_KEY_ID = 'stub';
process.env.AWS_SECRET_ACCESS_KEY = 'stub';
process.env.S3_BUCKET = 'stub-bucket';

import http from 'http';
import express from 'express';
import sharp from 'sharp';

// --- 2. Stub S3 with an in-memory store (module is commonjs → patch exports). -
// scan.service calls these via the module namespace at call time, so replacing
// the exports before the first request takes effect everywhere.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const s3 = require('../services/s3.service');
const memStore = new Map<string, Buffer>();
let s3Puts = 0;
s3.uploadBuffer = async (key: string, buf: Buffer): Promise<void> => {
  memStore.set(key, buf);
  s3Puts += 1;
};
s3.getObjectBuffer = async (key: string): Promise<Buffer> =>
  memStore.get(key) ?? Buffer.alloc(0);
s3.getSignedUrl = async (key: string): Promise<string> => `memory://${key}`;
s3.deleteMany = async (keys: string[]): Promise<void> => {
  for (const k of keys) memStore.delete(k);
};

// --- 3. Now pull in the real app pieces. -------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { connectDB, disconnectDB } = require('../config/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { closeRedis } = require('../config/redis');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getAnalyzeQueue } = require('../config/queue');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const scanRoutes = require('../routes/scan.routes').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { requestId } = require('../middleware/requestId');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler, notFoundHandler } = require('../middleware/error');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mongoose = require('mongoose');

const PORT = 4100;

// Faithful-but-minimal app: the SAME scan route/controller/service the real
// server mounts, minus the per-IP rate limiter (we're deliberately measuring
// raw capacity, not the 100/min/IP guard, which would just 429 a localhost run).
function buildApp(): express.Application {
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(requestId);
  app.use('/scans', scanRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

// A realistic phone-ish eye photo: 1600x1600 random-noise JPEG. Random content
// prevents any degenerate all-one-colour fast path in the encoder.
async function makeTestImageBase64(): Promise<{ b64: string; bytes: number }> {
  const px = 1600;
  const noise = Buffer.alloc(px * px * 3);
  for (let i = 0; i < noise.length; i += 1) noise[i] = (Math.random() * 256) | 0;
  const jpeg = await sharp(noise, { raw: { width: px, height: px, channels: 3 } })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { b64: jpeg.toString('base64'), bytes: jpeg.length };
}

interface Sample {
  ms: number;
  status: number;
  ok: boolean;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 512 });

function oneRequest(bodyStr: string): Promise<Sample> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/scans/upload',
        method: 'POST',
        agent,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - start) / 1e6;
          resolve({ ms, status: res.statusCode ?? 0, ok: res.statusCode === 201 });
        });
      },
    );
    req.on('error', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({ ms, status: 0, ok: false });
    });
    req.write(bodyStr);
    req.end();
  });
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Fire `total` requests with at most `concurrency` in flight at once. */
async function runLevel(
  bodyStr: string,
  total: number,
  concurrency: number,
): Promise<void> {
  const samples: Sample[] = [];
  let launched = 0;
  const wallStart = process.hrtime.bigint();

  async function worker(): Promise<void> {
    while (launched < total) {
      launched += 1;
      samples.push(await oneRequest(bodyStr));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;
  const oks = samples.filter((s) => s.ok);
  const lat = oks.map((s) => s.ms).sort((a, b) => a - b);
  const byStatus = samples.reduce<Record<string, number>>((acc, s) => {
    const k = s.status === 0 ? 'ERR/conn' : String(s.status);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  console.log(
    `concurrency ${String(concurrency).padStart(3)} | ` +
      `${oks.length}/${total} ok | ` +
      `${(wallMs / 1000).toFixed(2)}s wall | ` +
      `${((oks.length / wallMs) * 1000).toFixed(1)} req/s | ` +
      `p50 ${pct(lat, 50).toFixed(0)}ms  p90 ${pct(lat, 90).toFixed(0)}ms  ` +
      `p99 ${pct(lat, 99).toFixed(0)}ms  max ${(lat[lat.length - 1] ?? 0).toFixed(0)}ms | ` +
      `status ${JSON.stringify(byStatus)}`,
  );
}

async function main(): Promise<void> {
  console.log('EyeSection — scan INGESTION load test (Phase A, local, zero-cost)\n');
  console.log(`CPU cores: ${require('os').cpus().length} | node ${process.version}\n`);

  await connectDB();
  const { b64, bytes } = await makeTestImageBase64();
  const bodyStr = JSON.stringify({
    front: b64,
    geometry: { eyeOpennessL: 0.8, eyeOpennessR: 0.82, symmetry: 0.95 },
  });
  console.log(
    `test image: ${(bytes / 1024).toFixed(0)} KB JPEG → ${(Buffer.byteLength(bodyStr) / 1024).toFixed(0)} KB JSON body\n`,
  );

  const app = buildApp();
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(PORT, () => resolve(s));
  });

  // Warm up sharp / connection pools so the first level isn't penalised.
  await runLevel(bodyStr, 20, 10);
  console.log('(warm-up above)\n');

  // The curve: how throughput/latency behave as concurrency climbs. The 300 run
  // is the headline the question asked for.
  for (const c of [50, 100, 200, 300]) {
    await runLevel(bodyStr, 300, c);
  }

  console.log(`\nin-memory S3 puts served: ${s3Puts}`);
  const scanCount = await mongoose.connection.collection('eyescans').countDocuments();
  console.log(`scan docs written to throwaway DB: ${scanCount}`);

  // --- Cleanup: drop the throwaway DB + queued jobs so nothing lingers. -------
  console.log('\ncleaning up (drop test DB + obliterate queue)…');
  await mongoose.connection.dropDatabase();
  try {
    await getAnalyzeQueue().obliterate({ force: true });
  } catch {
    /* ignore */
  }
  await new Promise<void>((r) => server.close(() => r()));
  await disconnectDB();
  await closeRedis();
  console.log('done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('load test failed:', err);
  process.exit(1);
});
