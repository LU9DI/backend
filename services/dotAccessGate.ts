import type { Request } from 'express';
import { extrairToken, verifyAccessToken, isAdminUser } from '../lib/auth.js';
import { findEmpresa } from '../lib/db.js';
import { empresaTemAcesso } from './billingService.js';
import { normalizePlanAlias } from '../lib/plans.js';
import { ensureDotInternalPermissionBaseline } from './dotAccessControl.js';
import { isEmpresaOwner } from '../lib/empresaOwnership.js';

/**
 * Gate único de acesso ao Filtra Dot.
 *
 * Todas as rotas de empresa do Dot (`/api/dot/*` e `/api/dot/agent/*`) usam
 * esta mesma regra, em vez de verificações duplicadas e divergentes:
 *
 *  1. Token de acesso obrigatório (modo demonstração só fora de produção).
 *  2. Conta admin da plataforma não é conta de empresa.
 *  3. A empresa precisa existir e estar com assinatura/trial válidos.
 *  4. O Dot está em acesso antecipado: somente planos `rei` e `corporativo`
 *     (aliases `corp`/`corporate` são normalizados). Trial de 7 dias NÃO concede
 *     um benefício do trial, e conceder acesso por engano seria criar um
 *     benefício que a matriz de planos não declara.
 *
 * O gate responde apenas "pode entrar no Dot?"; permissões granulares
 * (ler/analisar/criar/executar) continuam em `dotAccessControl` e a
 * administração (permissões/PIN/execução) exige a sessão administrativa
 * (`dotAdminSecurity`).
 *
 * A PROPRIEDADE da empresa vem da tabela `empresa_owners` (provisionada no
 * cadastro ou por admin da plataforma) — jamais do `role` do token. O papel
 * padrão `empresa` não concede administração a funcionários.
 */

export type DotGateResult = {
  allowed: boolean;
  demo: boolean;
  empresaId?: string;
  plan?: string;
  userId: string | null;
  isOwner: boolean;
  canManagePermissions: boolean;
  reason?: string;
};

// Aliases ('corp', 'corporate') são normalizados para 'corporativo' antes da
// checagem (`normalizePlanAlias`), mantendo a matriz canônica Rei + Corporativo.
const DOT_ALLOWED_PLANS = ['rei', 'corporativo'];

export function dotDemoEnabled(): boolean {
  return process.env.DOT_DEMO_MODE === '1' && process.env.NODE_ENV !== 'production';
}

export async function resolveDotGate(req: Request): Promise<DotGateResult> {
  const token = extrairToken(req);

  if (!token) {
    if (dotDemoEnabled()) {
      return {
        allowed: true,
        demo: true,
        plan: 'rei',
        userId: null,
        isOwner: false,
        canManagePermissions: false,
      };
    }
    return {
      allowed: false,
      demo: false,
      userId: null,
      isOwner: false,
      canManagePermissions: false,
      reason: 'Autenticação necessária.',
    };
  }

  try {
    const payload = verifyAccessToken(token);
    const userId = String(payload.id || '') || null;

    if (isAdminUser({ empresa_id: payload.empresa_id, role: payload.role })) {
      return {
        allowed: false,
        demo: false,
        userId,
        isOwner: false,
        canManagePermissions: false,
        reason: 'Conta admin não possui acesso ao Dot de empresa.',
      };
    }

    const empresa = await findEmpresa(payload.empresa_id);
    if (!empresa || !empresaTemAcesso(empresa)) {
      return {
        allowed: false,
        demo: false,
        userId,
        isOwner: false,
        canManagePermissions: false,
        reason: 'Assinatura/trial inativo.',
      };
    }

    const plan = normalizePlanAlias(empresa.plan);
    if (!DOT_ALLOWED_PLANS.includes(plan)) {
      return {
        allowed: false,
        demo: false,
        empresaId: empresa.id,
        plan,
        userId,
        isOwner: false,
        canManagePermissions: false,
        reason: 'O Filtra Dot está em acesso antecipado para os planos Rei e Corporativo.',
      };
    }

    try {
      await ensureDotInternalPermissionBaseline(empresa.id);
    } catch (error: any) {
      console.error('[dot] falha ao inicializar as permissões internas:', error?.message || error);
      return {
        allowed: false,
        demo: false,
        empresaId: empresa.id,
        plan,
        userId,
        isOwner: false,
        canManagePermissions: false,
        reason: 'Não foi possível inicializar as permissões internas do DOT.',
      };
    }

    // Propriedade resolvida no servidor (tabela empresa_owners). Falha na
    // verificação NUNCA promove: o bit administrativo fica falso (fail-closed).
    let isOwner = false;
    try {
      isOwner = await isEmpresaOwner(empresa.id, userId);
    } catch (error: any) {
      console.error('[dot] falha ao verificar a propriedade da empresa:', error?.message || error);
      isOwner = false;
    }

    return {
      allowed: true,
      demo: false,
      empresaId: empresa.id,
      plan,
      userId,
      isOwner,
      canManagePermissions: isOwner,
    };
  } catch {
    return {
      allowed: false,
      demo: false,
      userId: null,
      isOwner: false,
      canManagePermissions: false,
      reason: 'Token inválido ou expirado.',
    };
  }
}
