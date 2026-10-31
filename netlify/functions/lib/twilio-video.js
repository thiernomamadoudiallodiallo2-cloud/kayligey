import crypto from 'node:crypto';
// Prestataire vidéo : Twilio Programmable Video. Aucune clé dans le code ; tout vient de l'environnement.
// Isolé dans ce fichier pour pouvoir changer de prestataire sans toucher aux règles d'accès (video.js).
export const videoEnabled=()=>!!process.env.TWILIO_ACCOUNT_SID&&!!process.env.TWILIO_API_KEY_SID&&!!process.env.TWILIO_API_KEY_SECRET;
const b64=o=>Buffer.from(typeof o==='string'?o:JSON.stringify(o)).toString('base64url');
// Jeton d'accès (JWT HS256, format documenté par Twilio) limité à UNE salle et UNE identité
export function accessToken({identity,room,ttlSec,now=Date.now()}){
  const iat=Math.floor(now/1000),exp=iat+ttlSec,head=b64({alg:'HS256',typ:'JWT',cty:'twilio-fpa;v=1'});
  const body=b64({jti:`${process.env.TWILIO_API_KEY_SID}-${iat}`,iss:process.env.TWILIO_API_KEY_SID,sub:process.env.TWILIO_ACCOUNT_SID,iat,exp,grants:{identity,video:{room}}});
  const sig=crypto.createHmac('sha256',process.env.TWILIO_API_KEY_SECRET).update(head+'.'+body).digest('base64url');
  return `${head}.${body}.${sig}`;
}
async function rest(method,path,form){
  const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),10000);
  try{
    const r=await fetch('https://video.twilio.com/v1'+path,{method,signal:ctl.signal,headers:{authorization:'Basic '+Buffer.from(process.env.TWILIO_API_KEY_SID+':'+process.env.TWILIO_API_KEY_SECRET).toString('base64'),'content-type':'application/x-www-form-urlencoded'},body:form?new URLSearchParams(form).toString():undefined});
    let data={};try{data=JSON.parse(await r.text()||'{}');}catch{}return {ok:r.ok,status:r.status,data};
  }catch(e){return {ok:false,status:0,data:{},error:e.message};}finally{clearTimeout(t);}
}
// Salle limitée à 2 participants, sans enregistrement. « Salle déjà existante » (code 53113) n'est pas une erreur.
export async function createRoom(uniqueName){
  const r=await rest('POST','/Rooms',{UniqueName:uniqueName,Type:process.env.TWILIO_VIDEO_ROOM_TYPE||'group',MaxParticipants:'2',RecordParticipantsOnConnect:'false'});
  if(r.ok)return {ok:true,sid:r.data.sid};
  if(r.data&&Number(r.data.code)===53113)return {ok:true,sid:null};
  return {ok:false,status:r.status};
}
export const completeRoom=async(nameOrSid)=>rest('POST','/Rooms/'+encodeURIComponent(nameOrSid),{Status:'completed'});
