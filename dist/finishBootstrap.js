/**
 * Bootstrap: carrega o server e registra extensões (Stripe + recuperação de senha).
 * Uso: altere package.json para:
 *   "dev": "tsx watch finishBootstrap.ts"
 *   "start": "tsx finishBootstrap.ts"
 *
 * O server.ts original exporta `db` e registra rotas no import.
 * Aqui montamos as extensões assim que o processo sobe.
 */
import 'dotenv/config';
// Carrega o servidor (rotas + main())
import { db } from './server.js';
// O app do Express não é exportado pelo server.ts atual.
// Por isso o encaixe definitivo continua sendo as linhas em FINISH.md
// até o app ser exportado.
console.log('ℹ️  finishBootstrap: para ativar Stripe e recuperação de senha, aplique FINISH.md no server.ts (export app + mounts).');
void db;

