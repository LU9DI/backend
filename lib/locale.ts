/** Idiomas suportados na plataforma e nas respostas de IA. */

export type AppLocale = 'pt' | 'en' | 'es' | 'zh';

const ALLOWED = new Set<string>(['pt', 'en', 'es', 'zh']);

export function normalizeLocale(raw?: string | null): AppLocale {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .slice(0, 2);
  if (ALLOWED.has(s)) return s as AppLocale;
  return 'pt';
}

export function localeInstruction(locale: AppLocale): string {
  switch (locale) {
    case 'en':
      return 'Write the entire reply in English.';
    case 'es':
      return 'Escribe toda la respuesta en español.';
    case 'zh':
      return '请用简体中文撰写全部回复。';
    default:
      return 'Escreva toda a resposta em português do Brasil.';
  }
}

export function tagLanguageName(locale: AppLocale): string {
  switch (locale) {
    case 'en':
      return 'English';
    case 'es':
      return 'Spanish';
    case 'zh':
      return 'Simplified Chinese';
    default:
      return 'Brazilian Portuguese';
  }
}
