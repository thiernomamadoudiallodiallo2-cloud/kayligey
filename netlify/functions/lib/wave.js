import crypto from 'node:crypto';
// Client Wave Business (docs.wave.com). Lit l'environnement à chaque appel ; aucune clé dans le code.
const BASE=()=>process.env.WAVE_BASE_URL||'https://api.wave.com';
export const waveEnabled=()=>!!process.env.WAVE_API_KEY&&!!process.env.WAVE_WEBHOOK_SECRET&&!!process.env.APP_ORIGIN;
async function call(method,path,bodyObj){
  const body=bodyObj?JSON.stringify(bodyObj):undefined;
  const headers={authorization:'Bearer '+process.env.WAVE_API_KEY,'content-type':'application/json'};
  if(process.env.WAVE_SIGNING_SECRET){ // signature des requêtes sortantes, si activée dans le portail Wave
    const t=Math.floor(Date.now()/1000);
    headers['wave-signature']=`t=${t},v1=${crypto.createHmac('sha256',process.env.WAVE_SIGNING_SECRET).update(t+(body||'')).digest('hex')}`;
  }
  const ctl=new AbortController(),to=setTimeout(()=>ctl.abort(),10000);
  try{
    const r=await fetch(BASE()+path,{method,headers,body,signal:ctl.signal});
    const text=await r.text();let data={};try{data=text?JSON.parse(text):{};}catch{}
    return {ok:r.ok,status:r.status,data};
  }catch(e){return {ok:false,status:0,data:{},error:e.message};}
  finally{clearTimeout(to);}
}
export const createSession=({amount,reference,successUrl,errorUrl})=>call('POST','/v1/checkout/sessions',{amount:String(amount),currency:'XOF',client_reference:reference,success_url:successUrl,error_url:errorUrl});
export const getSession=id=>call('GET','/v1/checkout/sessions/'+encodeURIComponent(id));
export const refundSession=id=>call('POST','/v1/checkout/sessions/'+encodeURIComponent(id)+'/refund',{});
// En-tête « Wave-Signature: t=<timestamp>,v1=<hmac> » ; HMAC-SHA256 de (timestamp + corps brut) avec le secret de webhook.
export function verifyWebhook(header,rawBody,secret,toleranceSec=300,now=Date.now()){
  if(!header||!secret)return false;
  const parts=Object.fromEntries(String(header).split(',').map(p=>{const i=p.indexOf('=');return [p.slice(0,i).trim(),p.slice(i+1).trim()];}));
  const t=parseInt(parts.t,10);if(!Number.isFinite(t)||Math.abs(now/1000-t)>toleranceSec)return false;
  const exp=crypto.createHmac('sha256',secret).update(parts.t+rawBody).digest('hex');
  const sigs=String(header).split(',').filter(p=>p.trim().startsWith('v1=')).map(p=>p.trim().slice(3));
  return sigs.some(s=>s.length===exp.length&&crypto.timingSafeEqual(Buffer.from(s),Buffer.from(exp)));
}
