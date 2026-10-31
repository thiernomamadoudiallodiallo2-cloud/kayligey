import crypto from 'node:crypto';
import {sql,audit} from './db.js';
import {json,sha256,clean} from './util.js';
import {notifyAppt} from './notify.js';
import {notifyMission} from './care.js';
import {notifyOrder,restock} from './pharmacy.js';
import {waveEnabled,createSession,getSession,refundSession,verifyWebhook} from './wave.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bps=()=>{const n=parseInt(process.env.COMMISSION_BPS||'0',10);return Number.isFinite(n)?Math.min(5000,Math.max(0,n)):0;};
const need=(me,role)=>!me?json(401,{error:'Non connecté.'}):(me.role!==role||me.status!=='active')?json(403,{error:'Accès refusé.'}):null;

// Libère les créneaux dont le paiement n'est pas arrivé dans le délai de retenue (15 min)
export async function releaseExpiredHolds(){
  await sql`WITH e AS (UPDATE appointments SET status='cancelled',cancelled_at=now(),cancel_reason='Paiement non reçu dans le délai'
      WHERE status='pending_payment' AND hold_expires_at<now() RETURNING slot_id)
    UPDATE availability_slots SET status='open' WHERE id IN (SELECT slot_id FROM e) AND starts_at>now()`;
  // Commande de pharmacie non payée dans le délai : annulée et stock remis (une seule instruction)
  await sql`WITH e AS (UPDATE pharmacy_orders SET status='annulee',cancel_reason='Paiement non reçu dans le délai',updated_at=now() WHERE status='pending_payment' AND hold_expires_at<now() RETURNING id,pharmacy_id),
      q AS (SELECT e.pharmacy_id AS ph,i.drug_id,sum(i.quantite)::int AS n FROM e JOIN pharmacy_order_items i ON i.order_id=e.id GROUP BY 1,2)
    UPDATE pharmacy_stock s SET quantite=s.quantite+q.n,updated_at=now() FROM q WHERE s.pharmacy_id=q.ph AND s.drug_id=q.drug_id`;
  // Mission non payée dans le délai : la demande redevient ouverte, les devis redeviennent proposables
  await sql`WITH e AS (UPDATE missions SET status='annulee' WHERE status='pending_payment' AND hold_expires_at<now() RETURNING request_id),
      r AS (UPDATE care_requests SET status='ouverte' WHERE id IN (SELECT request_id FROM e) RETURNING id)
    UPDATE care_quotes SET status='proposee' WHERE request_id IN (SELECT request_id FROM e)`;
}
async function postLedger(paymentId,amount,sign){
  const c=Math.floor(amount*bps()/10000),rows=sign>0
    ?[['paiement',amount],['commission',c],['a_verser_medecin',amount-c]]
    :[['remboursement',-amount],['annul_commission',-c],['annul_a_verser_medecin',-(amount-c)]];
  for(const [k,v] of rows)await sql`INSERT INTO ledger_entries(payment_id,kind,amount_fcfa) VALUES(${paymentId},${k},${v}) ON CONFLICT(payment_id,kind) DO NOTHING`;
}
// Remboursement réel via Wave. « refunded » uniquement si Wave répond OK ; sinon « refund_pending » pour traitement admin.
export async function requestRefund(paymentId,actor,ip){
  const p=(await sql`UPDATE payments SET status='refund_pending' WHERE id=${paymentId} AND status IN ('succeeded','refund_pending') RETURNING id,appointment_id,mission_id,order_id,amount_fcfa,provider_session_id`)[0];
  if(!p)return {ok:false,error:'Aucun paiement remboursable.'};
  const r=await refundSession(p.provider_session_id);
  if(!r.ok){await audit(actor,'refund_failed',ip,{payment:paymentId,status:r.status});return {ok:false,pending:true,error:'Le prestataire n\u2019a pas confirmé le remboursement ; il reste en attente.'};}
  await sql`UPDATE payments SET status='refunded',refunded_at=now() WHERE id=${paymentId}`;
  await postLedger(paymentId,p.amount_fcfa,-1);
  await audit(actor,'refund_done',ip,{payment:paymentId});
  if(p.appointment_id)await notifyAppt(p.appointment_id,'refunded');
  if(p.mission_id)await notifyMission(p.mission_id,'refunded');
  if(p.order_id)await notifyOrder(p.order_id,'refunded');
  return {ok:true};
}
// Applique un paiement RÉUSSI, déjà confirmé auprès de Wave. Idempotent.
async function applySuccess(payment,ip){
  const r=(await sql`WITH p AS (UPDATE payments SET status='succeeded',paid_at=now() WHERE id=${payment.id} AND status='pending' RETURNING id,appointment_id,mission_id,order_id),
      a AS (UPDATE appointments SET status='confirmed',hold_expires_at=NULL FROM p WHERE appointments.id=p.appointment_id AND appointments.status='pending_payment' RETURNING appointments.id),
      m AS (UPDATE missions SET status='confirmee',hold_expires_at=NULL FROM p WHERE missions.id=p.mission_id AND missions.status='pending_payment' RETURNING missions.id),
      o AS (UPDATE pharmacy_orders SET status='en_attente',hold_expires_at=NULL,updated_at=now() FROM p WHERE pharmacy_orders.id=p.order_id AND pharmacy_orders.status='pending_payment' RETURNING pharmacy_orders.id)
    SELECT (SELECT count(*) FROM p)::int AS paid,((SELECT count(*) FROM a)+(SELECT count(*) FROM m)+(SELECT count(*) FROM o))::int AS confirmed`)[0];
  const cur=(await sql`SELECT status FROM payments WHERE id=${payment.id}`)[0];
  if(cur&&['succeeded','refund_pending'].includes(cur.status)){ // (re)joue les écritures si une exécution précédente a été interrompue
    await postLedger(payment.id,payment.amount_fcfa,1);
    await sql`INSERT INTO receipts(payment_id,number) SELECT ${payment.id},'KAY-'||to_char(now(),'YYYY')||'-'||lpad(nextval('receipt_seq')::text,6,'0')
      WHERE NOT EXISTS(SELECT 1 FROM receipts WHERE payment_id=${payment.id}) ON CONFLICT(payment_id) DO NOTHING`;
  }
  if(r.paid===1&&r.confirmed===0){ // paiement arrivé après expiration/annulation : remboursement automatique
    await audit(null,'late_payment_refund',ip,{payment:payment.id});await requestRefund(payment.id,null,ip);return 'refunded_late';
  }
  if(r.paid===1&&r.confirmed===1){if(payment.appointment_id)await notifyAppt(payment.appointment_id,'paid');if(payment.mission_id)await notifyMission(payment.mission_id,'paid');if(payment.order_id)await notifyOrder(payment.order_id,'paid');}
  return r.paid===1?'confirmed':'already_applied';
}
// Interroge Wave (source de vérité) puis applique. Utilisé par le webhook ET par la synchronisation admin.
export async function syncPayment(paymentId,ip){
  const p=(await sql`SELECT * FROM payments WHERE id=${paymentId}`)[0];if(!p||!p.provider_session_id)return {outcome:'unknown_payment'};
  const r=await getSession(p.provider_session_id);if(!r.ok)return {outcome:'provider_unreachable'};
  const s=r.data;
  if(String(s.amount)!==String(p.amount_fcfa)||s.currency!=='XOF'||s.client_reference!==p.id){await audit(null,'payment_mismatch',ip,{payment:p.id});return {outcome:'mismatch'};}
  if(s.payment_status==='succeeded')return {outcome:await applySuccess(p,ip)};
  if(s.payment_status==='cancelled'||s.checkout_status==='expired'){await sql`UPDATE payments SET status='failed' WHERE id=${p.id} AND status='pending'`;return {outcome:'failed'};}
  return {outcome:'still_pending'};
}
export async function handleWaveWebhook(req){
  const raw=await req.text(),ip=req.headers.get('x-nf-client-connection-ip')||'';
  if(!verifyWebhook(req.headers.get('wave-signature'),raw,process.env.WAVE_WEBHOOK_SECRET))return json(401,{error:'Signature invalide.'});
  let ev;try{ev=JSON.parse(raw);}catch{return json(400,{error:'Corps invalide.'});}
  const sid=ev&&ev.data&&ev.data.id,key=String(ev.id||sha256(raw));
  await sql`INSERT INTO webhook_events(event_key,provider) VALUES(${key},'wave') ON CONFLICT DO NOTHING`;
  const p=sid?(await sql`SELECT id FROM payments WHERE provider_session_id=${String(sid)}`)[0]:null;
  if(!p){await sql`UPDATE webhook_events SET outcome='unknown_session' WHERE event_key=${key}`;return json(200,{ok:true});} // 200 : évite les renvois inutiles
  const out=await syncPayment(p.id,ip);
  await sql`UPDATE webhook_events SET outcome=${out.outcome} WHERE event_key=${key}`;
  return out.outcome==='provider_unreachable'?json(503,{error:'Réessayez.'}):json(200,{ok:true});
}

export async function payRoutes({path,method,body,me,ip}){
  let m;
  if(path==='/api/payments/config'&&method==='GET')
    return json(200,{enabled:waveEnabled(),providers:[{id:'wave',available:waveEnabled()},{id:'orange_money',available:false},{id:'free_money',available:false}]});
  if(path==='/api/payments/checkout'&&method==='POST'){
    const e=need(me,'patient');if(e)return e;
    if(!waveEnabled())return json(503,{error:'Paiement en ligne non disponible. Réglez sur place.'});
    const kind=body.orderId?'order':body.missionId?'mission':'appointment',tid=String(body.orderId||body.missionId||body.appointmentId||'');
    if(!UUID.test(tid))return json(400,{error:'Élément à payer invalide.'});
    await releaseExpiredHolds();
    const a=kind==='order'?(await sql`SELECT id,total_fcfa AS amount_fcfa FROM pharmacy_orders WHERE id=${tid} AND patient_id=${me.id} AND status='pending_payment' AND hold_expires_at>now()`)[0]
      :kind==='mission'?(await sql`SELECT id,amount_fcfa FROM missions WHERE id=${tid} AND patient_id=${me.id} AND status='pending_payment' AND hold_expires_at>now()`)[0]
      :(await sql`SELECT id,amount_fcfa FROM appointments WHERE id=${tid} AND patient_id=${me.id} AND status='pending_payment' AND hold_expires_at>now()`)[0];
    if(!a)return json(409,{error:'Rien à payer (introuvable, déjà payé ou délai dépassé).'});
    const ex=kind==='order'?(await sql`SELECT id,launch_url FROM payments WHERE order_id=${a.id} AND status='pending'`)[0]:kind==='mission'?(await sql`SELECT id,launch_url FROM payments WHERE mission_id=${a.id} AND status='pending'`)[0]:(await sql`SELECT id,launch_url FROM payments WHERE appointment_id=${a.id} AND status='pending'`)[0];
    if(ex&&ex.launch_url)return json(200,{payment:{id:ex.id},launch_url:ex.launch_url});
    const pid=crypto.randomUUID();
    if(kind==='order')await sql`INSERT INTO payments(id,order_id,patient_id,amount_fcfa,provider) VALUES(${pid},${a.id},${me.id},${a.amount_fcfa},'wave')`;
    else if(kind==='mission')await sql`INSERT INTO payments(id,mission_id,patient_id,amount_fcfa,provider) VALUES(${pid},${a.id},${me.id},${a.amount_fcfa},'wave')`;
    else await sql`INSERT INTO payments(id,appointment_id,patient_id,amount_fcfa,provider) VALUES(${pid},${a.id},${me.id},${a.amount_fcfa},'wave')`;
    const r=await createSession({amount:a.amount_fcfa,reference:pid,successUrl:process.env.APP_ORIGIN+'/?paiement=retour',errorUrl:process.env.APP_ORIGIN+'/?paiement=erreur'});
    if(!r.ok||!r.data.id||!r.data.wave_launch_url){await sql`UPDATE payments SET status='failed' WHERE id=${pid}`;await audit(me.id,'checkout_failed',ip,{status:r.status});return json(502,{error:'Le service de paiement est indisponible. Réessayez.'});}
    await sql`UPDATE payments SET provider_session_id=${r.data.id},launch_url=${r.data.wave_launch_url} WHERE id=${pid}`;
    await audit(me.id,'checkout_created',ip,{payment:pid});
    return json(201,{payment:{id:pid},launch_url:r.data.wave_launch_url});
  }
  if(path==='/api/payments'&&method==='GET'){
    const e=need(me,'patient');if(e)return e;
    return json(200,{payments:await sql`SELECT p.id,p.appointment_id,p.mission_id,p.order_id,p.amount_fcfa,p.currency,p.status,p.paid_at,r.number AS recu FROM payments p LEFT JOIN receipts r ON r.payment_id=p.id WHERE p.patient_id=${me.id} ORDER BY p.created_at DESC LIMIT 100`});
  }
  if((m=path.match(/^\/api\/payments\/([^/]+)\/receipt$/))&&method==='GET'){
    const e=need(me,'patient');if(e)return e;if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    const r=(await sql`SELECT r.number,r.issued_at,p.amount_fcfa,p.currency,p.provider,p.paid_at,p.status,COALESCE(u.nom,u2.nom,ph.nom_officine) AS medecin FROM payments p JOIN receipts r ON r.payment_id=p.id LEFT JOIN appointments a ON a.id=p.appointment_id LEFT JOIN users u ON u.id=a.doctor_id LEFT JOIN missions mi ON mi.id=p.mission_id LEFT JOIN users u2 ON u2.id=mi.provider_id LEFT JOIN pharmacy_orders po ON po.id=p.order_id LEFT JOIN pharmacies ph ON ph.user_id=po.pharmacy_id WHERE p.id=${m[1]} AND p.patient_id=${me.id}`)[0];
    return r?json(200,{receipt:r}):json(404,{error:'Reçu introuvable (le paiement doit être confirmé).'});
  }
  if(path==='/api/doctor/revenue'&&method==='GET'){
    const e=need(me,'medecin');if(e)return e;
    const r=(await sql`SELECT coalesce(sum(l.amount_fcfa),0)::int AS a_verser_fcfa,count(DISTINCT p.id)::int AS paiements FROM ledger_entries l JOIN payments p ON p.id=l.payment_id JOIN appointments a ON a.id=p.appointment_id WHERE a.doctor_id=${me.id} AND l.kind IN ('a_verser_medecin','annul_a_verser_medecin')`)[0];
    return json(200,{...r,note:'Montants confirmés par le prestataire de paiement. Le versement au médecin n\u2019est pas encore automatisé.'});
  }
  if(path.startsWith('/api/admin/payments')||path==='/api/admin/reconciliation'){
    const e=need(me,'admin');if(e){if(me)await audit(me.id,'forbidden_admin',ip,{path});return e;}
    if(path==='/api/admin/reconciliation'&&method==='GET'){
      const byStatus=await sql`SELECT status,count(*)::int AS n,coalesce(sum(amount_fcfa),0)::int AS total FROM payments GROUP BY status`;
      const issues={
        reussis_sans_recu:(await sql`SELECT p.id FROM payments p WHERE p.status IN ('succeeded','refund_pending','refunded') AND p.paid_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM receipts r WHERE r.payment_id=p.id)`).map(x=>x.id),
        ecart_grand_livre:(await sql`SELECT p.id FROM payments p WHERE p.paid_at IS NOT NULL AND coalesce((SELECT sum(amount_fcfa) FROM ledger_entries l WHERE l.payment_id=p.id AND l.kind IN ('paiement','remboursement')),0)<>CASE WHEN p.status='refunded' THEN 0 ELSE p.amount_fcfa END`).map(x=>x.id),
        en_attente_depuis_plus_d_une_heure:(await sql`SELECT id FROM payments WHERE status='pending' AND created_at<now()-interval '1 hour'`).map(x=>x.id),
        remboursements_en_attente:(await sql`SELECT id FROM payments WHERE status='refund_pending'`).map(x=>x.id)};
      return json(200,{par_statut:byStatus,anomalies:issues});
    }
    if(path==='/api/admin/payments'&&method==='GET')return json(200,{payments:await sql`SELECT id,appointment_id,amount_fcfa,status,provider,created_at,paid_at FROM payments ORDER BY created_at DESC LIMIT 200`});
    if((m=path.match(/^\/api\/admin\/payments\/([^/]+)\/(sync|refund)$/))&&method==='POST'){
      if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
      await audit(me.id,'admin_payment_'+m[2],ip,{payment:m[1],motif:clean(body.motif,300)});
      return json(200,m[2]==='sync'?await syncPayment(m[1],ip):await requestRefund(m[1],me.id,ip));
    }
  }
  return null;
}
