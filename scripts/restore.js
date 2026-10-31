import './env.js';
import {makeQ} from './neon-q.js';
// Usage : DATABASE_URL=<base NEUVE migrée> BACKUP_KEY=... node scripts/restore.js fichier.kbk
import {readFileSync} from 'node:fs';import {neon} from '@neondatabase/serverless';
import {decrypt,restoreAll} from '../netlify/functions/lib/backup.js';
if(!process.env.DATABASE_URL||!process.env.BACKUP_KEY||!process.argv[2]){console.error('DATABASE_URL, BACKUP_KEY et le fichier .kbk sont requis.');process.exit(1);}
const sql=neon(process.env.DATABASE_URL);
const counts=await restoreAll(makeQ(sql),decrypt(readFileSync(process.argv[2]),process.env.BACKUP_KEY));
console.log('Restauration terminée :',counts);
