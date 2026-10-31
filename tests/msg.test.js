import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';
import {__setDriver} from '../netlify/functions/lib/db.js';import {sha256} from '../netlify/functions/lib/util.js';
import {__setBlobDriver} from '../netlify/functions/lib/blobs.js';
const pg=new PGlite();__setDriver(async(st,...v)=>(await pg.query(st.reduce((a,s,i)=>a+(i?'$'+i:'')+s,''),v)).rows);
const mem=new Map();__setBlobDriver({put:async(k,b)=>{mem.set(k,Buffer.from(b));},get:async k=>mem.get(k)||null});
await pg.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
process.env.DOC_LINK_SECRET='s'.repeat(40);
const api=(await import('../netlify/functions/api.js')).default;
let n=0;
async function mk(role){const tok='t'+(++n)+'m'.repeat(30);const u=(await pg.query(`INSERT INTO users(role,status,nom,tel,pwd_hash,consent_version,consent_at) VALUES($1,'active',$2,$3,'x','t',now()) RETURNING id`,[role,role+n,'75'+String(4000000+n)])).rows[0];
  await pg.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[u.id,sha256(tok)]);return {id:u.id,tok};}
const raw=(who,m,p,b)=>api(new Request('https://x.sn'+p,{method:m,headers:{'content-type':'application/json','x-requested-with':'kayligey',...(who?{cookie:'kay_session='+who.tok}:{})},body:m==='GET'?undefined:JSON.stringify(b||{})}));
const call=async(w,m,p,b)=>{const r=await raw(w,m,p,b);return {s:r.status,b:await r.json()};};
const q=async(s,p=[])=>(await pg.query(s,p)).rows;
const doc=await mk('medecin'),doc2=await mk('medecin'),pA=await mk('patient'),pB=await mk('patient'),adm=await mk('admin');
for(const d of [doc,doc2])await pg.query(`INSERT INTO doctors(user_id,specialite,ville,tarif_fcfa,modes,numero_ordre,verified_at) VALUES($1,'Généraliste','Thiès',0,'{cabinet}','SN-'||$2,now())`,[d.id,d.id.slice(0,4)]);
const slot=(await pg.query(`INSERT INTO availability_slots(doctor_id,starts_at,ends_at,status) VALUES($1,now()+interval '2 days',now()+interval '2 days 30 minutes','booked') RETURNING id`,[doc.id])).rows[0].id;
const apt=(await pg.query(`INSERT INTO appointments(slot_id,patient_id,doctor_id,mode,motif,status,consent_at) VALUES($1,$2,$3,'cabinet','Suivi','confirmed',now()) RETURNING id`,[slot,pA.id,doc.id])).rows[0].id;
const cid=()=>crypto.randomUUID();let conv;

test('ouverture : lien de soin obligatoire, conversation unique, rôles',async()=>{
  assert.equal((await call(pA,'POST','/api/conversations',{withUserId:doc2.id})).s,403);
  assert.equal((await call(pB,'POST','/api/conversations',{withUserId:doc.id})).s,403);
  conv=(await call(pA,'POST','/api/conversations',{withUserId:doc.id})).b.id;
  assert.equal((await call(doc,'POST','/api/conversations',{withUserId:pA.id})).b.id,conv);
  assert.equal((await call(adm,'GET','/api/conversations')).s,403);assert.equal((await call(null,'GET','/api/conversations')).s,401);
});
test('envoi : doublon évité au renvoi, message vide refusé, notification sans contenu',async()=>{
  const id=cid();const a=await call(pA,'POST',`/api/conversations/${conv}/messages`,{body:'Bonjour docteur, j\u2019ai mal à la tête depuis 3 jours.',clientId:id});assert.equal(a.s,201);
  const b=await call(pA,'POST',`/api/conversations/${conv}/messages`,{body:'Bonjour docteur, j\u2019ai mal à la tête depuis 3 jours.',clientId:id});assert.equal(b.b.deja_recu,true);
  assert.equal((await q(`SELECT count(*)::int c FROM messages`))[0].c,1);
  assert.equal((await call(pA,'POST',`/api/conversations/${conv}/messages`,{body:'  ',clientId:cid()})).s,400);
  assert.equal((await call(pA,'POST',`/api/conversations/${conv}/messages`,{body:'x'})).s,400);
  const nt=await q(`SELECT body FROM notifications WHERE user_id=$1 AND kind='message'`,[doc.id]);assert.equal(nt.length,1);assert.ok(!/tête|mal/.test(nt[0].body)); // pas de contenu
});
test('confidentialité : un tiers ne peut ni lire ni écrire',async()=>{
  for(const w of [pB,doc2,adm]){const r=await call(w,'GET',`/api/conversations/${conv}/messages`);assert.ok([403,404].includes(r.s));
    assert.ok([403,404].includes((await call(w,'POST',`/api/conversations/${conv}/messages`,{body:'intrus',clientId:cid()})).s));}
  assert.equal((await call(doc2,'GET','/api/conversations')).b.conversations.length,0);
});
test('accusés de lecture, non lus et récupération incrémentale',async()=>{
  assert.equal((await call(doc,'GET','/api/conversations')).b.conversations[0].non_lus,1);
  const l=(await call(doc,'GET',`/api/conversations/${conv}/messages`)).b;assert.equal(l.messages.length,1);assert.equal(l.messages[0].moi,false);
  assert.equal((await call(doc,'GET','/api/conversations')).b.conversations[0].non_lus,0);
  assert.equal((await call(pA,'GET',`/api/conversations/${conv}/messages`)).b.messages[0].lu,true); // le patient voit « lu »
  await call(doc,'POST',`/api/conversations/${conv}/messages`,{body:'Reposez-vous et consultez si la fièvre persiste.',clientId:cid()});
  const last=l.messages[0].id;assert.equal((await call(pA,'GET',`/api/conversations/${conv}/messages?after=${last}`)).b.messages.length,1);
});
test('pièces jointes : seulement ses propres documents ; le médecin peut ouvrir celui qui lui est transmis',async()=>{
  const PDF=Buffer.concat([Buffer.from('%PDF-1.4\n'),Buffer.from('analyse')]).toString('base64');
  const d1=(await call(pA,'POST','/api/documents',{filename:'analyse.pdf',dataBase64:PDF})).b.id,dB=(await call(pB,'POST','/api/documents',{filename:'autre.pdf',dataBase64:PDF})).b.id;
  assert.equal((await call(doc,'GET',`/api/documents/${d1}/link`)).s,403);                                     // pas encore partagé
  assert.equal((await call(pA,'POST',`/api/conversations/${conv}/messages`,{clientId:cid(),body:'Voici mon analyse',documentId:dB})).s,403); // document d'un autre
  assert.equal((await call(pA,'POST',`/api/conversations/${conv}/messages`,{clientId:cid(),body:'Voici mon analyse',documentId:d1})).s,201);
  const l=(await call(doc,'GET',`/api/documents/${d1}/link`));assert.equal(l.s,200);assert.equal((await raw(doc,'GET',l.b.url)).status,200);
  assert.equal((await call(doc2,'GET',`/api/documents/${d1}/link`)).s,403);
  const dd=(await call(doc,'GET',`/api/conversations/${conv}/messages`)).b.messages.find(x=>x.document_id);assert.equal(dd.piece_jointe,'analyse.pdf');
});
test('limitation du débit, et fin de prise en charge : lecture possible, envoi bloqué',async()=>{
  await pg.query(`DELETE FROM rate_limits`);let last;
  for(let i=0;i<61;i++)last=await call(pA,'POST',`/api/conversations/${conv}/messages`,{body:'m'+i,clientId:cid()});
  assert.equal(last.s,429);await pg.query(`DELETE FROM rate_limits`);
  await pg.query(`UPDATE availability_slots SET starts_at=now()-interval '400 days',ends_at=now()-interval '400 days'+interval '30 minutes' WHERE id=$1`,[slot]);
  const g=await call(pA,'GET',`/api/conversations/${conv}/messages`);assert.equal(g.s,200);assert.equal(g.b.peut_ecrire,false);
  assert.equal((await call(pA,'POST',`/api/conversations/${conv}/messages`,{body:'encore',clientId:cid()})).s,403);
  assert.equal((await call(doc,'POST',`/api/conversations/${conv}/messages`,{body:'encore',clientId:cid()})).s,403);
});
