import './env.js';
import {makeQ} from './neon-q.js';
// Usage : DATABASE_URL=... BACKUP_KEY=... node scripts/backup.js [fichier.kbk]
import {writeFileSync} from 'node:fs';import {neon} from '@neondatabase/serverless';
import {exportAll,encrypt} from '../netlify/functions/lib/backup.js';
if(!process.env.DATABASE_URL||!process.env.BACKUP_KEY){console.error('DATABASE_URL et BACKUP_KEY requis.');process.exit(1);}
const sql=neon(process.env.DATABASE_URL),out=process.argv[2]||`kayligey-${new Date().toISOString().slice(0,10)}.kbk`;
const data=await exportAll(makeQ(sql));
writeFileSync(out,encrypt(data,process.env.BACKUP_KEY),{mode:0o600});
console.log('Sauvegarde chiffrée écrite :',out,Object.fromEntries(Object.entries(data.tables).map(([k,v])=>[k,v.length])));
