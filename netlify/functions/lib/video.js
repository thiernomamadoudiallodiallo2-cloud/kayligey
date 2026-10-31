import crypto from 'node:crypto';
import {sql,audit,rateLimited} from './db.js';
import {json} from './util.js';
import {notifyUser} from './notify.js';
import {requestRefund} from './payments.js';
import {videoEnabled,accessToken,createRoom,completeRoom} from './twilio-video.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EARLY_MIN=10,LATE_MIN=30,ABSENCE_MIN=15;
const EVENTS=['joined','left','reconnecting','reconnected','audio_only','media_error','sdk_error','room_error'];

async function load(id,me){
  const a=(await sql`SELECT a.id,a.patient_id,a.doctor_id,a.mode,a.status,s.starts_at,s.ends_at,
      r.room_name,r.opened_at,r.patient_waiting_at,r.ended_at
    FROM appointments a JOIN availability_slots s ON s.id=a.slot_id LEFT JOIN consultation_rooms r ON r.appointment_id=a.id
    WHERE a.id=${id} AND (a.patient_id=${me.id} OR a.doctor_id=${me.id})`)[0];
  return a||null;
}
const win=a=>{const n=Date.now(),s=new Date(a.starts_at).getTime(),e=new Date(a.ends_at).getTime();
  return {open:n>=s-EARLY_MIN*60e3&&n<=e+LATE_MIN*60e3,minutes_avant:Math.ceil((s-EARLY_MIN*60e3-n)/60e3),depasse:n>e+LATE_MIN*60e3,start:s,end:e,now:n};};
// Jeton : valable jusqu'à la fin du créneau + 45 min au plus (reconnexion), jamais plus de 2 h
const issue=(a,me)=>{const w=win(a),ttl=Math.max(600,Math.min(7200,Math.floor((w.end+45*60e3-w.now)/1000)));
  return accessToken({identity:'u_'+me.id,room:a.room_name,ttlSec:ttl});};

export async function videoRoutes({path,method,body,me,ip}){
  if(path==='/api/consultations/config'&&method==='GET')return json(200,{enabled:videoEnabled(),enregistrement:false,
    note:'Les consultations ne sont jamais enregistrées. En cas de problème de vidéo, passez en audio seul, puis par la messagerie. Urgence : 1515.'});
  if(!me)return json(401,{error:'Non connecté.'});
  const m=path.match(/^\/api\/consultations\/([^/]+)\/(status|wait|start|join|end|event|report-absence)$/);if(!m)return null;
  if(!['patient','medecin'].includes(me.role)||me.status!=='active')return json(403,{error:'Accès refusé.'});
  if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
  const a=await load(m[1],me);if(!a)return json(404,{error:'Consultation introuvable.'});
  const isDoc=a.doctor_id===me.id,act=m[2];
  if(!['video','audio'].includes(a.mode))return json(409,{error:'Ce rendez-vous est en cabinet : il n\u2019y a pas de consultation à distance.'});
  const w=win(a);
  const etat=a.ended_at?'terminee':a.status!=='confirmed'&&a.status!=='completed'?'indisponible':a.opened_at?'en_cours':a.patient_waiting_at?'patient_en_attente':'avant_ouverture';

  if(act==='status'&&method==='GET')return json(200,{mode:a.mode,etat,statut_rdv:a.status,fenetre_ouverte:w.open,minutes_avant_ouverture:w.open?0:Math.max(0,w.minutes_avant),
    medecin_present:!!a.opened_at&&!a.ended_at,patient_en_attente:!!a.patient_waiting_at,video_disponible:videoEnabled(),absence_signalable:Date.now()>w.start+ABSENCE_MIN*60e3&&a.status==='confirmed'});
  if(method!=='POST')return null;
  if(act==='event'){
    if(!EVENTS.includes(body.event))return json(400,{error:'Événement inconnu.'});
    if(await rateLimited('cev:'+me.id,200,3600))return json(429,{error:'Trop d\u2019événements.'});
    await sql`INSERT INTO consultation_events(appointment_id,user_id,event) VALUES(${a.id},${me.id},${body.event})`;return json(200,{ok:true});
  }
  if(act==='report-absence'){
    if(a.status!=='confirmed'||Date.now()<=w.start+ABSENCE_MIN*60e3)return json(409,{error:'Un signalement d\u2019absence est possible '+ABSENCE_MIN+' minutes après l\u2019heure du rendez-vous.'});
    if(!isDoc){ // le patient signale l'absence du médecin : annulation + remboursement automatique
      if(a.opened_at)return json(409,{error:'Le médecin a ouvert la consultation.'});
      const r=await sql`WITH u AS (UPDATE appointments SET status='cancelled',cancelled_by=${me.id},cancelled_at=now(),cancel_reason='Absence du médecin signalée par le patient',no_show_by='medecin' WHERE id=${a.id} AND status='confirmed' RETURNING id,slot_id)
        UPDATE availability_slots SET status='closed' WHERE id=(SELECT slot_id FROM u) RETURNING id`;
      if(!r.length)return json(409,{error:'Signalement impossible.'});
      await audit(me.id,'doctor_no_show',ip,{appointment:a.id});
      const pay=(await sql`SELECT id FROM payments WHERE appointment_id=${a.id} AND status IN ('succeeded','refund_pending')`)[0];let rem='sans objet';
      if(pay){const f=await requestRefund(pay.id,me.id,ip);rem=f.ok?'effectué':'en attente de confirmation du prestataire';}
      return json(200,{ok:true,remboursement:rem});
    }
    // le médecin signale l'absence du patient (jamais arrivé en salle d'attente) : rendez-vous « absent », sans remboursement automatique (règle à valider)
    if(a.patient_waiting_at)return json(409,{error:'Le patient s\u2019est présenté en salle d\u2019attente.'});
    const r=await sql`UPDATE appointments SET status='no_show',no_show_by='patient' WHERE id=${a.id} AND status='confirmed' RETURNING id`;
    if(!r.length)return json(409,{error:'Signalement impossible.'});await audit(me.id,'patient_no_show',ip,{appointment:a.id});return json(200,{ok:true});
  }
  if(!videoEnabled())return json(503,{error:'La visioconférence n\u2019est pas configurée. Utilisez la messagerie ; en urgence, appelez le 1515.'});
  if(a.status!=='confirmed')return json(409,{error:a.status==='pending_payment'?'Le paiement doit être confirmé avant la consultation.':'Ce rendez-vous n\u2019est pas actif.'});
  if(a.ended_at)return json(409,{error:'Cette consultation est terminée.'});
  if(act!=='end'&&!w.open)return json(409,{error:w.depasse?'Le créneau est dépassé.':`La salle ouvre ${EARLY_MIN} minutes avant l\u2019heure du rendez-vous (dans ${w.minutes_avant} min).`});

  const ensureRow=async()=>{await sql`INSERT INTO consultation_rooms(appointment_id,room_name) VALUES(${a.id},${crypto.randomBytes(16).toString('hex')}) ON CONFLICT DO NOTHING`;
    return (await sql`SELECT room_name,opened_at,patient_waiting_at FROM consultation_rooms WHERE appointment_id=${a.id}`)[0];};
  if(act==='wait'){ // salle d'attente virtuelle : le patient se signale, rien ne s'ouvre sans le médecin
    if(isDoc)return json(403,{error:'Réservé au patient.'});await ensureRow();
    const r=await sql`UPDATE consultation_rooms SET patient_waiting_at=coalesce(patient_waiting_at,now()) WHERE appointment_id=${a.id} RETURNING opened_at,(patient_waiting_at IS NOT NULL) AS ok`;
    if(!a.patient_waiting_at)await notifyUser(a.doctor_id,'consultation','Patient en salle d\u2019attente','Un patient attend dans la salle d\u2019attente de sa consultation.','/agenda','wait:'+a.id);
    return json(200,{etat:r[0].opened_at?'en_cours':'patient_en_attente'});
  }
  if(act==='start'){
    if(!isDoc)return json(403,{error:'Seul le médecin peut ouvrir la consultation.'});
    const row=await ensureRow(),c=await createRoom(row.room_name);
    if(!c.ok){await audit(me.id,'video_room_failed',ip,{status:c.status});return json(502,{error:'Le service vidéo est indisponible. Proposez un échange par messagerie ou reportez le rendez-vous.'});}
    if(c.sid)await sql`UPDATE consultation_rooms SET twilio_room_sid=${c.sid} WHERE appointment_id=${a.id}`;
    const first=await sql`UPDATE consultation_rooms SET opened_at=coalesce(opened_at,now()) WHERE appointment_id=${a.id} RETURNING (patient_waiting_at IS NOT NULL) AS attend`;
    await notifyUser(a.patient_id,'consultation','Votre médecin vous attend','Votre consultation est ouverte. Rejoignez-la depuis « Mes rendez-vous ».','/rdv','open:'+a.id);
    await audit(me.id,'consultation_started',ip,{appointment:a.id});
    return json(200,{token:issue({...a,room_name:row.room_name},me),room:row.room_name,identity:'u_'+me.id,patient_en_attente:first[0].attend});
  }
  if(act==='join'){
    const row=await ensureRow();if(!row.opened_at)return json(409,{error:'Le médecin n\u2019a pas encore ouvert la consultation. Restez en salle d\u2019attente.',etat:'attente_medecin'});
    return json(200,{token:issue({...a,room_name:row.room_name},me),room:row.room_name,identity:'u_'+me.id});
  }
  if(act==='end'){
    if(!isDoc)return json(403,{error:'Seul le médecin peut terminer la consultation.'});
    const r=await sql`WITH c AS (UPDATE consultation_rooms SET ended_at=now() WHERE appointment_id=${a.id} AND ended_at IS NULL AND opened_at IS NOT NULL RETURNING room_name),
        u AS (UPDATE appointments SET status='completed' WHERE id=${a.id} AND status='confirmed' AND EXISTS(SELECT 1 FROM c) RETURNING id)
      SELECT (SELECT room_name FROM c) AS room`;
    if(!r[0].room)return json(409,{error:'La consultation n\u2019a pas été ouverte ou est déjà terminée.'});
    await completeRoom(r[0].room);await audit(me.id,'consultation_ended',ip,{appointment:a.id});return json(200,{ok:true});
  }
  return null;
}
