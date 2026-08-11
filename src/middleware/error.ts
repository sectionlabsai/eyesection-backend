import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger';
import { isProd } from '../config/env';

/**
 * Operational error with a stable client-facing code.
 * Anything that is NOT an AppError is treated as unexpected and is masked
 * behind a generic message — internal/provider errors NEVER leak to users.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, message: string, code = 'ERROR') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace?.(this, AppError);
  }
}

/** 404 fallthrough for unmatched routes. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res
      .status(err.statusCode)
      .json({ error: { message: err.message, code: err.code } });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        message: 'Invalid request',
        code: 'VALIDATION_ERROR',
        details: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
    });
    return;
  }

  // Errors that carry an explicit HTTP status (body-parser payload-too-large /
  // malformed JSON, and similar) are client errors — surface the right 4xx with
  // a safe generic message instead of masking them as a 500.
  const status =
    (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
  const type = (err as { type?: string }).type;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const code =
      type === 'entity.too.large'
        ? 'PAYLOAD_TOO_LARGE'
        : type === 'entity.parse.failed'
          ? 'INVALID_JSON'
          : 'BAD_REQUEST';
    const message =
      type === 'entity.too.large'
        ? 'Request body is too large'
        : type === 'entity.parse.failed'
          ? 'Invalid JSON body'
          : 'Bad request';
    res.status(status).json({ error: { message, code } });
    return;
  }

  // Unknown / unexpected — log full detail internally, return a generic message.
  logger.error('Unhandled error', {
    requestId: (req as Request & { id?: string }).id,
    path: req.path,
    err,
  });

  res.status(500).json({
    error: {
      message: 'Something went wrong',
      code: 'INTERNAL_ERROR',
      ...(isProd ? {} : { debug: err instanceof Error ? err.message : String(err) }),
    },
  });
}
