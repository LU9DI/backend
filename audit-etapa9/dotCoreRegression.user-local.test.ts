/**
 * Regressão do núcleo DOT — ações internas, aprovação, auditoria, idempotência
 * e isolamento por `empresa_id`.
 *
 * Usa APENAS funções reais dos serviços do backend (monitor → decisão → preparo
 * → aprovação → execução) sobre um SQLite temporário e determinístico. Não
 * simula comportamento inexistente e NÃO altera a implementação de produção.
 *
 * Lacuna conhecida (não mascarada; ver FILTRA-AI-PLANO-INTEGRACAO-DOT.md §8):
 *  - Não existe ação registrada com `externalSideEffect: true`. O ramo de recusa
 *    de efeito externo do `dotExecutionGateway` não é exercitável por nenhuma
 *    ação real, então o teste verifica a invariante "nenhuma ação externa
 *    exposta" em vez de fabricar um executor falso.
 *  - O runner de missões ainda NÃO existe (não é implementado nesta fase); por
 *    isso estes testes cobrem o núcleo sobre o qual ele será construído.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
const tmpDb = path.join(os.tmpdir(), `filtra-dot-core-${Date.now()}-${process.pid}.sqlite`);
process.env.SQLITE_DB_PATH = tmpDb;
delete process.env.DATABASE_URL;

let dbMod: any;
let queueMod: any;
let gatewayMod: any;
let registryMod: any;
let auditMod: any;
let policyMod: any;
let prefsMod: any;
let followUpMod: any;
let monitorMod: any;
let fraudMod: any;

let empresaA = '';
let empresaB = '';
let monitorA: any;
let monitorB: any;

/** Semeia avaliações reais (as colunas de `reviews` são as que o fluxo usa). */
async function seedReviews(empresaId: string) {
  const db = dbMod.getDb();
  for (let i = 0; i < 5; i += 1) {
    await db.run(
      'INSERT INTO reviews (empresa_id, name, rating, comment, ai_tags, is_test, createdAt) VALUES (?,?,?,?,?,?,?)',
      [empresaId, `Cliente ${i}`, 3, 'Demora no atendimento', JSON.stringify(['espera']), 0, new Date().toISOString()],
    );
  }
}

function actionDecisionId(action: any): number {
  return Number(action?.decision_id ?? action?.decisionId);
}

before(async () => {
  dbMod = await import('../lib/db.js');
  queueMod = await import('../services/dotActionQueue.js');
  gatewayMod = await import('../services/dotExecutionGateway.js');
  registryMod = await import('../services/dotActionRegistry.js');
  auditMod = await import('../services/dotActionAudit.js');
  policyMod = await import('../services/dotPolicy.js');
  prefsMod = await import('../services/dotPreferences.js');
  followUpMod = await import('../services/dotFollowUp.js');
  monitorMod = await import('../services/dotMonitor.js');
  fraudMod = await import('../lib/reviewFraud.js');

  await dbMod.initDB();
  // Colunas reais de `reviews` (is_test etc.), como o fluxo de avaliação faz.
  await fraudMod.ensureReviewFraudColumns(dbMod.getDb());

  empresaA = crypto.randomUUID();
  empresaB = crypto.randomUUID();
  const now = new Date().toISOString();
  const expira = new Date(Date.now() + 7 * 86400000).toISOString();
  await dbMod.getDb().run(
    'INSERT INTO empresas (id, cnpj, nome_empresa, slug, status, plan, criado_em, expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [empresaA, '11222333000181', 'DOT A', `dot-a-${Date.now()}`, 'trial', 'trial', now, expira],
  );
  await dbMod.getDb().run(
    'INSERT INTO empresas (id, cnpj, nome_empresa, slug, status, plan, criado_em, expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [empresaB, '11222333000182', 'DOT B', `dot-b-${Date.now()}`, 'trial', 'trial', now, expira],
  );

  await seedReviews(empresaA);
  await seedReviews(empresaB);
  monitorA = await monitorMod.runDotMonitor(empresaA);
  monitorB = await monitorMod.runDotMonitor(empresaB);
});

after(async () => {
  try { await dbMod.closeDB(); } catch { /* */ }
  try { fs.unlinkSync(tmpDb); } catch { /* */ }
});

describe('DOT — regressão do núcleo (monitor → decisão → preparo)', () => {
  it('o monitor cria eventos, decisões e ações preparadas por empresa', () => {
    assert.ok(monitorA.events.length >= 1, 'esperava ao menos 1 evento');
    assert.ok(monitorA.decisions.length >= 2, 'esperava ao menos 2 decisões');
    assert.ok(monitorA.prepared_actions.length >= 2, 'esperava ao menos 2 ações preparadas');
    for (const action of monitorA.prepared_actions) assert.equal(action.status, 'prepared');
    for (const decision of monitorA.decisions) assert.equal(decision.requiresApproval, true);
  });
});

describe('DOT — isolamento por empresa_id', () => {
  it('não prepara ação a partir de decisão de outra empresa', async () => {
    const decisionB = monitorB.decisions[0];
    const r = await queueMod.prepareDotActionFromDecision(empresaA, Number(decisionB.id), decisionB.options[0].id);
    assert.equal(r, null);
  });

  it('não aprova ação de outra empresa', async () => {
    const actionB = monitorB.prepared_actions[0];
    const r = await queueMod.approveDotAction(empresaA, Number(actionB.id));
    assert.equal(r, null);
  });

  it('não executa ação de outra empresa', async () => {
    const actionB = monitorB.prepared_actions[0];
    const r = await gatewayMod.executeDotActionThroughGateway(empresaA, Number(actionB.id));
    assert.equal(r.ok, false);
  });

  it('listagens e auditoria respeitam o tenant', async () => {
    const actionB = monitorB.prepared_actions[0];
    const listaA = await queueMod.listDotActions(empresaA);
    assert.ok(listaA.length >= 1);
    assert.ok(listaA.every((a: any) => a.empresa_id === empresaA));
    assert.ok(listaA.every((a: any) => Number(a.id) !== Number(actionB.id)));
    const auditCross = await auditMod.listDotActionAudit(empresaA, Number(actionB.id));
    assert.equal(auditCross.length, 0);
  });
});

describe('DOT — aprovação obrigatória, execução interna e auditoria', () => {
  it('não executa antes da aprovação', async () => {
    const action = monitorA.prepared_actions[0];
    const r = await gatewayMod.executeDotActionThroughGateway(empresaA, Number(action.id));
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /não aprovada|não encontrada/i);
    const row = await dbMod.getDb().get('SELECT status FROM dot_action_queue WHERE id = ? AND empresa_id = ?', [Number(action.id), empresaA]);
    assert.equal(row.status, 'prepared');
  });

  it('executa após aprovação e cria caso interno, follow-up e auditoria ordenada', async () => {
    const action = monitorA.prepared_actions[0];

    const approved = await queueMod.approveDotAction(empresaA, Number(action.id));
    assert.ok(approved);
    assert.equal(approved.status, 'approved');

    const exec = await gatewayMod.executeDotActionThroughGateway(empresaA, Number(action.id));
    assert.equal(exec.ok, true, String(exec.reason));
    assert.equal(exec.status, 'executed');
    assert.equal(exec.simulated, false);

    const caso = await dbMod.getDb().get(
      'SELECT * FROM dot_internal_cases WHERE empresa_id = ? AND action_id = ?',
      [empresaA, Number(action.id)],
    );
    assert.ok(caso, 'esperava um caso interno persistido');

    const follow = await dbMod.getDb().get(
      'SELECT * FROM dot_followups WHERE empresa_id = ? AND action_id = ?',
      [empresaA, Number(action.id)],
    );
    assert.ok(follow, 'esperava um follow-up persistido');

    const audit = await auditMod.listDotActionAudit(empresaA, Number(action.id));
    assert.deepEqual(
      audit.map((a: any) => a.event),
      ['prepared', 'approved', 'execution_started', 'executed'],
    );
  });
});

describe('DOT — efeitos externos (lacuna documentada, sem mock)', () => {
  it('nenhuma ação registrada expõe efeito externo e todas exigem aprovação', () => {
    const defs = registryMod.listDotActionDefinitions();
    assert.ok(defs.length > 0);
    assert.ok(defs.every((d: any) => d.externalSideEffect === false), 'nenhuma ação externa pode estar exposta');
    assert.ok(defs.every((d: any) => d.requiresApproval === true), 'toda ação deve exigir aprovação');
    // LACUNA: o gateway recusa `externalSideEffect`, mas não há ação registrada
    // com esse atributo — o ramo não é exercitável sem executor homologado real.
  });
});

describe('DOT — idempotência', () => {
  it('preparar a mesma decisão duas vezes devolve a mesma ação ativa (uma por decisão)', async () => {
    // Usa a decisão cuja ação ainda está `prepared` (a primeira foi aprovada e
    // executada no grupo anterior, e aprovar move a decisão para `approved`).
    const decision = monitorA.decisions[1];
    assert.ok(decision, 'esperava uma segunda decisão ainda não aprovada');
    const primeira = monitorA.prepared_actions.find((a: any) => actionDecisionId(a) === Number(decision.id));
    assert.ok(primeira);

    const same = await queueMod.prepareDotActionFromDecision(empresaA, Number(decision.id), decision.options[0].id);
    assert.equal(Number(same.id), Number(primeira.id));

    const outro = await queueMod.prepareDotActionFromDecision(empresaA, Number(decision.id), decision.options[1].id);
    assert.equal(Number(outro.id), Number(primeira.id));
  });

  it('aprovar duas vezes não duplica efeito', async () => {
    const actionB = monitorB.prepared_actions[0];
    const first = await queueMod.approveDotAction(empresaB, Number(actionB.id));
    assert.ok(first);
    const second = await queueMod.approveDotAction(empresaB, Number(actionB.id));
    assert.equal(second, null);
  });

  it('executar duas vezes não duplica caso interno nem follow-up', async () => {
    const action = monitorA.prepared_actions[0];
    const again = await gatewayMod.executeDotActionThroughGateway(empresaA, Number(action.id));
    assert.equal(again.ok, false);

    const casos = await dbMod.getDb().get(
      'SELECT COUNT(*) AS n FROM dot_internal_cases WHERE empresa_id = ? AND action_id = ?',
      [empresaA, Number(action.id)],
    );
    assert.equal(Number(casos.n), 1);

    const follows = await dbMod.getDb().get(
      'SELECT COUNT(*) AS n FROM dot_followups WHERE empresa_id = ? AND action_id = ?',
      [empresaA, Number(action.id)],
    );
    assert.equal(Number(follows.n), 1);
  });

  it('createDotFollowUp é idempotente por (empresa, ação)', async () => {
    const action = monitorA.prepared_actions[0];
    const f1 = await followUpMod.createDotFollowUp(empresaA, actionDecisionId(action), Number(action.id));
    const f2 = await followUpMod.createDotFollowUp(empresaA, actionDecisionId(action), Number(action.id));
    assert.equal(Number(f1.id), Number(f2.id));
  });
});

describe('DOT — política e aprovação de ação externa', () => {
  it('normaliza preferências para sempre exigir aprovação de ação externa', async () => {
    const saved = await prefsMod.saveDotPreferences(empresaB, {
      autonomy: 'autonomo_controlado',
      prepareActionsAutomatically: true,
      requireApprovalForExternalActions: false,
    });
    assert.equal(saved.requireApprovalForExternalActions, true);
    const fetched = await prefsMod.getDotPreferences(empresaB);
    assert.equal(fetched.requireApprovalForExternalActions, true);
  });

  it('mesmo em autonomia máxima e risco baixo, não executa automaticamente e exige aprovação', async () => {
    const prefs = await prefsMod.getDotPreferences(empresaB);
    const policy = policyMod.evaluateDotPolicy(prefs, 'low');
    assert.equal(policy.executeAutomatically, false);
    assert.equal(policy.requiresApproval, true);
    assert.equal(policy.observe, true);
  });
});
