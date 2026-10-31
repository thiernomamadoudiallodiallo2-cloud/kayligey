import './env.js';
import {makeQ} from './neon-q.js';
import {readFileSync} from 'node:fs';import {neon} from '@neondatabase/serverless';
if(!process.env.DATABASE_URL){console.error('DATABASE_URL manquante');process.exit(1);}
const sql=neon(process.env.DATABASE_URL);
const stmts=readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8').split(/;\s*\n/).map(s=>s.trim()).filter(Boolean);
const q=makeQ(sql);for(const s of stmts)await q(s);console.log('Schéma appliqué ('+stmts.length+' instructions).');
