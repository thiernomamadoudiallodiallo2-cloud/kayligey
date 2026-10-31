import test from 'node:test';import assert from 'node:assert/strict';import bcrypt from 'bcryptjs';
import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';
import {seedTest,TEST_USERS} from '../netlify/functions/lib/seed.js';import {diagnostic} from '../netlify/functions/lib/diagnostic.js';
const schema=readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;','');
const mk=async()=>{const pg=new PGlite();await pg.exec(schema);return {pg,q:async(t,p=[])=>(await pg.query(t,p)).rows};};
test('refus sans variable explicite ou sur une base contenant de vrais comptes',async()=>{
  const {q}=await mk();await assert.rejects(seedTest(q,{allow:undefined}),/KAY_ALLOW_SEED/);
  await q(`INSERT INTO users(role,status,nom,tel,pwd_hash,consent_version,consent_at) VALUES('patient','active','Vraie Personne','771234567','x','t',now())`);
  await assert.rejects(seedTest(q,{allow:'oui-base-de-test'}),/pas des comptes de test/);
  assert.equal((await q(`SELECT count(*)::int n FROM drugs`))[0].n,0);                           // rien n'a été écrit
});
test('création complète des comptes de test, idempotente, mot de passe fort affiché une seule fois',async()=>{
  const {q}=await mk();const a=await seedTest(q,{allow:'oui-base-de-test',videoRdv:true});
  assert.equal(a.created.length,6);assert.ok(a.password.length>=16);assert.ok(a.video_rdv);
  const u=await q(`SELECT role,status,pwd_hash,nom FROM users ORDER BY tel`);assert.ok(u.every(x=>x.nom.startsWith('[TEST]')&&x.status==='active'));
  assert.equal(await bcrypt.compare(a.password,u[0].pwd_hash),true);                              // le mot de passe affiché fonctionne, haché en base
  assert.deepEqual(u.map(x=>x.role),TEST_USERS.map(x=>x[0]));
  assert.equal((await q(`SELECT count(*)::int n FROM doctors WHERE verified_at IS NOT NULL`))[0].n,1);
  assert.equal((await q(`SELECT count(*)::int n FROM pharmacy_stock`))[0].n,2);
  assert.equal((await q(`SELECT count(*)::int n FROM drugs WHERE sur_ordonnance`))[0].n,1);
  const b=await seedTest(q,{allow:'oui-base-de-test'});assert.equal(b.created.length,0);assert.equal(b.password,null);
  assert.equal((await q(`SELECT count(*)::int n FROM users`))[0].n,6);assert.equal((await q(`SELECT count(*)::int n FROM drugs`))[0].n,2);
  assert.equal((await q(`SELECT count(*)::int n FROM appointments WHERE mode='video' AND status='confirmed'`))[0].n,1);
});
test('diagnostic : compteurs seulement, aucune donnée personnelle',async()=>{
  const {q}=await mk();await seedTest(q,{allow:'oui-base-de-test'});
  await q(`INSERT INTO outbox(notification_id,user_id,channel,to_addr,status,last_error) SELECT n.id,n.user_id,'sms','+221700000002','failed','HTTP 401' FROM (SELECT 1) x JOIN LATERAL (SELECT 1) y ON true LEFT JOIN notifications n ON false`).catch(()=>{});
  const d=await diagnostic(q);const txt=JSON.stringify(d);
  assert.equal(d.comptes_par_role_et_statut['pharmacien/active'],1);assert.equal(d.anomalies_paiement.reussis_sans_recu,0);
  assert.ok(!/700000|\[TEST\]|@|\+221|Patient|Dr /.test(txt));                                   // ni téléphone, ni nom, ni adresse e-mail
});
