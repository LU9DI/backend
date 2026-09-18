/**
 * Filtra.IA — rotas de empresa (completas).
 * Helpers + patch (whatsapp/google/plano/validar) + painel.
 */
import type { Express } from 'express';
import { mountEmpresaPatchRoutes } from './empresaRoutesPatch.js';
import { mountEmpresaPainelRoute } from './empresaRoutesPainel.js';

export function mountEmpresaRoutes(app: Express) {
  mountEmpresaPatchRoutes(app);
  mountEmpresaPainelRoute(app);
}
