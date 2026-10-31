import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';
import {__setDriver} from '../netlify/functions/lib/db.js';import {sha256} from '../netlify/functions/lib/util.js';
const pg=new PGlite();__setDriver(async(st,...v)=>(await pg.query(st.reduce((a,s,i)=>a+(i?'$'+i:'')+s,''),v)).rows);
await pg.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
const api=(await import('../netlify/functions/api.js')).default;
const wave={sessions:{},refund:200,n:0};
globalThis.fetch=async(url,o={})=>{const u=new URL(url),b=o.body?JSON.parse(o.body):{};const res=(s,d)=>({ok:s<300,status:s,text:async()=>JSON.stringify(d)});
  if(o.method==='POST'&&u.pathname==='/v1/checkout/sessions'){const id='cos-'+(++wave.n);wave.sessions[id]={id,amount:b.amount,currency:b.currency,client_reference:b.client_reference,checkout_status:'open',payment_status:'processing',wave_launch_url:'https://pay.wave.com/c/'+id};return res(200,wave.sessions[id]);}
  let m;if(m=u.pathname.match(/\/refund$/))return res(wave.refund,{});if(m=u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))return wave.sessions[m[1]]?res(200,wave.sessions[m[1]]):res(404,{});return res(404,{});};
let n=0;
async function mk(role,status='active'){const tok='t'+(++n)+'h'.repeat(30);const u=(await pg.query(`INSERT INTO users(role,status,nom,tel,pwd_hash,consent_version,consent_at) VALUES($1,$2,$3,$4,'x','t',now()) RETURNING id`,[role,status,role+n,'76'+String(8000000+n)])).rows[0];
  await pg.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[u.id,sha256(tok)]);return {id:u.id,tok};}
const raw=(who,m,p,b)=>api(new Request('https://x.sn'+p,{method:m,headers:{'content-type':'application/json','x-requested-with':'kayligey',origin:'https://kay.test',...(who?{cookie:'kay_session='+who.tok}:{})},body:m==='GET'?undefined:JSON.stringify(b||{})}));
const call=async(w,m,p,b)=>{const r=await raw(w,m,p,b);return {s:r.status,b:await r.json()};};
const q=async(s,p=[])=>(await pg.query(s,p)).rows;
const hook=async sid=>{const t=Math.floor(Date.now()/1000),body=JSON.stringify({id:'e'+Math.random(),type:'x',data:{id:sid}});return (await api(new Request('https://x.sn/api/webhooks/wave',{method:'POST',headers:{'wave-signature':`t=${t},v1=${crypto.createHmac('sha256','whs').update(t+body).digest('hex')}`},body}))).status;};
const A=await mk('patient'),B=await mk('patient'),ph1=await mk('pharmacien'),ph2=await mk('pharmacien'),doc=await mk('medecin'),adm=await mk('admin');
let PARA,AMOX,rxn=0;
const mkRx=async(p)=>(await q(`INSERT INTO prescriptions(number,patient_id,doctor_id,items,status,signed_at) VALUES($1,$2,$3,'[{"medicament":"Amoxicilline","posologie":"3/j"}]','signee',now()) RETURNING id`,['ORD-2026-9'+String(++rxn).padStart(5,'0'),p.id,doc.id]))[0].id;

test('inscription pharmacien : compte en attente ; profil ; vérification de l\u2019autorisation par l\u2019admin',async()=>{
  const r=await call(null,'POST','/api/auth/register',{nom:'Pharmacie Test',tel:'761112223',password:'Motdepasse2026ok',role:'pharmacien',consent:true});assert.equal(r.s,201);assert.equal(r.b.user.status,'pending');
  const prof={nom_officine:'Pharmacie du Marché',ville:'Thiès',adresse:'Avenue Lamine Gueye',numero_autorisation:'PH-001',frais_livraison_fcfa:1000};
  assert.equal((await call(ph1,'POST','/api/pharmacy/profile',{...prof,numero_autorisation:''})).s,400);
  assert.equal((await call(ph1,'POST','/api/pharmacy/profile',prof)).s,200);
  assert.equal((await call(ph2,'POST','/api/pharmacy/profile',{...prof,nom_officine:'Pharmacie Centrale',numero_autorisation:'PH-002',frais_livraison_fcfa:''})).s,200);
  assert.equal((await call(null,'GET','/api/pharmacy/list')).b.officines.length,0);                                   // invisible tant que non vérifiée
  assert.equal((await call(ph1,'POST','/api/pharmacy/stock',{drugId:crypto.randomUUID(),prix_fcfa:100,quantite:1})).s,403);
  assert.equal((await call(A,'POST',`/api/admin/pharmacies/${ph1.id}/verify`,{justificatifs_verifies:true})).s,403);
  assert.equal((await call(adm,'POST',`/api/admin/pharmacies/${ph1.id}/verify`,{})).s,400);
  for(const p of [ph1,ph2])assert.equal((await call(adm,'POST',`/api/admin/pharmacies/${p.id}/verify`,{justificatifs_verifies:true})).s,200);
  assert.equal((await call(null,'GET','/api/pharmacy/list?ville=thiès')).b.officines.length,2);
});
test('catalogue : géré par l\u2019admin seul, vide au départ ; stock et prix par officine ; quantités exactes jamais exposées',async()=>{
  assert.equal((await call(null,'GET','/api/pharmacy/catalogue')).b.medicaments.length,0);
  assert.equal((await call(ph1,'POST','/api/admin/drugs',{nom:'X',sur_ordonnance:false})).s,403);
  assert.equal((await call(adm,'POST','/api/admin/drugs',{nom:'Paracétamol',forme:'comprimé',dosage:'500 mg'})).s,400);   // statut ordonnance obligatoire
  PARA=(await call(adm,'POST','/api/admin/drugs',{nom:'Paracétamol',forme:'comprimé',dosage:'500 mg',sur_ordonnance:false})).b.id;
  AMOX=(await call(adm,'POST','/api/admin/drugs',{nom:'Amoxicilline',forme:'gélule',dosage:'500 mg',sur_ordonnance:true})).b.id;
  assert.equal((await call(adm,'POST','/api/admin/drugs',{nom:'paracétamol',forme:'comprimé',dosage:'500 mg',sur_ordonnance:false})).s,409);
  assert.equal((await call(ph1,'POST','/api/pharmacy/stock',{drugId:PARA,prix_fcfa:0,quantite:5})).s,400);
  assert.equal((await call(ph1,'POST','/api/pharmacy/stock',{drugId:PARA,prix_fcfa:500,quantite:10})).s,200);
  assert.equal((await call(ph1,'POST','/api/pharmacy/stock',{drugId:AMOX,prix_fcfa:2500,quantite:5})).s,200);
  assert.equal((await call(ph2,'POST','/api/pharmacy/stock',{drugId:PARA,prix_fcfa:450,quantite:1})).s,200);
  assert.equal((await call(A,'POST','/api/pharmacy/stock',{drugId:PARA,prix_fcfa:1,quantite:1})).s,403);
  const s=(await call(null,'GET',`/api/pharmacy/list/${ph1.id}/stock`)).b.medicaments;assert.equal(s.length,2);assert.ok(s.every(x=>!('quantite' in x)&&x.disponible===true));
  assert.equal((await call(null,'GET','/api/pharmacy/catalogue?q=parac')).b.medicaments[0].officines_disponibles,2);
  await assert.rejects(q(`UPDATE pharmacy_stock SET quantite=-1`),/check/i);                                               // jamais de stock négatif, même en cas de bug
});
let O1,RX1;
test('commande : validation, ordonnance obligatoire pour les médicaments concernés, totaux, stock décrémenté',async()=>{
  const base={pharmacyId:ph1.id,mode:'retrait',consent:true};
  assert.equal((await call(A,'POST','/api/pharmacy/orders',{...base,consent:false,items:[{drugId:PARA,quantite:1}]})).s,400);
  assert.equal((await call(A,'POST','/api/pharmacy/orders',{...base,items:[{drugId:PARA,quantite:99}]})).s,400);
  assert.equal((await call(A,'POST','/api/pharmacy/orders',{...base,items:[{drugId:crypto.randomUUID(),quantite:1}]})).s,409);
  assert.equal((await call(A,'POST','/api/pharmacy/orders',{...base,items:[{drugId:PARA,quantite:11}]})).s,409);          // stock insuffisant
  assert.equal((await call(A,'POST','/api/pharmacy/orders',{pharmacyId:ph2.id,mode:'livraison',adresse:'Rue 1, Thiès',consent:true,items:[{drugId:PARA,quantite:1}]})).s,409); // pas de livraison
  assert.equal((await call(A,'POST','/api/pharmacy/orders',{...base,items:[{drugId:PARA,quantite:1},{drugId:AMOX,quantite:1}]})).s,400);      // ordonnance requise
  const rxB=await mkRx(B);assert.equal((await call(A,'POST','/api/pharmacy/orders',{...base,prescriptionId:rxB,items:[{drugId:AMOX,quantite:1}]})).s,403);   // ordonnance d'un autre patient
  RX1=await mkRx(A);
  assert.equal((await call(ph1,'POST','/api/pharmacy/orders',{...base,items:[{drugId:PARA,quantite:1}]})).s,403);
  const o=await call(A,'POST','/api/pharmacy/orders',{pharmacyId:ph1.id,mode:'livraison',adresse:'Rue 10, Thiès',consent:true,prescriptionId:RX1,items:[{drugId:PARA,quantite:2},{drugId:AMOX,quantite:1}]});
  assert.equal(o.s,201);assert.equal(o.b.commande.total_fcfa,2*500+2500+1000);assert.equal(o.b.commande.status,'en_attente');O1=o.b.commande.id;
  const st=Object.fromEntries((await q(`SELECT drug_id,quantite FROM pharmacy_stock WHERE pharmacy_id=$1`,[ph1.id])).map(x=>[x.drug_id,x.quantite]));assert.deepEqual([st[PARA],st[AMOX]],[8,4]);
  assert.equal((await call(B,'POST','/api/pharmacy/orders',{...base,prescriptionId:RX1,items:[{drugId:AMOX,quantite:1}]})).s,403);                  // même ordonnance, autre patient
  assert.equal((await call(A,'POST','/api/pharmacy/orders',{...base,prescriptionId:RX1,items:[{drugId:AMOX,quantite:1}]})).s,409);                 // ordonnance déjà liée
  const nt=await q(`SELECT body FROM notifications WHERE user_id=$1 AND kind='pharmacie'`,[ph1.id]);assert.ok(nt.length>=1&&!/Paracétamol|Amoxicilline/.test(nt[0].body));
});
test('dernière unité demandée par deux patients en même temps : une seule commande, jamais de survente',async()=>{
  const [a,b]=await Promise.all([call(A,'POST','/api/pharmacy/orders',{pharmacyId:ph2.id,mode:'retrait',consent:true,items:[{drugId:PARA,quantite:1}]}),call(B,'POST','/api/pharmacy/orders',{pharmacyId:ph2.id,mode:'retrait',consent:true,items:[{drugId:PARA,quantite:1}]})]);
  assert.deepEqual([a.s,b.s].sort(),[201,409]);assert.equal((await q(`SELECT quantite FROM pharmacy_stock WHERE pharmacy_id=$1 AND drug_id=$2`,[ph2.id,PARA]))[0].quantite,0);
});
test('traitement par l\u2019officine : confidentialité, ordonnance vérifiée avant remise, ordonnance « délivrée », droits',async()=>{
  const l=(await call(ph1,'GET','/api/pharmacy/orders')).b.commandes.find(c=>c.id===O1);assert.ok(l.patient&&l.adresse==='Rue 10, Thiès'&&l.ordonnance.items.length===1&&l.articles.length===2);
  assert.equal((await call(ph2,'POST',`/api/pharmacy/orders/${O1}/accept`,{})).s,404);                                        // autre officine
  for(const w of [A,doc,adm])assert.equal((await call(w,'POST',`/api/pharmacy/orders/${O1}/accept`,{})).s,403);
  assert.equal((await call(adm,'GET','/api/pharmacy/orders')).s,403);
  assert.equal((await call(ph1,'POST',`/api/pharmacy/orders/${O1}/ready`,{})).s,409);                                         // pas avant l'acceptation
  assert.equal((await call(ph1,'POST',`/api/pharmacy/orders/${O1}/accept`,{})).s,200);
  assert.equal((await call(A,'POST',`/api/pharmacy/orders/${O1}/cancel`,{})).s,409);                                          // déjà en préparation
  assert.equal((await call(ph1,'POST',`/api/pharmacy/orders/${O1}/handover`,{prescription_verifiee:true})).s,409);   // pas avant « prête »
  assert.equal((await call(ph1,'POST',`/api/pharmacy/orders/${O1}/ready`,{})).s,200);
  assert.equal((await call(ph1,'POST',`/api/pharmacy/orders/${O1}/handover`,{})).s,400);                                      // vérification d'ordonnance obligatoire
  assert.equal((await call(ph1,'POST',`/api/pharmacy/orders/${O1}/handover`,{prescription_verifiee:true})).b.ordonnance_delivree,true);
  assert.equal((await q(`SELECT status FROM prescriptions WHERE id=$1`,[RX1]))[0].status,'delivree');
  const num=(await q(`SELECT number FROM prescriptions WHERE id=$1`,[RX1]))[0].number;const v=await call(null,'GET','/api/prescriptions/verify/'+num);assert.deepEqual([v.b.statut,v.b.valide],['delivree',false]);
  await assert.rejects(q(`UPDATE prescriptions SET items='[]'::jsonb WHERE id=$1`,[RX1]),/non modifiable/);
  await assert.rejects(q(`UPDATE prescriptions SET status='signee' WHERE id=$1`,[RX1]),/non modifiable/);                     // pas de retour en arrière : pas de double délivrance
  assert.equal((await call(ph1,'POST',`/api/pharmacy/orders/${O1}/handover`,{prescription_verifiee:true})).s,409);
});
test('annulation par le patient : stock remis, ordonnance réutilisable ; refus par l\u2019officine',async()=>{
  const rx=await mkRx(A);const o=await call(A,'POST','/api/pharmacy/orders',{pharmacyId:ph1.id,mode:'retrait',consent:true,prescriptionId:rx,items:[{drugId:AMOX,quantite:2}]});
  assert.equal((await q(`SELECT quantite FROM pharmacy_stock WHERE pharmacy_id=$1 AND drug_id=$2`,[ph1.id,AMOX]))[0].quantite,2);
  assert.equal((await call(B,'POST',`/api/pharmacy/orders/${o.b.commande.id}/cancel`,{})).s,409);
  assert.equal((await call(A,'POST',`/api/pharmacy/orders/${o.b.commande.id}/cancel`,{})).s,200);
  assert.equal((await q(`SELECT quantite FROM pharmacy_stock WHERE pharmacy_id=$1 AND drug_id=$2`,[ph1.id,AMOX]))[0].quantite,4);
  const o2=await call(A,'POST','/api/pharmacy/orders',{pharmacyId:ph1.id,mode:'retrait',consent:true,prescriptionId:rx,items:[{drugId:AMOX,quantite:1}]});assert.equal(o2.s,201); // ordonnance de nouveau utilisable
  assert.equal((await call(ph1,'POST',`/api/pharmacy/orders/${o2.b.commande.id}/reject`,{reason:''})).s,400);
  assert.equal((await call(ph1,'POST',`/api/pharmacy/orders/${o2.b.commande.id}/reject`,{reason:'Rupture constatée'})).s,200);
  assert.equal((await q(`SELECT quantite FROM pharmacy_stock WHERE pharmacy_id=$1 AND drug_id=$2`,[ph1.id,AMOX]))[0].quantite,4);
});
test('paiement en ligne : retenue, stock réservé puis remis à l\u2019expiration, confirmation, reçu, refus = remboursement',async()=>{
  Object.assign(process.env,{WAVE_API_KEY:'k',WAVE_WEBHOOK_SECRET:'whs',APP_ORIGIN:'https://kay.test',COMMISSION_BPS:'1000'});
  const items=[{drugId:PARA,quantite:3}],mo={pharmacyId:ph1.id,mode:'retrait',consent:true,items};
  const a=await call(B,'POST','/api/pharmacy/orders',mo);assert.equal(a.b.commande.status,'pending_payment');const stk=()=>q(`SELECT quantite FROM pharmacy_stock WHERE pharmacy_id=$1 AND drug_id=$2`,[ph1.id,PARA]).then(r=>r[0].quantite);
  const before=await stk();
  assert.equal((await call(ph1,'GET','/api/pharmacy/orders')).b.commandes.find(c=>c.id===a.b.commande.id).patient,null);   // identité cachée tant que non payé
  await pg.query(`UPDATE pharmacy_orders SET hold_expires_at=now()-interval '1 minute' WHERE id=$1`,[a.b.commande.id]);await call(null,'GET','/api/doctors');
  assert.equal(await stk(),before+3);assert.equal((await q(`SELECT status FROM pharmacy_orders WHERE id=$1`,[a.b.commande.id]))[0].status,'annulee');
  const b=await call(B,'POST','/api/pharmacy/orders',mo);const c=await call(B,'POST','/api/payments/checkout',{orderId:b.b.commande.id});assert.equal(c.s,201);
  assert.equal((await call(A,'POST','/api/payments/checkout',{orderId:b.b.commande.id})).s,409);
  const sid='cos-'+wave.n;wave.sessions[sid].payment_status='succeeded';assert.equal(await hook(sid),200);assert.equal(await hook(sid),200);
  assert.equal((await q(`SELECT status FROM pharmacy_orders WHERE id=$1`,[b.b.commande.id]))[0].status,'en_attente');
  assert.equal((await q(`SELECT count(*)::int c FROM receipts WHERE payment_id=$1`,[c.b.payment.id]))[0].c,1);
  assert.match((await call(B,'GET',`/api/payments/${c.b.payment.id}/receipt`)).b.receipt.medecin,/Pharmacie du Marché/);
  assert.ok((await call(ph1,'GET','/api/pharmacy/orders')).b.commandes.find(x=>x.id===b.b.commande.id).patient);
  const s0=await stk();assert.equal((await call(ph1,'POST',`/api/pharmacy/orders/${b.b.commande.id}/reject`,{reason:'Produit indisponible'})).b.remboursement,'effectué');
  assert.equal(await stk(),s0+3);assert.equal((await q(`SELECT status FROM payments WHERE id=$1`,[c.b.payment.id]))[0].status,'refunded');
  const rec=await call(adm,'GET','/api/admin/reconciliation');assert.deepEqual([rec.b.anomalies.reussis_sans_recu,rec.b.anomalies.ecart_grand_livre],[[],[]]);
  assert.equal((await call(B,'GET','/api/pharmacy/my-orders')).b.commandes.length>=2,true);
});
