import {neon} from '@neondatabase/serverless';
let _sql;
export const sql=(...a)=>{
  if(!_sql){
    if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL non configurée');
    _sql=neon(process.env.DATABASE_URL);
  }
  return _sql(...a);
};
export const __setDriver=fn=>{_sql=fn;}; // tests uniquement
export async function audit(userId,event,ip,meta={}){
  try{await sql`INSERT INTO audit_log(user_id,event,ip,meta) VALUES(${userId},${event},${ip},${JSON.stringify(meta)})`;}catch(e){console.error('audit',e.message);}
}
// true si plus de `limit` actions dans la fenêtre de `windowSec` secondes
export async function rateLimited(key,limit,windowSec){
  const r=await sql`INSERT INTO rate_limits(key,count,window_start) VALUES(${key},1,now())
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN rate_limits.window_start < now()-make_interval(secs=>${windowSec}) THEN 1 ELSE rate_limits.count+1 END,
      window_start=CASE WHEN rate_limits.window_start < now()-make_interval(secs=>${windowSec}) THEN now() ELSE rate_limits.window_start END
    RETURNING count`;
  return r[0].count>limit;
}
