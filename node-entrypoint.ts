import { startServer } from './server.ts';

startServer().catch((error) => {
  console.error('❌ Falha ao iniciar a API Filtra.IA:', error);
  process.exit(1);
});
