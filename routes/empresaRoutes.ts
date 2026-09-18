import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import { normalizarWhatsapp, linkWhatsapp } from '../lib/whatsapp.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ensureReviewFraudColumns } from '../lib/reviewFraud.js';
import {
  planTemPdf,
  allowPlanSwitch,
  PLANOS_OFICIAIS,
  planLabel,
  isTrialPlan,
  isPlanoOficial,
} from '../lib/plans.js';
import {
  planTemIA,
  getFeedbackLimit,
  getTokenLimit,
  tokensUsadosMes,
  contarReviewsMes,
} from '../lib/quota.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { ensureReviewTreatmentColumns } from '../lib/lgpd.js';

const APP_URL = process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000';
