// Canaux d'envoi réels. Chaque canal n'est actif que si ses variables d'environnement existent.
export const emailConfigured=()=>!!process.env.RESEND_API_KEY&&!!process.env.MAIL_FROM;
export const smsConfigured=()=>!!process.env.TWILIO_ACCOUNT_SID&&!!process.env.TWILIO_AUTH_TOKEN&&!!process.env.TWILIO_FROM;
async function http(url,opts){
  const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),10000);
  try{const r=await fetch(url,{...opts,signal:ctl.signal});return {ok:r.ok,status:r.status};}
  catch(e){return {ok:false,status:0,error:e.message};}finally{clearTimeout(t);}
}
// Resend : POST https://api.resend.com/emails (Bearer, JSON from/to/subject/text)
export const sendEmail=(to,subject,text)=>http('https://api.resend.com/emails',{method:'POST',
  headers:{authorization:'Bearer '+process.env.RESEND_API_KEY,'content-type':'application/json'},
  body:JSON.stringify({from:process.env.MAIL_FROM,to:[to],subject,text})});
// Twilio : POST /2010-04-01/Accounts/{sid}/Messages.json (Basic, formulaire To/From/Body)
export const sendSms=(to,body)=>http(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(process.env.TWILIO_ACCOUNT_SID)}/Messages.json`,{method:'POST',
  headers:{authorization:'Basic '+Buffer.from(process.env.TWILIO_ACCOUNT_SID+':'+process.env.TWILIO_AUTH_TOKEN).toString('base64'),'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({To:to,From:process.env.TWILIO_FROM,Body:body}).toString()});
