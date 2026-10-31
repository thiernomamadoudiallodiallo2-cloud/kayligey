import crypto from 'node:crypto';import zlib from 'node:zlib';
// Sauvegarde logique chiffrée (AES-256-GCM). Ne contient PAS les sessions, codes de réinitialisation ni limiteurs.
// Les fichiers (Netlify Blobs) ne sont PAS inclus : voir DEPLOIEMENT.md.
export const TABLES=['users','doctors','dependents','availability_slots','appointments','consultation_rooms','consultation_events','prescriptions','provider_profiles','care_requests','care_quotes','missions','care_reviews','care_disputes','pharmacies','drugs','pharmacy_stock','pharmacy_orders','pharmacy_order_items','payments','ledger_entries','receipts','webhook_events','notification_prefs','notifications','outbox','record_access','record_entries','entry_versions','documents','document_shares','record_access_log','conversations','messages','dependent_access','ped_growth','ped_vaccines','deletion_requests','audit_log'];
const SERIAL=['consultation_events','audit_log','ledger_entries','outbox','notifications','record_access','entry_versions','record_access_log','messages','dependent_access'];
const ORDER={record_entries:' ORDER BY created_at,id',notifications:' ORDER BY id',messages:' ORDER BY id'};
export async function exportAll(q){
  const tables={};
  for(const t of TABLES)tables[t]=(await q(`SELECT to_jsonb(t) AS r FROM ${t} t${ORDER[t]||''}`,[])).map(x=>x.r);
  return {format:'kayligey-backup-1',created_at:new Date().toISOString(),tables};
}
const key=(pass,salt)=>crypto.scryptSync(pass,salt,32);
export function encrypt(obj,pass){
  if(!pass||pass.length<16)throw new Error('BACKUP_KEY trop courte (16 caractères minimum).');
  const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key(pass,salt),iv);
  const body=Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(obj)))),c.final()]);
  return Buffer.concat([Buffer.from('KAYBK1'),salt,iv,c.getAuthTag(),body]);
}
export function decrypt(buf,pass){
  if(buf.slice(0,6).toString()!=='KAYBK1')throw new Error('Fichier de sauvegarde invalide.');
  const salt=buf.slice(6,22),iv=buf.slice(22,34),tag=buf.slice(34,50),d=crypto.createDecipheriv('aes-256-gcm',key(pass,salt),iv);d.setAuthTag(tag);
  try{return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(buf.slice(50)),d.final()])).toString());}
  catch{throw new Error('Déchiffrement impossible : clé incorrecte ou fichier altéré.');}
}
export async function restoreAll(q,data,{force=false}={}){
  if(data.format!=='kayligey-backup-1')throw new Error('Format inconnu.');
  if(!force&&(await q('SELECT count(*)::int AS n FROM users',[]))[0].n>0)throw new Error('La base cible n\u2019est pas vide : restauration refusée (utilisez une base neuve).');
  const counts={};
  for(const t of TABLES){
    for(const row of data.tables[t]||[])await q(`INSERT INTO ${t} SELECT * FROM jsonb_populate_record(null::${t},$1::jsonb)`,[JSON.stringify(row)]);
    counts[t]=(data.tables[t]||[]).length;
  }
  for(const t of SERIAL)await q(`SELECT setval(pg_get_serial_sequence('${t}','id'),greatest(1,(SELECT coalesce(max(id),0) FROM ${t})),(SELECT count(*)>0 FROM ${t}))`,[]);
  await q(`SELECT setval('rx_seq',greatest(1,(SELECT coalesce(max(substring(number from '[0-9]+$')::int),0) FROM prescriptions)),(SELECT count(*)>0 FROM prescriptions WHERE number IS NOT NULL))`,[]);
  await q(`SELECT setval('receipt_seq',greatest(1,(SELECT coalesce(max(substring(number from '[0-9]+$')::int),0) FROM receipts)),(SELECT count(*)>0 FROM receipts))`,[]);
  return counts;
}
