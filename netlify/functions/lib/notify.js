import {sql,audit} from './db.js';
import {json} from './util.js';
import {emailConfigured,smsConfigured,sendEmail,sendSms} from './channels.js';
const UUID_OK=x=>Number.isInteger(x)&&x>0;
// Heure du Sénégal (UTC+0 toute l'année). Les messages ne contiennent JAMAIS de motif, spécialité ni donnée médicale.
const when=d=>{const p=Object.fromEntries(new Intl.DateTimeFormat('fr-FR',{timeZone:'Africa/Dakar',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date(d)).map(x=>[x.type,x.value]));return `${p.day}/${p.month} à ${p.hour}:${p.minute}`;};

async function enqueueOutbox(ids){
  if(!ids.length)return;
  if(emailConfigured())await sql`INSERT INTO outbox(notification_id,user_id,channel,to_addr)
    SELECT n.id,n.user_id,'email',u.email FROM notifications n JOIN users u ON u.id=n.user_id LEFT JOIN notification_prefs p ON p.user_id=u.id
    WHERE n.id=ANY(${ids}::bigint[]) AND u.email IS NOT NULL AND coalesce(p.email_enabled,true)`;
  if(smsConfigured())await sql`INSERT INTO outbox(notification_id,user_id,channel,to_addr)
    SELECT n.id,n.user_id,'sms','+221'||u.tel FROM notifications n JOIN users u ON u.id=n.user_id LEFT JOIN notification_prefs p ON p.user_id=u.id
    WHERE n.id=ANY(${ids}::bigint[]) AND coalesce(p.sms_enabled,false)`;
}
// Crée la notification dans l'application (toujours) puis met en file les canaux activés. Idempotent via dedupeKey.
export async function notify(userId,kind,title,body,link,dedupeKey){
  const r=await sql`INSERT INTO notifications(user_id,kind,title,body,link,dedupe_key) VALUES(${userId},${kind},${title},${body},${link||null},${dedupeKey})
    ON CONFLICT(user_id,dedupe_key) DO NOTHING RETURNING id`;
  if(r[0])await enqueueOutbox([Number(r[0].id)]);
  return !!r[0];
}
// Ne doit jamais faire échouer l'opération métier
export async function notifyAppt(apptId,event,byUserId=null){
  try{
    const a=(await sql`SELECT a.patient_id,a.doctor_id,a.rescheduled_count,s.starts_at FROM appointments a JOIN availability_slots s ON s.id=a.slot_id WHERE a.id=${apptId}`)[0];if(!a)return;
    const w=when(a.starts_at),k=`${event}:${apptId}:`,x=String(a.rescheduled_count),L='/rdv';
    const T={booked:[[a.patient_id,'Rendez-vous confirmé',`Votre rendez-vous Kayligey est confirmé le ${w}.`],[a.doctor_id,'Nouveau rendez-vous',`Un rendez-vous est prévu le ${w}.`]],
      paid:[[a.patient_id,'Paiement confirmé',`Votre paiement est confirmé. Rendez-vous le ${w}. Votre reçu est dans « Mes rendez-vous ».`],[a.doctor_id,'Nouveau rendez-vous',`Un rendez-vous payé est prévu le ${w}.`]],
      cancelled:[[a.patient_id,'Rendez-vous annulé',`Le rendez-vous du ${w} a été annulé.`],[a.doctor_id,'Rendez-vous annulé',`Le rendez-vous du ${w} a été annulé.`]],
      rescheduled:[[a.doctor_id,'Rendez-vous reprogrammé',`Un rendez-vous a été déplacé au ${w}.`]],
      refunded:[[a.patient_id,'Remboursement effectué',`Votre remboursement a été effectué. Il peut mettre un délai à apparaître sur votre compte.`]]}[event]||[];
    for(const [uid,t,b] of T){if(event==='cancelled'&&uid===byUserId)continue;await notify(uid,event,t,b,L,k+uid+':'+(event==='rescheduled'?x:''));}
  }catch(e){console.error('notifyAppt',e.message);}
}
export async function notifyUser(userId,kind,title,body,link,key){try{await notify(userId,kind,title,body,link,key);}catch(e){console.error('notifyUser',e.message);}}

// Rappels : J-1 (23 h à 25 h avant) et H-1 (30 à 90 min avant), une seule fois grâce à la clé de dédoublonnage.
export async function enqueueReminders(){
  let n=0;
  for(const [kind,lo,hi,label] of [['rem24','23 hours','25 hours','demain'],['rem1','30 minutes','90 minutes','dans environ une heure']]){
    const rows=await sql`SELECT a.id,a.patient_id,a.doctor_id,s.starts_at FROM appointments a JOIN availability_slots s ON s.id=a.slot_id
      WHERE a.status='confirmed' AND s.starts_at BETWEEN now()+${lo}::interval AND now()+${hi}::interval`;
    for(const a of rows)for(const uid of [a.patient_id,a.doctor_id]){
      const p=(await sql`SELECT reminders_enabled FROM notification_prefs WHERE user_id=${uid}`)[0];if(p&&!p.reminders_enabled)continue;
      if(await notify(uid,'reminder','Rappel de rendez-vous',`Rappel : rendez-vous Kayligey ${label}, le ${when(a.starts_at)}.`,'/rdv',`${kind}:${a.id}:${uid}`))n++;
    }
  }
  // Prochaine dose indiquée par le parent ou le médecin : rappel 7 jours avant, sans nom d'enfant ni de vaccin
  const vs=await sql`SELECT v.id,d.guardian_id FROM ped_vaccines v JOIN dependents d ON d.id=v.dependent_id
    WHERE v.voided_at IS NULL AND d.archived_at IS NULL AND v.next_due BETWEEN current_date AND current_date+7`;
  for(const v of vs){const p=(await sql`SELECT reminders_enabled FROM notification_prefs WHERE user_id=${v.guardian_id}`)[0];if(p&&!p.reminders_enabled)continue;
    if(await notify(v.guardian_id,'reminder','Rappel de suivi','Un rappel de suivi de santé est à prévoir pour l\u2019une des personnes à charge de votre compte.','/famille','vac:'+v.id))n++;}
  return n;
}
export async function processOutbox(){
  const due=await sql`UPDATE outbox SET attempts=attempts+1,next_attempt_at=now()+interval '10 minutes' WHERE id IN
    (SELECT id FROM outbox WHERE status='pending' AND next_attempt_at<=now() ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED)
    RETURNING id,channel,to_addr,notification_id,attempts`;
  let sent=0,failed=0;
  for(const o of due){
    const n=(await sql`SELECT title,body FROM notifications WHERE id=${o.notification_id}`)[0];
    const foot='\n\nKayligey. Ne répondez pas à ce message et n\u2019envoyez jamais de données médicales par e-mail ou SMS.';
    const ok=!n?{ok:false,status:0}:o.channel==='email'
      ?(emailConfigured()?await sendEmail(o.to_addr,n.title,n.body+foot):{ok:false,status:0,error:'canal non configuré'})
      :(smsConfigured()?await sendSms(o.to_addr,'Kayligey : '+n.body):{ok:false,status:0,error:'canal non configuré'});
    if(ok.ok){await sql`UPDATE outbox SET status='sent',sent_at=now(),last_error=NULL WHERE id=${o.id}`;sent++;}
    else{const err=(ok.error||('HTTP '+ok.status)).slice(0,120);
      if(o.attempts>=5){await sql`UPDATE outbox SET status='failed',last_error=${err} WHERE id=${o.id}`;failed++;}
      else await sql`UPDATE outbox SET last_error=${err},next_attempt_at=now()+make_interval(mins=>${o.attempts*o.attempts*5}) WHERE id=${o.id}`;}
  }
  return {processed:due.length,sent,failed};
}

export async function notifRoutes({path,method,body,me,ip}){
  if(path.startsWith('/api/admin/notifications')){
    if(!me)return json(401,{error:'Non connecté.'});
    if(me.role!=='admin'||me.status!=='active'){await audit(me.id,'forbidden_admin',ip,{path});return json(403,{error:'Accès refusé.'});}
    return json(200,{canaux:{email:emailConfigured(),sms:smsConfigured()},envois:await sql`SELECT channel,status,count(*)::int AS n FROM outbox GROUP BY channel,status ORDER BY channel,status`,
      derniers_echecs:await sql`SELECT id,channel,attempts,last_error,created_at FROM outbox WHERE status='failed' OR (status='pending' AND attempts>0) ORDER BY id DESC LIMIT 20`});
  }
  if(!me)return json(401,{error:'Non connecté.'});
  if(path==='/api/notifications'&&method==='GET'){
    const l=await sql`SELECT id,kind,title,body,link,read_at,created_at FROM notifications WHERE user_id=${me.id} ORDER BY created_at DESC,id DESC LIMIT 50`;
    const u=(await sql`SELECT count(*)::int AS n FROM notifications WHERE user_id=${me.id} AND read_at IS NULL`)[0].n;
    return json(200,{notifications:l,unread:u});
  }
  if(path==='/api/notifications/read'&&method==='POST'){
    if(body.all===true){await sql`UPDATE notifications SET read_at=now() WHERE user_id=${me.id} AND read_at IS NULL`;return json(200,{ok:true});}
    const ids=(Array.isArray(body.ids)?body.ids:[]).map(Number).filter(UUID_OK).slice(0,100);
    if(ids.length)await sql`UPDATE notifications SET read_at=now() WHERE user_id=${me.id} AND read_at IS NULL AND id=ANY(${ids}::bigint[])`;
    return json(200,{ok:true});
  }
  if(path==='/api/notifications/prefs'&&method==='GET'){
    const p=(await sql`SELECT email_enabled,sms_enabled,reminders_enabled FROM notification_prefs WHERE user_id=${me.id}`)[0]||{email_enabled:true,sms_enabled:false,reminders_enabled:true};
    return json(200,{prefs:p,canaux:{email:emailConfigured()&&!!me.email,sms:smsConfigured()}});
  }
  if(path==='/api/notifications/prefs'&&method==='POST'){
    const b=v=>v===true;
    await sql`INSERT INTO notification_prefs(user_id,email_enabled,sms_enabled,reminders_enabled) VALUES(${me.id},${b(body.email_enabled)},${b(body.sms_enabled)},${b(body.reminders_enabled)})
      ON CONFLICT(user_id) DO UPDATE SET email_enabled=EXCLUDED.email_enabled,sms_enabled=EXCLUDED.sms_enabled,reminders_enabled=EXCLUDED.reminders_enabled,updated_at=now()`;
    return json(200,{ok:true});
  }
  return null;
}
