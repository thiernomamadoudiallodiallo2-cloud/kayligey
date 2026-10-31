import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';
import {__setDriver} from '../netlify/functions/lib/db.js';import {sha256} from '../netlify/functions/lib/util.js';
const pg=new PGlite();
__setDriver(async(st,...v)=>(await pg.query(st.reduce((a,s,i)=>a+(i?'$'+i:'')+s,''),v)).rows);
await pg.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
const api=(await import('../netlify/functions/api.js')).default;
Object.assign(process.env,{WAVE_API_KEY:'test_key',WAVE_WEBHOOK_SECRET:'whs_test',APP_ORIGIN:'https://kay.test',COMMISSION_BPS:'1000'});
// Faux serveur Wave : on contrôle ce que « Wave » répond
const wave={sessions:{},refund:200,calls:[],n:0};
globalThis.fetch=async(url,o={})=>{
  const u=new URL(url),b=o.body?JSON.parse(o.body):{};wave.calls.push(o.method+' '+u.pathname);
  const res=(s,d)=>({ok:s<300,status:s,text:async()=>JSON.stringify(d)});
  if(o.method==='POST'&&u.pathname==='/v1/checkout/sessions'){const id='cos-'+(++wave.n);wave.sessions[id]={id,amount:b.amount,currency:b.currency,client_reference:b.client_reference,checkout_status:'open',payment_status:'processing',wave_launch_url:'https://pay.wave.com/c/'+id};return res(200,wave.sessions[id]);}
  let m;if(m=u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)\/refund$/))return res(wave.refund,{});
  if(m=u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))return wave.sessions[m[1]]?res(200,wave.sessions[m[1]]):res(404,{});
  return res(404,{});
};
let n=0;
async function mk(role){const tok='t'+(++n)+'y'.repeat(30);const u=(await pg.query(`INSERT INTO users(role,status,nom,tel,pwd_hash,consent_version,consent_at) VALUES($1,'active',$2,$3,'x','t',now()) RETURNING id`,[role,role+n,'78'+String(1000000+n)])).rows[0];
  await pg.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[u.id,sha256(tok)]);return {id:u.id,tok};}
const call=async(who,method,path,body)=>{const r=await api(new Request('https://x.sn'+path,{method,headers:{'content-type':'application/json','x-requested-with':'kayligey',origin:'https://kay.test',...(who?{cookie:'kay_session='+who.tok}:{})},body:method==='GET'?undefined:JSON.stringify(body||{})}));return {s:r.status,b:await r.json()};};
const hook=async(sid,{secret='whs_test',ts=Math.floor(Date.now()/1000),id='evt'+Math.random()}={})=>{
  const body=JSON.stringify({id,type:'checkout.session.completed',data:{id:sid}});
  const sig=`t=${ts},v1=${crypto.createHmac('sha256',secret).update(ts+body).digest('hex')}`;
  const r=await api(new Request('https://x.sn/api/webhooks/wave',{method:'POST',headers:{'wave-signature':sig},body}));return r.status;};
const at=m=>new Date(Date.now()+m*60000).toISOString();
const doc=await mk('medecin'),pA=await mk('patient'),pB=await mk('patient'),adm=await mk('admin');
await pg.query(`INSERT INTO doctors(user_id,specialite,ville,tarif_fcfa,modes,numero_ordre,verified_at) VALUES($1,'Généraliste','Thiès',10000,'{cabinet}','SN-1',now())`,[doc.id]);
const slots=[];for(const m of [300,400,500,600])slots.push((await pg.query(`INSERT INTO availability_slots(doctor_id,starts_at,ends_at) VALUES($1,$2,$3) RETURNING id`,[doc.id,at(m),at(m+30)])).rows[0].id);
const book=(who,i)=>call(who,'POST','/api/appointments',{slotId:slots[i],mode:'cabinet',motif:'Consultation',consent:true});
const dbq=async(q,p=[])=>(await pg.query(q,p)).rows;
let A1,P1;

test('retenue du créneau 15 min : un autre patient ne peut pas le prendre ; checkout réutilisé (pas de doublon)',async()=>{
  A1=await book(pA,0);assert.equal(A1.s,201);assert.equal(A1.b.appointment.status,'pending_payment');
  assert.equal((await book(pB,0)).s,409);
  const c1=await call(pA,'POST','/api/payments/checkout',{appointmentId:A1.b.appointment.id});assert.equal(c1.s,201);
  const c2=await call(pA,'POST','/api/payments/checkout',{appointmentId:A1.b.appointment.id});assert.equal(c2.b.launch_url,c1.b.launch_url);
  assert.equal(wave.calls.filter(c=>c==='POST /v1/checkout/sessions').length,1);P1=c1.b.payment.id;
  assert.equal((await call(pB,'POST','/api/payments/checkout',{appointmentId:A1.b.appointment.id})).s,409); // pas son rendez-vous
});
test('webhook : signature invalide, secret faux, horodatage périmé → refusés ; rien n\u2019est confirmé',async()=>{
  const sid=(await dbq(`SELECT provider_session_id s FROM payments WHERE id=$1`,[P1]))[0].s;
  wave.sessions[sid].payment_status='succeeded'; // même si Wave dit « payé », un webhook non authentique ne doit rien changer
  assert.equal(await hook(sid,{secret:'mauvais'}),401);
  assert.equal(await hook(sid,{ts:Math.floor(Date.now()/1000)-4000}),401);
  assert.equal((await dbq(`SELECT status FROM appointments WHERE id=$1`,[A1.b.appointment.id]))[0].status,'pending_payment');
  wave.sessions[sid].payment_status='processing';
});
test('webhook authentique mais Wave dit « en cours » ou montant différent → pas de confirmation',async()=>{
  const sid=(await dbq(`SELECT provider_session_id s FROM payments WHERE id=$1`,[P1]))[0].s;
  assert.equal(await hook(sid),200);assert.equal((await dbq(`SELECT status FROM payments WHERE id=$1`,[P1]))[0].status,'pending');
  wave.sessions[sid].payment_status='succeeded';wave.sessions[sid].amount='1';
  assert.equal(await hook(sid),200);assert.equal((await dbq(`SELECT status FROM payments WHERE id=$1`,[P1]))[0].status,'pending');
  wave.sessions[sid].amount='10000';
});
test('paiement confirmé : rendez-vous confirmé, reçu unique, grand livre juste (commission 10 %), rejeu sans doublon',async()=>{
  const sid=(await dbq(`SELECT provider_session_id s FROM payments WHERE id=$1`,[P1]))[0].s;
  assert.equal(await hook(sid),200);assert.equal(await hook(sid),200);assert.equal(await hook(sid),200);
  assert.equal((await dbq(`SELECT status FROM appointments WHERE id=$1`,[A1.b.appointment.id]))[0].status,'confirmed');
  assert.equal((await dbq(`SELECT count(*)::int c FROM receipts WHERE payment_id=$1`,[P1]))[0].c,1);
  const l=Object.fromEntries((await dbq(`SELECT kind,amount_fcfa a FROM ledger_entries WHERE payment_id=$1`,[P1])).map(x=>[x.kind,x.a]));
  assert.deepEqual(l,{paiement:10000,commission:1000,a_verser_medecin:9000});
  const rc=await call(pA,'GET',`/api/payments/${P1}/receipt`);assert.equal(rc.s,200);assert.match(rc.b.receipt.number,/^KAY-\d{4}-\d{6}$/);
  assert.equal((await call(pB,'GET',`/api/payments/${P1}/receipt`)).s,404);
  assert.equal((await call(doc,'GET','/api/doctor/revenue')).b.a_verser_fcfa,9000);
});
test('annulation par le médecin : remboursement via Wave, grand livre annulé ; échec Wave → « en attente », puis reprise admin',async()=>{
  assert.equal((await call(doc,'POST',`/api/appointments/${A1.b.appointment.id}/cancel`,{reason:'Urgence'})).b.remboursement,'effectué');
  assert.equal((await dbq(`SELECT status FROM payments WHERE id=$1`,[P1]))[0].status,'refunded');
  assert.equal((await call(doc,'GET','/api/doctor/revenue')).b.a_verser_fcfa,0);
  // second rendez-vous, remboursement refusé par Wave
  const A2=await book(pA,1);const c=await call(pA,'POST','/api/payments/checkout',{appointmentId:A2.b.appointment.id});
  const sid=wave.sessions['cos-'+wave.n].id;wave.sessions[sid].payment_status='succeeded';await hook(sid);
  wave.refund=500;const k=await call(doc,'POST',`/api/appointments/${A2.b.appointment.id}/cancel`,{});
  assert.equal(k.b.remboursement,'en attente de confirmation du prestataire');
  assert.equal((await dbq(`SELECT status FROM payments WHERE id=$1`,[c.b.payment.id]))[0].status,'refund_pending');
  assert.equal((await call(pA,'POST',`/api/admin/payments/${c.b.payment.id}/refund`,{})).s,403);
  wave.refund=200;assert.equal((await call(adm,'POST',`/api/admin/payments/${c.b.payment.id}/refund`,{motif:'reprise'})).b.ok,true);
  assert.equal((await dbq(`SELECT status FROM payments WHERE id=$1`,[c.b.payment.id]))[0].status,'refunded');
});
test('paiement tardif (retenue expirée) : remboursé automatiquement, créneau non repris',async()=>{
  const A3=await book(pA,2);const c=await call(pA,'POST','/api/payments/checkout',{appointmentId:A3.b.appointment.id});
  await pg.query(`UPDATE appointments SET hold_expires_at=now()-interval '1 minute' WHERE id=$1`,[A3.b.appointment.id]);
  assert.equal((await book(pB,2)).s,201); // créneau libéré, pB le prend (retenue)
  const sid='cos-'+wave.n;wave.sessions[sid].payment_status='succeeded';await hook(sid);
  assert.equal((await dbq(`SELECT status FROM payments WHERE id=$1`,[c.b.payment.id]))[0].status,'refunded');
  assert.equal((await dbq(`SELECT status FROM appointments WHERE id=$1`,[A3.b.appointment.id]))[0].status,'cancelled');
});
test('rapprochement admin cohérent ; patient refusé ; paiement non configuré → réservation « sur place »',async()=>{
  const r=await call(adm,'GET','/api/admin/reconciliation');assert.equal(r.s,200);
  assert.deepEqual([r.b.anomalies.reussis_sans_recu,r.b.anomalies.ecart_grand_livre],[[],[]]);
  assert.equal((await call(pA,'GET','/api/admin/reconciliation')).s,403);
  delete process.env.WAVE_API_KEY;
  assert.equal((await call(pA,'POST','/api/payments/checkout',{appointmentId:'00000000-0000-0000-0000-000000000000'})).s,503);
  const b=await book(pA,3);assert.equal(b.b.appointment.status,'confirmed');assert.equal(b.b.appointment.payment_mode,'sur_place');
});
