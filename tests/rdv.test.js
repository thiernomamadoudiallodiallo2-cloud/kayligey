import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';
import {__setDriver} from '../netlify/functions/lib/db.js';
import {sha256} from '../netlify/functions/lib/util.js';
const pg=new PGlite();
__setDriver(async(st,...v)=>(await pg.query(st.reduce((a,s,i)=>a+(i?'$'+i:'')+s,''),v)).rows);
await pg.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
const api=(await import('../netlify/functions/api.js')).default;
let n=0;
async function mk(role,status='active'){
  const tok='tok'+(++n)+'x'.repeat(30),tel='77'+String(1000000+n);
  const u=(await pg.query(`INSERT INTO users(role,status,nom,tel,pwd_hash,consent_version,consent_at) VALUES($1,$2,$3,$4,'x','t',now()) RETURNING id`,[role,status,role+n,tel])).rows[0];
  await pg.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[u.id,sha256(tok)]);
  return {id:u.id,tok};
}
const call=async(who,method,path,body)=>{
  const r=await api(new Request('https://x.sn'+path,{method,headers:{'content-type':'application/json','x-requested-with':'kayligey',...(who?{cookie:'kay_session='+who.tok}:{})},body:method==='GET'?undefined:JSON.stringify(body||{})}));
  return {s:r.status,b:await r.json()};
};
const at=(min)=>new Date(Date.now()+min*60000).toISOString();
const slot=(from,len=30)=>({starts_at:at(from),ends_at:at(from+len)});
const doc=await mk('medecin'),pA=await mk('patient'),pB=await mk('patient'),adm=await mk('admin');
const profil={specialite:'Pédiatrie',ville:'Thiès',numero_ordre:'SN-123',tarif_fcfa:10000,modes:['cabinet','video'],langues:['Français','Wolof']};

test('médecin non vérifié : invisible et ne peut pas publier de créneaux',async()=>{
  assert.equal((await call(doc,'POST','/api/doctor/profile',profil)).s,200);
  assert.equal((await call(null,'GET','/api/doctors')).b.doctors.length,0);
  assert.equal((await call(doc,'POST','/api/doctor/slots',{slots:[slot(180)]})).s,403);
});
test('vérification : réservée à l\u2019admin, avec confirmation des justificatifs',async()=>{
  assert.equal((await call(pA,'POST',`/api/admin/doctors/${doc.id}/verify`,{justificatifs_verifies:true})).s,403);
  assert.equal((await call(doc,'POST',`/api/admin/doctors/${doc.id}/verify`,{justificatifs_verifies:true})).s,403);
  assert.equal((await call(adm,'POST',`/api/admin/doctors/${doc.id}/verify`,{})).s,400);
  assert.equal((await call(adm,'POST',`/api/admin/doctors/${doc.id}/verify`,{justificatifs_verifies:true})).s,200);
});
let ids={};
test('créneaux : ajout, chevauchement et passé refusés ; annuaire filtré',async()=>{
  const r=await call(doc,'POST','/api/doctor/slots',{slots:[slot(60),slot(4320),slot(4380),slot(4330,30),slot(-120)]});
  assert.deepEqual([r.b.added,r.b.rejected],[3,2]);
  const l=(await call(null,'GET','/api/doctors?specialite=pédiatrie&ville=thiès&mode=video&langue=Wolof')).b.doctors;
  assert.equal(l.length,1);assert.equal((await call(null,'GET','/api/doctors?mode=audio')).b.doctors.length,0);
  const s=(await call(null,'GET',`/api/doctors/${doc.id}/slots`)).b.slots;assert.equal(s.length,3);
  ids=(await call(doc,'GET','/api/doctor/slots')).b.slots.map(x=>x.id);
});
test('réservation : non connecté, mode invalide, sans consentement',async()=>{
  const sl=(await pg.query(`SELECT id FROM availability_slots ORDER BY starts_at`)).rows.map(r=>r.id);ids=sl;
  assert.equal((await call(null,'POST','/api/appointments',{slotId:sl[1],mode:'video',motif:'Fièvre',consent:true})).s,401);
  assert.equal((await call(doc,'POST','/api/appointments',{slotId:sl[1],mode:'video',motif:'Fièvre',consent:true})).s,403);
  assert.equal((await call(pA,'POST','/api/appointments',{slotId:sl[1],mode:'audio',motif:'Fièvre',consent:true})).s,409);
  assert.equal((await call(pA,'POST','/api/appointments',{slotId:sl[1],mode:'video',motif:'Fièvre',consent:false})).s,400);
});
test('même créneau demandé en même temps par deux patients : un seul gagne',async()=>{
  const [a,b]=await Promise.all([call(pA,'POST','/api/appointments',{slotId:ids[1],mode:'video',motif:'Fièvre',consent:true}),call(pB,'POST','/api/appointments',{slotId:ids[1],mode:'cabinet',motif:'Toux',consent:true})]);
  assert.deepEqual([a.s,b.s].sort(),[201,409]);
  assert.equal((await pg.query(`SELECT count(*)::int c FROM appointments WHERE slot_id=$1 AND status='confirmed'`,[ids[1]])).rows[0].c,1);
});
test('un patient ne peut pas annuler ni lire le rendez-vous d\u2019un autre',async()=>{
  const owner=(await pg.query(`SELECT patient_id FROM appointments WHERE slot_id=$1`,[ids[1]])).rows[0].patient_id;
  const [me,other]=owner===pA.id?[pA,pB]:[pB,pA];
  const apt=(await call(me,'GET','/api/appointments')).b.appointments[0];
  assert.equal((await call(other,'POST',`/api/appointments/${apt.id}/cancel`,{})).s,409);
  assert.equal((await call(other,'GET','/api/appointments')).b.appointments.length,0);
  assert.equal((await call(adm,'GET','/api/appointments')).s,403);
  globalThis.mine=me;globalThis.apt=apt;globalThis.other=other;
});
test('reprogrammation : l\u2019ancien créneau est libéré, un autre médecin/créneau pris est refusé',async()=>{
  const {mine,apt,other}=globalThis;
  assert.equal((await call(mine,'POST',`/api/appointments/${apt.id}/reschedule`,{slotId:ids[1]})).s,409); // même créneau, déjà pris
  assert.equal((await call(mine,'POST',`/api/appointments/${apt.id}/reschedule`,{slotId:ids[2]})).s,200);
  assert.equal((await pg.query(`SELECT status FROM availability_slots WHERE id=$1`,[ids[1]])).rows[0].status,'open');
  assert.equal((await call(other,'POST','/api/appointments',{slotId:ids[1],mode:'cabinet',motif:'Toux',consent:true})).s,201);
});
test('annulation : patient refusé à moins de 2 h, médecin autorisé et créneau fermé',async()=>{
  const r=(await call(globalThis.other,'GET','/api/appointments')).b.appointments[0];
  // ids[0] est le créneau à +60 min : réservons-le avec le patient « mine »
  const b=await call(globalThis.mine,'POST','/api/appointments',{slotId:ids[0],mode:'cabinet',motif:'Contrôle',consent:true});assert.equal(b.s,201);
  assert.equal((await call(globalThis.mine,'POST',`/api/appointments/${b.b.appointment.id}/cancel`,{})).s,409);
  assert.equal((await call(doc,'POST',`/api/appointments/${b.b.appointment.id}/cancel`,{reason:'Urgence'})).s,200);
  assert.equal((await pg.query(`SELECT status FROM availability_slots WHERE id=$1`,[ids[0]])).rows[0].status,'closed');
  assert.equal((await call(doc,'GET','/api/appointments')).b.appointments.length,3);
});
test('sécurité : requête sans en-tête anti-CSRF refusée ; changement du n° d\u2019ordre retire la vérification',async()=>{
  const r=await api(new Request('https://x.sn/api/appointments',{method:'POST',body:'{}'}));assert.equal(r.status,403);
  await call(doc,'POST','/api/doctor/profile',{...profil,numero_ordre:'SN-999'});
  assert.equal((await call(null,'GET','/api/doctors')).b.doctors.length,0);
});

test('profil médecin lisible par son titulaire ; liste admin des profils à vérifier réservée à l\u2019admin',async()=>{
  assert.equal((await call(doc,'GET','/api/doctor/profile')).b.profile.numero_ordre,'SN-999');
  assert.equal((await call(pA,'GET','/api/doctor/profile')).s,403);
  assert.equal((await call(pA,'GET','/api/admin/doctors/pending')).s,403);
  const l=(await call(adm,'GET','/api/admin/doctors/pending')).b.doctors;assert.equal(l.length,1);assert.equal(l[0].numero_ordre,'SN-999');
});
