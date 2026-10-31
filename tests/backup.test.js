import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';
import {exportAll,encrypt,decrypt,restoreAll,TABLES} from '../netlify/functions/lib/backup.js';
const schema=readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;','');
const A=new PGlite(),B=new PGlite();await A.exec(schema);await B.exec(schema);
const qa=async(t,p=[])=>(await A.query(t,p)).rows,qb=async(t,p=[])=>(await B.query(t,p)).rows;
const U=async(role,i)=>(await qa(`INSERT INTO users(role,status,nom,tel,email,pwd_hash,consent_version,consent_at) VALUES($1,'active',$2,$3,$4,'h','t',now()) RETURNING id`,[role,role+i,'7712345'+i+'0',role+i+'@ex.sn']))[0].id;
const pat=await U('patient',1),doc=await U('medecin',2),adm=await U('admin',3);
await qa(`INSERT INTO doctors(user_id,specialite,ville,tarif_fcfa,langues,modes,numero_ordre,verified_at,verified_by) VALUES($1,'Pédiatrie','Thiès',10000,'{Français,Wolof}','{cabinet,video}','SN-1',now(),$2)`,[doc,adm]);
const dep=(await qa(`INSERT INTO dependents(guardian_id,nom,date_naissance,sexe) VALUES($1,'Fatou','2023-05-10','F') RETURNING id`,[pat]))[0].id;
const sl=(await qa(`INSERT INTO availability_slots(doctor_id,starts_at,ends_at,status) VALUES($1,now()+interval '1 day',now()+interval '1 day 30 minutes','booked') RETURNING id`,[doc]))[0].id;
const ap=(await qa(`INSERT INTO appointments(slot_id,patient_id,doctor_id,mode,motif,status,consent_at,amount_fcfa,payment_mode,dependent_id) VALUES($1,$2,$3,'video','Fièvre','confirmed',now(),10000,'en_ligne',$4) RETURNING id`,[sl,pat,doc,dep]))[0].id;
const pay=(await qa(`INSERT INTO payments(appointment_id,patient_id,amount_fcfa,provider,provider_session_id,status,paid_at) VALUES($1,$2,10000,'wave','cos-1','succeeded',now()) RETURNING id`,[ap,pat]))[0].id;
await qa(`INSERT INTO ledger_entries(payment_id,kind,amount_fcfa) VALUES($1,'paiement',10000),($1,'commission',1000),($1,'a_verser_medecin',9000)`,[pay]);
await qa(`INSERT INTO receipts(payment_id,number) VALUES($1,'KAY-2026-000012')`,[pay]);
const e1=(await qa(`INSERT INTO record_entries(patient_id,author_id,author_role,kind,title,body,data,status,finalized_at) VALUES($1,$1,'patient','allergie','Pénicilline','Urticaire','{"x":1}','finalise',now()) RETURNING id`,[pat]))[0].id;
await qa(`INSERT INTO record_entries(patient_id,author_id,author_role,kind,title,body,status,amends_id,finalized_at) VALUES($1,$1,'patient','allergie','Pénicilline (corrigé)','Rash','finalise',$2,now())`,[pat,e1]);
await qa(`INSERT INTO prescriptions(number,patient_id,doctor_id,items,status,signed_at,dependent_id,poids_kg) VALUES('ORD-2026-000007',$1,$2,'[{"medicament":"X","posologie":"Y"}]','signee',now(),$3,11.2)`,[pat,doc,dep]);
await qa(`INSERT INTO notification_prefs(user_id,sms_enabled) VALUES($1,true)`,[pat]);
await qa(`INSERT INTO notifications(user_id,kind,title,body,dedupe_key) VALUES($1,'x','t','b','k')`,[pat]);
const cv=(await qa(`INSERT INTO conversations(patient_id,doctor_id) VALUES($1,$2) RETURNING id`,[pat,doc]))[0].id;
await qa(`INSERT INTO messages(conversation_id,sender_id,client_id,body) VALUES($1,$2,$3,'Bonjour')`,[cv,pat,crypto.randomUUID()]);
await qa(`INSERT INTO ped_growth(dependent_id,measured_on,poids_kg,recorded_by,recorded_role) VALUES($1,'2026-01-10',11.2,$2,'patient')`,[dep,pat]);
await qa(`INSERT INTO ped_vaccines(dependent_id,vaccine,given_on,next_due,recorded_by,recorded_role) VALUES($1,'BCG','2023-05-11','2027-01-01',$2,'patient')`,[dep,pat]);
const prov=await U('prestataire',4);
await qa(`INSERT INTO provider_profiles(user_id,categorie,zones,tarif_fcfa,qualification_ref,verified_at,verified_by) VALUES($1,'infirmier','{Thiès,Dakar}',5000,'INF-1',now(),$2)`,[prov,adm]);
const cr=(await qa(`INSERT INTO care_requests(patient_id,categorie,zone,status) VALUES($1,'infirmier','Thiès','attribuee') RETURNING id`,[pat]))[0].id;
const cq=(await qa(`INSERT INTO care_quotes(request_id,provider_id,prix_fcfa,frais_fcfa,status) VALUES($1,$2,5000,500,'acceptee') RETURNING id`,[cr,prov]))[0].id;
const ms=(await qa(`INSERT INTO missions(request_id,quote_id,patient_id,provider_id,categorie,adresse,amount_fcfa,status,payment_mode) VALUES($1,$2,$3,$4,'infirmier','Rue 1',5500,'terminee','en_ligne') RETURNING id`,[cr,cq,pat,prov]))[0].id;
await qa(`INSERT INTO care_reviews(mission_id,patient_id,provider_id,rating,comment) VALUES($1,$2,$3,5,'Très bien')`,[ms,pat,prov]);
await qa(`INSERT INTO care_disputes(mission_id,opened_by,reason,status) VALUES($1,$2,'Retard','rejete')`,[ms,pat]);
await qa(`INSERT INTO payments(mission_id,patient_id,amount_fcfa,provider,provider_session_id,status,paid_at) VALUES($1,$2,5500,'wave','cos-2','succeeded',now())`,[ms,pat]);
const phm=await U('pharmacien',5);
await qa(`INSERT INTO pharmacies(user_id,nom_officine,ville,adresse,numero_autorisation,frais_livraison_fcfa,verified_at,verified_by) VALUES($1,'Pharmacie du Marché','Thiès','Av. 1','PH-1',1000,now(),$2)`,[phm,adm]);
const dg=(await qa(`INSERT INTO drugs(nom,forme,dosage,sur_ordonnance) VALUES('Amoxicilline','gélule','500 mg',true) RETURNING id`))[0].id;
await qa(`INSERT INTO pharmacy_stock(pharmacy_id,drug_id,prix_fcfa,quantite) VALUES($1,$2,2500,4)`,[phm,dg]);
const rxid=(await qa(`SELECT id FROM prescriptions LIMIT 1`))[0].id;
const od=(await qa(`INSERT INTO pharmacy_orders(patient_id,pharmacy_id,prescription_id,mode,total_fcfa,status,payment_mode) VALUES($1,$2,$3,'retrait',2500,'en_attente','en_ligne') RETURNING id`,[pat,phm,rxid]))[0].id;
await qa(`INSERT INTO pharmacy_order_items(order_id,drug_id,nom,prix_fcfa,quantite) VALUES($1,$2,'Amoxicilline',2500,1)`,[od,dg]);
await qa(`INSERT INTO payments(order_id,patient_id,amount_fcfa,provider,provider_session_id,status,paid_at) VALUES($1,$2,2500,'wave','cos-3','succeeded',now())`,[od,pat]);
await qa(`INSERT INTO audit_log(user_id,event,meta) VALUES($1,'login','{"a":1}')`,[pat]);
await qa(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,'secret-hash',now()+interval '1 hour')`,[pat]);
const KEY='cle-de-test-tres-longue-123';
const fp=async q=>Object.fromEntries(await Promise.all(TABLES.map(async t=>[t,(await q(`SELECT count(*)::int n,md5(coalesce(string_agg(to_jsonb(x)::text,'|' ORDER BY to_jsonb(x)::text),'')) h FROM ${t} x`))[0]])));

test('sauvegarde chiffrée : illisible sans la clé, altération détectée, sessions exclues',async()=>{
  const data=await exportAll((t,p)=>A.query(t,p).then(r=>r.rows));
  assert.ok(!('sessions' in data.tables));
  const blob=encrypt(data,KEY);assert.ok(!blob.toString('latin1').includes('Pénicilline')&&!blob.toString('latin1').includes('Fièvre'));
  assert.throws(()=>decrypt(blob,'mauvaise-cle-mauvaise-cle'),/Déchiffrement impossible/);
  const t=Buffer.from(blob);t[t.length-5]^=0xff;assert.throws(()=>decrypt(t,KEY),/Déchiffrement impossible/);
  assert.throws(()=>encrypt(data,'court'),/trop courte/);
  assert.deepEqual(decrypt(blob,KEY).tables.users.length,5);
});
test('restauration dans une base neuve : toutes les tables identiques, séquences cohérentes, refus si base non vide',async()=>{
  const blob=encrypt(await exportAll((t,p)=>A.query(t,p).then(r=>r.rows)),KEY);
  const counts=await restoreAll((t,p)=>B.query(t,p).then(r=>r.rows),decrypt(blob,KEY));
  assert.equal(counts.users,5);assert.equal(counts.pharmacy_orders,1);assert.equal(counts.pharmacy_stock,1);assert.equal(counts.missions,1);assert.equal(counts.care_reviews,1);
  assert.deepEqual(await fp(qb),await fp(qa));                                         // contenu strictement identique (empreinte par table)
  assert.equal((await qb(`SELECT nextval('rx_seq')::int n`))[0].n,8);                  // l'ordonnance suivante sera ORD-…-000008
  assert.equal((await qb(`SELECT nextval('receipt_seq')::int n`))[0].n,13);
  const maxA=(await qa(`SELECT max(id)::int m FROM audit_log`))[0].m;
  assert.ok((await qb(`INSERT INTO audit_log(event) VALUES('apres') RETURNING id`))[0].id>maxA);
  await assert.rejects(restoreAll((t,p)=>B.query(t,p).then(r=>r.rows),decrypt(blob,KEY)),/pas vide/);
  await assert.rejects(qb(`UPDATE prescriptions SET items='[]'::jsonb`),/non modifiable/);   // les protections d'immuabilité survivent à la restauration
  assert.equal((await qb(`SELECT count(*)::int n FROM sessions`))[0].n,0);
});
