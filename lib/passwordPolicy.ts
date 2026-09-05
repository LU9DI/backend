/**
 * Política de senha para contas de EMPRESA (trial / reset).
 */
const ESPECIAL = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/;

export function validarSenhaEmpresa(senha: string): { ok: true } | { ok: false; error: string } {
  const s = String(senha || '');
  if (s.length < 8) {
    return { ok: false, error: 'A senha deve ter pelo menos 8 caracteres.' };
  }
  if (!/[A-Z]/.test(s)) {
    return { ok: false, error: 'A senha deve conter pelo menos uma letra maiúscula.' };
  }
  if (!/[0-9]/.test(s)) {
    return { ok: false, error: 'A senha deve conter pelo menos um número.' };
  }
  if (!ESPECIAL.test(s)) {
    return {
      ok: false,
      error: 'A senha deve conter pelo menos um caractere especial (ex.: !@#$%).',
    };
  }
  return { ok: true };
}

export const SENHA_EMPRESA_HINT =
  'Mín. 8 caracteres, 1 maiúscula, 1 número e 1 especial (!@#$%)';
