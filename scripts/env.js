// Charge automatiquement le fichier .env (à la racine du projet) s'il existe.
// Fonctionne sous Windows, macOS et Linux, sans dépendance : plus besoin d'écrire DATABASE_URL=... devant chaque commande.
// Les variables déjà définies dans le terminal restent prioritaires.
import {readFileSync,existsSync} from 'node:fs';
const f=new URL('../.env',import.meta.url);
if(existsSync(f)){
  for(const raw of readFileSync(f,'utf8').split(/\r?\n/)){
    const l=raw.trim();if(!l||l.startsWith('#'))continue;
    const i=l.indexOf('=');if(i<1)continue;
    const k=l.slice(0,i).trim();let v=l.slice(i+1).trim();
    if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);
    if(process.env[k]===undefined&&v!=='')process.env[k]=v;
  }
}
