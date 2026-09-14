import assert from 'node:assert/strict';
import test from 'node:test';
import { buildN8nMonthlyReport } from '../lib/n8nReport.js';

test('buildN8nMonthlyReport mantém números consistentes e ignora dados de teste', async () => {
  const db = {
    async get(sql: string) {
      if (sql.includes('SELECT id, nome_empresa')) {
        return { id: 'emp-1', nome_empresa: 'Empresa Teste', slug: 'empresa-teste', plan: 'rei' };
      }
      return { email: 'cliente@exemplo.com' };
    },
    async all() {
      return [
        { rating: 5, comment: 'Ótimo' },
        { rating: 4, comment: 'Bom' },
        { rating: 3, comment: 'Regular' },
        { rating: 1, comment: 'Ruim' },
        { rating: 0, comment: 'inválida' },
      ];
    },
  } as any;

  const payload = await buildN8nMonthlyReport(db, 'emp-1', '2026-09');
  assert.ok(payload);
  assert.equal(payload.idempotency_key, 'relatorio:emp-1:2026-09');
  assert.deepEqual(payload.destinatarios, [
    { channel: 'email', destination: 'cliente@exemplo.com' },
  ]);

  const report = payload.relatorio as any;
  assert.equal(report.total, 4);
  assert.equal(report.positivas, 2);
  assert.equal(report.criticas, 2);
  assert.equal(report.nota_media, 3.25);
  assert.equal(report.taxa_positiva, '50%');
  assert.deepEqual(report.distribuicao, { '1': 1, '2': 0, '3': 1, '4': 1, '5': 1 });
  assert.equal(report.integridade.avaliacoes_invalidas, 1);
});
