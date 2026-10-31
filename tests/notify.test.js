import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';
import {__setDriver} from '../netlify/functions/lib/db.js';import {sha256} from '../netlify/functions/lib/util.js';
const pg=new PGlite();
__setDriver(async(st,...v)=>(await pg.query(st.reduce((a,s,i)=>a+(i?'$'+i:'')+s,''),v)).rows);
await pg.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
const api=(await import('../netlify/functions/api.js')).default;
const {enqueueReminders,processOutbox}=await import('../netlify/functions/lib/notify.js');
// faux Resend / Twilio
const net={calls:[],status:200};
globalThis.fetch=async(url,o={})=>{net.calls.push({url:String(url),body:o.body,auth:(o.headers||{}).authorization});return {ok:net.status<300,status:net.status,text:async()=>'{}'};};
let n=0;
async function mk(role,email){const tok='t'+(++n)+'z'.repeat(30);const u=(await pg.query(`INSERT INTO users(role,status,nom,tel,email,pwd_hash,consent_version,consent_at) VALUES($1,'active',$2,$3,$4,'x','t',now()) RETURNING id`,[role,role+n,'77'+String(2000000+n),email||null])).rows[0];
  await pg.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[u.id,sha256(tok)]);return {id:u.id,tok,tel:'77'+String(2000000+n)};}
const call=async(who,method,path,body)=>{const r=await api(new Request('https://x.sn'+path,{method,headers:{'content-type':'application/json','x-requested-with':'kayligey',...(who?{cookie:'kay_session='+who.tok}:{})},body:method==='GET'?undefined:JSON.stringify(body||{})}));return {s:r.status,b:await r.json()};};
const q=async(s,p=[])=>(await pg.query(s,p)).rows;
const at=m=>new Date(Date.now()+m*60000).toISOString();
const doc=await mk('medecin','dr@ex.sn'),pA=await mk('patient','awa@ex.sn'),pB=await mk('patient');
await pg.query(`INSERT INTO doctors(user_id,specialite,ville,tarif_fcfa,modes,numero_ordre,verified_at) VALUES($1,'Psychiatrie','Thiès',0,'{cabinet}','SN-1',now())`,[doc.id]);
const mkSlot=async m=>(await pg.query(`INSERT INTO availability_slots(doctor_id,starts_at,ends_at) VALUES($1,$2,$3) RETURNING id`,[doc.id,at(m),at(m+30)])).rows[0].id;
const book=async(who,slot)=>call(who,'POST','/api/appointments',{slotId:slot,mode:'cabinet',motif:'Dépression sévère',consent:true});
let ap1;

test('sans service externe : notifications dans l\u2019application uniquement, sans données médicales',async()=>{
  const s=await mkSlot(60*24);ap1=(await book(pA,s)).b.appointment;
  const mine=(await call(pA,'GET','/api/notifications')).b;assert.equal(mine.unread,1);
  const dr=(await call(doc,'GET','/api/notifications')).b;assert.equal(dr.unread,1);
  const txt=JSON.stringify([mine,dr]);assert.ok(!/Psychiatrie|Dépression/.test(txt)); // ni spécialité ni motif
  assert.equal((await q(`SELECT count(*)::int c FROM outbox`))[0].c,0);
  assert.equal((await call(pB,'GET','/api/notifications')).b.notifications.length,0);
});
test('lecture : seulement les siennes ; non connecté refusé',async()=>{
  const id=(await call(pA,'GET','/api/notifications')).b.notifications[0].id;
  await call(pB,'POST','/api/notifications/read',{ids:[id]});assert.equal((await call(pA,'GET','/api/notifications')).b.unread,1);
  await call(pA,'POST','/api/notifications/read',{ids:[id]});assert.equal((await call(pA,'GET','/api/notifications')).b.unread,0);
  assert.equal((await call(null,'GET','/api/notifications')).s,401);
  assert.equal((await call(pA,'GET','/api/admin/notifications')).s,403);
});
test('rappels : une seule fois (J-1), respect des préférences',async()=>{
  const s=await mkSlot(24*60);const a=(await book(pB,s));assert.equal(a.s,201);
  await call(doc,'POST','/api/notifications/prefs',{email_enabled:true,sms_enabled:false,reminders_enabled:false}); // le médecin refuse les rappels
  const r1=await enqueueReminders(),r2=await enqueueReminders();
  assert.ok(r1>=2);assert.equal(r2,0);
  const rem=await q(`SELECT user_id FROM notifications WHERE kind='reminder'`);
  assert.ok(!rem.some(x=>x.user_id===doc.id)&&rem.some(x=>x.user_id===pB.id));
});
test('canaux configurés : e-mail et SMS réellement appelés, échecs relancés puis abandonnés',async()=>{
  Object.assign(process.env,{RESEND_API_KEY:'re_x',MAIL_FROM:'Kayligey <no-reply@kay.test>',TWILIO_ACCOUNT_SID:'ACx',TWILIO_AUTH_TOKEN:'tok',TWILIO_FROM:'+15550001'});
  await call(pA,'POST','/api/notifications/prefs',{email_enabled:true,sms_enabled:true,reminders_enabled:true});
  const s=await mkSlot(60*50);await book(pA,s);
  const ob=await q(`SELECT channel,to_addr FROM outbox WHERE user_id=$1 ORDER BY channel`,[pA.id]);
  assert.deepEqual(ob.map(x=>x.channel),['email','sms']);assert.equal(ob[1].to_addr,'+221'+pA.tel);
  net.calls.length=0;const r=await processOutbox();assert.ok(r.sent>=2);
  const em=net.calls.find(c=>c.url==='https://api.resend.com/emails'),sm=net.calls.find(c=>c.url.includes('api.twilio.com'));
  assert.ok(em&&em.auth==='Bearer re_x'&&JSON.parse(em.body).to[0]==='awa@ex.sn'&&!/Dépression|Psychiatrie/.test(em.body));
  assert.ok(sm&&sm.auth.startsWith('Basic ')&&sm.body.includes('To=%2B221'+pA.tel));
  // échec réseau : reste « pending » avec un délai, puis « failed » après 5 tentatives
  net.status=500;const s2=await mkSlot(60*60);await book(pA,s2);
  for(let i=0;i<5;i++){await pg.query(`UPDATE outbox SET next_attempt_at=now() WHERE status='pending'`);await processOutbox();}
  net.status=200;
  const st=await q(`SELECT status,attempts FROM outbox WHERE status='failed'`);assert.ok(st.length>=1&&st.every(x=>x.attempts===5));
  const adm=await mk('admin');const stats=(await call(adm,'GET','/api/admin/notifications')).b;
  assert.ok(stats.envois.some(e=>e.status==='failed')&&stats.canaux.email&&stats.canaux.sms);
});
test('réinitialisation du mot de passe : code livré par SMS puis accepté ; sans SMS : non livré',async()=>{
  net.calls.length=0;
  assert.equal((await call(null,'POST','/api/auth/reset-request',{ident:pB.tel})).s,200);
  const sms=net.calls.find(c=>c.url.includes('twilio'));const code=decodeURIComponent(sms.body.replace(/\+/g,' ')).match(/est (\d{6})/)[1];
  assert.equal((await call(null,'POST','/api/auth/reset-confirm',{ident:pB.tel,code:'000000',password:'Nouveau2026ok'})).s,400);
  assert.equal((await call(null,'POST','/api/auth/reset-confirm',{ident:pB.tel,code,password:'Nouveau2026ok'})).s,200);
  assert.equal((await q(`SELECT count(*)::int c FROM audit_log WHERE event='reset_sent'`))[0].c,1);
  delete process.env.TWILIO_ACCOUNT_SID;net.calls.length=0;
  await call(null,'POST','/api/auth/reset-request',{ident:pA.tel});
  assert.equal(net.calls.length,0);assert.equal((await q(`SELECT count(*)::int c FROM audit_log WHERE event='reset_not_delivered'`))[0].c,1);
});
