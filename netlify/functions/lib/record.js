import crypto from 'node:crypto';
import {sql,audit,rateLimited} from './db.js';
import {json,clean,sha256,readCookie} from './util.js';
import {putBlob,getBlob} from './blobs.js';
import {notifyUser} from './notify.js';
import {hasRelDep} from './ped.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const need=(me,role)=>!me?json(401,{error:'Non connecté.'}):(me.role!==role||me.status!=='active')?json(403,{error:'Accès refusé.'}):null;
const MAX_FILE=4*1024*1024,LINK_TTL=300;
const VITAUX={poids_kg:[0.3,400],taille_cm:[20,250],temperature_c:[30,45],pouls:[20,250]};
const hash=o=>sha256(JSON.stringify(o));

// Lien de soin : rendez-vous confirmé/terminé avec ce patient depuis moins d'un an (ou à venir)
const hasRel=async(d,p)=>(await sql`SELECT 1 FROM appointments a JOIN availability_slots s ON s.id=a.slot_id WHERE a.patient_id=${p} AND a.doctor_id=${d} AND a.dependent_id IS NULL AND a.status IN ('confirmed','completed') AND s.starts_at>now()-interval '365 days' LIMIT 1`).length>0;
// Autorisation explicite du patient, non expirée, non révoquée
const hasGrant=async(d,p)=>(await sql`SELECT 1 FROM record_access WHERE patient_id=${p} AND doctor_id=${d} AND revoked_at IS NULL AND expires_at>now() LIMIT 1`).length>0;
const canRead=async(d,p)=>(await hasRel(d,p))&&(await hasGrant(d,p));
const logAcc=(actor,patient,action,type,id,ip)=>sql`INSERT INTO record_access_log(actor_id,patient_id,action,object_type,object_id,ip) VALUES(${actor},${patient},${action},${type||null},${id?String(id):null},${ip})`;
const docOk=async(me,doc)=>me.id===doc.patient_id||(me.role==='medecin'&&me.status==='active'&&(doc.uploader_id===me.id||(await sql`SELECT 1 FROM document_shares WHERE document_id=${doc.id} AND doctor_id=${me.id}`).length>0||await canRead(me.id,doc.patient_id)));

function validEntry(b){
  const kind=b.kind,title=clean(b.title,120),body=clean(b.body,2000);let data=null;
  if(!['allergie','antecedent','constante','vaccination','note'].includes(kind))return {error:'Type invalide.'};
  if(kind==='constante'){
    const t=b.data&&b.data.type,v=b.data&&b.data.valeur;
    if(t==='tension'){const m=/^(\d{2,3})\/(\d{2,3})$/.exec(String(v||''));if(!m||+m[1]<50||+m[1]>260||+m[2]<30||+m[2]>160)return {error:'Tension invalide (ex. 120/80).'};data={type:t,valeur:String(v)};}
    else{const r=VITAUX[t],n=Number(v);if(!r||!Number.isFinite(n)||n<r[0]||n>r[1])return {error:'Constante invalide ou hors limites plausibles.'};data={type:t,valeur:n};}
  }else if(b.data&&typeof b.data==='object'){data={date:clean(b.data.date,20)||undefined};}
  if(title.length<2)return {error:'Titre obligatoire.'};
  return {kind,title,body,data};
}
async function entriesFor(patientId,viewerId){
  return sql`SELECT e.id,e.kind,e.title,e.body,e.data,e.status,e.version,e.author_role,u.nom AS auteur,e.created_at,e.finalized_at,e.amends_id,
      EXISTS(SELECT 1 FROM record_entries x WHERE x.amends_id=e.id AND x.status='finalise') AS remplacee
    FROM record_entries e JOIN users u ON u.id=e.author_id WHERE e.patient_id=${patientId} AND (e.status='finalise' OR e.author_id=${viewerId}) ORDER BY e.created_at DESC LIMIT 300`;
}
function parseFile(b){
  const name=clean(String(b.filename||'document').replace(/[\\/]/g,'_'),100)||'document';
  const buf=Buffer.from(String(b.dataBase64||''),'base64');
  if(!buf.length)return {error:'Fichier vide.'};if(buf.length>MAX_FILE)return {error:'Fichier trop volumineux (4 Mo maximum).',status:413};
  const mime=buf.slice(0,5).toString('latin1')==='%PDF-'?'application/pdf':(buf[0]===0xff&&buf[1]===0xd8&&buf[2]===0xff)?'image/jpeg':(buf[0]===0x89&&buf.slice(1,4).toString('latin1')==='PNG')?'image/png':null;
  if(!mime)return {error:'Format non accepté (PDF, JPEG ou PNG uniquement ; le contenu est vérifié).'};
  return {name,buf,mime};
}
export function signLink(docId,userId,ttl=LINK_TTL,now=Date.now()){
  const p=Buffer.from(JSON.stringify({d:docId,u:userId,e:Math.floor(now/1000)+ttl})).toString('base64url');
  return p+'.'+crypto.createHmac('sha256',process.env.DOC_LINK_SECRET).update(p).digest('base64url');
}
function checkLink(tok,docId,userId){
  if(!process.env.DOC_LINK_SECRET||!tok)return false;const [p,s]=String(tok).split('.');if(!p||!s)return false;
  const exp=crypto.createHmac('sha256',process.env.DOC_LINK_SECRET).update(p).digest('base64url');
  if(s.length!==exp.length||!crypto.timingSafeEqual(Buffer.from(s),Buffer.from(exp)))return false;
  try{const o=JSON.parse(Buffer.from(p,'base64url').toString());return o.d===docId&&o.u===userId&&o.e>Date.now()/1000;}catch{return false;}
}

export async function recordRoutes({req,path,method,body,me,ip,query}){
  let m;
  // Vérification publique d'une ordonnance : aucune donnée de santé ni nom de patient
  if((m=path.match(/^\/api\/prescriptions\/verify\/([A-Z0-9-]{8,30})$/))&&method==='GET'){
    if(await rateLimited('rxv:'+ip,30,3600))return json(429,{error:'Trop de vérifications.'});
    const r=(await sql`SELECT p.status,p.signed_at,u.nom AS medecin FROM prescriptions p JOIN users u ON u.id=p.doctor_id WHERE p.number=${m[1]} AND p.status IN ('signee','annulee','delivree')`)[0];
    return r?json(200,{valide:r.status==='signee',statut:r.status,date_signature:r.signed_at,medecin:r.medecin}):json(404,{error:'Numéro inconnu.'});
  }
  if(!me)return json(401,{error:'Non connecté.'});
  if(me.role==='admin'||!['patient','medecin'].includes(me.role))return json(403,{error:'Accès refusé : les données médicales ne sont pas accessibles à ce rôle.'});

  // ---------- Dossier du patient ----------
  if(path==='/api/record'&&method==='GET'){const e=need(me,'patient');if(e)return e;return json(200,{entries:await entriesFor(me.id,me.id)});}
  if(path==='/api/record/entries'&&method==='POST'){
    const e=need(me,'patient');if(e)return e;if(body.kind==='note')return json(400,{error:'Type invalide.'});
    const v=validEntry(body);if(v.error)return json(400,{error:v.error});
    let am=null;if(body.amends_id){if(!UUID.test(String(body.amends_id)))return json(400,{error:'Identifiant invalide.'});am=body.amends_id;}
    const r=await sql`INSERT INTO record_entries(patient_id,author_id,author_role,kind,title,body,data,status,amends_id,content_hash,finalized_at)
      SELECT ${me.id},${me.id},'patient',${v.kind},${v.title},${v.body},${v.data?JSON.stringify(v.data):null}::jsonb,'finalise',${am},${hash([me.id,v.kind,v.title,v.body,v.data])},now()
      WHERE ${am}::uuid IS NULL OR EXISTS(SELECT 1 FROM record_entries WHERE id=${am} AND patient_id=${me.id} AND author_id=${me.id}) RETURNING id`;
    return r.length?json(201,{id:r[0].id}):json(404,{error:'Entrée à corriger introuvable.'});
  }
  if(path==='/api/record/export'&&method==='GET'){
    const e=need(me,'patient');if(e)return e;await logAcc(me.id,me.id,'export','dossier',null,ip);
    const data={exporte_le:new Date().toISOString(),entrees:await entriesFor(me.id,me.id),
      ordonnances:await sql`SELECT number,status,items,notes,signed_at,cancelled_at FROM prescriptions WHERE patient_id=${me.id} AND status IN ('signee','annulee','delivree') ORDER BY created_at`,
      documents:await sql`SELECT id,filename,mime,size_bytes,kind,created_at FROM documents WHERE patient_id=${me.id}`,
      autorisations:await sql`SELECT doctor_id,granted_at,expires_at,revoked_at FROM record_access WHERE patient_id=${me.id}`,
      journal_acces:await sql`SELECT actor_id,action,object_type,at FROM record_access_log WHERE patient_id=${me.id} ORDER BY at`};
    return new Response(JSON.stringify(data,null,2),{status:200,headers:{'content-type':'application/json; charset=utf-8','content-disposition':'attachment; filename="kayligey-mon-dossier.json"','cache-control':'no-store'}});
  }

  // ---------- Partage du dossier (consentement explicite) ----------
  if(path==='/api/record/access'&&method==='GET'){
    const e=need(me,'patient');if(e)return e;
    return json(200,{
      autorisations:await sql`SELECT a.doctor_id,u.nom,a.granted_at,a.expires_at FROM record_access a JOIN users u ON u.id=a.doctor_id WHERE a.patient_id=${me.id} AND a.revoked_at IS NULL AND a.expires_at>now()`,
      medecins_possibles:await sql`SELECT DISTINCT u.id,u.nom FROM appointments a JOIN availability_slots s ON s.id=a.slot_id JOIN users u ON u.id=a.doctor_id WHERE a.patient_id=${me.id} AND a.dependent_id IS NULL AND a.status IN ('confirmed','completed') AND s.starts_at>now()-interval '365 days'`,
      journal:await sql`SELECT l.action,l.object_type,l.at,u.nom AS acteur FROM record_access_log l JOIN users u ON u.id=l.actor_id WHERE l.patient_id=${me.id} AND l.actor_id<>${me.id} ORDER BY l.at DESC LIMIT 50`});
  }
  if(path==='/api/record/access'&&method==='POST'){
    const e=need(me,'patient');if(e)return e;if(!UUID.test(String(body.doctorId||'')))return json(400,{error:'Médecin invalide.'});
    const days=Math.min(365,Math.max(1,parseInt(body.days,10)||90));
    if(!(await hasRel(body.doctorId,me.id)))return json(409,{error:'Ce médecin n\u2019a pas de rendez-vous avec vous : partage impossible.'});
    await sql`UPDATE record_access SET revoked_at=now() WHERE patient_id=${me.id} AND doctor_id=${body.doctorId} AND revoked_at IS NULL`;
    await sql`INSERT INTO record_access(patient_id,doctor_id,expires_at) VALUES(${me.id},${body.doctorId},now()+make_interval(days=>${days}))`;
    await logAcc(me.id,me.id,'partage_accorde','medecin',body.doctorId,ip);return json(200,{ok:true,jours:days});
  }
  if((m=path.match(/^\/api\/record\/access\/([^/]+)\/revoke$/))&&method==='POST'){
    const e=need(me,'patient');if(e)return e;if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    await sql`UPDATE record_access SET revoked_at=now() WHERE patient_id=${me.id} AND doctor_id=${m[1]} AND revoked_at IS NULL`;
    await logAcc(me.id,me.id,'partage_retire','medecin',m[1],ip);return json(200,{ok:true});
  }

  // ---------- Médecin : patients, dossier, notes ----------
  if(path==='/api/doctor/patients'&&method==='GET'){
    const e=need(me,'medecin');if(e)return e;
    return json(200,{patients:await sql`SELECT u.id,u.nom,max(s.starts_at) AS dernier_rdv,
        EXISTS(SELECT 1 FROM record_access r WHERE r.patient_id=u.id AND r.doctor_id=${me.id} AND r.revoked_at IS NULL AND r.expires_at>now()) AS acces_accorde
      FROM appointments a JOIN availability_slots s ON s.id=a.slot_id JOIN users u ON u.id=a.patient_id
      WHERE a.doctor_id=${me.id} AND a.dependent_id IS NULL AND a.status IN ('confirmed','completed') AND s.starts_at>now()-interval '365 days' GROUP BY u.id,u.nom ORDER BY dernier_rdv DESC`});
  }
  if((m=path.match(/^\/api\/patients\/([^/]+)\/record$/))&&method==='GET'){
    const e=need(me,'medecin');if(e)return e;if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    if(!(await canRead(me.id,m[1]))){await audit(me.id,'record_denied',ip,{patient:m[1]});return json(403,{error:'Accès refusé : il faut un rendez-vous avec ce patient ET son autorisation de partage.'});}
    await logAcc(me.id,m[1],'lecture_dossier','dossier',null,ip);
    return json(200,{entries:await entriesFor(m[1],me.id)});
  }
  if((m=path.match(/^\/api\/patients\/([^/]+)\/notes$/))&&method==='POST'){
    const e=need(me,'medecin');if(e)return e;if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    if(!(await hasRel(me.id,m[1])))return json(403,{error:'Aucune prise en charge en cours avec ce patient.'});
    const v=validEntry({kind:'note',title:body.title,body:body.body});if(v.error)return json(400,{error:v.error});
    const r=await sql`INSERT INTO record_entries(patient_id,author_id,author_role,kind,title,body,status) VALUES(${m[1]},${me.id},'medecin','note',${v.title},${v.body},'brouillon') RETURNING id`;
    return json(201,{id:r[0].id});
  }
  if((m=path.match(/^\/api\/entries\/([^/]+)\/(edit|finalize|amend)$/))&&method==='POST'){
    if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    const en=(await sql`SELECT * FROM record_entries WHERE id=${m[1]} AND author_id=${me.id}`)[0];
    if(!en)return json(404,{error:'Entrée introuvable.'});
    if(m[2]==='edit'){
      if(en.status!=='brouillon')return json(409,{error:'Une entrée finalisée ne peut pas être modifiée : ajoutez une correction.'});
      const v=validEntry({kind:en.kind==='note'?'note':en.kind,title:body.title,body:body.body,data:en.data});if(v.error)return json(400,{error:v.error});
      await sql`INSERT INTO entry_versions(entry_id,version,title,body) VALUES(${en.id},${en.version},${en.title},${en.body})`;
      await sql`UPDATE record_entries SET title=${v.title},body=${v.body},version=version+1 WHERE id=${en.id} AND status='brouillon'`;
      return json(200,{ok:true,version:en.version+1});
    }
    if(m[2]==='finalize'){
      if(en.status!=='brouillon')return json(409,{error:'Déjà finalisée.'});
      const r=await sql`UPDATE record_entries SET status='finalise',finalized_at=now(),content_hash=${hash([en.patient_id,en.author_id,en.kind,en.title,en.body,en.version])} WHERE id=${en.id} AND status='brouillon' RETURNING id`;
      if(r.length)await notifyUser(en.patient_id,'dossier','Dossier mis à jour','Un nouvel élément a été ajouté à votre dossier médical.','/dossier','entry:'+en.id);
      return r.length?json(200,{ok:true}):json(409,{error:'Déjà finalisée.'});
    }
    if(en.status!=='finalise')return json(409,{error:'Seule une entrée finalisée peut être corrigée.'});
    const v=validEntry({kind:en.kind,title:body.title,body:body.body,data:body.data||en.data});if(v.error)return json(400,{error:v.error});
    const st=en.author_role==='patient'?'finalise':'brouillon';
    const r=await sql`INSERT INTO record_entries(patient_id,author_id,author_role,kind,title,body,data,status,amends_id,finalized_at,content_hash)
      VALUES(${en.patient_id},${me.id},${en.author_role},${en.kind},${v.title},${v.body},${v.data?JSON.stringify(v.data):null}::jsonb,${st},${en.id},${st==='finalise'?new Date().toISOString():null},${st==='finalise'?hash([en.patient_id,v.title,v.body]):null}) RETURNING id`;
    return json(201,{id:r[0].id,statut:st});
  }

  // ---------- Ordonnances ----------
  const items=b=>{const l=(Array.isArray(b.items)?b.items:[]).slice(0,15).map(x=>({medicament:clean(x&&x.medicament,120),posologie:clean(x&&x.posologie,200),duree:clean(x&&x.duree,60)}));return l.length&&l.every(x=>x.medicament&&x.posologie)?l:null;};
  const isVerifiedDoc=async()=>(await sql`SELECT 1 FROM doctors WHERE user_id=${me.id} AND verified_at IS NOT NULL`).length>0;
  if(path==='/api/prescriptions'&&method==='POST'){
    const e=need(me,'medecin');if(e)return e;
    if(!(await isVerifiedDoc()))return json(403,{error:'Seul un médecin vérifié peut prescrire.'});
    let pid=String(body.patientId||''),dep=null,poids=null;
    if(body.dependentId){ // ordonnance pour un enfant : lien de soin pour CET enfant + poids obligatoire
      if(!UUID.test(String(body.dependentId)))return json(400,{error:'Enfant invalide.'});
      const d=(await sql`SELECT guardian_id FROM dependents WHERE id=${body.dependentId} AND archived_at IS NULL`)[0];
      if(!d||!(await hasRelDep(me.id,body.dependentId)))return json(403,{error:'Aucune prise en charge en cours pour cet enfant.'});
      poids=Number(body.poids_kg);if(!(poids>=0.3&&poids<=150))return json(400,{error:'Le poids de l\u2019enfant (kg) est obligatoire sur une ordonnance pédiatrique.'});
      pid=d.guardian_id;dep=body.dependentId;
    }else{
      if(!UUID.test(pid))return json(400,{error:'Patient invalide.'});
      if(!(await hasRel(me.id,pid)))return json(403,{error:'Aucune prise en charge en cours avec ce patient.'});
    }
    const it=items(body);if(!it)return json(400,{error:'Indiquez au moins un médicament avec sa posologie.'});
    const r=await sql`INSERT INTO prescriptions(patient_id,doctor_id,items,notes,dependent_id,poids_kg) VALUES(${pid},${me.id},${JSON.stringify(it)}::jsonb,${clean(body.notes,1000)||null},${dep}::uuid,${poids}) RETURNING id`;
    return json(201,{id:r[0].id,statut:'brouillon'});
  }
  if((m=path.match(/^\/api\/prescriptions\/([^/]+)\/(edit|sign|cancel)$/))&&method==='POST'){
    const e=need(me,'medecin');if(e)return e;if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    const p=(await sql`SELECT * FROM prescriptions WHERE id=${m[1]} AND doctor_id=${me.id}`)[0];if(!p)return json(404,{error:'Ordonnance introuvable.'});
    if(m[2]==='edit'){
      const it=items(body);if(!it)return json(400,{error:'Indiquez au moins un médicament avec sa posologie.'});
      const r=await sql`UPDATE prescriptions SET items=${JSON.stringify(it)}::jsonb,notes=${clean(body.notes,1000)||null},version=version+1 WHERE id=${p.id} AND status='brouillon' RETURNING id`;
      return r.length?json(200,{ok:true}):json(409,{error:'Une ordonnance signée ne peut plus être modifiée : annulez-la et créez-en une nouvelle.'});
    }
    if(m[2]==='sign'){
      if(body.confirm!==true)return json(400,{error:'Confirmez la signature.'});
      if(!(await isVerifiedDoc()))return json(403,{error:'Seul un médecin vérifié peut signer.'});
      const r=await sql`UPDATE prescriptions SET status='signee',signed_at=now(),number='ORD-'||to_char(now(),'YYYY')||'-'||lpad(nextval('rx_seq')::text,6,'0'),
        content_hash=${hash([p.patient_id,p.doctor_id,p.items,p.notes,p.version,p.dependent_id,p.poids_kg])} WHERE id=${p.id} AND status='brouillon' RETURNING number`;
      if(!r.length)return json(409,{error:'Ordonnance déjà signée ou annulée.'});
      await audit(me.id,'rx_signed',ip,{rx:p.id});
      await notifyUser(p.patient_id,'ordonnance','Nouvelle ordonnance','Une ordonnance est disponible dans votre dossier.','/dossier','rx:'+p.id);
      return json(200,{ok:true,numero:r[0].number,note:'Signature électronique simple (authentification du médecin). Ce n\u2019est pas une signature qualifiée.'});
    }
    const reason=clean(body.reason,300);if(reason.length<3)return json(400,{error:'Indiquez le motif d\u2019annulation.'});
    const r=await sql`UPDATE prescriptions SET status='annulee',cancelled_at=now(),cancel_reason=${reason} WHERE id=${p.id} AND status='signee' RETURNING id`;
    if(r.length)await audit(me.id,'rx_cancelled',ip,{rx:p.id});
    return r.length?json(200,{ok:true}):json(409,{error:'Seule une ordonnance signée peut être annulée.'});
  }
  if(path==='/api/prescriptions'&&method==='GET'){
    if(me.role==='patient')return json(200,{prescriptions:await sql`SELECT p.id,p.number,p.status,p.items,p.notes,p.signed_at,p.cancelled_at,p.poids_kg,dp.nom AS enfant,u.nom AS medecin FROM prescriptions p JOIN users u ON u.id=p.doctor_id LEFT JOIN dependents dp ON dp.id=p.dependent_id WHERE p.patient_id=${me.id} AND p.status IN ('signee','annulee','delivree') ORDER BY p.created_at DESC LIMIT 100`});
    return json(200,{prescriptions:await sql`SELECT p.id,p.number,p.status,p.items,p.notes,p.signed_at,p.poids_kg,COALESCE(dp.nom,u.nom) AS patient FROM prescriptions p JOIN users u ON u.id=p.patient_id LEFT JOIN dependents dp ON dp.id=p.dependent_id WHERE p.doctor_id=${me.id} ORDER BY p.created_at DESC LIMIT 100`});
  }

  // ---------- Documents (stockage privé, liens temporaires) ----------
  if(path==='/api/documents'&&method==='POST'){
    if(await rateLimited('up:'+me.id,30,3600))return json(429,{error:'Trop d\u2019envois. Réessayez plus tard.'});
    let pid=me.id;
    if(me.role==='medecin'){if(me.status!=='active'||!UUID.test(String(body.patientId||''))||!(await hasRel(me.id,body.patientId)))return json(403,{error:'Aucune prise en charge en cours avec ce patient.'});pid=body.patientId;}
    const f=parseFile(body);if(f.error)return json(f.status||400,{error:f.error});
    const key=crypto.randomUUID()+'-'+crypto.randomBytes(8).toString('hex');
    await putBlob(key,f.buf);
    const r=await sql`INSERT INTO documents(patient_id,uploader_id,filename,mime,size_bytes,sha256,blob_key,kind) VALUES(${pid},${me.id},${f.name},${f.mime},${f.buf.length},${crypto.createHash('sha256').update(f.buf).digest('hex')},${key},${clean(body.kind,30)||'autre'}) RETURNING id`;
    await logAcc(me.id,pid,'depot_document','document',r[0].id,ip);
    return json(201,{id:r[0].id,analyse_antivirus:'non effectuée'});
  }
  if(path==='/api/documents'&&method==='GET'){
    let pid=me.id,onlyMine=false;
    if(me.role==='medecin'){const p=query.get('patientId');if(!UUID.test(String(p||'')))return json(400,{error:'Patient invalide.'});pid=p;onlyMine=!(await canRead(me.id,p));if(onlyMine&&!(await hasRel(me.id,p)))return json(403,{error:'Accès refusé.'});if(!onlyMine)await logAcc(me.id,p,'liste_documents','document',null,ip);}
    return json(200,{documents:await sql`SELECT d.id,d.filename,d.mime,d.size_bytes,d.kind,d.scan_status,d.created_at,u.nom AS depose_par FROM documents d JOIN users u ON u.id=d.uploader_id WHERE d.patient_id=${pid} AND (${!onlyMine}::boolean OR d.uploader_id=${me.id}) ORDER BY d.created_at DESC LIMIT 200`});
  }
  if((m=path.match(/^\/api\/documents\/([^/]+)\/link$/))&&method==='GET'){
    if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});if(!process.env.DOC_LINK_SECRET)return json(503,{error:'Stockage de documents non configuré.'});
    const d=(await sql`SELECT id,patient_id,uploader_id FROM documents WHERE id=${m[1]}`)[0];
    if(!d||!(await docOk(me,d))){await audit(me.id,'doc_denied',ip,{doc:m[1]});return json(d?403:404,{error:d?'Accès refusé.':'Document introuvable.'});}
    return json(200,{url:`/api/documents/${d.id}/file?t=${signLink(d.id,me.id)}`,expire_dans_secondes:LINK_TTL});
  }
  if((m=path.match(/^\/api\/documents\/([^/]+)\/file$/))&&method==='GET'){
    if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    if(!checkLink(query.get('t'),m[1],me.id))return json(403,{error:'Lien invalide ou expiré.'});
    const d=(await sql`SELECT * FROM documents WHERE id=${m[1]}`)[0];
    if(!d||!(await docOk(me,d)))return json(403,{error:'Accès refusé.'});
    const buf=await getBlob(d.blob_key);if(!buf)return json(404,{error:'Fichier introuvable.'});
    await logAcc(me.id,d.patient_id,'telechargement','document',d.id,ip);
    return new Response(buf,{status:200,headers:{'content-type':d.mime,'content-disposition':`attachment; filename="${d.filename.replace(/"/g,'')}"`,'x-content-type-options':'nosniff','cache-control':'no-store'}});
  }
  return null;
}
