import {sql,audit} from './db.js';
import {json,clean} from './util.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
// Lien de soin pour un enfant : rendez-vous confirmé/terminé POUR CET ENFANT depuis moins d'un an
export const hasRelDep=async(d,dep)=>(await sql`SELECT 1 FROM appointments a JOIN availability_slots s ON s.id=a.slot_id WHERE a.dependent_id=${dep} AND a.doctor_id=${d} AND a.status IN ('confirmed','completed') AND s.starts_at>now()-interval '365 days' LIMIT 1`).length>0;
const hasGrantDep=async(d,dep)=>(await sql`SELECT 1 FROM dependent_access WHERE dependent_id=${dep} AND doctor_id=${d} AND revoked_at IS NULL AND expires_at>now() LIMIT 1`).length>0;
const logAcc=(actor,guardian,action,dep,ip)=>sql`INSERT INTO record_access_log(actor_id,patient_id,action,object_type,object_id,ip) VALUES(${actor},${guardian},${action},'enfant',${dep},${ip})`;
const num=(v,lo,hi)=>{if(v===undefined||v===null||v==='')return null;const n=Number(v);return Number.isFinite(n)&&n>=lo&&n<=hi?n:NaN;};
const dstr=v=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
const today=()=>new Date().toISOString().slice(0,10);
const ageMois=d=>{const b=new Date(d),n=new Date();return (n.getFullYear()-b.getFullYear())*12+n.getMonth()-b.getMonth()-(n.getDate()<b.getDate()?1:0);};

export async function pedRoutes({path,method,body,me,ip}){
  if(!me)return json(401,{error:'Non connecté.'});
  if(!['patient','medecin'].includes(me.role)||me.status!=='active')return json(403,{error:'Accès refusé.'});
  const isP=me.role==='patient';let m;
  if(path==='/api/dependents'&&method==='GET'){
    if(!isP)return json(403,{error:'Accès refusé.'});
    const l=await sql`SELECT id,nom,date_naissance,sexe FROM dependents WHERE guardian_id=${me.id} AND archived_at IS NULL ORDER BY created_at`;
    return json(200,{dependents:l.map(d=>({...d,age_mois:ageMois(d.date_naissance)}))});
  }
  if(path==='/api/dependents'&&method==='POST'){
    if(!isP)return json(403,{error:'Accès refusé.'});
    const nom=clean(body.nom,80),dn=String(body.date_naissance||''),sexe=['F','M'].includes(body.sexe)?body.sexe:null;
    if(nom.length<2)return json(400,{error:'Nom invalide.'});
    if(!DATE.test(dn)||isNaN(new Date(dn))||dn>today()||dn<'1900-01-01')return json(400,{error:'Date de naissance invalide.'});
    if(body.responsable_legal!==true)return json(400,{error:'Vous devez confirmer être le parent ou le représentant légal de cette personne.'});
    if((await sql`SELECT count(*)::int n FROM dependents WHERE guardian_id=${me.id} AND archived_at IS NULL`)[0].n>=10)return json(409,{error:'Nombre maximum de personnes à charge atteint.'});
    const r=await sql`INSERT INTO dependents(guardian_id,nom,date_naissance,sexe) VALUES(${me.id},${nom},${dn},${sexe}) RETURNING id`;
    await audit(me.id,'dependent_added',ip,{dependent:r[0].id});return json(201,{id:r[0].id});
  }
  if(path==='/api/doctor/children'&&method==='GET'){
    if(isP)return json(403,{error:'Accès refusé.'});
    return json(200,{enfants:await sql`SELECT d.id,d.nom,d.date_naissance,max(s.starts_at) AS dernier_rdv,
        EXISTS(SELECT 1 FROM dependent_access x WHERE x.dependent_id=d.id AND x.doctor_id=${me.id} AND x.revoked_at IS NULL AND x.expires_at>now()) AS acces_accorde
      FROM appointments a JOIN availability_slots s ON s.id=a.slot_id JOIN dependents d ON d.id=a.dependent_id
      WHERE a.doctor_id=${me.id} AND a.status IN ('confirmed','completed') AND s.starts_at>now()-interval '365 days' AND d.archived_at IS NULL GROUP BY d.id,d.nom,d.date_naissance ORDER BY dernier_rdv DESC`});
  }
  if(!(m=path.match(/^\/api\/dependents\/([^/]+)(\/.*)?$/)))return null;
  if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
  const dep=(await sql`SELECT * FROM dependents WHERE id=${m[1]} AND archived_at IS NULL`)[0];
  const sub=m[2]||'';
  const guardian=!!dep&&isP&&dep.guardian_id===me.id;
  // Un parent ne peut accéder qu'à SES personnes à charge ; un médecin que s'il a un lien de soin pour CET enfant
  const docRel=!!dep&&!isP&&await hasRelDep(me.id,dep.id);
  if(!dep||(!guardian&&!docRel)){if(me)await audit(me.id,'dependent_denied',ip,{path});return json(404,{error:'Personne introuvable.'});}

  if(sub===''&&method==='GET'||sub==='/record'&&method==='GET'){
    if(!guardian&&!(await hasGrantDep(me.id,dep.id)))return json(403,{error:'Le parent n\u2019a pas partagé le carnet de cet enfant avec vous.'});
    if(!guardian)await logAcc(me.id,dep.guardian_id,'lecture_carnet_enfant',dep.id,ip);
    const g=await sql`SELECT id,measured_on,poids_kg,taille_cm,pc_cm,recorded_role,voided_at FROM ped_growth WHERE dependent_id=${dep.id} ORDER BY measured_on DESC,created_at DESC LIMIT 300`;
    const v=await sql`SELECT id,vaccine,dose,given_on,lot,administered_by,next_due,recorded_role,voided_at FROM ped_vaccines WHERE dependent_id=${dep.id} ORDER BY given_on DESC,created_at DESC LIMIT 300`;
    const rx=await sql`SELECT p.id,p.number,p.status,p.items,p.notes,p.poids_kg,p.signed_at,u.nom AS medecin FROM prescriptions p JOIN users u ON u.id=p.doctor_id WHERE p.dependent_id=${dep.id} AND p.status IN ('signee','annulee','delivree') ORDER BY p.created_at DESC LIMIT 50`;
    return json(200,{enfant:{id:dep.id,nom:dep.nom,date_naissance:dep.date_naissance,sexe:dep.sexe,age_mois:ageMois(dep.date_naissance)},croissance:g,vaccinations:v,ordonnances:rx,
      avertissement:'Aucune courbe de référence ni calcul automatique n\u2019est fourni : l\u2019interprétation des mesures relève d\u2019un professionnel de santé.'});
  }
  if(sub==='/growth'&&method==='POST'){
    const on=String(body.measured_on||today());
    const p=num(body.poids_kg,0.3,150),t=num(body.taille_cm,20,200),c=num(body.pc_cm,20,70);
    if([p,t,c].some(Number.isNaN))return json(400,{error:'Valeur hors limites plausibles (poids 0,3–150 kg, taille 20–200 cm, périmètre crânien 20–70 cm).'});
    if(p===null&&t===null&&c===null)return json(400,{error:'Indiquez au moins une mesure.'});
    if(!DATE.test(on)||on>today())return json(400,{error:'Date de mesure invalide.'});
    if(on<dstr(dep.date_naissance))return json(400,{error:'La mesure ne peut pas précéder la naissance.'});
    const r=await sql`INSERT INTO ped_growth(dependent_id,measured_on,poids_kg,taille_cm,pc_cm,recorded_by,recorded_role) VALUES(${dep.id},${on},${p},${t},${c},${me.id},${me.role}) RETURNING id`;
    return json(201,{id:r[0].id});
  }
  if(sub==='/vaccines'&&method==='POST'){
    const vac=clean(body.vaccine,80),given=String(body.given_on||''),nd=body.next_due?String(body.next_due):null;
    if(vac.length<2)return json(400,{error:'Nom du vaccin obligatoire.'});
    if(!DATE.test(given)||given>today()||given<dstr(dep.date_naissance))return json(400,{error:'Date de vaccination invalide.'});
    if(nd&&(!DATE.test(nd)||nd<=given))return json(400,{error:'La prochaine dose doit être postérieure à la vaccination.'});
    const r=await sql`INSERT INTO ped_vaccines(dependent_id,vaccine,dose,given_on,lot,administered_by,next_due,recorded_by,recorded_role) VALUES(${dep.id},${vac},${clean(body.dose,40)||null},${given},${clean(body.lot,40)||null},${clean(body.administered_by,120)||null},${nd},${me.id},${me.role}) RETURNING id`;
    return json(201,{id:r[0].id});
  }
  if((m=sub.match(/^\/(growth|vaccines)\/([^/]+)\/void$/))&&method==='POST'){
    if(!UUID.test(m[2]))return json(400,{error:'Identifiant invalide.'});const reason=clean(body.reason,200);if(reason.length<3)return json(400,{error:'Indiquez le motif.'});
    const row=m[1]==='growth'?(await sql`SELECT recorded_by,voided_at FROM ped_growth WHERE id=${m[2]} AND dependent_id=${dep.id}`)[0]:(await sql`SELECT recorded_by,voided_at FROM ped_vaccines WHERE id=${m[2]} AND dependent_id=${dep.id}`)[0];
    if(!row)return json(404,{error:'Entrée introuvable.'});if(row.voided_at)return json(409,{error:'Déjà annulée.'});
    if(!guardian&&row.recorded_by!==me.id)return json(403,{error:'Seul l\u2019auteur ou le parent peut annuler une entrée.'});
    if(m[1]==='growth')await sql`UPDATE ped_growth SET voided_at=now(),void_reason=${reason} WHERE id=${m[2]}`;else await sql`UPDATE ped_vaccines SET voided_at=now(),void_reason=${reason} WHERE id=${m[2]}`;
    await audit(me.id,'ped_entry_voided',ip,{entry:m[2]});return json(200,{ok:true});
  }
  if(!guardian)return json(403,{error:'Réservé au parent.'});
  if(sub==='/access'&&method==='GET'){
    return json(200,{autorisations:await sql`SELECT a.doctor_id,u.nom,a.granted_at,a.expires_at FROM dependent_access a JOIN users u ON u.id=a.doctor_id WHERE a.dependent_id=${dep.id} AND a.revoked_at IS NULL AND a.expires_at>now()`,
      medecins_possibles:await sql`SELECT DISTINCT u.id,u.nom FROM appointments a JOIN availability_slots s ON s.id=a.slot_id JOIN users u ON u.id=a.doctor_id WHERE a.dependent_id=${dep.id} AND a.status IN ('confirmed','completed') AND s.starts_at>now()-interval '365 days'`});
  }
  if(sub==='/access'&&method==='POST'){
    if(!UUID.test(String(body.doctorId||'')))return json(400,{error:'Médecin invalide.'});
    if(!(await hasRelDep(body.doctorId,dep.id)))return json(409,{error:'Ce médecin n\u2019a pas de rendez-vous pour cet enfant : partage impossible.'});
    const days=Math.min(365,Math.max(1,parseInt(body.days,10)||90));
    await sql`UPDATE dependent_access SET revoked_at=now() WHERE dependent_id=${dep.id} AND doctor_id=${body.doctorId} AND revoked_at IS NULL`;
    await sql`INSERT INTO dependent_access(dependent_id,doctor_id,expires_at) VALUES(${dep.id},${body.doctorId},now()+make_interval(days=>${days}))`;
    await logAcc(me.id,me.id,'partage_enfant_accorde',dep.id,ip);return json(200,{ok:true});
  }
  if((m=sub.match(/^\/access\/([^/]+)\/revoke$/))&&method==='POST'){
    if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    await sql`UPDATE dependent_access SET revoked_at=now() WHERE dependent_id=${dep.id} AND doctor_id=${m[1]} AND revoked_at IS NULL`;
    await logAcc(me.id,me.id,'partage_enfant_retire',dep.id,ip);return json(200,{ok:true});
  }
  if(sub==='/archive'&&method==='POST'){await sql`UPDATE dependents SET archived_at=now() WHERE id=${dep.id}`;await audit(me.id,'dependent_archived',ip,{dependent:dep.id});return json(200,{ok:true});}
  if(sub==='/export'&&method==='GET'){
    await logAcc(me.id,me.id,'export_carnet_enfant',dep.id,ip);
    const data={exporte_le:new Date().toISOString(),enfant:{nom:dep.nom,date_naissance:dep.date_naissance,sexe:dep.sexe},
      croissance:await sql`SELECT measured_on,poids_kg,taille_cm,pc_cm,recorded_role,voided_at,void_reason FROM ped_growth WHERE dependent_id=${dep.id} ORDER BY measured_on`,
      vaccinations:await sql`SELECT vaccine,dose,given_on,lot,administered_by,next_due,recorded_role,voided_at,void_reason FROM ped_vaccines WHERE dependent_id=${dep.id} ORDER BY given_on`,
      ordonnances:await sql`SELECT number,status,items,notes,poids_kg,signed_at FROM prescriptions WHERE dependent_id=${dep.id} AND status IN ('signee','annulee') ORDER BY created_at`};
    return new Response(JSON.stringify(data,null,2),{status:200,headers:{'content-type':'application/json; charset=utf-8','content-disposition':'attachment; filename="carnet-de-sante.json"','cache-control':'no-store'}});
  }
  return null;
}
