import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

console.log('🔧 Starting test user creation...');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

(async () => {
  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email: 'test_user_20260901@example.com',
      password: 'TestUser!2026',
      email_confirm: true,
      user_metadata: {
        nome_funcionario: 'Teste',
        empresa_id: 'test-empresa',
        role: 'user'
      }
    });
    if (error) {
      console.error('❌ Error creating user:', error);
      process.exit(1);
    }
    console.log('✅ User created:', data);
  } catch (e) {
    console.error('❌ Unexpected error:', e);
    process.exit(1);
  }
})();
