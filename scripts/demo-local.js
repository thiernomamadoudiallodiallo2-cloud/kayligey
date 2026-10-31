// Démo LOCALE : site complet + base PostgreSQL embarquée (en mémoire) + comptes de test. Rien n'est conservé à l'arrêt.
// Usage : npm run demo   puis ouvrir http://localhost:8787
import http from 'node:http';import {readFileSync,existsSync} from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import {__setDriver} from '../netlify/functions/lib/db.js';
import {seedTest} from '../netlify/functions/lib/seed.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PORT=process.env.PORT||8787;
console.log('Préparation de la base de démonstration (10 à 30 secondes)…');
const pg=new PGlite();
__setDriver(async(st,...v)=>(await pg.query(st.reduce((a,s,i)=>a+(i?'$'+i:'')+s,''),v)).rows);
await pg.exec(readFileSync(path.join(root,'db/schema.sql'),'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
const r=await seedTest(async(t,p=[])=>(await pg.query(t,p)).rows,{allow:'oui-base-de-test',videoRdv:true});
const api=(await import('../netlify/functions/api.js')).default;
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.txt':'text/plain','.md':'text/plain'};
http.createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
    if(req.url.startsWith('/api/')){
      const h=new Headers();for(const[k,v]of Object.entries(req.headers))h.set(k,v);
      const rs=await api(new Request('http://localhost:'+PORT+req.url,{method:req.method,headers:h,body:['GET','HEAD'].includes(req.method)?undefined:body}));
      const hd={};rs.headers.forEach((v,k)=>{if(k!=='set-cookie')hd[k]=v;});
      const sc=(rs.headers.getSetCookie?.()||[]).map(c=>c.replace(/;\s*Secure/i,'')); // http://localhost : pas de HTTPS en démo
      if(sc.length)hd['set-cookie']=sc;
      res.writeHead(rs.status,hd);res.end(Buffer.from(await rs.arrayBuffer()));return;
    }
    let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';
    const f=path.join(root,'public',path.normalize(p));
    if(f.startsWith(path.join(root,'public'))&&existsSync(f)){res.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'});res.end(readFileSync(f));}
    else{res.writeHead(404,{'content-type':'text/plain'});res.end('Introuvable');}
  }catch(e){console.error(e);res.writeHead(500);res.end('Erreur');}
}).listen(PORT,()=>{
  console.log('\n=== Kayligey (démo locale) prêt : http://localhost:'+PORT+' ===');
  console.log('Mot de passe commun des comptes de test :',r.password);
  console.log('Téléphones : 700000001 admin | 700000002 patient 1 | 700000003 patient 2 | 700000004 médecin | 700000005 infirmier | 700000006 pharmacien');
  console.log('Arrêter : Ctrl + C\n');
});
