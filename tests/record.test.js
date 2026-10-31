import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';
import {__setDriver} from '../netlify/functions/lib/db.js';import {sha256} from '../netlify/functions/lib/util.js';
import {__setBlobDriver} from '../netlify/functions/lib/blobs.js';
const pg=new PGlite();
__setDriver(async(st,...v)=>(await pg.query(st.reduce((a,s,i)=>a+(i?'$'+i:'')+s,''),v)).rows);
const mem=new Map();__setBlobDriver({put:async(k,b)=>{mem.set(k,Buffer.from(b));},get:async k=>mem.get(k)||null});
await pg.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
process.env.DOC_LINK_SECRET='test-secret-link';
const api=(await import('../netlify/functions/api.js')).default;
const {signLink}=await import('../netlify/functions/lib/record.js');
let n=0;
async function mk(role){const tok='t'+(++n)+'k'.repeat(30);const u=(await pg.query(`INSERT INTO users(role,status,nom,tel,pwd_hash,consent_version,consent_at) VALUES($1,'active',$2,$3,'x','t',now()) RETURNING id`,[role,role+n,'76'+String(3000000+n)])).rows[0];
  await pg.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[u.id,sha256(tok)]);return {id:u.id,tok};}
const raw=async(who,method,path,body)=>api(new Request('https://x.sn'+path,{method,headers:{'content-type':'application/json','x-requested-with':'kayligey',...(who?{cookie:'kay_session='+who.tok}:{})},body:method==='GET'?undefined:JSON.stringify(body||{})}));
const call=async(who,m,p,b)=>{const r=await raw(who,m,p,b);return {s:r.status,b:await r.json()};};
const q=async(s,p=[])=>(await pg.query(s,p)).rows;
const doc=await mk('medecin'),doc2=await mk('medecin'),pA=await mk('patient'),pB=await mk('patient'),adm=await mk('admin'),prest=await mk('prestataire');
for(const d of [doc,doc2])await pg.query(`INSERT INTO doctors(user_id,specialite,ville,tarif_fcfa,modes,numero_ordre,verified_at) VALUES($1,'Généraliste','Thiès',0,'{cabinet}','SN-'||$2,now())`,[d.id,d.id.slice(0,4)]);
await pg.query(`INSERT INTO doctors(user_id,specialite,ville,tarif_fcfa,modes,numero_ordre) VALUES((SELECT id FROM users WHERE false LIMIT 1),'x','x',0,'{cabinet}','x') ON CONFLICT DO NOTHING`).catch(()=>{});
// rendez-vous confirmé entre doc et pA (lien de soin) ; aucun pour doc2
const sl=(await pg.query(`INSERT INTO availability_slots(doctor_id,starts_at,ends_at,status) VALUES($1,now()+interval '2 days',now()+interval '2 days 30 minutes','booked') RETURNING id`,[doc.id])).rows[0].id;
await pg.query(`INSERT INTO appointments(slot_id,patient_id,doctor_id,mode,motif,status,consent_at) VALUES($1,$2,$3,'cabinet','Suivi','confirmed',now())`,[sl,pA.id,doc.id]);

test('accès au dossier : sans lien, sans autorisation, avec les deux, révocation, expiration, journal',async()=>{
  assert.equal((await call(pA,'POST','/api/record/entries',{kind:'allergie',title:'Pénicilline',body:'Urticaire'})).s,201);
  assert.equal((await call(pA,'GET','/api/record')).b.entries.length,1);
  assert.equal((await call(pB,'GET','/api/record')).b.entries.length,0);
  assert.equal((await call(doc2,'GET',`/api/patients/${pA.id}/record`)).s,403);            // aucun lien
  assert.equal((await call(doc,'GET',`/api/patients/${pA.id}/record`)).s,403);             // lien mais pas d'autorisation
  assert.equal((await call(pA,'POST','/api/record/access',{doctorId:doc2.id})).s,409);     // partage sans rendez-vous refusé
  assert.equal((await call(pA,'POST','/api/record/access',{doctorId:doc.id,days:30})).s,200);
  assert.equal((await call(doc,'GET',`/api/patients/${pA.id}/record`)).b.entries.length,1);
  assert.equal((await call(doc2,'GET',`/api/patients/${pA.id}/record`)).s,403);
  const j=(await call(pA,'GET','/api/record/access')).b;assert.equal(j.journal.length,1);assert.equal(j.autorisations.length,1);
  await pg.query(`UPDATE record_access SET expires_at=now()-interval '1 minute' WHERE patient_id=$1`,[pA.id]);
  assert.equal((await call(doc,'GET',`/api/patients/${pA.id}/record`)).s,403);              // expirée
  assert.equal((await call(pA,'POST','/api/record/access',{doctorId:doc.id})).s,200);await call(pA,'POST',`/api/record/access/${doc.id}/revoke`,{});
  assert.equal((await call(doc,'GET',`/api/patients/${pA.id}/record`)).s,403);              // révoquée
  assert.equal((await call(pA,'POST','/api/record/access',{doctorId:doc.id})).s,200); // accordée à nouveau pour la suite
});
test('administrateur, prestataire et non connecté : aucun accès aux données médicales',async()=>{
  for(const [w,p] of [[adm,'/api/record'],[adm,`/api/patients/${pA.id}/record`],[adm,'/api/prescriptions'],[adm,'/api/documents'],[prest,'/api/record']])assert.equal((await call(w,'GET',p)).s,403);
  assert.equal((await call(null,'GET','/api/record')).s,401);
  assert.equal((await call(doc,'GET','/api/record')).s,403);   // un médecin n'a pas « son » dossier patient
});
test('constantes : validation des valeurs',async()=>{
  assert.equal((await call(pA,'POST','/api/record/entries',{kind:'constante',title:'Poids',data:{type:'poids_kg',valeur:72}})).s,201);
  assert.equal((await call(pA,'POST','/api/record/entries',{kind:'constante',title:'Poids',data:{type:'poids_kg',valeur:9999}})).s,400);
  assert.equal((await call(pA,'POST','/api/record/entries',{kind:'constante',title:'TA',data:{type:'tension',valeur:'120/80'}})).s,201);
  assert.equal((await call(pA,'POST','/api/record/entries',{kind:'note',title:'x'})).s,400); // le patient ne crée pas de « note médicale »
});
let note;
test('note médicale : brouillon invisible, versions, finalisation, immuabilité (API et base), correction par ajout',async()=>{
  assert.equal((await call(doc2,'POST',`/api/patients/${pA.id}/notes`,{title:'x',body:'y'})).s,403);
  note=(await call(doc,'POST',`/api/patients/${pA.id}/notes`,{title:'Consultation',body:'Brouillon 1'})).b.id;
  assert.ok(!(await call(pA,'GET','/api/record')).b.entries.some(e=>e.id===note));              // brouillon non visible du patient
  assert.equal((await call(doc,'POST',`/api/entries/${note}/edit`,{title:'Consultation',body:'Brouillon 2'})).b.version,2);
  assert.equal((await q(`SELECT count(*)::int c FROM entry_versions WHERE entry_id=$1`,[note]))[0].c,1);
  assert.equal((await call(doc2,'POST',`/api/entries/${note}/finalize`,{})).s,404);             // pas l'auteur
  assert.equal((await call(doc,'POST',`/api/entries/${note}/finalize`,{})).s,200);
  assert.ok((await call(pA,'GET','/api/record')).b.entries.some(e=>e.id===note));
  assert.equal((await call(doc,'POST',`/api/entries/${note}/edit`,{title:'x',body:'modif silencieuse'})).s,409);
  await assert.rejects(pg.query(`UPDATE record_entries SET body='falsifié' WHERE id=$1`,[note]),/non modifiable/);
  await assert.rejects(pg.query(`DELETE FROM record_entries WHERE id=$1`,[note]),/non supprimable/);
  const am=(await call(doc,'POST',`/api/entries/${note}/amend`,{title:'Correction',body:'Précision'})).b;assert.equal(am.statut,'brouillon');
  await call(doc,'POST',`/api/entries/${am.id}/finalize`,{});
  assert.equal((await call(pA,'GET','/api/record')).b.entries.find(e=>e.id===note).remplacee,true);
});
let rx;
test('ordonnance : brouillon, signature explicite, numéro, immuabilité, annulation, vérification publique',async()=>{
  const it=[{medicament:'Paracétamol 500 mg',posologie:'1 comprimé 3 fois par jour',duree:'3 jours'}];
  assert.equal((await call(doc2,'POST','/api/prescriptions',{patientId:pA.id,items:it})).s,403);       // pas de prise en charge
  assert.equal((await call(pA,'POST','/api/prescriptions',{patientId:pA.id,items:it})).s,403);         // un patient ne prescrit pas
  assert.equal((await call(doc,'POST','/api/prescriptions',{patientId:pA.id,items:[]})).s,400);
  rx=(await call(doc,'POST','/api/prescriptions',{patientId:pA.id,items:it})).b.id;
  assert.equal((await call(pA,'GET','/api/prescriptions')).b.prescriptions.length,0);                    // brouillon invisible
  assert.equal((await call(doc,'POST',`/api/prescriptions/${rx}/sign`,{})).s,400);                        // confirmation requise
  assert.equal((await call(doc2,'POST',`/api/prescriptions/${rx}/sign`,{confirm:true})).s,404);          // autre médecin
  const s=await call(doc,'POST',`/api/prescriptions/${rx}/sign`,{confirm:true});assert.match(s.b.numero,/^ORD-\d{4}-\d{6}$/);
  assert.equal((await call(doc,'POST',`/api/prescriptions/${rx}/edit`,{items:it})).s,409);
  await assert.rejects(pg.query(`UPDATE prescriptions SET items='[]'::jsonb WHERE id=$1`,[rx]),/non modifiable/);
  assert.equal((await call(pA,'GET','/api/prescriptions')).b.prescriptions[0].number,s.b.numero);
  assert.equal((await call(pB,'GET','/api/prescriptions')).b.prescriptions.length,0);
  const v=await call(null,'GET','/api/prescriptions/verify/'+s.b.numero);assert.equal(v.b.valide,true);assert.ok(!JSON.stringify(v.b).includes('Paracétamol')&&!JSON.stringify(v.b).includes(pA.id));
  assert.equal((await call(doc,'POST',`/api/prescriptions/${rx}/cancel`,{reason:'x'})).s,400);
  assert.equal((await call(doc,'POST',`/api/prescriptions/${rx}/cancel`,{reason:'Erreur de dosage'})).s,200);
  assert.equal((await call(null,'GET','/api/prescriptions/verify/'+s.b.numero)).b.valide,false);
  assert.equal((await call(null,'GET','/api/prescriptions/verify/ORD-2026-999999')).s,404);
  await pg.query(`UPDATE doctors SET verified_at=NULL WHERE user_id=$1`,[doc.id]);
  assert.equal((await call(doc,'POST','/api/prescriptions',{patientId:pA.id,items:it})).s,403);          // médecin non vérifié
  await pg.query(`UPDATE doctors SET verified_at=now() WHERE user_id=$1`,[doc.id]);
});
const b64=b=>Buffer.from(b).toString('base64');
const PDF=Buffer.concat([Buffer.from('%PDF-1.4\n'),Buffer.from('contenu test')]);
let docId;
test('documents : contenu vérifié, taille limitée, stockage privé, liens temporaires liés à l\u2019utilisateur',async()=>{
  assert.equal((await call(pA,'POST','/api/documents',{filename:'virus.pdf',dataBase64:b64('MZ\x90\x00 exe')})).s,400);   // faux PDF
  assert.equal((await call(pA,'POST','/api/documents',{filename:'gros.pdf',dataBase64:b64(Buffer.concat([Buffer.from('%PDF-'),Buffer.alloc(4.5*1024*1024)]))})).s,413);
  const up=await call(pA,'POST','/api/documents',{filename:'../../analyse.pdf',dataBase64:b64(PDF),kind:'examen'});assert.equal(up.s,201);docId=up.b.id;
  assert.ok(!(await q(`SELECT filename FROM documents WHERE id=$1`,[docId]))[0].filename.includes('/'));
  assert.equal((await call(pB,'GET',`/api/documents/${docId}/link`)).s,403);                 // autre patient
  assert.equal((await call(adm,'GET',`/api/documents/${docId}/link`)).s,403);
  assert.equal((await call(doc2,'GET',`/api/documents/${docId}/link`)).s,403);               // médecin sans lien
  const l=(await call(pA,'GET',`/api/documents/${docId}/link`)).b;assert.ok(l.url.includes('t='));
  const f=await raw(pA,'GET',l.url);assert.equal(f.status,200);assert.equal(f.headers.get('x-content-type-options'),'nosniff');assert.match(f.headers.get('content-disposition'),/attachment/);
  assert.deepEqual(Buffer.from(await f.arrayBuffer()),PDF);
  assert.equal((await raw(pB,'GET',l.url)).status,403);                                       // jeton d'un autre utilisateur
  assert.equal((await raw(null,'GET',l.url)).status,401);                                     // sans session
  assert.equal((await raw(pA,'GET',`/api/documents/${docId}/file?t=faux.jeton`)).status,403);
  assert.equal((await raw(pA,'GET',`/api/documents/${docId}/file?t=${signLink(docId,pA.id,-10)}`)).status,403); // expiré
  assert.ok(![...mem.keys()].some(k=>/analyse|\//.test(k)));                                  // clé de stockage opaque
});
test('médecin et documents : lien + autorisation requis ; dépôt par le médecin ; journal des téléchargements',async()=>{
  await call(pA,'POST',`/api/record/access/${doc.id}/revoke`,{});
  assert.equal((await call(doc,'GET',`/api/documents/${docId}/link`)).s,403);               // autorisation retirée
  assert.equal((await call(doc,'GET',`/api/documents?patientId=${pA.id}`)).b.documents.length,0);
  const up=await call(doc,'POST','/api/documents',{patientId:pA.id,filename:'cr.pdf',dataBase64:b64(PDF),kind:'compte rendu'});assert.equal(up.s,201);
  assert.equal((await call(doc,'GET',`/api/documents/${up.b.id}/link`)).s,200);              // il peut relire ce qu'il a déposé
  assert.equal((await call(doc2,'POST','/api/documents',{patientId:pA.id,filename:'x.pdf',dataBase64:b64(PDF)})).s,403);
  assert.equal((await call(pA,'POST','/api/record/access',{doctorId:doc.id})).s,200);
  assert.equal((await call(doc,'GET',`/api/documents?patientId=${pA.id}`)).b.documents.length,2);
  const l=(await call(doc,'GET',`/api/documents/${docId}/link`)).b;assert.equal((await raw(doc,'GET',l.url)).status,200);
  assert.ok((await call(pA,'GET','/api/record/access')).b.journal.some(j=>j.action==='telechargement'));
});
test('export du dossier : le patient obtient ses données, personne d\u2019autre',async()=>{
  const r=await raw(pA,'GET','/api/record/export');assert.equal(r.status,200);const d=await r.json();
  assert.ok(d.entrees.length>=3&&d.ordonnances.length===1&&d.documents.length===2&&d.journal_acces.length>=1);
  assert.equal((await raw(doc,'GET','/api/record/export')).status,403);assert.equal((await raw(adm,'GET','/api/record/export')).status,403);
});
