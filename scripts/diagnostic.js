import './env.js';
import {makeQ} from './neon-q.js';
// Diagnostic à partager (aucune donnée personnelle) :  DATABASE_URL=... node scripts/diagnostic.js > diagnostic.json
import {neon} from '@neondatabase/serverless';import {diagnostic} from '../netlify/functions/lib/diagnostic.js';
if(!process.env.DATABASE_URL){console.error('DATABASE_URL manquante');process.exit(1);}
const sql=neon(process.env.DATABASE_URL);console.log(JSON.stringify(await diagnostic(makeQ(sql)),null,2));
