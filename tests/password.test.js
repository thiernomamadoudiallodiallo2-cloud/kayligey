import test from 'node:test';import assert from 'node:assert/strict';import bcrypt from 'bcryptjs';
import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';
import {__setDriver} from '../netlify/functions/lib/db.js';import {sha256} from '../netlify/functions/lib/util.js';
const pg=new PGlite();
__setDriver(async(st,...v)=>(await pg.query(st.reduce((a,s,i)=>a+(i?'$'+i:'')+s,''),v)).rows);
await pg.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
const api=(await import('../netlify/functions/api.js')).default;
const hash=await bcrypt.hash('AncienMotDePasse1',4);
const u=(await pg.query(`INSERT INTO users(role,status,nom,tel,pwd_hash,consent_version,consent_at) VALUES('patient','active','Pat Test','771110000',$1,'t',now()) RETURNING id`,[hash])).rows[0];
const sess=async t=>pg.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[u.id,sha256(t)]);
await sess('tokA'+'x'.repeat(30));await sess('tokB'+'x'.repeat(30));
const call=async(tok,body)=>{const r=await api(new Request('https://x.sn/api/auth/change-password',{method:'POST',headers:{'content-type':'application/json','x-requested-with':'kayligey',...(tok?{cookie:'kay_session='+tok}:{})},body:JSON.stringify(body)}));return {s:r.status,b:await r.json()};};
const A='tokA'+'x'.repeat(30),B='tokB'+'x'.repeat(30);
test('changement de mot de passe : connexion obligatoire',async()=>{assert.equal((await call(null,{current:'AncienMotDePasse1',password:'NouveauMdp12345'})).s,401);});
test('refus : ancien mot de passe faux, nouveau trop faible ou identique',async()=>{
  assert.equal((await call(A,{current:'faux',password:'NouveauMdp12345'})).s,400);
  assert.equal((await call(A,{current:'AncienMotDePasse1',password:'court1'})).s,400);
  assert.equal((await call(A,{current:'AncienMotDePasse1',password:'AncienMotDePasse1'})).s,400);
  assert.equal(await bcrypt.compare('AncienMotDePasse1',(await pg.query(`SELECT pwd_hash FROM users WHERE id=$1`,[u.id])).rows[0].pwd_hash),true);
});
test('succès : nouveau mot de passe actif, session courante conservée, autres appareils déconnectés, journal sans secret',async()=>{
  const r=await call(A,{current:'AncienMotDePasse1',password:'NouveauMdp12345'});assert.equal(r.s,200);
  const row=(await pg.query(`SELECT pwd_hash FROM users WHERE id=$1`,[u.id])).rows[0];
  assert.equal(await bcrypt.compare('NouveauMdp12345',row.pwd_hash),true);
  const left=(await pg.query(`SELECT token_hash FROM sessions WHERE user_id=$1`,[u.id])).rows.map(x=>x.token_hash);
  assert.deepEqual(left,[sha256(A)]);assert.ok(!left.includes(sha256(B)));
  const a=(await pg.query(`SELECT event,meta FROM audit_log WHERE event='password_changed'`)).rows;assert.equal(a.length,1);
  assert.ok(!JSON.stringify(a).includes('NouveauMdp'));
});
