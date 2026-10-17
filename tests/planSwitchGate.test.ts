/**
 * Gate da troca de planos de teste: produção é SEMPRE off (ALLOW_PLAN_SWITCH
 * é ignorada); fora de produção o default é ligado e ALLOW_PLAN_SWITCH=0/false
 * desliga.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPlanSwitchRoutes } from '../routes/planSwitchRoutes.js';
import { allowPlanSwitch } from '../lib/plans.js';

const SAVED_NODE_ENV = process.env.NODE_ENV;
const SAVED_ALLOW = process.env.ALLOW_PLAN_SWITCH;

function restoreEnv() {
  if (SAVED_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = SAVED_NODE_ENV;
  if (SAVED_ALLOW === undefined) delete process.env.ALLOW_PLAN_SWITCH;
  else process.env.ALLOW_PLAN_SWITCH = SAVED_ALLOW;
}

test('allowPlanSwitch: produção sempre OFF, mesmo com ALLOW_PLAN_SWITCH=1', () => {
  try {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_PLAN_SWITCH = '1';
    assert.equal(allowPlanSwitch(), false);
    process.env.ALLOW_PLAN_SWITCH = 'true';
    assert.equal(allowPlanSwitch(), false);
    delete process.env.ALLOW_PLAN_SWITCH;
    assert.equal(allowPlanSwitch(), false);
  } finally {
    restoreEnv();
  }
});

test('allowPlanSwitch: fora de produção ligado por padrão e desligável por env', () => {
  try {
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOW_PLAN_SWITCH;
    assert.equal(allowPlanSwitch(), true);
    process.env.ALLOW_PLAN_SWITCH = '1';
    assert.equal(allowPlanSwitch(), true);
    process.env.ALLOW_PLAN_SWITCH = '0';
    assert.equal(allowPlanSwitch(), false);
    process.env.ALLOW_PLAN_SWITCH = 'false';
    assert.equal(allowPlanSwitch(), false);
  } finally {
    restoreEnv();
  }
});

test('rotas de teste respondem desativadas em produção', async () => {
  const routes: Array<{ method: string; path: string; handlers: Function[] }> = [];
  const app = {
    get(path: string, ...handlers: Function[]) { routes.push({ method: 'GET', path, handlers }); },
    patch(path: string, ...handlers: Function[]) { routes.push({ method: 'PATCH', path, handlers }); },
  } as any;
  mountPlanSwitchRoutes(app);

  try {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_PLAN_SWITCH = '1';

    const getRoute = routes.find((r) => r.method === 'GET' && r.path === '/api/planos-teste');
    assert.ok(getRoute, 'GET /api/planos-teste montado');
    let getBody: any = null;
    await getRoute!.handlers[0]({}, { json: (b: any) => { getBody = b; } });
    assert.equal(getBody?.enabled, false);

    const patchRoute = routes.find((r) => r.method === 'PATCH' && r.path === '/api/empresa/:ref/plano');
    assert.ok(patchRoute, 'PATCH /api/empresa/:ref/plano montado');
    let statusCode = 0;
    let patchBody: any = null;
    const fakeRes: any = {
      status: (code: number) => { statusCode = code; return fakeRes; },
      json: (body: any) => { patchBody = body; return fakeRes; },
    };
    await patchRoute!.handlers[patchRoute!.handlers.length - 1]({ params: { ref: 'empresa-x' }, body: { plan: 'rei' } }, fakeRes);
    assert.equal(statusCode, 403);
    assert.match(String(patchBody?.error || ''), /desativada em produção/i);
  } finally {
    restoreEnv();
  }
});
