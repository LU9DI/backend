import { Client } from 'pg';
const sourceUrl=(process.env.DATABASE_URL||'').trim();
const targetPassword=(process.env.SUPABASE_DB_PASSWORD||'').trim();
const targetHost=(process.env.SUPABASE_DB_HOST||'aws-0-us-west-2.pooler.supabase.com').trim();
const targetUser=(process.env.SUPABASE_DB_USER||'postgres.xutrgqurdrpujxjraynm').trim();
const targetDb=(process.env.SUPABASE_DB_NAME||'postgres').trim();
const targetPort=Number(process.env.SUPABASE_DB_PORT||5432);
const marker='render-to-supabase-2026-09-21-v1';
const q=(s:string)=>'"'+s.replaceAll('"','""')+'"';

export async function main(){
 if(!sourceUrl) throw new Error('DATABASE_URL não configurada.');
 if(!targetPassword) throw new Error('SUPABASE_DB_PASSWORD não configurada.');
 let sourceInfo='unknown';
 try{const u=new URL(sourceUrl);sourceInfo=u.username+'@'+u.hostname+':'+(u.port||'5432')+'/'+u.pathname.replace(/^\//,'');}catch{}
 console.log('[MIGRATION] source='+sourceInfo+' target='+targetUser+'@'+targetHost+':'+targetPort+'/'+targetDb);
 const source=new Client({connectionString:sourceUrl,ssl:{rejectUnauthorized:false}});
 const targetConfig={host:targetHost,port:targetPort,database:targetDb,user:targetUser,password:targetPassword,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000};
 console.log('[MIGRATION] target password present='+String(Boolean(targetPassword))+' length='+String(targetPassword.length));
 let target=new Client(targetConfig);
 try{
  await source.connect(); console.log('[MIGRATION] source connected');
  try { await target.connect(); console.log('[MIGRATION] target connected as '+targetUser); }
  catch (err:any) {
   await target.end().catch(()=>{});
   if (targetUser !== 'postgres' && String(err?.code||'') === '28P01') {
    console.log('[MIGRATION] pooler rejected project-scoped user; retrying as postgres');
    target=new Client({...targetConfig,user:'postgres'});
    await target.connect(); console.log('[MIGRATION] target connected as postgres');
   } else throw err;
  }
  await target.query('CREATE TABLE IF NOT EXISTS "__filtra_migrations" (id text PRIMARY KEY, completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, details jsonb)');
  if((await target.query('SELECT 1 FROM "__filtra_migrations" WHERE id=$1',[marker])).rowCount) return;
  const tables=(await source.query("SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname")).rows;
  const report:Record<string,number>={};
  for(const t of tables){
   const table=String(t.table_name);
   const cols=(await source.query("SELECT a.attname name,format_type(a.atttypid,a.atttypmod) type,a.attnotnull not_null,pg_get_expr(d.adbin,d.adrelid) default_expr,a.attidentity identity_kind FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",[table])).rows;
   const existing=(await target.query("SELECT column_name name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).rows;
   const have=new Set(existing.map((r:any)=>r.name));
   if(!existing.length){
    const defs=cols.map((c:any)=>{let d=q(c.name)+' '+c.type;if(c.identity_kind)d+=' GENERATED '+(c.identity_kind==='a'?'ALWAYS':'BY DEFAULT')+' AS IDENTITY';else if(c.default_expr)d+=' DEFAULT '+c.default_expr;if(c.not_null)d+=' NOT NULL';return d;});
    await target.query('CREATE TABLE '+q(table)+' ('+defs.join(', ')+')');
   }else{
    for(const c of cols){if(have.has(c.name))continue;let s='ALTER TABLE '+q(table)+' ADD COLUMN '+q(c.name)+' '+c.type;if(c.default_expr)s+=' DEFAULT '+c.default_expr;if(c.not_null)s+=' NOT NULL';await target.query(s);}
   }
   const n=Number((await source.query('SELECT COUNT(*)::bigint n FROM '+q(table))).rows[0].n);
   const dn=Number((await target.query('SELECT COUNT(*)::bigint n FROM '+q(table))).rows[0].n);
   if(dn!==0)throw new Error('Tabela destino não está vazia: '+table);
   const names=cols.map((c:any)=>c.name);
   if(n){
    const rows=(await source.query('SELECT * FROM '+q(table))).rows;
    for(let i=0;i<rows.length;i+=200){const batch=rows.slice(i,i+200);const vals:any[]=[];const tuples=batch.map((r:any)=>'('+names.map((name:string)=>{vals.push(r[name]);return '$'+vals.length;}).join(',')+')').join(',');await target.query('INSERT INTO '+q(table)+' ('+names.map(q).join(',')+') VALUES '+tuples,vals);}
   }
   for(const c of cols){const s=(await source.query('SELECT pg_get_serial_sequence($1,$2) seq',['public.'+table,c.name])).rows[0]?.seq;if(s){const max=(await target.query('SELECT MAX('+q(c.name)+') max FROM '+q(table))).rows[0].max;if(max!==null)await target.query('SELECT setval($1::regclass,$2,true)',[String(s).split('.').pop().replaceAll('"',''),max]);}}
   report[table]=n;
  }
  for(const t of tables){const table=String(t.table_name);const n=Number((await target.query('SELECT COUNT(*)::bigint n FROM '+q(table))).rows[0].n);if(n!==report[table])throw new Error('Validação falhou em '+table);}
  await target.query('INSERT INTO "__filtra_migrations"(id,details) VALUES($1,$2)',[marker,JSON.stringify(report)]);
  console.log('Migração Render -> Supabase concluída.',report);
 }finally{await Promise.allSettled([source.end(),target.end()]);}
}