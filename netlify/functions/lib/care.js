import {sql,audit,rateLimited} from './db.js';
import {json,clean} from './util.js';
import {notifyUser} from './notify.js';
import {waveEnabled} from './wave.js';
import {releaseExpiredHolds,requestRefund} from './payments.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Classement à faire valider juridiquement : « regule » = profession de santé exigeant diplôme et numéro d'inscription vérifiés.
export const CATEGORIES=[
  {id:'infirmier',nom:'Soins infirmiers',regule:true,justificatif:'Diplôme et numéro d\u2019inscription professionnelle'},
  {id:'kinesitherapeute',nom:'Kinésithérapie',regule:true,justificatif:'Diplôme et numéro d\u2019inscription professionnelle'},
  {id:'sage_femme',nom:'Sage-femme',regule:true,justificatif:'Diplôme et numéro d\u2019inscription professionnelle'},
  {id:'aide_a_domicile',nom:'Aide à domicile (non médical)',regule:false,justificatif:'Pièce d\u2019identité et références'},
  {id:'bien_etre',nom:'Bien-être (non médical)',regule:false,justificatif:'Pièce d\u2019identité et références'}];
const CAT=Object.fromEntries(CATEGORIES.map(c=>[c.id,c]));
const need=(me,role)=>!me?json(401,{error:'Non connecté.'}):(me.role!==role||me.status!=='active')?json(403,{error:'Accès refusé.'}):null;
const inZone=(a,b)=>sql`EXISTS(SELECT 1 FROM unnest(${a}) z WHERE lower(z)=lower(${b}))`;

// Notifications volontairement génériques : ni adresse, ni description, ni nature des soins
export async function notifyMission(id,event,byUserId=null){
  try{
    const m=(await sql`SELECT patient_id,provider_id FROM missions WHERE id=${id}`)[0];if(!m)return;
    const T={accepted:[[m.provider_id,'Devis accepté','Un de vos devis a été accepté. Consultez « Mes interventions ».']],
      paid:[[m.patient_id,'Paiement confirmé','Votre paiement est confirmé et l\u2019intervention est planifiée.'],[m.provider_id,'Intervention confirmée','Un paiement est confirmé : l\u2019intervention est planifiée.']],
      cancelled:[[m.patient_id,'Intervention annulée','Une intervention a été annulée.'],[m.provider_id,'Intervention annulée','Une intervention a été annulée.']],
      declared:[[m.patient_id,'Intervention terminée ?','Le prestataire indique avoir terminé. Merci de confirmer ou de signaler un problème.']],
      completed:[[m.provider_id,'Intervention confirmée','Le patient a confirmé la réalisation de l\u2019intervention.']],
      dispute:[[m.patient_id,'Litige ouvert','Un litige a été ouvert sur une intervention.'],[m.provider_id,'Litige ouvert','Un litige a été ouvert sur une intervention.']],
      refunded:[[m.patient_id,'Remboursement effectué','Votre remboursement a été effectué.']]}[event]||[];
    for(const [u,t,b] of T){if(event==='cancelled'&&u===byUserId)continue;await notifyUser(u,'mission',t,b,'/services',`m:${event}:${id}:${u}`);}
  }catch(e){console.error('notifyMission',e.message);}
}
const quoteNotif=(patient,rid)=>notifyUser(patient,'mission','Nouveau devis','Vous avez reçu un devis pour votre demande de soins à domicile.','/services',`q:${rid}:${Math.floor(Date.now()/600000)}`);

export async function careRoutes({path,method,body,me,ip,query}){
  let m;
  if(path==='/api/care/categories'&&method==='GET')return json(200,{categories:CATEGORIES});
  if(path==='/api/care/providers'&&method==='GET'){
    const c=CAT[query.get('categorie')]?query.get('categorie'):null,z=clean(query.get('zone'),60)||null;
    return json(200,{prestataires:await sql`SELECT u.id,u.nom,p.categorie,p.zones,p.tarif_fcfa,p.frais_deplacement_fcfa,p.bio,
        (SELECT round(avg(rating),1) FROM care_reviews r WHERE r.provider_id=u.id) AS note,(SELECT count(*)::int FROM care_reviews r WHERE r.provider_id=u.id) AS nb_avis
      FROM provider_profiles p JOIN users u ON u.id=p.user_id WHERE p.verified_at IS NOT NULL AND u.status='active'
        AND (${c}::text IS NULL OR p.categorie=${c}) AND (${z}::text IS NULL OR EXISTS(SELECT 1 FROM unnest(p.zones) zz WHERE lower(zz)=lower(${z}))) ORDER BY note DESC NULLS LAST,u.nom LIMIT 50`});
  }
  if(!me)return json(401,{error:'Non connecté.'});
  const isP=me.role==='patient',isV=me.role==='prestataire';

  // ---------- Prestataire ----------
  if(path==='/api/provider/profile'&&method==='GET'){const e=need(me,'prestataire');if(e)return e;
    return json(200,{profile:(await sql`SELECT categorie,zones,tarif_fcfa,frais_deplacement_fcfa,bio,qualification_ref,verified_at FROM provider_profiles WHERE user_id=${me.id}`)[0]||null});}
  if(path==='/api/provider/profile'&&method==='POST'){
    const e=need(me,'prestataire');if(e)return e;
    const cat=CAT[body.categorie];if(!cat)return json(400,{error:'Catégorie inconnue.'});
    const zones=(Array.isArray(body.zones)?body.zones:[]).map(z=>clean(z,60)).filter(Boolean).slice(0,10),tarif=parseInt(body.tarif_fcfa,10),frais=parseInt(body.frais_deplacement_fcfa||0,10),ref=clean(body.qualification_ref,60);
    if(!zones.length)return json(400,{error:'Indiquez au moins une zone d\u2019intervention.'});
    if(!(tarif>=0&&tarif<=1000000)||!(frais>=0&&frais<=100000))return json(400,{error:'Tarif ou frais invalide.'});
    if(cat.regule&&ref.length<3)return json(400,{error:'Cette catégorie exige votre numéro d\u2019inscription professionnelle.'});
    await sql`INSERT INTO provider_profiles(user_id,categorie,zones,tarif_fcfa,frais_deplacement_fcfa,bio,qualification_ref) VALUES(${me.id},${cat.id},${zones},${tarif},${frais},${clean(body.bio,800)||null},${ref||null})
      ON CONFLICT(user_id) DO UPDATE SET categorie=EXCLUDED.categorie,zones=EXCLUDED.zones,tarif_fcfa=EXCLUDED.tarif_fcfa,frais_deplacement_fcfa=EXCLUDED.frais_deplacement_fcfa,bio=EXCLUDED.bio,updated_at=now(),
        qualification_ref=EXCLUDED.qualification_ref,
        verified_at=CASE WHEN provider_profiles.categorie IS DISTINCT FROM EXCLUDED.categorie OR provider_profiles.qualification_ref IS DISTINCT FROM EXCLUDED.qualification_ref THEN NULL ELSE provider_profiles.verified_at END`;
    await audit(me.id,'provider_profile_saved',ip);return json(200,{ok:true,message:'Profil enregistré. Il sera visible après vérification par un administrateur.'});
  }
  if(path==='/api/provider/requests'&&method==='GET'){
    const e=need(me,'prestataire');if(e)return e;
    // Demandes ouvertes correspondant à la catégorie et à la zone : AUCUNE identité ni adresse précise
    return json(200,{demandes:await sql`SELECT r.id,r.categorie,r.zone,r.preferred_date,r.description,r.created_at,
        EXISTS(SELECT 1 FROM care_quotes q WHERE q.request_id=r.id AND q.provider_id=${me.id}) AS devis_envoye
      FROM care_requests r JOIN provider_profiles p ON p.user_id=${me.id} AND p.verified_at IS NOT NULL
      WHERE r.status='ouverte' AND r.categorie=p.categorie AND EXISTS(SELECT 1 FROM unnest(p.zones) z WHERE lower(z)=lower(r.zone)) ORDER BY r.created_at DESC LIMIT 50`});
  }
  if((m=path.match(/^\/api\/provider\/requests\/([^/]+)\/quote$/))&&method==='POST'){
    const e=need(me,'prestataire');if(e)return e;if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    const prix=parseInt(body.prix_fcfa,10),frais=parseInt(body.frais_fcfa||0,10);if(!(prix>=0&&prix<=1000000)||!(frais>=0&&frais<=100000))return json(400,{error:'Montant invalide.'});
    const r=await sql`INSERT INTO care_quotes(request_id,provider_id,prix_fcfa,frais_fcfa,message)
      SELECT r.id,${me.id},${prix},${frais},${clean(body.message,500)||null} FROM care_requests r JOIN provider_profiles p ON p.user_id=${me.id} AND p.verified_at IS NOT NULL
      WHERE r.id=${m[1]} AND r.status='ouverte' AND r.categorie=p.categorie AND EXISTS(SELECT 1 FROM unnest(p.zones) z WHERE lower(z)=lower(r.zone))
      ON CONFLICT(request_id,provider_id) DO NOTHING RETURNING id,request_id`;
    if(!r.length)return json(409,{error:'Devis impossible : demande indisponible, hors de votre catégorie/zone, profil non vérifié, ou devis déjà envoyé.'});
    const pt=(await sql`SELECT patient_id FROM care_requests WHERE id=${m[1]}`)[0];await quoteNotif(pt.patient_id,m[1]);return json(201,{id:r[0].id});
  }
  if(path==='/api/provider/quotes'&&method==='GET'){const e=need(me,'prestataire');if(e)return e;
    return json(200,{devis:await sql`SELECT q.id,q.prix_fcfa,q.frais_fcfa,q.status,q.created_at,r.categorie,r.zone,r.preferred_date FROM care_quotes q JOIN care_requests r ON r.id=q.request_id WHERE q.provider_id=${me.id} ORDER BY q.created_at DESC LIMIT 100`});}
  if(path==='/api/provider/missions'&&method==='GET'){const e=need(me,'prestataire');if(e)return e;
    // L'adresse et le nom du patient ne sont révélés qu'une fois l'intervention confirmée
    return json(200,{missions:await sql`SELECT mi.id,mi.status,mi.categorie,mi.amount_fcfa,mi.preferred_date,mi.payment_mode,mi.created_at,
        CASE WHEN mi.status IN ('confirmee','declaree_realisee','terminee','litige') THEN mi.adresse END AS adresse,
        CASE WHEN mi.status IN ('confirmee','declaree_realisee','terminee','litige') THEN u.nom END AS patient,
        (SELECT rating FROM care_reviews r WHERE r.mission_id=mi.id) AS note
      FROM missions mi JOIN users u ON u.id=mi.patient_id WHERE mi.provider_id=${me.id} ORDER BY mi.created_at DESC LIMIT 100`});}
  if(path==='/api/provider/revenue'&&method==='GET'){const e=need(me,'prestataire');if(e)return e;
    const r=(await sql`SELECT coalesce(sum(l.amount_fcfa),0)::int AS a_verser_fcfa FROM ledger_entries l JOIN payments p ON p.id=l.payment_id JOIN missions mi ON mi.id=p.mission_id WHERE mi.provider_id=${me.id} AND l.kind IN ('a_verser_medecin','annul_a_verser_medecin')`)[0];
    return json(200,{...r,note:'Montants confirmés par le prestataire de paiement. Le versement n\u2019est pas encore automatisé.'});}

  // ---------- Patient ----------
  if(path==='/api/care/requests'&&method==='POST'){
    const e=need(me,'patient');if(e)return e;
    if(await rateLimited('care:'+me.id,10,3600))return json(429,{error:'Trop de demandes. Réessayez plus tard.'});
    const cat=CAT[body.categorie],zone=clean(body.zone,60),desc=clean(body.description,300),pd=body.preferred_date?String(body.preferred_date):null;
    if(!cat)return json(400,{error:'Catégorie inconnue.'});if(zone.length<2)return json(400,{error:'Indiquez votre ville ou quartier.'});
    if(pd&&(!/^\d{4}-\d{2}-\d{2}$/.test(pd)||pd<new Date().toISOString().slice(0,10)))return json(400,{error:'Date souhaitée invalide.'});
    let dep=null;if(body.dependentId){if(!UUID.test(String(body.dependentId))||!(await sql`SELECT 1 FROM dependents WHERE id=${body.dependentId} AND guardian_id=${me.id} AND archived_at IS NULL`).length)return json(403,{error:'Cette personne n\u2019est pas rattachée à votre compte.'});dep=body.dependentId;}
    const r=await sql`INSERT INTO care_requests(patient_id,dependent_id,categorie,zone,preferred_date,description) VALUES(${me.id},${dep}::uuid,${cat.id},${zone},${pd},${desc||null}) RETURNING id`;
    return json(201,{id:r[0].id});
  }
  if(path==='/api/care/requests'&&method==='GET'){
    const e=need(me,'patient');if(e)return e;
    const rs=await sql`SELECT id,categorie,zone,preferred_date,description,status,created_at FROM care_requests WHERE patient_id=${me.id} ORDER BY created_at DESC LIMIT 50`;
    const qs=await sql`SELECT q.id,q.request_id,q.prix_fcfa,q.frais_fcfa,q.message,q.status,u.nom AS prestataire,
        (SELECT round(avg(rating),1) FROM care_reviews r WHERE r.provider_id=q.provider_id) AS note,(SELECT count(*)::int FROM care_reviews r WHERE r.provider_id=q.provider_id) AS nb_avis
      FROM care_quotes q JOIN users u ON u.id=q.provider_id JOIN care_requests r ON r.id=q.request_id WHERE r.patient_id=${me.id} ORDER BY q.prix_fcfa+q.frais_fcfa`;
    return json(200,{demandes:rs.map(r=>({...r,devis:qs.filter(q=>q.request_id===r.id)}))});
  }
  if((m=path.match(/^\/api\/care\/requests\/([^/]+)\/(accept|cancel)$/))&&method==='POST'){
    const e=need(me,'patient');if(e)return e;if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    if(m[2]==='cancel'){const r=await sql`UPDATE care_requests SET status='annulee' WHERE id=${m[1]} AND patient_id=${me.id} AND status='ouverte' RETURNING id`;return r.length?json(200,{ok:true}):json(409,{error:'Demande introuvable ou déjà attribuée.'});}
    const qid=String(body.quoteId||''),adr=clean(body.adresse,200);
    if(!UUID.test(qid))return json(400,{error:'Devis invalide.'});if(adr.length<5)return json(400,{error:'Indiquez l\u2019adresse d\u2019intervention (elle ne sera communiquée qu\u2019au prestataire retenu).'});
    if(body.consent!==true)return json(400,{error:'Votre consentement est requis.'});
    await releaseExpiredHolds();const online=waveEnabled();
    // Une seule instruction : devis accepté, autres refusés, demande attribuée, mission créée — ou rien
    const r=await sql`WITH q AS (UPDATE care_quotes SET status='acceptee' WHERE id=${qid} AND request_id=${m[1]} AND status='proposee'
          AND EXISTS(SELECT 1 FROM care_requests r WHERE r.id=${m[1]} AND r.patient_id=${me.id} AND r.status='ouverte') RETURNING id,provider_id,prix_fcfa,frais_fcfa),
        r AS (UPDATE care_requests SET status='attribuee' WHERE id=${m[1]} AND EXISTS(SELECT 1 FROM q) RETURNING id,patient_id,dependent_id,categorie,preferred_date),
        o AS (UPDATE care_quotes SET status='refusee' WHERE request_id=${m[1]} AND id<>${qid} AND EXISTS(SELECT 1 FROM q) RETURNING id)
      INSERT INTO missions(request_id,quote_id,patient_id,provider_id,dependent_id,categorie,adresse,amount_fcfa,status,payment_mode,hold_expires_at,preferred_date)
      SELECT r.id,q.id,r.patient_id,q.provider_id,r.dependent_id,r.categorie,${adr},q.prix_fcfa+q.frais_fcfa,
        CASE WHEN ${online}::boolean AND q.prix_fcfa+q.frais_fcfa>0 THEN 'pending_payment' ELSE 'confirmee' END,
        CASE WHEN ${online}::boolean AND q.prix_fcfa+q.frais_fcfa>0 THEN 'en_ligne' ELSE 'sur_place' END,
        CASE WHEN ${online}::boolean AND q.prix_fcfa+q.frais_fcfa>0 THEN now()+interval '30 minutes' END,r.preferred_date FROM q JOIN r ON true
      RETURNING id,status,amount_fcfa,payment_mode,hold_expires_at`;
    if(!r.length)return json(409,{error:'Ce devis n\u2019est plus disponible (demande déjà attribuée ou devis retiré).'});
    await audit(me.id,'mission_created',ip,{mission:r[0].id});
    if(r[0].status==='confirmee')await notifyMission(r[0].id,'accepted');
    return json(201,{mission:r[0],message:r[0].status==='pending_payment'?'Intervention retenue 30 minutes : finalisez le paiement pour la confirmer.':'Intervention confirmée. Règlement sur place : le paiement en ligne n\u2019est pas activé.'});
  }
  if(path==='/api/care/missions'&&method==='GET'){
    const e=need(me,'patient');if(e)return e;
    return json(200,{missions:await sql`SELECT mi.id,mi.status,mi.categorie,mi.amount_fcfa,mi.payment_mode,mi.preferred_date,mi.hold_expires_at,mi.created_at,u.nom AS prestataire,
        (SELECT rating FROM care_reviews r WHERE r.mission_id=mi.id) AS note_donnee,
        (SELECT id FROM payments p WHERE p.mission_id=mi.id AND p.status IN ('succeeded','refunded','refund_pending') ORDER BY created_at DESC LIMIT 1) AS paiement_id
      FROM missions mi JOIN users u ON u.id=mi.provider_id WHERE mi.patient_id=${me.id} ORDER BY mi.created_at DESC LIMIT 100`});
  }

  // ---------- Cycle de vie d'une mission ----------
  if((m=path.match(/^\/api\/missions\/([^/]+)\/(cancel|declare-done|confirm-done|review|dispute)$/))&&method==='POST'){
    if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    const mi=(await sql`SELECT * FROM missions WHERE id=${m[1]} AND (patient_id=${me.id} OR provider_id=${me.id})`)[0];
    if(!mi||!(isP||isV)||me.status!=='active')return json(404,{error:'Mission introuvable.'});
    const byPatient=mi.patient_id===me.id;
    if(m[2]==='cancel'){
      const refundable=!byPatient||!mi.preferred_date||new Date(mi.preferred_date).getTime()>Date.now()+24*3600e3; // règle à faire valider et à afficher
      const r=await sql`UPDATE missions SET status='annulee' WHERE id=${mi.id} AND status IN ('pending_payment','confirmee') RETURNING id`;
      if(!r.length)return json(409,{error:'Annulation impossible à ce stade.'});
      await audit(me.id,'mission_cancelled',ip,{mission:mi.id});await notifyMission(mi.id,'cancelled',me.id);
      const pay=(await sql`SELECT id FROM payments WHERE mission_id=${mi.id} AND status IN ('succeeded','refund_pending')`)[0];let rem='sans objet';
      if(pay){if(refundable){const f=await requestRefund(pay.id,me.id,ip);rem=f.ok?'effectué':'en attente de confirmation du prestataire';}else rem='non remboursable (annulation tardive)';}
      return json(200,{ok:true,remboursement:rem});
    }
    if(m[2]==='declare-done'){if(byPatient)return json(403,{error:'Réservé au prestataire.'});
      const r=await sql`UPDATE missions SET status='declaree_realisee',done_declared_at=now() WHERE id=${mi.id} AND status='confirmee' RETURNING id`;
      if(r.length)await notifyMission(mi.id,'declared');return r.length?json(200,{ok:true}):json(409,{error:'Action impossible à ce stade.'});}
    if(m[2]==='confirm-done'){if(!byPatient)return json(403,{error:'Réservé au patient.'});
      const r=await sql`UPDATE missions SET status='terminee',completed_at=now() WHERE id=${mi.id} AND status='declaree_realisee' RETURNING id`;
      if(r.length)await notifyMission(mi.id,'completed');return r.length?json(200,{ok:true}):json(409,{error:'Le prestataire n\u2019a pas encore déclaré l\u2019intervention terminée.'});}
    if(m[2]==='review'){if(!byPatient)return json(403,{error:'Réservé au patient.'});
      const rt=parseInt(body.rating,10);if(!(rt>=1&&rt<=5))return json(400,{error:'Note de 1 à 5.'});
      if(mi.status!=='terminee')return json(409,{error:'Vous pouvez noter une intervention seulement après l\u2019avoir confirmée.'});
      const r=await sql`INSERT INTO care_reviews(mission_id,patient_id,provider_id,rating,comment) VALUES(${mi.id},${me.id},${mi.provider_id},${rt},${clean(body.comment,500)||null}) ON CONFLICT DO NOTHING RETURNING mission_id`;
      return r.length?json(201,{ok:true}):json(409,{error:'Vous avez déjà noté cette intervention.'});}
    // litige
    const reason=clean(body.reason,500);if(reason.length<5)return json(400,{error:'Décrivez le problème.'});
    const r=await sql`WITH u AS (UPDATE missions SET status='litige' WHERE id=${mi.id} AND status IN ('confirmee','declaree_realisee','terminee') AND (completed_at IS NULL OR completed_at>now()-interval '14 days') RETURNING id)
      INSERT INTO care_disputes(mission_id,opened_by,reason) SELECT id,${me.id},${reason} FROM u RETURNING id`;
    if(!r.length)return json(409,{error:'Litige impossible à ce stade (délai de 14 jours après confirmation dépassé ?).'});
    await audit(me.id,'dispute_opened',ip,{mission:mi.id});await notifyMission(mi.id,'dispute');return json(201,{id:r[0].id});
  }

  // ---------- Administration ----------
  if(path.startsWith('/api/admin/providers')||path.startsWith('/api/admin/disputes')){
    const e=need(me,'admin');if(e){if(me)await audit(me.id,'forbidden_admin',ip,{path});return e;}
    if(path==='/api/admin/providers/pending'&&method==='GET')
      return json(200,{prestataires:await sql`SELECT u.id,u.nom,u.tel,p.categorie,p.zones,p.qualification_ref,p.updated_at FROM provider_profiles p JOIN users u ON u.id=p.user_id WHERE p.verified_at IS NULL AND u.status='active' ORDER BY p.updated_at`,
        categories:CATEGORIES});
    if((m=path.match(/^\/api\/admin\/providers\/([^/]+)\/verify$/))&&method==='POST'){
      if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});if(body.justificatifs_verifies!==true)return json(400,{error:'Confirmez avoir contrôlé les justificatifs requis pour cette catégorie.'});
      const r=await sql`UPDATE provider_profiles SET verified_at=now(),verified_by=${me.id} WHERE user_id=${m[1]} RETURNING user_id`;if(!r.length)return json(404,{error:'Profil introuvable.'});
      await audit(me.id,'provider_verified',ip,{target:m[1],note:clean(body.note,300)});await notifyUser(m[1],'verif','Profil vérifié','Votre profil est vérifié : vous pouvez répondre aux demandes.','/missions','pv:'+Date.now());return json(200,{ok:true});}
    if(path==='/api/admin/disputes'&&method==='GET')
      return json(200,{litiges:await sql`SELECT d.id,d.status,d.reason,d.created_at,mi.id AS mission_id,mi.amount_fcfa,mi.status AS statut_mission,pu.nom AS patient,vu.nom AS prestataire FROM care_disputes d JOIN missions mi ON mi.id=d.mission_id JOIN users pu ON pu.id=mi.patient_id JOIN users vu ON vu.id=mi.provider_id ORDER BY d.created_at DESC LIMIT 100`});
    if((m=path.match(/^\/api\/admin\/disputes\/([^/]+)\/resolve$/))&&method==='POST'){
      if(!UUID.test(m[1])||!['rembourser','rejeter'].includes(body.decision))return json(400,{error:'Requête invalide.'});const note=clean(body.note,300);if(note.length<3)return json(400,{error:'Motivez la décision.'});
      const d=(await sql`UPDATE care_disputes SET status=${body.decision==='rembourser'?'rembourse':'rejete'},note=${note},handled_by=${me.id},handled_at=now() WHERE id=${m[1]} AND status='ouvert' RETURNING mission_id`)[0];
      if(!d)return json(404,{error:'Litige introuvable ou déjà traité.'});
      let rem='sans objet';
      if(body.decision==='rembourser'){await sql`UPDATE missions SET status='annulee' WHERE id=${d.mission_id}`;const pay=(await sql`SELECT id FROM payments WHERE mission_id=${d.mission_id} AND status IN ('succeeded','refund_pending')`)[0];if(pay){const f=await requestRefund(pay.id,me.id,ip);rem=f.ok?'effectué':'en attente de confirmation du prestataire';}}
      else await sql`UPDATE missions SET status='terminee',completed_at=coalesce(completed_at,now()) WHERE id=${d.mission_id}`;
      await audit(me.id,'dispute_resolved',ip,{dispute:m[1],decision:body.decision});return json(200,{ok:true,remboursement:rem});}
  }
  return null;
}
