import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';
import {__setDriver} from '../netlify/functions/lib/db.js';import {sha256} from '../netlify/functions/lib/util.js';
const pg=new PGlite();__setDriver(async(st,...v)=>(await pg.query(st.reduce((a,s,i)=>a+(i?'$'+i:'')+s,''),v)).rows);
await pg.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
const api=(await import('../netlify/functions/api.js')).default;
const tw={calls:[],roomStatus:201,existing:new Set()};
globalThis.fetch=async(url,o={})=>{const u=new URL(url),form=o.body?Object.fromEntries(new URLSearchParams(o.body)):{};tw.calls.push({m:o.method,path:u.pathname,form,auth:(o.headers||{}).authorization});
  const res=(s,d)=>({ok:s<300,status:s,text:async()=>JSON.stringify(d)});
  if(u.host==='video.twilio.com'&&u.pathname==='/v1/Rooms'&&o.method==='POST'){if(tw.roomStatus>=300)return res(tw.roomStatus,{code:20003});if(tw.existing.has(form.UniqueName))return res(400,{code:53113});tw.existing.add(form.UniqueName);return res(201,{sid:'RM'+tw.existing.size});}
  if(u.host==='video.twilio.com')return res(200,{});return res(404,{});};
let n=0;
async function mk(role){const tok='t'+(++n)+'v'.repeat(30);const u=(await pg.query(`INSERT INTO users(role,status,nom,tel,pwd_hash,consent_version,consent_at) VALUES($1,'active',$2,$3,'x','t',now()) RETURNING id`,[role,role+n,'77'+String(9000000+n)])).rows[0];
  await pg.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[u.id,sha256(tok)]);return {id:u.id,tok};}
const raw=(who,m,p,b)=>api(new Request('https://x.sn'+p,{method:m,headers:{'content-type':'application/json','x-requested-with':'kayligey',origin:'https://kay.test',...(who?{cookie:'kay_session='+who.tok}:{})},body:m==='GET'?undefined:JSON.stringify(b||{})}));
const call=async(w,m,p,b)=>{const r=await raw(w,m,p,b);return {s:r.status,b:await r.json()};};
const q=async(s,p=[])=>(await pg.query(s,p)).rows;
const pat=await mk('patient'),pat2=await mk('patient'),doc=await mk('medecin'),doc2=await mk('medecin'),adm=await mk('admin');
for(const d of [doc,doc2])await pg.query(`INSERT INTO doctors(user_id,specialite,ville,tarif_fcfa,modes,numero_ordre,verified_at) VALUES($1,'Généraliste','Thiès',0,'{cabinet,video,audio}','SN-'||$2,now())`,[d.id,d.id.slice(0,4)]);
const appt=async({start=5,dur=30,mode='video',status='confirmed',d=doc,p=pat}={})=>{
  const sl=(await q(`INSERT INTO availability_slots(doctor_id,starts_at,ends_at,status) VALUES($1,now()+($2||' minutes')::interval,now()+(($2::int+$3)||' minutes')::interval,'booked') RETURNING id`,[d.id,String(start),dur]))[0].id;
  return (await q(`INSERT INTO appointments(slot_id,patient_id,doctor_id,mode,motif,status,consent_at) VALUES($1,$2,$3,$4,'Suivi',$5,now()) RETURNING id`,[sl,p.id,d.id,mode,status]))[0].id;};
const decode=t=>{const [h,p,s]=t.split('.');return {head:JSON.parse(Buffer.from(h,'base64url')),pay:JSON.parse(Buffer.from(p,'base64url')),ok:crypto.createHmac('sha256','api-key-secret-test').update(h+'.'+p).digest('base64url')===s};};
let A1,tokD,tokP;

test('sans configuration vidéo : rien n\u2019est promis, message honnête',async()=>{
  A1=await appt();
  assert.equal((await call(null,'GET','/api/consultations/config')).b.enabled,false);
  const r=await call(doc,'POST',`/api/consultations/${A1}/start`,{});assert.equal(r.s,503);assert.match(r.b.error,/1515/);
  Object.assign(process.env,{TWILIO_ACCOUNT_SID:'ACtest',TWILIO_API_KEY_SID:'SKtest',TWILIO_API_KEY_SECRET:'api-key-secret-test'});
  const c=(await call(null,'GET','/api/consultations/config')).b;assert.deepEqual([c.enabled,c.enregistrement],[true,false]);
});
test('accès : participants seulement, rendez-vous à distance seulement, paiement confirmé exigé',async()=>{
  assert.equal((await call(null,'GET',`/api/consultations/${A1}/status`)).s,401);
  for(const w of [pat2,doc2,adm])assert.ok([403,404].includes((await call(w,'GET',`/api/consultations/${A1}/status`)).s));
  const cab=await appt({mode:'cabinet'});assert.equal((await call(pat,'GET',`/api/consultations/${cab}/status`)).s,409);
  const unpaid=await appt({status:'pending_payment'});const r=await call(doc,'POST',`/api/consultations/${unpaid}/start`,{});assert.equal(r.s,409);assert.match(r.b.error,/paiement/);
  assert.equal((await call(pat,'POST',`/api/consultations/${A1}/start`,{})).s,403);                    // seul le médecin ouvre
  assert.equal((await call(doc2,'POST',`/api/consultations/${A1}/start`,{})).s,404);
});
test('fenêtre horaire : pas avant 10 min, pas après la fin + 30 min',async()=>{
  const early=await appt({start:120}),late=await appt({start:-120,dur:30});
  const e=await call(doc,'POST',`/api/consultations/${early}/start`,{});assert.equal(e.s,409);assert.match(e.b.error,/ouvre 10 minutes avant/);
  assert.equal((await call(doc,'POST',`/api/consultations/${late}/start`,{})).s,409);
  const st=(await call(pat,'GET',`/api/consultations/${early}/status`)).b;assert.deepEqual([st.fenetre_ouverte,st.etat],[false,'avant_ouverture']);assert.ok(st.minutes_avant_ouverture>100);
});
test('salle d\u2019attente : le patient ne peut pas entrer avant le médecin ; ouverture ; jetons limités à la salle',async()=>{
  assert.equal((await call(pat,'POST',`/api/consultations/${A1}/join`,{})).s,409);                    // médecin pas encore là
  assert.equal((await call(doc,'POST',`/api/consultations/${A1}/wait`,{})).s,403);
  assert.equal((await call(pat,'POST',`/api/consultations/${A1}/wait`,{})).b.etat,'patient_en_attente');
  const nt=await q(`SELECT body FROM notifications WHERE user_id=$1 AND kind='consultation'`,[doc.id]);assert.equal(nt.length,1);assert.ok(!/Suivi/.test(nt[0].body));
  assert.equal((await call(pat,'POST',`/api/consultations/${A1}/join`,{})).s,409);                    // toujours en attente du médecin
  const s=await call(doc,'POST',`/api/consultations/${A1}/start`,{});assert.equal(s.s,200);assert.equal(s.b.patient_en_attente,true);tokD=s.b;
  const t=decode(tokD.token);assert.equal(t.ok,true);assert.equal(t.head.cty,'twilio-fpa;v=1');
  assert.deepEqual([t.pay.iss,t.pay.sub,t.pay.grants.identity],['SKtest','ACtest','u_'+doc.id]);assert.equal(t.pay.grants.video.room,tokD.room);
  assert.match(tokD.room,/^[0-9a-f]{32}$/);assert.ok(!tokD.room.includes(A1.replace(/-/g,''))&&!tokD.room.includes(A1));        // nom de salle non devinable
  const slotEnd=new Date((await q(`SELECT s.ends_at FROM appointments a JOIN availability_slots s ON s.id=a.slot_id WHERE a.id=$1`,[A1]))[0].ends_at).getTime()/1000;
  assert.ok(t.pay.exp<=slotEnd+45*60+5&&t.pay.exp>t.pay.iat);                                         // jeton court, borné par le créneau
  const rc=tw.calls.find(c=>c.path==='/v1/Rooms');assert.deepEqual([rc.form.MaxParticipants,rc.form.RecordParticipantsOnConnect,rc.form.UniqueName],['2','false',tokD.room]);
  assert.equal(rc.auth,'Basic '+Buffer.from('SKtest:api-key-secret-test').toString('base64'));
  const j=await call(pat,'POST',`/api/consultations/${A1}/join`,{});assert.equal(j.s,200);tokP=j.b;
  assert.equal(tokP.room,tokD.room);assert.equal(decode(tokP.token).pay.grants.identity,'u_'+pat.id);assert.notEqual(tokP.token,tokD.token);
  assert.equal((await call(pat2,'POST',`/api/consultations/${A1}/join`,{})).s,404);
  const A2=await appt();await call(doc,'POST',`/api/consultations/${A2}/start`,{});assert.notEqual((await q(`SELECT room_name FROM consultation_rooms WHERE appointment_id=$1`,[A2]))[0].room_name,tokD.room);
  assert.equal((await call(doc,'POST',`/api/consultations/${A1}/start`,{})).b.room,tokD.room);                     // reprise : même salle, pas de doublon
});
test('journal d\u2019événements : liste fermée',async()=>{
  assert.equal((await call(pat,'POST',`/api/consultations/${A1}/event`,{event:'joined'})).s,200);
  assert.equal((await call(pat,'POST',`/api/consultations/${A1}/event`,{event:'audio_only'})).s,200);
  assert.equal((await call(pat,'POST',`/api/consultations/${A1}/event`,{event:'<script>'})).s,400);
  assert.equal((await call(pat2,'POST',`/api/consultations/${A1}/event`,{event:'joined'})).s,404);
  assert.equal((await q(`SELECT count(*)::int c FROM consultation_events WHERE appointment_id=$1`,[A1]))[0].c,2);
});
test('fin de consultation : réservée au médecin, rendez-vous terminé, salle fermée chez Twilio, plus de jeton ensuite',async()=>{
  assert.equal((await call(pat,'POST',`/api/consultations/${A1}/end`,{})).s,403);
  assert.equal((await call(doc,'POST',`/api/consultations/${A1}/end`,{})).s,200);
  assert.equal((await q(`SELECT status FROM appointments WHERE id=$1`,[A1]))[0].status,'completed');
  assert.ok(tw.calls.some(c=>c.m==='POST'&&c.path==='/v1/Rooms/'+tokD.room&&c.form.Status==='completed'));
  assert.equal((await call(pat,'POST',`/api/consultations/${A1}/join`,{})).s,409);assert.equal((await call(doc,'POST',`/api/consultations/${A1}/start`,{})).s,409);
  assert.equal((await call(doc,'POST',`/api/consultations/${A1}/end`,{})).s,409);
  assert.equal((await call(pat,'GET',`/api/consultations/${A1}/status`)).b.etat,'terminee');
});
test('retards et absences : seulement 15 min après l\u2019heure ; le médecin absent est remboursé, le patient absent est marqué',async()=>{
  const soon=await appt({start:5});assert.equal((await call(pat,'POST',`/api/consultations/${soon}/report-absence`,{})).s,409);
  const late=await appt({start:-20,dur:40});
  const st=(await call(pat,'GET',`/api/consultations/${late}/status`)).b;assert.equal(st.absence_signalable,true);
  const r=await call(pat,'POST',`/api/consultations/${late}/report-absence`,{});assert.equal(r.s,200);
  assert.deepEqual((await q(`SELECT status,no_show_by FROM appointments WHERE id=$1`,[late]))[0],{status:'cancelled',no_show_by:'medecin'});
  assert.equal((await q(`SELECT count(*)::int c FROM audit_log WHERE event='doctor_no_show'`))[0].c,1);
  const opened=await appt({start:-20,dur:40});await call(doc,'POST',`/api/consultations/${opened}/start`,{});
  assert.equal((await call(pat,'POST',`/api/consultations/${opened}/report-absence`,{})).s,409);                   // le médecin était là
  const noP=await appt({start:-20,dur:40,p:pat2});assert.equal((await call(doc,'POST',`/api/consultations/${noP}/report-absence`,{})).s,200);
  assert.equal((await q(`SELECT status,no_show_by FROM appointments WHERE id=$1`,[noP]))[0].status,'no_show');
  const waited=await appt({start:-20,dur:40,p:pat2});await call(pat2,'POST',`/api/consultations/${waited}/wait`,{});
  assert.equal((await call(doc,'POST',`/api/consultations/${waited}/report-absence`,{})).s,409);                   // le patient attendait
});
test('panne du service vidéo : erreur claire, la consultation n\u2019est pas déclarée ouverte, reprise possible',async()=>{
  const a=await appt({p:pat2});tw.roomStatus=500;
  const r=await call(doc,'POST',`/api/consultations/${a}/start`,{});assert.equal(r.s,502);assert.match(r.b.error,/messagerie/);
  assert.equal((await q(`SELECT opened_at FROM consultation_rooms WHERE appointment_id=$1`,[a]))[0].opened_at,null);
  assert.equal((await call(pat2,'POST',`/api/consultations/${a}/join`,{})).s,409);
  tw.roomStatus=201;assert.equal((await call(doc,'POST',`/api/consultations/${a}/start`,{})).s,200);
});
