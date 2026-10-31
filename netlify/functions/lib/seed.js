import crypto from 'node:crypto';import bcrypt from 'bcryptjs';
// Données de TEST uniquement. Garde-fous : variable explicite + refus si la base contient un compte qui n'est pas « [TEST] ».
export const TEST_USERS=[['admin','[TEST] Administrateur','700000001'],['patient','[TEST] Patient Un','700000002'],['patient','[TEST] Patient Deux','700000003'],
  ['medecin','[TEST] Dr Médecin','700000004'],['prestataire','[TEST] Infirmier à domicile','700000005'],['pharmacien','[TEST] Pharmacien','700000006']];
export async function seedTest(q,{allow=process.env.KAY_ALLOW_SEED,videoRdv=false}={}){
  if(allow!=='oui-base-de-test')throw new Error('Refusé : définissez KAY_ALLOW_SEED=oui-base-de-test, uniquement sur une base de TEST.');
  if((await q(`SELECT count(*)::int n FROM users WHERE nom NOT LIKE '[TEST]%'`,[]))[0].n>0)throw new Error('Refusé : cette base contient des comptes qui ne sont pas des comptes de test.');
  const password=crypto.randomBytes(12).toString('base64url')+'a1',hash=await bcrypt.hash(password,12),ids={},created=[];
  for(const [role,nom,tel] of TEST_USERS){
    const r=await q(`INSERT INTO users(role,status,nom,tel,pwd_hash,consent_version,consent_at,tel_verified_at) VALUES($1::user_role,'active',$2,$3,$4,'test',now(),NULL) ON CONFLICT(tel) DO NOTHING RETURNING id`,[role,nom,tel,hash]);
    if(r.length){created.push(tel);ids[tel]=r[0].id;}else ids[tel]=(await q(`SELECT id FROM users WHERE tel=$1`,[tel]))[0].id;
  }
  const [adm,pat1,pat2,doc,prest,phm]=TEST_USERS.map(u=>ids[u[2]]);
  await q(`INSERT INTO doctors(user_id,specialite,ville,tarif_fcfa,langues,modes,structure,numero_ordre,bio,verified_at,verified_by) VALUES($1,'Médecine générale','Thiès',5000,'{Français,Wolof}','{cabinet,video,audio}','[TEST] Cabinet fictif','TEST-0001','Profil de test.',now(),$2) ON CONFLICT DO NOTHING`,[doc,adm]);
  await q(`INSERT INTO provider_profiles(user_id,categorie,zones,tarif_fcfa,frais_deplacement_fcfa,bio,qualification_ref,verified_at,verified_by) VALUES($1,'infirmier','{Thiès}',3000,500,'Profil de test.','TEST-INF-1',now(),$2) ON CONFLICT DO NOTHING`,[prest,adm]);
  await q(`INSERT INTO pharmacies(user_id,nom_officine,ville,adresse,numero_autorisation,frais_livraison_fcfa,verified_at,verified_by) VALUES($1,'[TEST] Pharmacie fictive','Thiès','Adresse fictive',  'TEST-PH-1',500,now(),$2) ON CONFLICT DO NOTHING`,[phm,adm]);
  const drugs=[['[TEST] Médicament libre A','comprimé','500 mg',false,500,20],['[TEST] Médicament sur ordonnance B','gélule','250 mg',true,2500,5]];
  for(const [nom,forme,dosage,rx,prix,qte] of drugs){
    await q(`INSERT INTO drugs(nom,forme,dosage,sur_ordonnance) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[nom,forme,dosage,rx]);
    const d=(await q(`SELECT id FROM drugs WHERE nom=$1`,[nom]))[0].id;
    await q(`INSERT INTO pharmacy_stock(pharmacy_id,drug_id,prix_fcfa,quantite) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[phm,d,prix,qte]);
  }
  for(const h of [24,26,48]) // créneaux à venir (heures)
    await q(`INSERT INTO availability_slots(doctor_id,starts_at,ends_at) VALUES($1,now()+($2||' hours')::interval,now()+($2||' hours')::interval+interval '30 minutes') ON CONFLICT DO NOTHING`,[doc,String(h)]);
  let video=null;
  if(videoRdv){ // rendez-vous vidéo confirmé qui commence dans 5 minutes, sans paiement : pour tester la salle tout de suite
    const sl=(await q(`INSERT INTO availability_slots(doctor_id,starts_at,ends_at,status) VALUES($1,now()+interval '5 minutes',now()+interval '35 minutes','booked') RETURNING id`,[doc]))[0].id;
    video=(await q(`INSERT INTO appointments(slot_id,patient_id,doctor_id,mode,motif,status,consent_at) VALUES($1,$2,$3,'video','[TEST] essai vidéo','confirmed',now()) RETURNING id`,[sl,pat1,doc]))[0].id;
  }
  return {password:created.length?password:null,created,telephones:TEST_USERS.map(([role,nom,tel])=>({role,nom,tel})),video_rdv:video};
}
