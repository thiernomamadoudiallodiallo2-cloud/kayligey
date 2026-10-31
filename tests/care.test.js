import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';
import {__setDriver} from '../netlify/functions/lib/db.js';import {sha256} from '../netlify/functions/lib/util.js';
const pg=new PGlite();__setDriver(async(st,...v)=>(await pg.query(st.reduce((a,s,i)=>a+(i?'$'+i:'')+s,''),v)).rows);
await pg.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
const api=(await import('../netlify/functions/api.js')).default;
// faux Wave
const wave={sessions:{},refund:200,n:0};
globalThis.fetch=async(url,o={})=>{const u=new URL(url),b=o.body?JSON.parse(o.body):{};const res=(s,d)=>({ok:s<300,status:s,text:async()=>JSON.stringify(d)});
  if(o.method==='POST'&&u.pathname==='/v1/checkout/sessions'){const id='cos-'+(++wave.n);wave.sessions[id]={id,amount:b.amount,currency:b.currency,client_reference:b.client_reference,checkout_status:'open',payment_status:'processing',wave_launch_url:'https://pay.wave.com/c/'+id};return res(200,wave.sessions[id]);}
  let m;if(m=u.pathname.match(/\/refund$/))return res(wave.refund,{});if(m=u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))return wave.sessions[m[1]]?res(200,wave.sessions[m[1]]):res(404,{});return res(404,{});};
let n=0;
async function mk(role){const tok='t'+(++n)+'c'.repeat(30);const u=(await pg.query(`INSERT INTO users(role,status,nom,tel,pwd_hash,consent_version,consent_at) VALUES($1,'active',$2,$3,'x','t',now()) RETURNING id`,[role,role+n,'77'+String(7000000+n)])).rows[0];
  await pg.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[u.id,sha256(tok)]);return {id:u.id,tok};}
const raw=(who,m,p,b)=>api(new Request('https://x.sn'+p,{method:m,headers:{'content-type':'application/json','x-requested-with':'kayligey',origin:'https://kay.test',...(who?{cookie:'kay_session='+who.tok}:{})},body:m==='GET'?undefined:JSON.stringify(b||{})}));
const call=async(w,m,p,b)=>{const r=await raw(w,m,p,b);return {s:r.status,b:await r.json()};};
const q=async(s,p=[])=>(await pg.query(s,p)).rows;
const hook=async(sid)=>{const t=Math.floor(Date.now()/1000),body=JSON.stringify({id:'e'+Math.random(),type:'x',data:{id:sid}});
  return (await api(new Request('https://x.sn/api/webhooks/wave',{method:'POST',headers:{'wave-signature':`t=${t},v1=${crypto.createHmac('sha256','whs').update(t+body).digest('hex')}`},body}))).status;};
const pat=await mk('patient'),pat2=await mk('patient'),inf=await mk('prestataire'),inf2=await mk('prestataire'),kine=await mk('prestataire'),doc=await mk('medecin'),adm=await mk('admin');
const day=d=>new Date(Date.now()+d*864e5).toISOString().slice(0,10);
let rid,Q1,Q2,M1;

test('profil prestataire : n° d\u2019inscription exigé pour une profession réglementée ; invisible tant que non vérifié',async()=>{
  const prof={categorie:'infirmier',zones:['Thiès'],tarif_fcfa:5000,frais_deplacement_fcfa:1000};
  assert.equal((await call(inf,'POST','/api/provider/profile',prof)).s,400);
  assert.equal((await call(inf,'POST','/api/provider/profile',{...prof,qualification_ref:'INF-123'})).s,200);
  assert.equal((await call(inf2,'POST','/api/provider/profile',{...prof,qualification_ref:'INF-456',tarif_fcfa:4000})).s,200);
  assert.equal((await call(kine,'POST','/api/provider/profile',{categorie:'kinesitherapeute',zones:['Dakar'],tarif_fcfa:8000,qualification_ref:'KIN-1'})).s,200);
  assert.equal((await call(null,'GET','/api/care/providers')).b.prestataires.length,0);
  assert.equal((await call(pat,'POST',`/api/admin/providers/${inf.id}/verify`,{justificatifs_verifies:true})).s,403);
  assert.equal((await call(adm,'POST',`/api/admin/providers/${inf.id}/verify`,{})).s,400);
  for(const p of [inf,inf2,kine])assert.equal((await call(adm,'POST',`/api/admin/providers/${p.id}/verify`,{justificatifs_verifies:true})).s,200);
  assert.equal((await call(null,'GET','/api/care/providers?categorie=infirmier&zone=thiès')).b.prestataires.length,2);   // zone insensible à la casse
  await call(inf,'POST','/api/provider/profile',{categorie:'infirmier',zones:['Thiès'],tarif_fcfa:5000,qualification_ref:'INF-999'});
  assert.equal((await call(null,'GET','/api/care/providers?categorie=infirmier')).b.prestataires.length,1);              // n° modifié => vérification retirée
  await call(adm,'POST',`/api/admin/providers/${inf.id}/verify`,{justificatifs_verifies:true});
});
test('demande : visible seulement des prestataires vérifiés de la bonne catégorie et zone, sans identité',async()=>{
  assert.equal((await call(pat,'POST','/api/care/requests',{categorie:'infirmier',zone:'Thiès',preferred_date:'2000-01-01'})).s,400);
  assert.equal((await call(pat,'POST','/api/care/requests',{categorie:'inconnue',zone:'Thiès'})).s,400);
  rid=(await call(pat,'POST','/api/care/requests',{categorie:'infirmier',zone:'Thiès',preferred_date:day(5),description:'Pansement à refaire'})).b.id;
  const seen=await call(inf,'GET','/api/provider/requests');assert.equal(seen.b.demandes.length,1);assert.ok(!JSON.stringify(seen.b).includes(pat.id));
  assert.equal((await call(kine,'GET','/api/provider/requests')).b.demandes.length,0);                                    // autre catégorie/zone
  assert.equal((await call(doc,'GET','/api/provider/requests')).s,403);assert.equal((await call(pat,'GET','/api/provider/requests')).s,403);
  assert.equal((await call(pat,'POST','/api/care/requests',{categorie:'infirmier',zone:'Thiès',dependentId:'11111111-1111-1111-1111-111111111111'})).s,403);
});
test('devis : un seul par prestataire, hors périmètre refusé, comparaison côté patient',async()=>{
  Q1=(await call(inf,'POST',`/api/provider/requests/${rid}/quote`,{prix_fcfa:5000,frais_fcfa:1000,message:'Disponible jeudi'})).b.id;
  assert.equal((await call(inf,'POST',`/api/provider/requests/${rid}/quote`,{prix_fcfa:1,frais_fcfa:0})).s,409);
  assert.equal((await call(kine,'POST',`/api/provider/requests/${rid}/quote`,{prix_fcfa:5000})).s,409);
  Q2=(await call(inf2,'POST',`/api/provider/requests/${rid}/quote`,{prix_fcfa:4000,frais_fcfa:500})).b.id;
  const d=(await call(pat,'GET','/api/care/requests')).b.demandes[0];assert.deepEqual(d.devis.map(x=>x.prix_fcfa+x.frais_fcfa),[4500,6000]);  // triés par coût total
  assert.equal((await call(pat2,'GET','/api/care/requests')).b.demandes.length,0);
  const nt=await q(`SELECT body FROM notifications WHERE user_id=$1 AND kind='mission'`,[pat.id]);assert.ok(nt.length>=1&&!/Pansement|Thiès/.test(nt[0].body));
});
test('acceptation (sans paiement en ligne) : atomique, adresse révélée au seul prestataire retenu',async()=>{
  assert.equal((await call(pat2,'POST',`/api/care/requests/${rid}/accept`,{quoteId:Q1,adresse:'Rue 10, Thiès',consent:true})).s,409);   // pas sa demande
  assert.equal((await call(pat,'POST',`/api/care/requests/${rid}/accept`,{quoteId:Q2,adresse:'x',consent:true})).s,400);
  assert.equal((await call(pat,'POST',`/api/care/requests/${rid}/accept`,{quoteId:Q2,adresse:'Rue 10, Thiès',consent:false})).s,400);
  const a=await call(pat,'POST',`/api/care/requests/${rid}/accept`,{quoteId:Q2,adresse:'Rue 10, Thiès',consent:true});assert.equal(a.s,201);assert.equal(a.b.mission.status,'confirmee');assert.equal(a.b.mission.payment_mode,'sur_place');M1=a.b.mission.id;
  assert.equal((await call(pat,'POST',`/api/care/requests/${rid}/accept`,{quoteId:Q1,adresse:'Rue 10, Thiès',consent:true})).s,409);       // déjà attribuée
  assert.deepEqual((await q(`SELECT status FROM care_quotes WHERE id=$1`,[Q1])).map(x=>x.status),['refusee']);
  assert.equal((await call(inf,'GET','/api/provider/missions')).b.missions.length,0);                                                      // l'autre prestataire ne voit rien
  const mine=(await call(inf2,'GET','/api/provider/missions')).b.missions[0];assert.equal(mine.adresse,'Rue 10, Thiès');assert.ok(mine.patient);
  assert.equal((await call(adm,'GET','/api/provider/missions')).s,403);
});
test('réalisation, confirmation, avis authentique, note moyenne',async()=>{
  assert.equal((await call(pat,'POST',`/api/missions/${M1}/review`,{rating:5})).s,409);                         // pas avant la confirmation
  assert.equal((await call(pat,'POST',`/api/missions/${M1}/declare-done`,{})).s,403);                           // le patient ne déclare pas à la place du prestataire
  assert.equal((await call(pat,'POST',`/api/missions/${M1}/confirm-done`,{})).s,409);                           // rien déclaré
  assert.equal((await call(inf2,'POST',`/api/missions/${M1}/declare-done`,{})).s,200);
  assert.equal((await call(inf2,'POST',`/api/missions/${M1}/confirm-done`,{})).s,403);
  assert.equal((await call(pat2,'POST',`/api/missions/${M1}/confirm-done`,{})).s,404);                          // étranger à la mission
  assert.equal((await call(pat,'POST',`/api/missions/${M1}/confirm-done`,{})).s,200);
  assert.equal((await call(pat,'POST',`/api/missions/${M1}/review`,{rating:9})).s,400);
  assert.equal((await call(pat,'POST',`/api/missions/${M1}/review`,{rating:5,comment:'Très bien'})).s,201);
  assert.equal((await call(pat,'POST',`/api/missions/${M1}/review`,{rating:1})).s,409);
  const p=(await call(null,'GET','/api/care/providers?categorie=infirmier')).b.prestataires.find(x=>x.id===inf2.id);assert.deepEqual([Number(p.note),p.nb_avis],[5,1]);
});
test('paiement en ligne : retenue 30 min, Wave, confirmation, reçu, annulation par le prestataire = remboursement',async()=>{
  Object.assign(process.env,{WAVE_API_KEY:'k',WAVE_WEBHOOK_SECRET:'whs',APP_ORIGIN:'https://kay.test',COMMISSION_BPS:'1000'});
  const r2=(await call(pat,'POST','/api/care/requests',{categorie:'infirmier',zone:'Thiès'})).b.id;
  const q1=(await call(inf,'POST',`/api/provider/requests/${r2}/quote`,{prix_fcfa:9000,frais_fcfa:1000})).b.id;
  const a=await call(pat,'POST',`/api/care/requests/${r2}/accept`,{quoteId:q1,adresse:'Avenue 5, Thiès',consent:true});assert.equal(a.b.mission.status,'pending_payment');const mid=a.b.mission.id;
  assert.equal((await call(inf,'GET','/api/provider/missions')).b.missions.find(x=>x.id===mid).adresse,null);   // adresse cachée tant que non payé
  const c1=await call(pat,'POST','/api/payments/checkout',{missionId:mid});assert.equal(c1.s,201);assert.equal((await call(pat,'POST','/api/payments/checkout',{missionId:mid})).b.launch_url,c1.b.launch_url);
  assert.equal((await call(pat2,'POST','/api/payments/checkout',{missionId:mid})).s,409);
  const sid='cos-'+wave.n;wave.sessions[sid].payment_status='succeeded';assert.equal(await hook(sid),200);assert.equal(await hook(sid),200);
  assert.equal((await q(`SELECT status FROM missions WHERE id=$1`,[mid]))[0].status,'confirmee');
  const pid=c1.b.payment.id;assert.equal((await q(`SELECT count(*)::int c FROM receipts WHERE payment_id=$1`,[pid]))[0].c,1);
  assert.deepEqual(Object.fromEntries((await q(`SELECT kind,amount_fcfa a FROM ledger_entries WHERE payment_id=$1`,[pid])).map(x=>[x.kind,x.a])),{paiement:10000,commission:1000,a_verser_medecin:9000});
  assert.equal((await call(inf,'GET','/api/provider/missions')).b.missions.find(x=>x.id===mid).adresse,'Avenue 5, Thiès');
  assert.equal((await call(inf,'GET','/api/provider/revenue')).b.a_verser_fcfa,9000);
  assert.match((await call(pat,'GET',`/api/payments/${pid}/receipt`)).b.receipt.medecin,/prestataire/);
  assert.equal((await call(inf,'POST',`/api/missions/${mid}/cancel`,{})).b.remboursement,'effectué');
  assert.equal((await q(`SELECT status FROM payments WHERE id=$1`,[pid]))[0].status,'refunded');assert.equal((await call(inf,'GET','/api/provider/revenue')).b.a_verser_fcfa,0);
});
test('retenue expirée : la demande redevient ouverte ; annulation tardive du patient non remboursée',async()=>{
  const r3=(await call(pat,'POST','/api/care/requests',{categorie:'infirmier',zone:'Thiès'})).b.id;
  const q3=(await call(inf,'POST',`/api/provider/requests/${r3}/quote`,{prix_fcfa:3000})).b.id;
  const a=await call(pat,'POST',`/api/care/requests/${r3}/accept`,{quoteId:q3,adresse:'Rue 1, Thiès',consent:true});
  await pg.query(`UPDATE missions SET hold_expires_at=now()-interval '1 minute' WHERE id=$1`,[a.b.mission.id]);
  await call(null,'GET','/api/doctors');                                                                          // déclenche la libération des retenues
  assert.equal((await q(`SELECT status FROM care_requests WHERE id=$1`,[r3]))[0].status,'ouverte');assert.equal((await q(`SELECT status FROM care_quotes WHERE id=$1`,[q3]))[0].status,'proposee');
  // paiement arrivé après expiration => remboursé automatiquement
  const re=await call(pat,'POST',`/api/care/requests/${r3}/accept`,{quoteId:q3,adresse:'Rue 1, Thiès',consent:true});assert.equal(re.b.mission.status,'pending_payment');
  const c=await call(pat,'POST','/api/payments/checkout',{missionId:re.b.mission.id});await pg.query(`UPDATE missions SET hold_expires_at=now()-interval '1 minute' WHERE id=$1`,[re.b.mission.id]);await call(null,'GET','/api/doctors');
  const sid='cos-'+wave.n;wave.sessions[sid].payment_status='succeeded';await hook(sid);
  assert.equal((await q(`SELECT status FROM payments WHERE id=$1`,[c.b.payment.id]))[0].status,'refunded');
  // annulation tardive : intervention demain, payée, annulée par le patient => pas de remboursement automatique
  const r4=(await call(pat,'POST','/api/care/requests',{categorie:'infirmier',zone:'Thiès',preferred_date:day(0)})).b.id;
  const q4=(await call(inf,'POST',`/api/provider/requests/${r4}/quote`,{prix_fcfa:2000})).b.id;
  const a4=await call(pat,'POST',`/api/care/requests/${r4}/accept`,{quoteId:q4,adresse:'Rue 2, Thiès',consent:true});const c4=await call(pat,'POST','/api/payments/checkout',{missionId:a4.b.mission.id});
  const s4='cos-'+wave.n;wave.sessions[s4].payment_status='succeeded';await hook(s4);
  assert.equal((await call(pat,'POST',`/api/missions/${a4.b.mission.id}/cancel`,{})).b.remboursement,'non remboursable (annulation tardive)');
  assert.equal((await q(`SELECT status FROM payments WHERE id=$1`,[c4.b.payment.id]))[0].status,'succeeded');
});
test('litige : ouverture, décision réservée à l\u2019admin, remboursement',async()=>{
  const r5=(await call(pat,'POST','/api/care/requests',{categorie:'infirmier',zone:'Thiès'})).b.id;
  const q5=(await call(inf,'POST',`/api/provider/requests/${r5}/quote`,{prix_fcfa:6000})).b.id;
  const a=await call(pat,'POST',`/api/care/requests/${r5}/accept`,{quoteId:q5,adresse:'Rue 3, Thiès',consent:true});const mid=a.b.mission.id;
  const c=await call(pat,'POST','/api/payments/checkout',{missionId:mid});const sid='cos-'+wave.n;wave.sessions[sid].payment_status='succeeded';await hook(sid);
  assert.equal((await call(pat,'POST',`/api/missions/${mid}/dispute`,{reason:'abc'})).s,400);
  const d=await call(pat,'POST',`/api/missions/${mid}/dispute`,{reason:'Le prestataire ne s\u2019est pas présenté'});assert.equal(d.s,201);
  assert.equal((await call(pat,'POST',`/api/admin/disputes/${d.b.id}/resolve`,{decision:'rembourser',note:'ok'})).s,403);
  assert.equal((await call(adm,'GET','/api/admin/disputes')).b.litiges.length,1);
  assert.equal((await call(adm,'POST',`/api/admin/disputes/${d.b.id}/resolve`,{decision:'rembourser',note:'Absence constatée'})).b.remboursement,'effectué');
  assert.equal((await q(`SELECT status FROM payments WHERE id=$1`,[c.b.payment.id]))[0].status,'refunded');
  assert.equal((await call(adm,'POST',`/api/admin/disputes/${d.b.id}/resolve`,{decision:'rejeter',note:'encore'})).s,404);            // déjà traité
  const rec=await call(adm,'GET','/api/admin/reconciliation');assert.deepEqual([rec.b.anomalies.reussis_sans_recu,rec.b.anomalies.ecart_grand_livre],[[],[]]);
});
