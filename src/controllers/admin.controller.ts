import { Request, Response } from 'express';
import { z } from 'zod';
import * as adminService from '../services/admin.service';

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/* -------------------------------- Auth --------------------------------- */

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = loginSchema.parse(req.body);
  res.status(200).json(await adminService.login(email, password));
}

export async function me(req: Request, res: Response): Promise<void> {
  res.status(200).json({ admin: await adminService.me(req.adminId as string) });
}

/* ------------------------------- Stats --------------------------------- */

export async function statsOverview(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.statsOverview());
}

export async function statsGrowth(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.statsGrowth());
}

export async function statsScans(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.statsScans());
}

export async function statsRevenue(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.statsRevenue());
}

export async function needsAttention(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.needsAttention());
}

/* ------------------------------- Users --------------------------------- */

const listUsersQuery = pageQuery.extend({
  search: z.string().trim().min(1).optional(),
  plan: z.string().trim().min(1).optional(),
});

export async function listUsers(req: Request, res: Response): Promise<void> {
  const q = listUsersQuery.parse(req.query);
  res.status(200).json(await adminService.listUsers(q));
}

export async function getUser(req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.getUser(req.params.id));
}

const statusSchema = z.object({ status: z.enum(['active', 'suspended']) });

export async function setUserStatus(req: Request, res: Response): Promise<void> {
  const { status } = statusSchema.parse(req.body);
  res.status(200).json(await adminService.setUserStatus(req.params.id, status));
}

export async function deleteUser(req: Request, res: Response): Promise<void> {
  await adminService.deleteUser(req.params.id);
  res.status(200).json({ deleted: true });
}

/* ------------------------------- Scans --------------------------------- */

const listScansQuery = pageQuery.extend({
  status: z.enum(['pending', 'processing', 'complete', 'failed']).optional(),
});

export async function listScans(req: Request, res: Response): Promise<void> {
  const q = listScansQuery.parse(req.query);
  res.status(200).json(await adminService.listScans(q));
}

export async function getScan(req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.getScan(req.params.id));
}

export async function reprocessScan(req: Request, res: Response): Promise<void> {
  res.status(202).json(await adminService.reprocessScan(req.params.id));
}

export async function deleteScanPhotos(req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.deleteScanPhotos(req.params.id));
}

/* ------------------------------ Storage -------------------------------- */

export async function storageStats(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.getStorageStats());
}

export async function purgeExpired(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.purgeExpiredRaw());
}

export async function pendingDeletion(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.pendingDeletion());
}

/* --------------------------- Subscriptions ----------------------------- */

const listSubsQuery = pageQuery.extend({ plan: z.string().trim().min(1).optional() });

export async function listSubscriptions(req: Request, res: Response): Promise<void> {
  const q = listSubsQuery.parse(req.query);
  res.status(200).json(await adminService.listSubscriptions(q));
}

export async function refreshSubscription(req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.refreshSubscription(req.params.userId));
}

export async function subscriptionStats(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.subscriptionStats());
}

/* ----------------------------- Exercises ------------------------------- */

export async function listExercises(_req: Request, res: Response): Promise<void> {
  res.status(200).json({ exercises: await adminService.listExercises() });
}

const updateExerciseSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    steps: z.array(z.string()).optional(),
    durationSec: z.number().int().min(1).max(3600).optional(),
    category: z.enum(['relaxation', 'focus_relief', 'screen_break']).optional(),
    premium: z.boolean().optional(),
    order: z.number().int().min(0).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export async function updateExercise(req: Request, res: Response): Promise<void> {
  const patch = updateExerciseSchema.parse(req.body);
  res.status(200).json(await adminService.updateExercise(req.params.id, patch));
}

/* ------------------------- GDPR / Notifications ------------------------ */

export async function gdprRequests(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.gdprRequests());
}

const sendNotificationSchema = z
  .object({
    userId: z.string().min(1).optional(),
    segment: z.enum(['all', 'premium', 'free', 'trial']).optional(),
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(500),
    data: z.record(z.string(), z.string()).optional(),
  })
  .refine((v) => !!v.userId || !!v.segment, {
    message: 'Provide either userId or segment',
  });

export async function sendNotification(req: Request, res: Response): Promise<void> {
  const body = sendNotificationSchema.parse(req.body);
  res.status(200).json(await adminService.sendNotification(body, req.adminId));
}

const estimateSchema = z
  .object({
    userId: z.string().min(1).optional(),
    segment: z.enum(['all', 'premium', 'free', 'trial']).optional(),
  })
  .refine((v) => !!v.userId || !!v.segment, { message: 'Provide either userId or segment' });

export async function estimateAudience(req: Request, res: Response): Promise<void> {
  const body = estimateSchema.parse(req.body);
  res.status(200).json(await adminService.estimateAudience(body));
}

export async function notificationHistory(req: Request, res: Response): Promise<void> {
  const q = pageQuery.parse(req.query);
  res.status(200).json(await adminService.notificationHistory(q));
}

/* ------------------------------- Jobs ---------------------------------- */

const jobsQuery = z.object({
  status: z.enum(['failed', 'active', 'waiting', 'completed']).optional(),
});

export async function listJobs(req: Request, res: Response): Promise<void> {
  const { status } = jobsQuery.parse(req.query);
  res.status(200).json(await adminService.listJobs({ status }));
}

export async function retryJob(req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.retryJob(req.params.id));
}

export async function retryAllJobs(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.retryAllFailed());
}

export async function systemHealth(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await adminService.systemHealth());
}
