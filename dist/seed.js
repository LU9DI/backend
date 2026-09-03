import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
// ------------------------------------------------------------
// Seed script – cria uma empresa de exemplo e um usuário (funcionário)
// ------------------------------------------------------------
// Ajuste as constantes abaixo antes de executar.
const EXAMPLE_CNPJ = '12345678000199'; // CNPJ da empresa (apenas números)
const EXAMPLE_NOME_EMPRESA = 'Empresa Exemplo Ltda';
const EXAMPLE_NOME_FUNCIONARIO = 'Ana Silva';
const EXAMPLE_SENHA = 'SenhaSegura123!';
async function getDbPath() {
    const isProd = process.env.NODE_ENV === 'production';
    const dbPath = process.env.SQLITE_DB_PATH || (isProd ? '/data/database.sqlite' : path.resolve(__dirname, '..', 'data', 'database.sqlite'));
    // garante diretório
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    return dbPath;
}
async function main() {
    const dbPath = await getDbPath();
    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    // 1️⃣ Inserir empresa (se ainda não existir)
    const empresaExiste = await db.get('SELECT id FROM empresas WHERE cnpj = ?', [EXAMPLE_CNPJ]);
    if (empresaExiste) {
        console.log('⚠️  Empresa já existe com id', empresaExiste.id);
        await db.close();
        return;
    }
    const empresaId = crypto.randomUUID();
    const slug = EXAMPLE_NOME_EMPRESA
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'empresa';
    const criadoEm = new Date().toISOString();
    const expiraEm = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 dias de trial
    await db.run(`INSERT INTO empresas (id, cnpj, nome_empresa, slug, status, plan, criado_em, expira_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [empresaId, EXAMPLE_CNPJ, EXAMPLE_NOME_EMPRESA, slug, 'trial', 'trial', criadoEm, expiraEm]);
    console.log('✅  Empresa criada com id', empresaId);
    // 2️⃣ Inserir usuário/funcionário
    const senhaHash = await bcrypt.hash(EXAMPLE_SENHA, 10);
    const usuarioId = crypto.randomUUID();
    await db.run(`INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash) VALUES (?, ?, ?, ?, ?)`, [usuarioId, EXAMPLE_CNPJ, EXAMPLE_NOME_FUNCIONARIO, empresaId, senhaHash]);
    console.log('✅  Usuário criado – CNPJ', EXAMPLE_CNPJ, 'Nome', EXAMPLE_NOME_FUNCIONARIO);
    await db.close();
}
main().catch((e) => {
    console.error('❌ Erro ao executar seed:', e);
    process.exit(1);
});
