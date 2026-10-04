/** Validação simples de formato de e-mail (uma arroba e um ponto no domínio, sem espaços). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: unknown): boolean {
  return EMAIL_RE.test(String(value ?? '').trim().slice(0, 320));
}
