/**
 * Política de senha forte (empresas + reset).
 * Mín. 12 caracteres, maiúscula, minúscula, número e símbolo.
 */
const ESPECIAL = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/;

export function validarSenhaEmpresa(senha: string): { ok: true } | { ok: false; error: string } {
  const s = String(senha || '');
  if (s.length < 12) {
    return { ok: false, error: 'A senha deve ter pelo menos 12 caracteres.' };
  }
  if (!/[a-z]/.test(s)) {
    return { ok: false, error: 'A senha deve conter pelo menos uma letra minúscula.' };
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

/** Alias usado por lib/security e rotas novas. */
export function validateStrongPassword(password: string): {
  ok: boolean;
  error?: string;
} {
  const r = validarSenhaEmpresa(password);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export const SENHA_EMPRESA_HINT =
  'Mín. 12 caracteres, maiúscula, minúscula, número e símbolo (!@#$%)';
