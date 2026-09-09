/**
 * Wrapper bcryptjs (API compatível com bcrypt).
 * Evita dependências nativas (node-gyp / tar) no Docker.
 */
import bcryptjs from 'bcryptjs';

export async function hash(data: string, rounds: number | string = 12): Promise<string> {
  const saltRounds = typeof rounds === 'string' ? parseInt(rounds, 10) || 12 : rounds;
  return bcryptjs.hash(data, saltRounds);
}

export async function compare(data: string, encrypted: string): Promise<boolean> {
  return bcryptjs.compare(data, encrypted);
}

export default { hash, compare };
