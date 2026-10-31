import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';
import {__setDriver} from '../netlify/functions/lib/db.js';import {sha256} from '../netlify/functions/lib/util.js';
const pg=new PGlite();const good=async(st,...v)=>(await pg.query(st.reduce((a,s,i)=>a+(i?'$'+i:'')+s,''),v)).rows;__setDriver(good);
await pg.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
process.env.APP_ORIGIN='https://kay.test';
const api=(await import('../netlify/functions/api.js')).default;
const {purgeExpired}=await import('../netlify/functions/lib/maintenance.js');
let n=0;
async function mk(role,status='active'){const tok='t'+(++n)+'s'.repeat(30);const u=(await pg.query(`INSERT INTO users(role,status,nom,tel,pwd_hash,consent_version,consent_at) VALUES($1,$2,$3,$4,'x','t',now()) RETURNING id`,[role,status,role+n,'78'+String(6000000+n)])).rows[0];
  await pg.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[u.id,sha256(tok)]);return {id:u.id,tok};}
const raw=(who,m,p,b,hdr={})=>api(new Request('https://x.sn'+p,{method:m,headers:{'content-type':'application/json','x-requested-with':'kayligey',origin:'https://kay.test',...hdr,...(who?{cookie:'kay_session='+who.tok}:{})},body:m==='GET'?undefined:(typeof b==='string'?b:JSON.stringify(b||{}))}));
const call=async(w,m,p,b)=>{const r=await raw(w,m,p,b);let j={};try{j=await r.json();}catch{}return {s:r.status,b:j};};
const R={patient:await mk('patient'),medecin:await mk('medecin'),prestataire:await mk('prestataire'),admin:await mk('admin')};
const ID='11111111-1111-1111-1111-111111111111';

test('matrice des rôles : chaque route protégée refuse les rôles non prévus et les visiteurs',async()=>{
  const M=[['/api/record',['patient']],['/api/payments',['patient']],['/api/dependents',['patient']],['/api/doctor/patients',['medecin']],['/api/doctor/children',['medecin']],['/api/doctor/slots',['medecin']],
    ['/api/doctor/profile',['medecin']],['/api/doctor/revenue',['medecin']],['/api/prescriptions',['patient','medecin']],['/api/conversations',['patient','medecin']],['/api/appointments',['patient','medecin']],
    ['/api/admin/pending',['admin']],['/api/admin/doctors/pending',['admin']],['/api/admin/reconciliation',['admin']],['/api/admin/notifications',['admin']],['/api/admin/deletion-requests',['admin']],['/api/admin/payments',['admin']]];
  for(const [p,allowed] of M){
    assert.equal((await call(null,'GET',p)).s,401,'visiteur '+p);
    for(const role of Object.keys(R)){const s=(await call(R[role],'GET',p)).s;
      if(allowed.includes(role))assert.ok(s<400,`${role} devrait accéder à ${p} (reçu ${s})`);else assert.ok([401,403].includes(s),`${role} ne doit pas accéder à ${p} (reçu ${s})`);}
  }
});
test('anti-CSRF : toute écriture sans en-tête ou avec une autre origine est refusée',async()=>{
  const P=['/api/auth/logout','/api/appointments','/api/doctor/profile','/api/doctor/slots','/api/payments/checkout','/api/record/entries','/api/record/access','/api/prescriptions','/api/documents','/api/conversations','/api/dependents','/api/notifications/read','/api/notifications/prefs','/api/account/delete-request',`/api/admin/users/${ID}/status`,`/api/admin/doctors/${ID}/verify`];
  for(const p of P){
    assert.equal((await raw(R.patient,'POST',p,{},{'x-requested-with':''})).status,403,'sans en-tête '+p);
    assert.equal((await raw(R.patient,'POST',p,{},{origin:'https://evil.example'})).status,403,'origine étrangère '+p);
  }
});
test('injections et corps malformés : aucune erreur serveur, aucune table touchée',async()=>{
  const bad="'; DROP TABLE users; --";
  assert.equal((await call(null,'GET',`/api/doctors?q=${encodeURIComponent(bad)}&specialite=${encodeURIComponent(bad)}&ville=${encodeURIComponent(bad)}`)).s,200);
  assert.equal((await call(null,'POST','/api/auth/login',{ident:bad,password:bad})).s,401);
  assert.equal((await call(null,'POST','/api/auth/register',{nom:bad,tel:bad,password:bad,consent:true})).s,400);
  for(const p of ['/api/auth/login','/api/auth/register','/api/appointments','/api/record/entries']){
    const r=await raw(R.patient,'POST',p,'{pas du json');assert.ok(r.status>=400&&r.status<500,p+' → '+r.status);}
  assert.equal((await call(R.patient,'GET','/api/doctors/pas-un-uuid/slots')).s,400);
  assert.ok((await pg.query(`SELECT count(*)::int n FROM users`)).rows[0].n>=4);
});
test('session : cookie HttpOnly/Secure/SameSite, jeton stocké haché, déconnexion, expiration, compte suspendu',async()=>{
  const reg=await call(null,'POST','/api/auth/register',{nom:'Awa Sow',tel:'771234567',password:'Motdepasse2026ok',consent:true});assert.equal(reg.s,201);
  const lg=await raw(null,'POST','/api/auth/login',{ident:'77 123 45 67',password:'Motdepasse2026ok'});assert.equal(lg.status,200);
  const ck=lg.headers.get('set-cookie');assert.match(ck,/HttpOnly/);assert.match(ck,/Secure/);assert.match(ck,/SameSite=Strict/);assert.equal(lg.headers.get('cache-control'),'no-store');
  const tok=/kay_session=([^;]+)/.exec(ck)[1];
  assert.equal((await pg.query(`SELECT count(*)::int n FROM sessions WHERE token_hash=$1`,[tok])).rows[0].n,0);                 // jamais en clair
  assert.equal((await pg.query(`SELECT count(*)::int n FROM sessions WHERE token_hash=$1`,[sha256(tok)])).rows[0].n,1);
  const me={tok};assert.equal((await call(me,'GET','/api/auth/me')).s,200);
  await pg.query(`UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1`,[sha256(tok)]);assert.equal((await call(me,'GET','/api/auth/me')).s,401); // expirée
  const lg2=await raw(null,'POST','/api/auth/login',{ident:'771234567',password:'Motdepasse2026ok'});const t2={tok:/kay_session=([^;]+)/.exec(lg2.headers.get('set-cookie'))[1]};
  assert.equal((await call(t2,'POST','/api/auth/logout',{})).s,200);assert.equal((await call(t2,'GET','/api/auth/me')).s,401);       // déconnexion effective côté serveur
  for(let i=0;i<5;i++)await raw(null,'POST','/api/auth/login',{ident:'771234567',password:'faux-mot-de-passe-'+i});
  assert.equal((await call(null,'POST','/api/auth/login',{ident:'771234567',password:'Motdepasse2026ok'})).s,423);                // verrouillé même avec le bon mot de passe
  await pg.query(`UPDATE users SET locked_until=NULL,status='suspended' WHERE tel='771234567'`);
  assert.equal((await call(null,'POST','/api/auth/login',{ident:'771234567',password:'Motdepasse2026ok'})).s,403);                // suspendu
});
test('erreurs internes : aucune fuite de détails techniques',async()=>{
  __setDriver(async()=>{throw new Error('connection to host=db.secret.internal password=hunter2 failed');});
  const r=await raw(R.patient,'GET','/api/record');const t=await r.text();__setDriver(good);
  assert.equal(r.status,500);assert.ok(!/secret|hunter2|host=|stack|at /.test(t),t);
});
test('suppression de compte : demande, traitement admin, anonymisation, conservation des données médicales',async()=>{
  const p=await mk('patient');await pg.query(`INSERT INTO record_entries(patient_id,author_id,author_role,kind,title,body,status,finalized_at) VALUES($1,$1,'patient','allergie','Arachide','','finalise',now())`,[p.id]);
  assert.equal((await call(p,'POST','/api/account/delete-request',{})).s,201);assert.equal((await call(p,'POST','/api/account/delete-request',{})).s,409);
  assert.equal((await call(R.admin,'POST','/api/account/delete-request',{})).s,403);
  const id=(await call(R.admin,'GET','/api/admin/deletion-requests')).b.demandes.find(d=>d.nom===p.nom||d.status==='pending').id;
  assert.equal((await call(p,'POST',`/api/admin/deletion-requests/${id}/resolve`,{decision:'done',note:'ok'})).s,403);
  assert.equal((await call(R.admin,'POST',`/api/admin/deletion-requests/${id}/resolve`,{decision:'done',note:''})).s,400);
  assert.equal((await call(R.admin,'POST',`/api/admin/deletion-requests/${id}/resolve`,{decision:'done',note:'Demande de la personne concernée'})).s,200);
  const u=(await pg.query(`SELECT nom,email,status FROM users WHERE id=$1`,[p.id])).rows[0];assert.deepEqual([u.nom,u.email,u.status],['Compte supprimé',null,'suspended']);
  assert.equal((await call(p,'GET','/api/auth/me')).s,401);
  assert.equal((await pg.query(`SELECT count(*)::int n FROM record_entries WHERE patient_id=$1`,[p.id])).rows[0].n,1);                 // conservation à valider juridiquement
});
test('maintenance : purge des données techniques périmées seulement',async()=>{
  await pg.query(`INSERT INTO rate_limits(key,count,window_start) VALUES('vieux',1,now()-interval '3 days'),('recent',1,now())`);
  await pg.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,'vieille',now()-interval '1 day')`,[R.patient.id]);
  const r=await purgeExpired();assert.ok(r.limiteurs>=1&&r.sessions>=1);
  assert.equal((await pg.query(`SELECT count(*)::int n FROM rate_limits WHERE key='recent'`)).rows[0].n,1);
});
test('inscription d\u2019un médecin : compte « en attente », connexion impossible jusqu\u2019à validation par un administrateur',async()=>{
  const r=await call(null,'POST','/api/auth/register',{nom:'Dr Ndiaye',tel:'761234567',password:'Motdepasse2026ok',role:'medecin',consent:true});assert.equal(r.s,201);assert.equal(r.b.user.status,'pending');
  assert.equal((await call(null,'POST','/api/auth/register',{nom:'Pirate',tel:'761234568',password:'Motdepasse2026ok',role:'admin',consent:true})).s,400); // pas d'auto-inscription admin
  assert.equal((await call(null,'POST','/api/auth/login',{ident:'761234567',password:'Motdepasse2026ok'})).s,403);
  assert.equal((await call(R.admin,'POST',`/api/admin/users/${r.b.user.id}/status`,{status:'active'})).s,200);
  assert.equal((await call(null,'POST','/api/auth/login',{ident:'761234567',password:'Motdepasse2026ok'})).s,200);
});
