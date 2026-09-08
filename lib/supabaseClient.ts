import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim();

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Supabase environment variables missing. Set SUPABASE_URL and SUPABASE_ANON_KEY in .env');
}

/**
 * Shared Supabase client instance.
 * Use `supabase.auth` for authentication and `supabase.from` for queries.
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
