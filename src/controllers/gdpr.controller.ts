import { Request, Response } from 'express';
import { z } from 'zod';
import * as gdprService from '../services/gdpr.service';
import { requireUser } from '../services/comfort.service';
import { enqueueExport, getExportQueue } from '../config/exportQueue';
import { AppError } from '../middleware/error';

/** Kick off a data export; the JSON is built off-request in a queue job. */
export async function requestExport(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const jobId = await enqueueExport(userId);
  res.status(202).json({ jobId, status: 'queued' });
}

export async function exportStatus(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const job = await getExportQueue().getJob(req.params.jobId);
  // Users may only see their own export jobs.
  if (!job || job.data.userId !== userId) {
    throw new AppError(404, 'Export not found', 'EXPORT_NOT_FOUND');
  }
  const state = await job.getState();
  const result = job.returnvalue as { url: string } | undefined;
  res.status(200).json({
    jobId: job.id,
    status: state,
    url: state === 'completed' && result ? result.url : null,
  });
}

const deleteSchema = z.object({
  password: z.string().optional(),
  confirm: z.boolean().optional(),
});

export async function deleteAccount(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const { password, confirm } = deleteSchema.parse(req.body);
  await gdprService.assertReauth(userId, password, confirm);
  await gdprService.deleteAccount(userId);
  res.status(200).json({ deleted: true });
}
