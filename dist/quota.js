// Quota enforcement utilities
import { db } from './server.js';
import { getCurrentMonth } from './planUtils.js';
/** Verify IA usage quota for a given plan and type (tags or respostas) */
export async function checkQuota(plan, type) {
    const month = getCurrentMonth();
    const row = await db.get(`SELECT ${type} FROM usage WHERE plan = ? AND month = ?`, [plan, month]);
    const limit = plan === 'ultra' ? 4000 : 20000; // adjust as needed
    if (row && row[type] >= limit) {
        throw new Error(`Limite mensal de ${type} para o plano ${plan} atingido`);
    }
    await db.run(`INSERT INTO usage (plan, month, ${type}) VALUES (?, ?, 1)
    ON CONFLICT(plan, month) DO UPDATE SET ${type} = ${type} + 1`, [plan, month]);
}

