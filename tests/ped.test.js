import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';
import {__setDriver} from '../netlify/functions/lib/db.js';import {sha256} from '../netlify/functions/lib/util.js';
const pg=new PGlite();__setDriver(async(st,...v)=>(await pg.query(st.reduce((a,s,i)=>a+(i?'$'+i:'')+s,''),v)).rows);
await pg.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
const api=(await import('../netlify/functions/api.js')).default;
const {enqueueReminders}=await import('../netlify/functions/lib/notify.js');
let n=0;
async function mk(role){const tok='t'+(++n)+'p'.repeat(30);const u=(await pg.query(`INSERT INTO users(role,status,nom,tel,pwd_hash,consent_version,consent_at) VALUES($1,'active',$2,$3,'x','t',now()) RETURNING id`,[role,role+n,'70'+String(5000000+n)])).rows[0];
  await pg.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[u.id,sha256(tok)]);return {id:u.id,tok};}
const raw=(who,m,p,b)=>api(new Request('https://x.sn'+p,{method:m,headers:{'content-type':'application/json','x-requested-with':'kayligey',...(who?{cookie:'kay_session='+who.tok}:{})},body:m==='GET'?undefined:JSON.stringify(b||{})}));
const call=async(w,m,p,b)=>{const r=await raw(w,m,p,b);return {s:r.status,b:await r.json()};};
const q=async(s,p=[])=>(await pg.query(s,p)).rows;
const par=await mk('patient'),par2=await mk('patient'),doc=await mk('medecin'),doc2=await mk('medecin'),adm=await mk('admin');
for(const d of [doc,doc2])await pg.query(`INSERT INTO doctors(user_id,specialite,ville,tarif_fcfa,modes,numero_ordre,verified_at) VALUES($1,'Pédiatrie','Thiès',0,'{cabinet}','SN-'||$2,now())`,[d.id,d.id.slice(0,4)]);
const mkSlot=async(m)=>(await pg.query(`INSERT INTO availability_slots(doctor_id,starts_at,ends_at) VALUES($1,now()+($2||' minutes')::interval,now()+($2||' minutes')::interval+interval '30 minutes') RETURNING id`,[doc.id,String(m)])).rows[0].id;
const book=(w,slot,extra)=>call(w,'POST','/api/appointments',{slotId:slot,mode:'cabinet',motif:'Contrôle',consent:true,...extra});
let kid,kid2;

test('personnes à charge : création validée, isolation entre parents, rôles',async()=>{
  assert.equal((await call(par,'POST','/api/dependents',{nom:'Fatou',date_naissance:'2023-05-10'})).s,400);               // confirmation du statut de représentant légal
  assert.equal((await call(par,'POST','/api/dependents',{nom:'Fatou',date_naissance:'2999-01-01',responsable_legal:true})).s,400);
  kid=(await call(par,'POST','/api/dependents',{nom:'Fatou',date_naissance:'2023-05-10',sexe:'F',responsable_legal:true})).b.id;
  kid2=(await call(par2,'POST','/api/dependents',{nom:'Moussa',date_naissance:'2022-01-02',responsable_legal:true})).b.id;
  const l=(await call(par,'GET','/api/dependents')).b.dependents;assert.deepEqual(l.map(x=>x.nom),['Fatou']);assert.ok(l[0].age_mois>=0);
  for(const [w,m,p] of [[par2,'GET',`/api/dependents/${kid}/record`],[par2,'POST',`/api/dependents/${kid}/growth`],[par2,'GET',`/api/dependents/${kid}/export`],[adm,'GET',`/api/dependents/${kid}/record`],[doc,'GET',`/api/dependents/${kid}/record`]])
    assert.ok([403,404].includes((await call(w,m,p,{poids_kg:10})).s)); // 404 (introuvable) ou 403 (rôle non autorisé) : jamais 200
  assert.equal((await call(doc,'POST','/api/dependents',{nom:'X',date_naissance:'2020-01-01',responsable_legal:true})).s,403);
  assert.equal((await call(null,'GET','/api/dependents')).s,401);
});
test('rendez-vous pour un enfant : seulement le sien ; noms affichés ; pas de mélange avec le dossier adulte',async()=>{
  const s1=await mkSlot(300),s2=await mkSlot(400);
  assert.equal((await book(par2,s1,{dependentId:kid})).s,403);                                  // enfant d'un autre parent
  const b=await book(par,s1,{dependentId:kid});assert.equal(b.s,201);
  assert.equal((await call(par,'GET','/api/appointments')).b.appointments[0].enfant,'Fatou');
  const d=(await call(doc,'GET','/api/appointments')).b.appointments[0];assert.equal(d.patient,'Fatou');assert.equal(d.enfant,true);
  // le médecin n'obtient AUCUN lien de soin avec le parent adulte à cause du rendez-vous de l'enfant
  assert.equal((await call(doc,'GET',`/api/patients/${par.id}/record`)).s,403);
  assert.equal((await call(doc,'POST','/api/prescriptions',{patientId:par.id,items:[{medicament:'x',posologie:'y'}]})).s,403);
  assert.equal((await call(par,'POST','/api/record/access',{doctorId:doc.id})).s,409);           // partage adulte impossible
  assert.equal((await call(doc,'GET','/api/doctor/patients')).b.patients.length,0);
  assert.equal((await call(doc,'GET','/api/doctor/children')).b.enfants[0].nom,'Fatou');
});
test('carnet : lecture par le médecin = lien pour CET enfant + autorisation du parent ; journal ; retrait',async()=>{
  assert.equal((await call(doc,'GET',`/api/dependents/${kid}/record`)).s,403);                   // pas d'autorisation
  assert.equal((await call(doc2,'GET',`/api/dependents/${kid}/record`)).s,404);                  // aucun lien
  assert.equal((await call(par,'POST',`/api/dependents/${kid}/access`,{doctorId:doc2.id})).s,409);
  assert.equal((await call(par,'POST',`/api/dependents/${kid}/access`,{doctorId:doc.id,days:60})).s,200);
  const r=await call(doc,'GET',`/api/dependents/${kid}/record`);assert.equal(r.s,200);assert.match(r.b.avertissement,/Aucune courbe de référence/);
  assert.ok((await call(par,'GET','/api/record/access')).b.journal.some(j=>j.action==='lecture_carnet_enfant'));
  assert.equal((await call(doc,'POST',`/api/dependents/${kid}/access`,{doctorId:doc.id})).s,403);  // un médecin ne s'auto-autorise pas
  await call(par,'POST',`/api/dependents/${kid}/access/${doc.id}/revoke`,{});
  assert.equal((await call(doc,'GET',`/api/dependents/${kid}/record`)).s,403);
  await call(par,'POST',`/api/dependents/${kid}/access`,{doctorId:doc.id});
});
let g1;
test('croissance : valeurs plausibles, dates cohérentes, provenance, annulation, immuabilité',async()=>{
  const ok=await call(par,'POST',`/api/dependents/${kid}/growth`,{measured_on:'2026-01-10',poids_kg:11.2,taille_cm:84});assert.equal(ok.s,201);g1=ok.b.id;
  assert.equal((await call(par,'POST',`/api/dependents/${kid}/growth`,{poids_kg:900})).s,400);
  assert.equal((await call(par,'POST',`/api/dependents/${kid}/growth`,{})).s,400);
  assert.equal((await call(par,'POST',`/api/dependents/${kid}/growth`,{measured_on:'2020-01-01',poids_kg:5})).s,400);   // avant la naissance
  assert.equal((await call(par,'POST',`/api/dependents/${kid}/growth`,{measured_on:'2999-01-01',poids_kg:5})).s,400);
  const dg=await call(doc,'POST',`/api/dependents/${kid}/growth`,{measured_on:'2026-02-01',poids_kg:11.8});assert.equal(dg.s,201);
  const rec=(await call(par,'GET',`/api/dependents/${kid}/record`)).b;assert.deepEqual(rec.croissance.map(x=>x.recorded_role).sort(),['medecin','patient']);
  assert.equal((await call(doc,'POST',`/api/dependents/${kid}/growth/${g1}/void`,{reason:'erreur'})).s,403);     // pas l'auteur
  assert.equal((await call(par,'POST',`/api/dependents/${kid}/growth/${dg.b.id}/void`,{reason:'saisie erronée'})).s,200);
  await assert.rejects(pg.query(`UPDATE ped_growth SET poids_kg=1 WHERE id=$1`,[g1]),/non modifiable/);
  await assert.rejects(pg.query(`DELETE FROM ped_growth WHERE id=$1`,[g1]),/non supprimable/);
});
test('vaccinations : saisie, prochaine dose, rappel unique sans donnée sensible',async()=>{
  const due=new Date(Date.now()+3*864e5).toISOString().slice(0,10),given=new Date(Date.now()-60*864e5).toISOString().slice(0,10);
  assert.equal((await call(par,'POST',`/api/dependents/${kid}/vaccines`,{vaccine:'BCG',given_on:given,next_due:given})).s,400);
  assert.equal((await call(par,'POST',`/api/dependents/${kid}/vaccines`,{vaccine:'Pentavalent',dose:'dose 2',given_on:given,next_due:due,administered_by:'Centre de santé'})).s,201);
  assert.ok(await enqueueReminders()>=1);assert.equal(await enqueueReminders(),0);
  const nt=await q(`SELECT body FROM notifications WHERE user_id=$1 AND dedupe_key LIKE 'vac:%'`,[par.id]);assert.equal(nt.length,1);assert.ok(!/Fatou|Pentavalent|vaccin/i.test(nt[0].body));
});
test('ordonnance pédiatrique : poids obligatoire, lien pour cet enfant, visible du parent, pas des autres',async()=>{
  const it=[{medicament:'Paracétamol sirop',posologie:'selon prescription du médecin',duree:'3 jours'}];
  assert.equal((await call(doc,'POST','/api/prescriptions',{dependentId:kid,items:it})).s,400);                 // poids manquant
  assert.equal((await call(doc2,'POST','/api/prescriptions',{dependentId:kid,poids_kg:11,items:it})).s,403);   // aucun lien
  const rx=(await call(doc,'POST','/api/prescriptions',{dependentId:kid,poids_kg:11.2,items:it})).b.id;
  assert.equal((await call(doc,'POST',`/api/prescriptions/${rx}/sign`,{confirm:true})).s,200);
  const pr=(await call(par,'GET','/api/prescriptions')).b.prescriptions[0];assert.equal(pr.enfant,'Fatou');assert.equal(Number(pr.poids_kg),11.2);
  assert.equal((await call(par2,'GET','/api/prescriptions')).b.prescriptions.length,0);
  assert.equal((await call(par,'GET',`/api/dependents/${kid}/record`)).b.ordonnances.length,1);
});
test('export du carnet : parent uniquement ; archivage retire l\u2019accès',async()=>{
  const r=await raw(par,'GET',`/api/dependents/${kid}/export`);assert.equal(r.status,200);const d=await r.json();
  assert.ok(d.croissance.length>=1&&d.vaccinations.length===1&&d.ordonnances.length===1);
  assert.equal((await raw(doc,'GET',`/api/dependents/${kid}/export`)).status,403);
  assert.equal((await call(par,'POST',`/api/dependents/${kid}/archive`,{})).s,200);
  assert.equal((await call(par,'GET',`/api/dependents/${kid}/record`)).s,404);assert.equal((await call(doc,'GET',`/api/dependents/${kid}/record`)).s,404);
});
