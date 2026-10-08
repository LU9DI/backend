import test from 'node:test';
import assert from 'node:assert/strict';
import { mountRelatorioRoutes } from '../routes/relatorioRoutes.js';
import { planTemRelatorio } from '../lib/plans.js';

type Route = { method: string; path: string; handler: Function };

test('legacy PDF report endpoints return 410 Gone', () => {
  const routes: Route[] = [];
  const app = {
    get(path: string, ...handlers: Function[]) { routes.push({ method: 'GET', path, handler: handlers.at(-1)! }); },
    post(path: string, ...handlers: Function[]) { routes.push({ method: 'POST', path, handler: handlers.at(-1)! }); },
    put(path: string, ...handlers: Function[]) { routes.push({ method: 'PUT', path, handler: handlers.at(-1)! }); },
  } as any;

  mountRelatorioRoutes(app);

  for (const path of [
    '/api/empresa/:ref/relatorio.pdf',
    '/api/empresa/:ref/relatorio-inteligente.pdf',
  ]) {
    const route = routes.find((r) => r.method === 'GET' && r.path === path);
    assert.ok(route, `missing compatibility route: ${path}`);

    const response = {
      statusCode: 200,
      payload: null as any,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.payload = body; return this; },
    };

    route.handler({} as any, response as any);
    assert.equal(response.statusCode, 410);
    assert.equal(response.payload?.code, 'REPORT_PDF_GONE');
    assert.equal(response.payload?.endpoint, '/api/empresa/:ref/relatorio');
  }
});

test('report entitlement is not advertised for Initial plan', () => {
  assert.equal(planTemRelatorio('inicial'), false);
  assert.equal(planTemRelatorio('pro'), true);
  assert.equal(planTemRelatorio('ultra'), true);
  assert.equal(planTemRelatorio('corporativo'), true);
  assert.equal(planTemRelatorio('rei'), true);
  assert.equal(planTemRelatorio('trial'), true);
});
