import {sql,audit} from './db.js';
import {json,clean,newToken} from './util.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Droit à l'effacement : la demande est enregistrée et traitée par un administrateur. Les données médicales et les écritures
// de paiement sont CONSERVÉES (obligations légales de conservation à faire valider) ; l'identité du compte est anonymisée.
export async function accountRoutes({path,method,body,me,ip}){
  if(!me)return json(401,{error:'Non connecté.'});
  let m;
  if(path==='/api/account/delete-request'&&method==='POST'){
    if(me.role==='admin')return json(403,{error:'Un compte administrateur ne peut pas être supprimé par cette voie.'});
    const r=await sql`INSERT INTO deletion_requests(user_id) VALUES(${me.id}) ON CONFLICT DO NOTHING RETURNING id`;
    if(!r.length)return json(409,{error:'Une demande est déjà en cours de traitement.'});
    await audit(me.id,'deletion_requested',ip);return json(201,{ok:true,message:'Demande enregistrée. Un administrateur la traitera ; certaines données doivent être conservées par obligation légale.'});
  }
  if(path.startsWith('/api/admin/deletion-requests')){
    if(me.role!=='admin'||me.status!=='active'){await audit(me.id,'forbidden_admin',ip,{path});return json(403,{error:'Accès refusé.'});}
    if(path==='/api/admin/deletion-requests'&&method==='GET')
      return json(200,{demandes:await sql`SELECT d.id,d.status,d.requested_at,u.role,u.nom FROM deletion_requests d JOIN users u ON u.id=d.user_id ORDER BY d.requested_at DESC LIMIT 100`});
    if((m=path.match(/^\/api\/admin\/deletion-requests\/([^/]+)\/resolve$/))&&method==='POST'){
      if(!UUID.test(m[1])||!['done','refused'].includes(body.decision))return json(400,{error:'Requête invalide.'});
      const note=clean(body.note,300);if(note.length<3)return json(400,{error:'Indiquez le motif ou la base légale de la décision.'});
      const d=(await sql`UPDATE deletion_requests SET status=${body.decision},note=${note},handled_by=${me.id},handled_at=now() WHERE id=${m[1]} AND status='pending' RETURNING user_id`)[0];
      if(!d)return json(404,{error:'Demande introuvable ou déjà traitée.'});
      if(body.decision==='done'){
        await sql`UPDATE users SET nom='Compte supprimé',email=NULL,tel='x'||substr(replace(id::text,'-',''),1,12),status='suspended',pwd_hash=${newToken()} WHERE id=${d.user_id}`;
        await sql`DELETE FROM sessions WHERE user_id=${d.user_id}`;
        await sql`DELETE FROM notifications WHERE user_id=${d.user_id}`;
      }
      await audit(me.id,'deletion_'+body.decision,ip,{target:d.user_id});return json(200,{ok:true});
    }
  }
  return null;
}
