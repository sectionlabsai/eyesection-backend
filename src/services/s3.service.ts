import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { AppError } from '../middleware/error';

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!env.AWS_REGION || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.S3_BUCKET) {
    throw new AppError(503, 'Image storage is not available right now', 'STORAGE_UNAVAILABLE');
  }
  if (!client) {
    client = new S3Client({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

function bucket(): string {
  return env.S3_BUCKET as string;
}

export async function uploadBuffer(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  await getClient().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: buffer, ContentType: contentType }),
  );
}

/** Fetch an object's bytes into a Buffer (used by the analysis worker). */
export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await getClient().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const body = res.Body as unknown as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

export async function getSignedUrl(key: string, expiresInSec = 900): Promise<string> {
  return presign(getClient(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: expiresInSec,
  });
}

export async function deleteObject(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

export async function deleteMany(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  // S3 DeleteObjects handles up to 1000 keys per call.
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await getClient().send(
      new DeleteObjectsCommand({
        Bucket: bucket(),
        Delete: { Objects: chunk.map((Key) => ({ Key })) },
      }),
    );
  }
}

/** List every object key under a prefix (paginates through all pages). */
export async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await getClient().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** Delete every object under a prefix. Returns the number deleted. */
export async function deletePrefix(prefix: string): Promise<number> {
  const keys = await listKeys(prefix);
  await deleteMany(keys);
  return keys.length;
}

/** Prefix that holds everything belonging to one user (scans, exports). */
export function userPrefix(userId: string): string {
  return `users/${userId}/`;
}

export interface StorageStats {
  objectCount: number;
  totalBytes: number;
  rawCount: number;
  rawBytes: number;
  thumbCount: number;
  thumbBytes: number;
}

/** Aggregate object counts and sizes under a prefix (admin storage view). */
export async function storageStats(prefix = 'users/'): Promise<StorageStats> {
  const stats: StorageStats = {
    objectCount: 0,
    totalBytes: 0,
    rawCount: 0,
    rawBytes: 0,
    thumbCount: 0,
    thumbBytes: 0,
  };
  let token: string | undefined;
  do {
    const res = await getClient().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const obj of res.Contents ?? []) {
      const size = obj.Size ?? 0;
      stats.objectCount += 1;
      stats.totalBytes += size;
      if (obj.Key?.endsWith('-raw.jpg')) {
        stats.rawCount += 1;
        stats.rawBytes += size;
      } else if (obj.Key?.endsWith('-thumb.jpg')) {
        stats.thumbCount += 1;
        stats.thumbBytes += size;
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return stats;
}

/** Lightweight reachability check for the admin health endpoint. */
export async function ping(): Promise<boolean> {
  try {
    await getClient().send(
      new ListObjectsV2Command({ Bucket: bucket(), MaxKeys: 1 }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Build the S3 key for a scan image. */
export function scanKey(
  userId: string,
  scanId: string,
  shot: 'front' | 'closeup',
  kind: 'raw' | 'thumb' | 'eye-thumb',
): string {
  return `users/${userId}/scans/${scanId}/${shot}-${kind}.jpg`;
}
