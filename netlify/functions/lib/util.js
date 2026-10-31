import crypto from 'node:crypto';
export const sha256=s=>crypto.createHash('sha256').update(s).digest('hex');
export const newToken=()=>crypto.randomBytes(32).toString('base64url');
export const resetCode=()=>String(crypto.randomInt(100000,1000000));
// Numéros sénégalais : 70/75/76/77/78 + 7 chiffres, avec ou sans +221
export function normalizePhone(v){
  let d=String(v||'').replace(/[\s.\-()]/g,'').replace(/^\+?221/,'');
  return /^7[05678]\d{7}$/.test(d)?d:null;
}
export const validEmail=e=>/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e);
export function passwordIssue(p){
  if(typeof p!=='string'||p.length<10||p.length>128)return 'Le mot de passe doit contenir 10 à 128 caractères.';
  if(!/[A-Za-z]/.test(p)||!/\d/.test(p))return 'Le mot de passe doit contenir des lettres et des chiffres.';
  return null;
}
export const clean=(s,max=120)=>String(s||'').replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,max);
export const json=(status,body,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}});
export const getIp=req=>req.headers.get('x-nf-client-connection-ip')||(req.headers.get('x-forwarded-for')||'').split(',')[0].trim()||'inconnue';
export const SESSION_HOURS=12;
export const sessionCookie=(t,sec)=>`kay_session=${t}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${sec}`;
export function readCookie(req,name){
  const m=(req.headers.get('cookie')||'').split(/;\s*/).find(c=>c.startsWith(name+'='));
  return m?m.slice(name.length+1):null;
}
