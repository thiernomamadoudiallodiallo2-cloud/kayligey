import './env.js';
import {makeQ} from './neon-q.js';
// BASE DE TEST UNIQUEMENT :  KAY_ALLOW_SEED=oui-base-de-test DATABASE_URL=<base de TEST> node scripts/seed-test.js [--video]
import {neon} from '@neondatabase/serverless';import {seedTest} from '../netlify/functions/lib/seed.js';
if(!process.env.DATABASE_URL){console.error('DATABASE_URL manquante');process.exit(1);}
const sql=neon(process.env.DATABASE_URL);
try{
  const r=await seedTest(makeQ(sql),{videoRdv:process.argv.includes('--video')});
  console.log('Comptes de TEST (téléphone / rôle) :');r.telephones.forEach(u=>console.log('  ',u.tel,u.role.padEnd(12),u.nom));
  console.log(r.password?`\nMot de passe commun, affiché UNE SEULE FOIS : ${r.password}`:'\nComptes déjà existants : mot de passe inchangé.');
  if(r.video_rdv)console.log('\nRendez-vous vidéo de test créé (commence dans 5 min) :',r.video_rdv);
}catch(e){console.error(e.message);process.exit(1);}
