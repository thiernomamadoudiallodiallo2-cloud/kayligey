import {sql,audit,rateLimited} from './db.js';
import {json,clean} from './util.js';
import {notifyUser} from './notify.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Lien de soin : même règle que le dossier (rendez-vous confirmé/terminé depuis moins d'un an)
const hasRel=async(d,p)=>(await sql`SELECT 1 FROM appointments a JOIN availability_slots s ON s.id=a.slot_id WHERE a.patient_id=${p} AND a.doctor_id=${d} AND a.status IN ('confirmed','completed') AND s.starts_at>now()-interval '365 days' LIMIT 1`).length>0;
const mine=async(id,me)=>(await sql`SELECT * FROM conversations WHERE id=${id} AND (patient_id=${me.id} OR doctor_id=${me.id})`)[0];

export async function msgRoutes({path,method,body,me,ip,query}){
  if(!me)return json(401,{error:'Non connecté.'});
  if(!['patient','medecin'].includes(me.role)||me.status!=='active')return json(403,{error:'Messagerie non disponible pour ce rôle.'}); // l'admin n'a aucun accès aux messages
  let m;const isP=me.role==='patient';
  if(path==='/api/conversations'&&method==='GET'){
    return json(200,{conversations:await sql`SELECT c.id,c.last_message_at,u.nom AS interlocuteur,
        (SELECT count(*)::int FROM messages x WHERE x.conversation_id=c.id AND x.sender_id<>${me.id} AND x.read_at IS NULL) AS non_lus
      FROM conversations c JOIN users u ON u.id=CASE WHEN c.patient_id=${me.id} THEN c.doctor_id ELSE c.patient_id END
      WHERE c.patient_id=${me.id} OR c.doctor_id=${me.id} ORDER BY c.last_message_at DESC NULLS LAST,c.created_at DESC LIMIT 100`});
  }
  if(path==='/api/conversations'&&method==='POST'){
    const other=String(body.withUserId||'');if(!UUID.test(other))return json(400,{error:'Interlocuteur invalide.'});
    const [p,d]=isP?[me.id,other]:[other,me.id];
    if(!(await hasRel(d,p)))return json(403,{error:'Vous pouvez écrire à un médecin après un rendez-vous avec lui.'});
    await sql`INSERT INTO conversations(patient_id,doctor_id) VALUES(${p},${d}) ON CONFLICT(patient_id,doctor_id) DO NOTHING`;
    return json(200,{id:(await sql`SELECT id FROM conversations WHERE patient_id=${p} AND doctor_id=${d}`)[0].id});
  }
  if((m=path.match(/^\/api\/conversations\/([^/]+)\/messages$/))){
    if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    const c=await mine(m[1],me);if(!c)return json(404,{error:'Conversation introuvable.'});
    const other=isP?c.doctor_id:c.patient_id;
    if(method==='GET'){
      const after=parseInt(query.get('after'),10)||0;
      // Accusé de lecture : les messages de l'autre partie sont marqués lus à l'ouverture
      await sql`UPDATE messages SET read_at=now() WHERE conversation_id=${c.id} AND sender_id<>${me.id} AND read_at IS NULL`;
      const rows=await sql`SELECT x.id,x.client_id,x.body,x.created_at,(x.sender_id=${me.id}) AS moi,(x.read_at IS NOT NULL) AS lu,x.document_id,d.filename AS piece_jointe
        FROM messages x LEFT JOIN documents d ON d.id=x.document_id WHERE x.conversation_id=${c.id} AND x.id>${after} ORDER BY x.id LIMIT 200`;
      return json(200,{messages:rows,peut_ecrire:await hasRel(c.doctor_id,c.patient_id)});
    }
    if(method==='POST'){
      if(await rateLimited('msg:'+me.id,60,3600))return json(429,{error:'Trop de messages. Réessayez plus tard.'});
      const text=clean(body.body,2000),cid=String(body.clientId||''),doc=body.documentId?String(body.documentId):null;
      if(!UUID.test(cid))return json(400,{error:'Identifiant d\u2019envoi manquant.'});
      if(!text&&!doc)return json(400,{error:'Message vide.'});
      if(doc&&!UUID.test(doc))return json(400,{error:'Pièce jointe invalide.'});
      if(!(await hasRel(c.doctor_id,c.patient_id)))return json(403,{error:'La prise en charge est terminée : vous ne pouvez plus envoyer de message.'});
      if(!isP&&!(await sql`SELECT 1 FROM doctors WHERE user_id=${me.id} AND verified_at IS NOT NULL`).length)return json(403,{error:'Profil non vérifié.'});
      const dup=(await sql`SELECT id FROM messages WHERE conversation_id=${c.id} AND client_id=${cid}`)[0];
      if(dup)return json(200,{id:dup.id,deja_recu:true}); // renvoi après coupure réseau : pas de doublon
      if(doc){ // pièce jointe : uniquement un document du dossier de ce patient que l'expéditeur a le droit d'utiliser
        const d=(await sql`SELECT id FROM documents WHERE id=${doc} AND patient_id=${c.patient_id} AND (uploader_id=${me.id} OR ${isP}::boolean)`)[0];
        if(!d)return json(403,{error:'Pièce jointe non autorisée.'});
        if(isP)await sql`INSERT INTO document_shares(document_id,doctor_id) VALUES(${doc},${c.doctor_id}) ON CONFLICT DO NOTHING`;
      }
      const r=await sql`INSERT INTO messages(conversation_id,sender_id,client_id,body,document_id) VALUES(${c.id},${me.id},${cid},${text},${doc}) ON CONFLICT(conversation_id,client_id) DO NOTHING RETURNING id`;
      await sql`UPDATE conversations SET last_message_at=now() WHERE id=${c.id}`;
      // Notification volontairement sans contenu (écran verrouillé) et limitée à 1 par tranche de 10 min
      await notifyUser(other,'message','Nouveau message','Vous avez reçu un nouveau message sur Kayligey.','/messages',`msg:${c.id}:${other}:${Math.floor(Date.now()/600000)}`);
      return json(201,{id:r[0]&&r[0].id});
    }
  }
  return null;
}
