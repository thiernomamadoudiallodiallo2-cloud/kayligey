import {sql,audit} from './db.js';
import {clean,json} from './util.js';
import {waveEnabled} from './wave.js';
import {notifyAppt,notifyUser} from './notify.js';
import {releaseExpiredHolds,requestRefund} from './payments.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES=['cabinet','video','audio'];
const need=(me,role)=>!me?json(401,{error:'Non connecté.'}):(me.role!==role||me.status!=='active')?json(403,{error:'Accès refusé.'}):null;
const lim=(v,d,min,max)=>{const n=parseInt(v,10);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):d;};

export async function rdvRoutes({path,method,body,me,ip,query}){
  let m;
  // ---- Annuaire public : uniquement les médecins vérifiés ----
  if(path==='/api/doctors'&&method==='GET'){
    await releaseExpiredHolds();
    const q=clean(query.get('q'),60)||null,sp=clean(query.get('specialite'),60)||null,vi=clean(query.get('ville'),60)||null,
      mo=MODES.includes(query.get('mode'))?query.get('mode'):null,la=clean(query.get('langue'),30)||null;
    const rows=await sql`SELECT d.user_id AS id,u.nom,d.specialite,d.ville,d.tarif_fcfa,d.langues,d.modes,d.structure,d.verified_at,
        (SELECT min(s.starts_at) FROM availability_slots s WHERE s.doctor_id=d.user_id AND s.status='open' AND s.starts_at>now()+interval '30 minutes') AS prochain_creneau
      FROM doctors d JOIN users u ON u.id=d.user_id
      WHERE d.verified_at IS NOT NULL AND u.status='active'
        AND (${q}::text IS NULL OR u.nom ILIKE '%'||${q}||'%') AND (${sp}::text IS NULL OR d.specialite ILIKE ${sp})
        AND (${vi}::text IS NULL OR d.ville ILIKE ${vi}) AND (${mo}::text IS NULL OR ${mo}=ANY(d.modes))
        AND (${la}::text IS NULL OR ${la}=ANY(d.langues))
      ORDER BY prochain_creneau NULLS LAST,u.nom LIMIT 50`;
    return json(200,{doctors:rows});
  }
  if((m=path.match(/^\/api\/doctors\/([^/]+)\/slots$/))&&method==='GET'){
    if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    await releaseExpiredHolds();
    const rows=await sql`SELECT s.id,s.starts_at,s.ends_at FROM availability_slots s JOIN doctors d ON d.user_id=s.doctor_id
      WHERE s.doctor_id=${m[1]} AND d.verified_at IS NOT NULL AND s.status='open' AND s.starts_at>now()+interval '30 minutes'
      ORDER BY s.starts_at LIMIT 200`;
    return json(200,{slots:rows});
  }

  // ---- Espace médecin ----
  if(path==='/api/doctor/profile'&&method==='POST'){
    const e=need(me,'medecin');if(e)return e;
    const spec=clean(body.specialite,60),ville=clean(body.ville,60),ordre=clean(body.numero_ordre,40),tarif=parseInt(body.tarif_fcfa,10);
    const modes=(Array.isArray(body.modes)?body.modes:[]).filter(x=>MODES.includes(x));
    const langues=(Array.isArray(body.langues)?body.langues:[]).map(x=>clean(x,30)).filter(Boolean).slice(0,6);
    if(!spec||!ville||!ordre)return json(400,{error:'Spécialité, ville et numéro d\u2019ordre sont obligatoires.'});
    if(!Number.isFinite(tarif)||tarif<0||tarif>500000)return json(400,{error:'Tarif invalide.'});
    if(!modes.length)return json(400,{error:'Choisissez au moins un mode de consultation.'});
    // Toute modification de la spécialité ou du numéro d'ordre annule la vérification
    await sql`INSERT INTO doctors(user_id,specialite,ville,tarif_fcfa,langues,modes,structure,numero_ordre,bio)
      VALUES(${me.id},${spec},${ville},${tarif},${langues},${modes},${clean(body.structure,120)||null},${ordre},${clean(body.bio,1000)||null})
      ON CONFLICT(user_id) DO UPDATE SET specialite=EXCLUDED.specialite,ville=EXCLUDED.ville,tarif_fcfa=EXCLUDED.tarif_fcfa,
        langues=EXCLUDED.langues,modes=EXCLUDED.modes,structure=EXCLUDED.structure,bio=EXCLUDED.bio,updated_at=now(),
        numero_ordre=EXCLUDED.numero_ordre,
        verified_at=CASE WHEN doctors.numero_ordre IS DISTINCT FROM EXCLUDED.numero_ordre OR doctors.specialite IS DISTINCT FROM EXCLUDED.specialite THEN NULL ELSE doctors.verified_at END`;
    await audit(me.id,'doctor_profile_saved',ip);
    return json(200,{ok:true,message:'Profil enregistré. Il sera visible après vérification par un administrateur.'});
  }
  if(path==='/api/doctor/profile'&&method==='GET'){
    const e=need(me,'medecin');if(e)return e;
    const r=(await sql`SELECT specialite,ville,tarif_fcfa,langues,modes,structure,numero_ordre,bio,verified_at FROM doctors WHERE user_id=${me.id}`)[0];
    return json(200,{profile:r||null});
  }
  if(path==='/api/doctor/slots'&&method==='GET'){
    const e=need(me,'medecin');if(e)return e;
    return json(200,{slots:await sql`SELECT id,starts_at,ends_at,status FROM availability_slots WHERE doctor_id=${me.id} AND ends_at>now() ORDER BY starts_at LIMIT 500`});
  }
  if(path==='/api/doctor/slots'&&method==='POST'){
    const e=need(me,'medecin');if(e)return e;
    const d=await sql`SELECT verified_at FROM doctors WHERE user_id=${me.id}`;
    if(!d[0]||!d[0].verified_at)return json(403,{error:'Votre profil doit être vérifié par un administrateur avant de publier des créneaux.'});
    const list=Array.isArray(body.slots)?body.slots.slice(0,50):[];if(!list.length)return json(400,{error:'Aucun créneau fourni.'});
    let added=0,rejected=0;const now=Date.now();
    for(const x of list){
      const a=new Date(x&&x.starts_at),b=new Date(x&&x.ends_at),mins=(b-a)/60000;
      if(isNaN(a)||isNaN(b)||a<=now||a-now>60*864e5||mins<15||mins>120){rejected++;continue;}
      const r=await sql`INSERT INTO availability_slots(doctor_id,starts_at,ends_at)
        SELECT ${me.id},${a.toISOString()}::timestamptz,${b.toISOString()}::timestamptz
        WHERE NOT EXISTS(SELECT 1 FROM availability_slots WHERE doctor_id=${me.id} AND status<>'closed' AND starts_at<${b.toISOString()}::timestamptz AND ends_at>${a.toISOString()}::timestamptz)
        ON CONFLICT DO NOTHING RETURNING id`;
      r.length?added++:rejected++;
    }
    return json(200,{added,rejected});
  }
  if((m=path.match(/^\/api\/doctor\/slots\/([^/]+)\/close$/))&&method==='POST'){
    const e=need(me,'medecin');if(e)return e;if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    const r=await sql`UPDATE availability_slots SET status='closed' WHERE id=${m[1]} AND doctor_id=${me.id} AND status='open' RETURNING id`;
    return r.length?json(200,{ok:true}):json(409,{error:'Créneau introuvable ou déjà réservé (annulez d\u2019abord le rendez-vous).'});
  }

  // ---- Validation administrative ----
  if(path==='/api/admin/doctors/pending'&&method==='GET'){
    const e=need(me,'admin');if(e){if(me)await audit(me.id,'forbidden_admin',ip,{path});return e;}
    return json(200,{doctors:await sql`SELECT d.user_id AS id,u.nom,u.tel,d.specialite,d.ville,d.numero_ordre,d.structure,d.updated_at FROM doctors d JOIN users u ON u.id=d.user_id WHERE d.verified_at IS NULL AND u.status='active' ORDER BY d.updated_at`});
  }
  if((m=path.match(/^\/api\/admin\/doctors\/([^/]+)\/verify$/))&&method==='POST'){
    const e=need(me,'admin');if(e){if(me)await audit(me.id,'forbidden_admin',ip,{path});return e;}
    if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    if(body.justificatifs_verifies!==true)return json(400,{error:'Confirmez avoir contrôlé les justificatifs (diplôme, numéro d\u2019ordre).'});
    const r=await sql`UPDATE doctors SET verified_at=now(),verified_by=${me.id} WHERE user_id=${m[1]} RETURNING user_id`;
    if(!r.length)return json(404,{error:'Profil médecin introuvable.'});
    await audit(me.id,'doctor_verified',ip,{target:m[1],note:clean(body.note,300)});
    await notifyUser(m[1],'doctor_verified','Profil vérifié','Votre profil professionnel a été vérifié. Vous pouvez publier vos créneaux.','/agenda','doctor_verified:'+Date.now());
    return json(200,{ok:true});
  }

  // ---- Rendez-vous ----
  if(path==='/api/appointments'&&method==='POST'){
    const e=need(me,'patient');if(e)return e;
    const slotId=String(body.slotId||''),mode=body.mode,motif=clean(body.motif,500);
    if(!UUID.test(slotId)||!MODES.includes(mode))return json(400,{error:'Créneau ou mode invalide.'});
    if(motif.length<3)return json(400,{error:'Indiquez le motif de la consultation.'});
    if(body.consent!==true)return json(400,{error:'Votre consentement est requis pour réserver.'});
    let dep=null;
    if(body.dependentId){ // réservation pour une personne à charge : uniquement la sienne
      if(!UUID.test(String(body.dependentId)))return json(400,{error:'Personne à charge invalide.'});
      if(!(await sql`SELECT 1 FROM dependents WHERE id=${body.dependentId} AND guardian_id=${me.id} AND archived_at IS NULL`).length)return json(403,{error:'Cette personne n\u2019est pas rattachée à votre compte.'});
      dep=body.dependentId;
    }
    await releaseExpiredHolds();
    const online=waveEnabled();
    // Une seule instruction : le créneau passe de « open » à « booked » ET le rendez-vous est créé, ou rien.
    const r=await sql`WITH s AS (
        UPDATE availability_slots s SET status='booked' FROM doctors d
        WHERE s.id=${slotId} AND s.status='open' AND s.starts_at>now()+interval '30 minutes'
          AND d.user_id=s.doctor_id AND d.verified_at IS NOT NULL AND ${mode}=ANY(d.modes)
          AND NOT EXISTS(SELECT 1 FROM appointments a JOIN availability_slots s2 ON s2.id=a.slot_id
            WHERE a.patient_id=${me.id} AND a.dependent_id IS NOT DISTINCT FROM ${dep}::uuid AND a.status IN ('confirmed','pending_payment') AND s2.starts_at<s.ends_at AND s2.ends_at>s.starts_at)
        RETURNING s.id,s.doctor_id,d.tarif_fcfa)
      INSERT INTO appointments(slot_id,patient_id,doctor_id,mode,motif,status,consent_at,amount_fcfa,payment_mode,hold_expires_at,dependent_id)
      SELECT id,${me.id},doctor_id,${mode},${motif},
        CASE WHEN ${online}::boolean AND tarif_fcfa>0 THEN 'pending_payment' ELSE 'confirmed' END,now(),tarif_fcfa,
        CASE WHEN ${online}::boolean AND tarif_fcfa>0 THEN 'en_ligne' ELSE 'sur_place' END,
        CASE WHEN ${online}::boolean AND tarif_fcfa>0 THEN now()+interval '15 minutes' END,${dep}::uuid FROM s
      RETURNING id,slot_id,doctor_id,mode,status,amount_fcfa,payment_mode,hold_expires_at`;
    if(!r.length)return json(409,{error:'Ce créneau n\u2019est plus disponible ou n\u2019est pas compatible avec ce mode ou vos autres rendez-vous.'});
    await audit(me.id,'appointment_booked',ip,{appointment:r[0].id});
    if(r[0].status==='confirmed')await notifyAppt(r[0].id,'booked');
    return json(201,{appointment:r[0],message:r[0].status==='pending_payment'?'Créneau retenu 15 minutes : finalisez le paiement pour confirmer.':'Rendez-vous confirmé. Règlement sur place : le paiement en ligne n\u2019est pas activé.'});
  }
  if(path==='/api/appointments'&&method==='GET'){
    if(!me)return json(401,{error:'Non connecté.'});
    if(me.role==='patient')return json(200,{appointments:await sql`SELECT a.id,a.status,a.mode,a.motif,a.doctor_id,a.amount_fcfa,a.payment_mode,a.hold_expires_at,s.starts_at,s.ends_at,u.nom AS medecin,d.specialite,dp.nom AS enfant
      FROM appointments a JOIN availability_slots s ON s.id=a.slot_id JOIN users u ON u.id=a.doctor_id JOIN doctors d ON d.user_id=a.doctor_id LEFT JOIN dependents dp ON dp.id=a.dependent_id
      WHERE a.patient_id=${me.id} ORDER BY s.starts_at DESC LIMIT 200`});
    if(me.role==='medecin')return json(200,{appointments:await sql`SELECT a.id,a.status,a.mode,a.motif,a.amount_fcfa,a.payment_mode,s.starts_at,s.ends_at,COALESCE(dp.nom,u.nom) AS patient,(a.dependent_id IS NOT NULL) AS enfant
      FROM appointments a JOIN availability_slots s ON s.id=a.slot_id JOIN users u ON u.id=a.patient_id LEFT JOIN dependents dp ON dp.id=a.dependent_id
      WHERE a.doctor_id=${me.id} ORDER BY s.starts_at DESC LIMIT 200`});
    return json(403,{error:'Accès refusé.'});
  }
  if((m=path.match(/^\/api\/appointments\/([^/]+)\/cancel$/))&&method==='POST'){
    if(!me||!['patient','medecin'].includes(me.role))return json(me?403:401,{error:me?'Accès refusé.':'Non connecté.'});
    if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    // Patient : jusqu'à 2 h avant. Médecin : à tout moment (le créneau est alors fermé, pas rouvert).
    const r=await sql`WITH a AS (
        UPDATE appointments ap SET status='cancelled',cancelled_by=${me.id},cancelled_at=now(),cancel_reason=${clean(body.reason,300)||null}
        FROM availability_slots s WHERE ap.id=${m[1]} AND ap.status IN ('confirmed','pending_payment') AND s.id=ap.slot_id
          AND (ap.doctor_id=${me.id} OR (ap.patient_id=${me.id} AND s.starts_at>now()+interval '2 hours'))
        RETURNING ap.slot_id,ap.doctor_id)
      UPDATE availability_slots SET status=CASE WHEN (SELECT doctor_id FROM a)=${me.id} THEN 'closed' ELSE 'open' END
      WHERE id=(SELECT slot_id FROM a) RETURNING id`;
    if(!r.length)return json(409,{error:'Annulation impossible : rendez-vous introuvable, déjà annulé, ou moins de 2 heures avant la consultation.'});
    await audit(me.id,'appointment_cancelled',ip,{appointment:m[1]});
    await notifyAppt(m[1],'cancelled',me.id);
    const pay=(await sql`SELECT id FROM payments WHERE appointment_id=${m[1]} AND status IN ('succeeded','refund_pending')`)[0];
    let refund=null;if(pay){refund=await requestRefund(pay.id,me.id,ip);if(refund.ok)await notifyAppt(m[1],'refunded');}
    return json(200,{ok:true,remboursement:refund?(refund.ok?'effectué':'en attente de confirmation du prestataire'):'sans objet'});
  }
  if((m=path.match(/^\/api\/appointments\/([^/]+)\/reschedule$/))&&method==='POST'){
    const e=need(me,'patient');if(e)return e;
    const nid=String(body.slotId||'');if(!UUID.test(m[1])||!UUID.test(nid))return json(400,{error:'Identifiant invalide.'});
    const r=await sql`WITH old AS (
        SELECT a.slot_id,a.doctor_id FROM appointments a JOIN availability_slots s ON s.id=a.slot_id
        WHERE a.id=${m[1]} AND a.patient_id=${me.id} AND a.status='confirmed' AND s.starts_at>now()+interval '2 hours'),
      ns AS (UPDATE availability_slots SET status='booked'
        WHERE id=${nid} AND status='open' AND starts_at>now()+interval '30 minutes'
          AND doctor_id=(SELECT doctor_id FROM old) AND EXISTS(SELECT 1 FROM old) RETURNING id),
      ap AS (UPDATE appointments SET slot_id=(SELECT id FROM ns),rescheduled_count=rescheduled_count+1
        WHERE id=${m[1]} AND EXISTS(SELECT 1 FROM ns) RETURNING id),
      fr AS (UPDATE availability_slots SET status='open' WHERE id=(SELECT slot_id FROM old) AND EXISTS(SELECT 1 FROM ap) RETURNING id)
      SELECT id FROM ap`;
    if(!r.length)return json(409,{error:'Reprogrammation impossible : nouveau créneau indisponible, autre médecin, ou moins de 2 heures avant la consultation.'});
    await audit(me.id,'appointment_rescheduled',ip,{appointment:m[1]});
    await notifyAppt(m[1],'rescheduled');
    return json(200,{ok:true});
  }
  return null;
}
