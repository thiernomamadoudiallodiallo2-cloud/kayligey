import './env.js';
// Test de fumée après déploiement : SITE_URL=https://votre-site.netlify.app node scripts/smoke.js
const base=process.env.SITE_URL;if(!base){console.error('SITE_URL requis');process.exit(1);}
const H={'x-requested-with':'kayligey'};let bad=0;
const check=async(name,fn)=>{try{const r=await fn();console.log(r?'OK  ':'ÉCHEC',name);if(!r)bad++;}catch(e){console.log('ÉCHEC',name,e.message);bad++;}};
await check('page d\u2019accueil servie en HTTPS avec en-têtes de sécurité',async()=>{const r=await fetch(base);return r.ok&&base.startsWith('https://')&&r.headers.get('strict-transport-security')&&r.headers.get('x-content-type-options')==='nosniff'&&(r.headers.get('content-security-policy')||'').includes("frame-ancestors 'none'");});
await check('API : /api/auth/me refuse un visiteur (401)',async()=>(await fetch(base+'/api/auth/me')).status===401);
await check('API : écriture sans en-tête anti-CSRF refusée (403)',async()=>(await fetch(base+'/api/auth/login',{method:'POST',body:'{}'})).status===403);
await check('API : annuaire public accessible (200)',async()=>(await fetch(base+'/api/doctors')).status===200);
await check('API : accès admin refusé à un visiteur (401)',async()=>(await fetch(base+'/api/admin/pending')).status===401);
await check('API : webhook Wave refuse une signature absente (401)',async()=>(await fetch(base+'/api/webhooks/wave',{method:'POST',body:'{}'})).status===401);
await check('API : configuration paiement lisible',async()=>{const r=await fetch(base+'/api/payments/config');const j=await r.json();console.log('     paiement en ligne activé :',j.enabled);return r.ok;});
await check('vidéo : configuration lisible',async()=>{const r=await fetch(base+'/api/consultations/config');const j=await r.json();console.log('     vidéo activée :',j.enabled);return r.ok&&j.enregistrement===false;});
await check('SDK vidéo hébergé avec le site',async()=>{const r=await fetch(base+'/vendor/twilio-video-2.36.1.min.js');return r.ok&&(r.headers.get('content-type')||'').includes('javascript');});
await check('page 404 personnalisée',async()=>{const r=await fetch(base+'/page-qui-nexiste-pas');return r.status===404&&(await r.text()).includes('1515');});
await check('robots.txt interdit /api/',async()=>(await (await fetch(base+'/robots.txt')).text()).includes('Disallow: /api/'));
console.log(bad?`\n${bad} vérification(s) en échec`:'\nToutes les vérifications passent');process.exit(bad?1:0);
