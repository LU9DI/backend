// Utilitários para controle de plano e data
/**
 * Extrai o plano (e.g., 'trial', 'ultra', 'corporativo') do token JWT presente no header Authorization.
 * Caso não haja token ou seja impossível decodificar, retorna 'trial'.
 */
export function getPlanFromRequest(req) {
    const authHeader = req?.headers?.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token)
        return 'trial';
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        return payload.plan ?? 'trial';
    }
    catch {
        return 'trial';
    }
}
/** Retorna o mês corrente no formato YYYY-MM */
export function getCurrentMonth() {
    return new Date().toISOString().slice(0, 7);
}

