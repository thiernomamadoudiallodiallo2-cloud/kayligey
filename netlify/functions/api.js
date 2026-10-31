import bcrypt from 'bcryptjs';
import {sql,audit,rateLimited} from './lib/db.js';
import {rdvRoutes} from './lib/rdv.js';
import {payRoutes,handleWaveWebhook} from './lib/payments.js';
import {notifRoutes} from './lib/notify.js';
import {recordRoutes} from './lib/record.js';
import {msgRoutes} from './lib/msg.js';
import {pedRoutes} from './lib/ped.js';
import {accountRoutes} from './lib/account.js';
import {careRoutes} from './lib/care.js';
import {pharmacyRoutes} from './lib/pharmacy.js';
import {videoRoutes} from './lib/video.js';
import {smsConfigured,sendSms} from './lib/channels.js';
import {sha256,newToken,resetCode,normalizePhone,validEmail,passwordIssue,clean,json,getIp,SESSION_HOURS,sessionCookie,readCookie} from './lib/util.js';

export const config={path:'/api/*'};
const CONSENT_VERSION='2026-10';
const SELF_ROLES=['patient','medecin','prestataire','pharmacien']; // l'admin ne s'auto-inscrit jamais
let DUMMY;const dummyHash=()=>DUMMY||(DUMMY=bcrypt.hashSync('dummy-password-1',12));

async function currentUser(req){
  const t=readCookie(req,'kay_session');if(!t)return null;
  const r=await sql`SELECT u.id,u.role,u.status,u.nom,u.tel,u.email FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=${sha256(t)} AND s.expires_at>now()`;
  return r[0]||null;
}
async function openSession(user,req){
  const t=newToken();
  await sql`INSERT INTO sessions(user_id,token_hash,expires_at,ip,ua) VALUES(${user.id},${sha256(t)},now()+make_interval(hours=>${SESSION_HOURS}),${getIp(req)},${clean(req.headers.get('user-agent'),200)})`;
  return sessionCookie(t,SESSION_HOURS*3600);
}
const pub=u=>({id:u.id,role:u.role,status:u.status,nom:u.nom,tel:u.tel,email:u.email});

export default async function handler(req){
  const path=new URL(req.url).pathname.replace(/\/+$/,''),method=req.method,ip=getIp(req);
  try{
    if(path==='/api/webhooks/wave'&&method==='POST')return await handleWaveWebhook(req);
    // CSRF : cookie SameSite=Strict + en-tête obligatoire + contrôle de l'origine
    if(method!=='GET'){
      const origin=req.headers.get('origin');
      if(req.headers.get('x-requested-with')!=='kayligey'||(process.env.APP_ORIGIN&&origin!==process.env.APP_ORIGIN))
        return json(403,{error:'Requête refusée.'});
    }
    const body=method==='POST'?await req.json().catch(()=>({})):{};

    if(path==='/api/auth/register'&&method==='POST'){
      if(await rateLimited('reg:'+ip,10,3600))return json(429,{error:'Trop de demandes. Réessayez plus tard.'});
      const nom=clean(body.nom),tel=normalizePhone(body.tel),email=body.email?clean(body.email,254).toLowerCase():null,role=body.role||'patient';
      if(nom.length<3)return json(400,{error:'Nom invalide.'});
      if(!tel)return json(400,{error:'Numéro de téléphone sénégalais invalide (ex. 77 123 45 67).'});
      if(email&&!validEmail(email))return json(400,{error:'Adresse e-mail invalide.'});
      if(!SELF_ROLES.includes(role))return json(400,{error:'Rôle non autorisé.'});
      if(body.consent!==true)return json(400,{error:'Vous devez accepter les conditions d\u2019utilisation.'});
      const pe=passwordIssue(body.password);if(pe)return json(400,{error:pe});
      const dup=await sql`SELECT 1 FROM users WHERE tel=${tel} OR (${email}::text IS NOT NULL AND email=${email})`;
      if(dup.length)return json(409,{error:'Un compte existe déjà avec ces coordonnées.'});
      const status=role==='patient'?'active':'pending'; // médecins/prestataires : validation admin requise
      const hash=await bcrypt.hash(body.password,12);
      const r=await sql`INSERT INTO users(role,status,nom,tel,email,pwd_hash,consent_version,consent_at)
        VALUES(${role},${status},${nom},${tel},${email},${hash},${CONSENT_VERSION},now()) RETURNING id,role,status,nom,tel,email`;
      await audit(r[0].id,'register',ip,{role});
      return json(201,{user:pub(r[0]),message:status==='pending'?'Compte créé. Il sera activé après vérification de vos justificatifs par un administrateur.':'Compte créé.'});
    }

    if(path==='/api/auth/login'&&method==='POST'){
      if(await rateLimited('login:'+ip,20,900))return json(429,{error:'Trop de tentatives. Réessayez dans quelques minutes.'});
      const ident=String(body.ident||''),tel=normalizePhone(ident),email=validEmail(ident)?ident.toLowerCase():null;
      const r=await sql`SELECT * FROM users WHERE (${tel}::text IS NOT NULL AND tel=${tel}) OR (${email}::text IS NOT NULL AND email=${email})`;
      const u=r[0];
      if(u&&u.locked_until&&new Date(u.locked_until)>new Date())return json(423,{error:'Compte temporairement verrouillé. Réessayez dans 15 minutes.'});
      const ok=await bcrypt.compare(String(body.password||''),u?u.pwd_hash:dummyHash())&&!!u; // même durée si compte inconnu
      if(!ok){
        if(u){
          if(u.failed_logins+1>=5)await sql`UPDATE users SET failed_logins=0,locked_until=now()+interval '15 minutes' WHERE id=${u.id}`;
          else await sql`UPDATE users SET failed_logins=failed_logins+1 WHERE id=${u.id}`;
        }
        await audit(u?.id||null,'login_failed',ip);
        return json(401,{error:'Identifiants incorrects.'});
      }
      if(u.status==='suspended')return json(403,{error:'Ce compte est suspendu. Contactez le support.'});
      if(u.status==='pending')return json(403,{error:'Votre compte est en attente de validation par un administrateur.'});
      await sql`UPDATE users SET failed_logins=0,locked_until=NULL WHERE id=${u.id}`;
      const cookie=await openSession(u,req);await audit(u.id,'login',ip);
      return json(200,{user:pub(u)},{'set-cookie':cookie});
    }

    if(path==='/api/auth/logout'&&method==='POST'){
      const t=readCookie(req,'kay_session');
      if(t)await sql`DELETE FROM sessions WHERE token_hash=${sha256(t)}`;
      return json(200,{ok:true},{'set-cookie':sessionCookie('',0)});
    }

    if(path==='/api/auth/me'&&method==='GET'){
      const u=await currentUser(req);return u?json(200,{user:pub(u)}):json(401,{error:'Non connecté.'});
    }

    if(path==='/api/auth/reset-request'&&method==='POST'){
      if(await rateLimited('rst:'+ip,5,3600))return json(429,{error:'Trop de demandes.'});
      const tel=normalizePhone(body.ident);
      const r=tel?await sql`SELECT id FROM users WHERE tel=${tel} AND status<>'suspended'`:[];
      if(r[0]){
        const c=resetCode();
        await sql`INSERT INTO reset_codes(user_id,code_hash,expires_at) VALUES(${r[0].id},${sha256(c)},now()+interval '15 minutes')`;
        let delivered=false;
        if(smsConfigured()){const sr=await sendSms('+221'+tel,`Kayligey : votre code de réinitialisation est ${c}. Valable 15 minutes. Ne le communiquez à personne.`);delivered=sr.ok;}
        await audit(r[0].id,delivered?'reset_sent':'reset_not_delivered',ip);
      }
      return json(200,{message:'Si un compte correspond, un code de réinitialisation lui sera envoyé.'});
    }

    if(path==='/api/auth/reset-confirm'&&method==='POST'){
      if(await rateLimited('rstc:'+ip,10,3600))return json(429,{error:'Trop de tentatives.'});
      const tel=normalizePhone(body.ident),pe=passwordIssue(body.password);if(pe)return json(400,{error:pe});
      const r=tel?await sql`SELECT rc.id,rc.user_id,rc.code_hash,rc.attempts FROM reset_codes rc JOIN users u ON u.id=rc.user_id
        WHERE u.tel=${tel} AND rc.used_at IS NULL AND rc.expires_at>now() ORDER BY rc.created_at DESC LIMIT 1`:[];
      const rc=r[0];
      if(!rc||rc.attempts>=5||rc.code_hash!==sha256(String(body.code||''))){
        if(rc)await sql`UPDATE reset_codes SET attempts=attempts+1 WHERE id=${rc.id}`;
        return json(400,{error:'Code invalide ou expiré.'});
      }
      const hash=await bcrypt.hash(body.password,12);
      await sql`UPDATE users SET pwd_hash=${hash},failed_logins=0,locked_until=NULL WHERE id=${rc.user_id}`;
      await sql`UPDATE reset_codes SET used_at=now() WHERE id=${rc.id}`;
      await sql`DELETE FROM sessions WHERE user_id=${rc.user_id}`;
      await audit(rc.user_id,'password_reset',ip);
      return json(200,{ok:true});
    }

    if(path==='/api/auth/change-password'&&method==='POST'){
      const me=await currentUser(req);if(!me)return json(401,{error:'Non connecté.'});
      if(await rateLimited('chpw:'+me.id,5,900))return json(429,{error:'Trop de tentatives. Réessayez dans quelques minutes.'});
      const pe=passwordIssue(body.password);if(pe)return json(400,{error:pe});
      const row=(await sql`SELECT pwd_hash FROM users WHERE id=${me.id}`)[0];
      if(!row||!(await bcrypt.compare(String(body.current||''),row.pwd_hash)))return json(400,{error:'Mot de passe actuel incorrect.'});
      if(body.current===body.password)return json(400,{error:'Le nouveau mot de passe doit être différent de l\u2019ancien.'});
      const hash=await bcrypt.hash(body.password,12);
      await sql`UPDATE users SET pwd_hash=${hash},failed_logins=0,locked_until=NULL WHERE id=${me.id}`;
      await sql`DELETE FROM sessions WHERE user_id=${me.id} AND token_hash<>${sha256(readCookie(req,'kay_session'))}`; // les autres appareils sont déconnectés
      await audit(me.id,'password_changed',ip);
      return json(200,{ok:true});
    }

    if(path.startsWith('/api/consultations/')){
      const vr=await videoRoutes({path,method,body,me:await currentUser(req),ip});
      if(vr)return vr;
    }
    if(path.startsWith('/api/pharmacy/')||path.startsWith('/api/admin/pharmacies')||path.startsWith('/api/admin/drugs')){
      const ph=await pharmacyRoutes({path,method,body,me:await currentUser(req),ip,query:new URL(req.url).searchParams});
      if(ph)return ph;
    }
    if(/^\/api\/(care|provider|missions)(\/|$)/.test(path)||path.startsWith('/api/admin/providers')||path.startsWith('/api/admin/disputes')){
      const cr=await careRoutes({path,method,body,me:await currentUser(req),ip,query:new URL(req.url).searchParams});
      if(cr)return cr;
    }
    if(path.startsWith('/api/account/')||path.startsWith('/api/admin/deletion-requests')){
      const ac=await accountRoutes({path,method,body,me:await currentUser(req),ip});
      if(ac)return ac;
    }
    if(path.startsWith('/api/dependents')||path==='/api/doctor/children'){
      const pd=await pedRoutes({path,method,body,me:await currentUser(req),ip});
      if(pd)return pd;
    }
    if(path.startsWith('/api/conversations')){
      const mr=await msgRoutes({path,method,body,me:await currentUser(req),ip,query:new URL(req.url).searchParams});
      if(mr)return mr;
    }
    if(/^\/api\/(record|patients|entries|prescriptions|documents)(\/|$)/.test(path)||path==='/api/doctor/patients'){
      const rr2=await recordRoutes({req,path,method,body,me:await currentUser(req),ip,query:new URL(req.url).searchParams});
      if(rr2)return rr2;
    }
    if(path.startsWith('/api/notifications')||path.startsWith('/api/admin/notifications')){
      const nr=await notifRoutes({path,method,body,me:await currentUser(req),ip});
      if(nr)return nr;
    }
    if(/^\/api\/(payments|doctor\/revenue)/.test(path)||path==='/api/admin/reconciliation'||path.startsWith('/api/admin/payments')){
      const pr=await payRoutes({path,method,body,me:await currentUser(req),ip});
      if(pr)return pr;
    }
    if(/^\/api\/(doctors|doctor|appointments)(\/|$)/.test(path)||path.startsWith('/api/admin/doctors/')){
      const rr=await rdvRoutes({path,method,body,me:await currentUser(req),ip,query:new URL(req.url).searchParams});
      if(rr)return rr;
    }
    if(path.startsWith('/api/admin/')){ // permissions vérifiées côté serveur
      const me=await currentUser(req);
      if(!me)return json(401,{error:'Non connecté.'});
      if(me.role!=='admin'||me.status!=='active'){await audit(me.id,'forbidden_admin',ip,{path});return json(403,{error:'Accès refusé.'});}
      if(path==='/api/admin/pending'&&method==='GET')
        return json(200,{users:await sql`SELECT id,role,nom,tel,email,created_at FROM users WHERE status='pending' ORDER BY created_at`});
      const m=path.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/status$/);
      if(m&&method==='POST'){
        if(!['active','suspended'].includes(body.status))return json(400,{error:'Statut invalide.'});
        if(m[1]===me.id)return json(400,{error:'Vous ne pouvez pas modifier votre propre statut.'});
        const r=await sql`UPDATE users SET status=${body.status} WHERE id=${m[1]} RETURNING id`;
        if(!r.length)return json(404,{error:'Utilisateur introuvable.'});
        if(body.status==='suspended')await sql`DELETE FROM sessions WHERE user_id=${m[1]}`;
        await audit(me.id,'admin_set_status',ip,{target:m[1],status:body.status,motif:clean(body.motif,300)});
        return json(200,{ok:true});
      }
    }
    return json(404,{error:'Route inconnue.'});
  }catch(e){
    console.error('api error',e.message);
    return json(500,{error:'Erreur interne. Réessayez plus tard.'});
  }
}
