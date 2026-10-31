import './env.js';
// Premier administrateur : ADMIN_TEL et ADMIN_PASSWORD lus dans l'environnement, jamais dans le code.
import bcrypt from 'bcryptjs';import {neon} from '@neondatabase/serverless';
import {normalizePhone,passwordIssue} from '../netlify/functions/lib/util.js';
const tel=normalizePhone(process.env.ADMIN_TEL),pw=process.env.ADMIN_PASSWORD||'';
if(!process.env.DATABASE_URL||!tel||passwordIssue(pw)){console.error('DATABASE_URL, ADMIN_TEL valide et ADMIN_PASSWORD (10+ car., lettres+chiffres) requis.');process.exit(1);}
const sql=neon(process.env.DATABASE_URL);
await sql`INSERT INTO users(role,status,nom,tel,pwd_hash,consent_version,consent_at) VALUES('admin','active','Administrateur',${tel},${await bcrypt.hash(pw,12)},'2026-10',now()) ON CONFLICT(tel) DO NOTHING`;
console.log('Administrateur créé (ou déjà existant). Retirez ADMIN_PASSWORD de votre environnement.');
