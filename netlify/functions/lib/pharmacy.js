import {sql,audit,rateLimited} from './db.js';
import {json,clean} from './util.js';
import {notifyUser} from './notify.js';
import {waveEnabled} from './wave.js';
import {releaseExpiredHolds,requestRefund} from './payments.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const need=(me,role)=>!me?json(401,{error:'Non connecté.'}):(me.role!==role||me.status!=='active')?json(403,{error:'Accès refusé.'}):null;
const OPEN=['en_attente','en_preparation','prete'];

// Remet en stock les quantités d'une commande ANNULÉE (appelée uniquement après une transition réussie vers « annulee »)
export const restock=(orderId)=>sql`UPDATE pharmacy_stock s SET quantite=s.quantite+i.quantite,updated_at=now() FROM pharmacy_order_items i JOIN pharmacy_orders o ON o.id=i.order_id
  WHERE i.order_id=${orderId} AND s.pharmacy_id=o.pharmacy_id AND s.drug_id=i.drug_id`;
// Notifications génériques : jamais de nom de médicament ni d'adresse
export async function notifyOrder(id,event){
  try{const o=(await sql`SELECT patient_id,pharmacy_id FROM pharmacy_orders WHERE id=${id}`)[0];if(!o)return;
    const T={new:[[o.pharmacy_id,'Nouvelle commande','Une nouvelle commande vous attend dans « Commandes ».']],
      paid:[[o.patient_id,'Paiement confirmé','Votre paiement est confirmé. L\u2019officine prépare votre commande.'],[o.pharmacy_id,'Nouvelle commande payée','Une commande payée vous attend dans « Commandes ».']],
      accepted:[[o.patient_id,'Commande acceptée','Votre commande est en préparation.']],ready:[[o.patient_id,'Commande prête','Votre commande est prête.']],
      delivered:[[o.patient_id,'Commande remise','Votre commande a été remise.']],rejected:[[o.patient_id,'Commande refusée','Votre commande n\u2019a pas pu être acceptée. Un remboursement est lancé si vous avez payé.']],
      cancelled:[[o.pharmacy_id,'Commande annulée','Une commande a été annulée par le patient.']],refunded:[[o.patient_id,'Remboursement effectué','Votre remboursement a été effectué.']]}[event]||[];
    for(const [u,t,b] of T)await notifyUser(u,'pharmacie',t,b,'/pharmacie',`o:${event}:${id}:${u}`);
  }catch(e){console.error('notifyOrder',e.message);}
}

export async function pharmacyRoutes({path,method,body,me,ip,query}){
  let m;
  // ---------- Public : officines vérifiées et catalogue ----------
  if(path==='/api/pharmacy/list'&&method==='GET'){
    const v=clean(query.get('ville'),60)||null;
    return json(200,{officines:await sql`SELECT u.id,p.nom_officine,p.ville,p.adresse,p.frais_livraison_fcfa FROM pharmacies p JOIN users u ON u.id=p.user_id WHERE p.verified_at IS NOT NULL AND u.status='active' AND (${v}::text IS NULL OR lower(p.ville)=lower(${v})) ORDER BY p.nom_officine LIMIT 100`});
  }
  if((m=path.match(/^\/api\/pharmacy\/list\/([^/]+)\/stock$/))&&method==='GET'){
    if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});const t=clean(query.get('q'),60)||null;
    // Disponibilité seulement (jamais la quantité exacte)
    return json(200,{medicaments:await sql`SELECT d.id,d.nom,d.forme,d.dosage,d.sur_ordonnance,s.prix_fcfa,(s.quantite>0) AS disponible,(s.quantite>0 AND s.quantite<=3) AS stock_faible
      FROM pharmacy_stock s JOIN drugs d ON d.id=s.drug_id JOIN pharmacies p ON p.user_id=s.pharmacy_id WHERE s.pharmacy_id=${m[1]} AND p.verified_at IS NOT NULL AND d.actif AND (${t}::text IS NULL OR d.nom ILIKE '%'||${t}||'%') ORDER BY d.nom LIMIT 200`});
  }
  if(path==='/api/pharmacy/catalogue'&&method==='GET'){
    const t=clean(query.get('q'),60)||null;
    return json(200,{medicaments:await sql`SELECT d.id,d.nom,d.forme,d.dosage,d.sur_ordonnance,
        (SELECT count(*)::int FROM pharmacy_stock s JOIN pharmacies p ON p.user_id=s.pharmacy_id WHERE s.drug_id=d.id AND s.quantite>0 AND p.verified_at IS NOT NULL) AS officines_disponibles
      FROM drugs d WHERE d.actif AND (${t}::text IS NULL OR d.nom ILIKE '%'||${t}||'%') ORDER BY d.nom LIMIT 100`});
  }
  if(!me)return json(401,{error:'Non connecté.'});

  // ---------- Pharmacien ----------
  if(path==='/api/pharmacy/profile'&&method==='GET'){const e=need(me,'pharmacien');if(e)return e;
    return json(200,{profile:(await sql`SELECT nom_officine,ville,adresse,numero_autorisation,frais_livraison_fcfa,verified_at FROM pharmacies WHERE user_id=${me.id}`)[0]||null});}
  if(path==='/api/pharmacy/profile'&&method==='POST'){
    const e=need(me,'pharmacien');if(e)return e;
    const nom=clean(body.nom_officine,100),ville=clean(body.ville,60),adr=clean(body.adresse,200),num=clean(body.numero_autorisation,60);
    const fr=body.frais_livraison_fcfa===''||body.frais_livraison_fcfa==null?null:parseInt(body.frais_livraison_fcfa,10);
    if(nom.length<2||ville.length<2||adr.length<5||num.length<3)return json(400,{error:'Nom, ville, adresse et numéro d\u2019autorisation de l\u2019officine sont obligatoires.'});
    if(fr!==null&&!(fr>=0&&fr<=50000))return json(400,{error:'Frais de livraison invalides.'});
    await sql`INSERT INTO pharmacies(user_id,nom_officine,ville,adresse,numero_autorisation,frais_livraison_fcfa) VALUES(${me.id},${nom},${ville},${adr},${num},${fr})
      ON CONFLICT(user_id) DO UPDATE SET nom_officine=EXCLUDED.nom_officine,ville=EXCLUDED.ville,adresse=EXCLUDED.adresse,frais_livraison_fcfa=EXCLUDED.frais_livraison_fcfa,updated_at=now(),
        numero_autorisation=EXCLUDED.numero_autorisation,verified_at=CASE WHEN pharmacies.numero_autorisation IS DISTINCT FROM EXCLUDED.numero_autorisation THEN NULL ELSE pharmacies.verified_at END`;
    await audit(me.id,'pharmacy_profile_saved',ip);return json(200,{ok:true,message:'Profil enregistré. L\u2019officine sera visible après vérification de son autorisation par un administrateur.'});
  }
  if(path==='/api/pharmacy/stock'&&method==='GET'){const e=need(me,'pharmacien');if(e)return e;
    return json(200,{stock:await sql`SELECT d.id AS drug_id,d.nom,d.forme,d.dosage,d.sur_ordonnance,d.actif,s.prix_fcfa,s.quantite,s.updated_at FROM pharmacy_stock s JOIN drugs d ON d.id=s.drug_id WHERE s.pharmacy_id=${me.id} ORDER BY d.nom`,
      catalogue:await sql`SELECT id,nom,forme,dosage,sur_ordonnance FROM drugs WHERE actif ORDER BY nom LIMIT 500`});}
  if(path==='/api/pharmacy/stock'&&method==='POST'){
    const e=need(me,'pharmacien');if(e)return e;
    if(!(await sql`SELECT 1 FROM pharmacies WHERE user_id=${me.id} AND verified_at IS NOT NULL`).length)return json(403,{error:'Votre officine doit être vérifiée avant de publier un stock.'});
    const prix=parseInt(body.prix_fcfa,10),qte=parseInt(body.quantite,10);
    if(!UUID.test(String(body.drugId||''))||!(prix>0&&prix<=1000000)||!(qte>=0&&qte<=100000))return json(400,{error:'Médicament, prix (>0) ou quantité invalide.'});
    const r=await sql`INSERT INTO pharmacy_stock(pharmacy_id,drug_id,prix_fcfa,quantite) SELECT ${me.id},id,${prix},${qte} FROM drugs WHERE id=${body.drugId} AND actif
      ON CONFLICT(pharmacy_id,drug_id) DO UPDATE SET prix_fcfa=EXCLUDED.prix_fcfa,quantite=EXCLUDED.quantite,updated_at=now() RETURNING drug_id`;
    if(!r.length)return json(404,{error:'Médicament introuvable dans le catalogue.'});
    await audit(me.id,'stock_updated',ip,{drug:body.drugId,prix,qte});return json(200,{ok:true});
  }
  if(path==='/api/pharmacy/orders'&&method==='GET'){
    const e=need(me,'pharmacien');if(e)return e;
    const os=await sql`SELECT o.id,o.status,o.mode,o.total_fcfa,o.frais_livraison_fcfa,o.payment_mode,o.created_at,o.prescription_id,
        CASE WHEN o.status<>'pending_payment' THEN u.nom END AS patient,
        CASE WHEN o.status<>'pending_payment' AND o.mode='livraison' THEN o.adresse END AS adresse,
        CASE WHEN o.status<>'pending_payment' AND o.prescription_id IS NOT NULL THEN (SELECT jsonb_build_object('numero',p.number,'statut',p.status,'items',p.items,'poids_kg',p.poids_kg,'medecin',du.nom) FROM prescriptions p JOIN users du ON du.id=p.doctor_id WHERE p.id=o.prescription_id) END AS ordonnance
      FROM pharmacy_orders o JOIN users u ON u.id=o.patient_id WHERE o.pharmacy_id=${me.id} ORDER BY o.created_at DESC LIMIT 100`;
    const its=await sql`SELECT i.order_id,i.nom,i.quantite,i.prix_fcfa,d.sur_ordonnance FROM pharmacy_order_items i JOIN drugs d ON d.id=i.drug_id JOIN pharmacy_orders o ON o.id=i.order_id WHERE o.pharmacy_id=${me.id}`;
    return json(200,{commandes:os.map(o=>({...o,articles:its.filter(i=>i.order_id===o.id)}))});
  }
  if((m=path.match(/^\/api\/pharmacy\/orders\/([^/]+)\/(accept|ready|handover|reject)$/))&&method==='POST'){
    const e=need(me,'pharmacien');if(e)return e;if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    const o=(await sql`SELECT * FROM pharmacy_orders WHERE id=${m[1]} AND pharmacy_id=${me.id}`)[0];if(!o)return json(404,{error:'Commande introuvable.'});
    if(m[2]==='accept'){const r=await sql`UPDATE pharmacy_orders SET status='en_preparation',updated_at=now() WHERE id=${o.id} AND status='en_attente' RETURNING id`;if(r.length)await notifyOrder(o.id,'accepted');return r.length?json(200,{ok:true}):json(409,{error:'Commande non acceptable à ce stade.'});}
    if(m[2]==='ready'){const r=await sql`UPDATE pharmacy_orders SET status='prete',updated_at=now() WHERE id=${o.id} AND status='en_preparation' RETURNING id`;if(r.length)await notifyOrder(o.id,'ready');return r.length?json(200,{ok:true}):json(409,{error:'La commande doit d\u2019abord être en préparation.'});}
    if(m[2]==='handover'){
      if(o.prescription_id&&body.prescription_verifiee!==true)return json(400,{error:'Confirmez avoir vérifié l\u2019ordonnance et l\u2019identité de la personne avant remise.'});
      // Remise + ordonnance « délivrée » dans la même instruction (jamais l'une sans l'autre)
      const r=await sql`WITH u AS (UPDATE pharmacy_orders SET status='livree',updated_at=now() WHERE id=${o.id} AND status='prete' RETURNING id,prescription_id),
          p AS (UPDATE prescriptions SET status='delivree' WHERE id=(SELECT prescription_id FROM u) AND status='signee' RETURNING id)
        SELECT (SELECT count(*) FROM u)::int AS n,(SELECT count(*) FROM p)::int AS rx`;
      if(!r[0].n)return json(409,{error:'La commande doit être prête avant la remise.'});
      await audit(me.id,'order_handed_over',ip,{order:o.id,ordonnance_delivree:r[0].rx});await notifyOrder(o.id,'delivered');return json(200,{ok:true,ordonnance_delivree:r[0].rx===1});
    }
    const reason=clean(body.reason,300);if(reason.length<3)return json(400,{error:'Indiquez le motif du refus.'});
    const r=await sql`UPDATE pharmacy_orders SET status='annulee',cancel_reason=${reason},updated_at=now() WHERE id=${o.id} AND status IN ('en_attente','en_preparation','prete') RETURNING id`;
    if(!r.length)return json(409,{error:'Refus impossible à ce stade.'});
    await restock(o.id);await audit(me.id,'order_rejected',ip,{order:o.id});await notifyOrder(o.id,'rejected');
    const pay=(await sql`SELECT id FROM payments WHERE order_id=${o.id} AND status IN ('succeeded','refund_pending')`)[0];let rem='sans objet';
    if(pay){const f=await requestRefund(pay.id,me.id,ip);rem=f.ok?'effectué':'en attente de confirmation du prestataire';}
    return json(200,{ok:true,remboursement:rem});
  }

  // ---------- Patient : commande ----------
  if(path==='/api/pharmacy/orders'&&method==='POST'){
    const e=need(me,'patient');if(e)return e;
    if(await rateLimited('ord:'+me.id,20,3600))return json(429,{error:'Trop de commandes. Réessayez plus tard.'});
    const ph=String(body.pharmacyId||''),mode=body.mode;
    if(!UUID.test(ph)||!['retrait','livraison'].includes(mode))return json(400,{error:'Officine ou mode invalide.'});
    if(body.consent!==true)return json(400,{error:'Votre consentement est requis.'});
    const raw=Array.isArray(body.items)?body.items:[];const items=[...new Map(raw.map(x=>[String(x&&x.drugId),{drug_id:String(x&&x.drugId),qty:parseInt(x&&x.quantite,10)}])).values()];
    if(!items.length||items.length>20||items.some(i=>!UUID.test(i.drug_id)||!(i.qty>=1&&i.qty<=20)))return json(400,{error:'Articles invalides (1 à 20 articles, 20 unités maximum chacun).'});
    const office=(await sql`SELECT frais_livraison_fcfa FROM pharmacies WHERE user_id=${ph} AND verified_at IS NOT NULL`)[0];if(!office)return json(404,{error:'Officine introuvable ou non vérifiée.'});
    let adr=null,frais=0;if(mode==='livraison'){if(office.frais_livraison_fcfa==null)return json(409,{error:'Cette officine ne propose pas la livraison.'});adr=clean(body.adresse,200);if(adr.length<5)return json(400,{error:'Indiquez l\u2019adresse de livraison.'});frais=office.frais_livraison_fcfa;}
    await releaseExpiredHolds();
    const st=await sql`SELECT d.id,d.nom,d.sur_ordonnance,s.prix_fcfa,s.quantite FROM pharmacy_stock s JOIN drugs d ON d.id=s.drug_id WHERE s.pharmacy_id=${ph} AND d.actif AND d.id=ANY(${items.map(i=>i.drug_id)}::uuid[])`;
    if(st.length!==items.length)return json(409,{error:'Un article n\u2019est pas proposé par cette officine.'});
    const ko=items.find(i=>st.find(s=>s.id===i.drug_id).quantite<i.qty);if(ko)return json(409,{error:'Stock insuffisant pour « '+st.find(s=>s.id===ko.drug_id).nom+' ».'});
    const needRx=st.some(s=>s.sur_ordonnance);let rx=null;
    if(needRx){ // médicament soumis à ordonnance : ordonnance signée, au nom du patient, non encore délivrée ni liée à une autre commande
      if(!UUID.test(String(body.prescriptionId||'')))return json(400,{error:'Un médicament de votre panier exige une ordonnance : sélectionnez une ordonnance signée.'});
      rx=(await sql`SELECT id FROM prescriptions WHERE id=${body.prescriptionId} AND patient_id=${me.id} AND status='signee'`)[0];
      if(!rx)return json(403,{error:'Ordonnance introuvable, annulée, déjà délivrée ou non signée.'});
    }
    const online=waveEnabled(),total=items.reduce((a,i)=>a+i.qty*st.find(s=>s.id===i.drug_id).prix_fcfa,0)+frais,pay=online&&total>0;
    let r;
    try{
      // Une seule instruction : stock décrémenté (CHECK quantite>=0 : jamais de survente même en concurrence), commande et lignes créées, ou rien
      r=await sql`WITH req AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS x(drug_id uuid,qty int)),
          upd AS (UPDATE pharmacy_stock s SET quantite=s.quantite-r.qty,updated_at=now() FROM req r WHERE s.pharmacy_id=${ph} AND s.drug_id=r.drug_id RETURNING s.drug_id,s.prix_fcfa,r.qty),
          o AS (INSERT INTO pharmacy_orders(patient_id,pharmacy_id,prescription_id,mode,adresse,frais_livraison_fcfa,total_fcfa,status,payment_mode,hold_expires_at)
            SELECT ${me.id},${ph},${rx?rx.id:null}::uuid,${mode},${adr},${frais},(SELECT sum(prix_fcfa*qty) FROM upd)+${frais},${pay?'pending_payment':'en_attente'},${pay?'en_ligne':'sur_place'},${pay?new Date(Date.now()+30*60000).toISOString():null}::timestamptz
            WHERE (SELECT count(*) FROM upd)=(SELECT count(*) FROM req) RETURNING id,status,total_fcfa,payment_mode,hold_expires_at),
          ins AS (INSERT INTO pharmacy_order_items(order_id,drug_id,nom,prix_fcfa,quantite) SELECT o.id,u.drug_id,d.nom,u.prix_fcfa,u.qty FROM o JOIN upd u ON true JOIN drugs d ON d.id=u.drug_id RETURNING order_id)
        SELECT * FROM o`;
    }catch(err){
      if(/quantite|check constraint|23514/i.test(String(err.message)))return json(409,{error:'Stock insuffisant (un autre client vient de commander).'});
      if(/order_one_per_rx|duplicate key/i.test(String(err.message)))return json(409,{error:'Cette ordonnance est déjà liée à une commande.'});
      throw err;
    }
    if(!r.length)return json(409,{error:'Commande impossible (stock modifié). Réessayez.'});
    await audit(me.id,'pharmacy_order_created',ip,{order:r[0].id});
    if(r[0].status==='en_attente')await notifyOrder(r[0].id,'new');
    return json(201,{commande:r[0],message:r[0].status==='pending_payment'?'Commande retenue 30 minutes : finalisez le paiement.':'Commande transmise à l\u2019officine. Règlement à la remise : le paiement en ligne n\u2019est pas activé.'});
  }
  if(path==='/api/pharmacy/my-orders'&&method==='GET'){
    const e=need(me,'patient');if(e)return e;
    const os=await sql`SELECT o.id,o.status,o.mode,o.total_fcfa,o.payment_mode,o.hold_expires_at,o.created_at,p.nom_officine,p.adresse AS adresse_officine,
        (SELECT id FROM payments y WHERE y.order_id=o.id AND y.status IN ('succeeded','refunded','refund_pending') ORDER BY created_at DESC LIMIT 1) AS paiement_id
      FROM pharmacy_orders o JOIN pharmacies p ON p.user_id=o.pharmacy_id WHERE o.patient_id=${me.id} ORDER BY o.created_at DESC LIMIT 100`;
    const its=await sql`SELECT i.order_id,i.nom,i.quantite,i.prix_fcfa FROM pharmacy_order_items i JOIN pharmacy_orders o ON o.id=i.order_id WHERE o.patient_id=${me.id}`;
    return json(200,{commandes:os.map(o=>({...o,articles:its.filter(i=>i.order_id===o.id)}))});
  }
  if((m=path.match(/^\/api\/pharmacy\/orders\/([^/]+)\/cancel$/))&&method==='POST'){
    const e=need(me,'patient');if(e)return e;if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});
    const r=await sql`UPDATE pharmacy_orders SET status='annulee',cancel_reason='Annulée par le patient',updated_at=now() WHERE id=${m[1]} AND patient_id=${me.id} AND status IN ('pending_payment','en_attente') RETURNING id`;
    if(!r.length)return json(409,{error:'Annulation impossible : la commande est déjà en préparation ou terminée.'});
    await restock(m[1]);await notifyOrder(m[1],'cancelled');
    const pay=(await sql`SELECT id FROM payments WHERE order_id=${m[1]} AND status IN ('succeeded','refund_pending')`)[0];let rem='sans objet';
    if(pay){const f=await requestRefund(pay.id,me.id,ip);rem=f.ok?'effectué':'en attente de confirmation du prestataire';}
    return json(200,{ok:true,remboursement:rem});
  }

  // ---------- Administration : officines et catalogue ----------
  if(path.startsWith('/api/admin/pharmacies')||path.startsWith('/api/admin/drugs')){
    const e=need(me,'admin');if(e){if(me)await audit(me.id,'forbidden_admin',ip,{path});return e;}
    if(path==='/api/admin/pharmacies/pending'&&method==='GET')return json(200,{officines:await sql`SELECT u.id,u.nom,u.tel,p.nom_officine,p.ville,p.adresse,p.numero_autorisation,p.updated_at FROM pharmacies p JOIN users u ON u.id=p.user_id WHERE p.verified_at IS NULL AND u.status='active' ORDER BY p.updated_at`});
    if((m=path.match(/^\/api\/admin\/pharmacies\/([^/]+)\/verify$/))&&method==='POST'){
      if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});if(body.justificatifs_verifies!==true)return json(400,{error:'Confirmez avoir contrôlé l\u2019autorisation d\u2019exercer de l\u2019officine.'});
      const r=await sql`UPDATE pharmacies SET verified_at=now(),verified_by=${me.id} WHERE user_id=${m[1]} RETURNING user_id`;if(!r.length)return json(404,{error:'Officine introuvable.'});
      await audit(me.id,'pharmacy_verified',ip,{target:m[1],note:clean(body.note,300)});await notifyUser(m[1],'verif','Officine vérifiée','Votre officine est vérifiée : vous pouvez publier votre stock.','/stock','phv:'+Date.now());return json(200,{ok:true});}
    if(path==='/api/admin/drugs'&&method==='GET')return json(200,{medicaments:await sql`SELECT id,nom,forme,dosage,sur_ordonnance,actif FROM drugs ORDER BY nom LIMIT 1000`});
    if(path==='/api/admin/drugs'&&method==='POST'){
      const nom=clean(body.nom,120);if(nom.length<2||typeof body.sur_ordonnance!=='boolean')return json(400,{error:'Nom et statut « sur ordonnance » (oui/non) obligatoires.'});
      const r=await sql`INSERT INTO drugs(nom,forme,dosage,sur_ordonnance) VALUES(${nom},${clean(body.forme,60)||null},${clean(body.dosage,60)||null},${body.sur_ordonnance}) ON CONFLICT DO NOTHING RETURNING id`;
      if(!r.length)return json(409,{error:'Ce médicament existe déjà.'});await audit(me.id,'drug_added',ip,{drug:r[0].id,sur_ordonnance:body.sur_ordonnance});return json(201,{id:r[0].id});}
    if((m=path.match(/^\/api\/admin\/drugs\/([^/]+)\/toggle$/))&&method==='POST'){
      if(!UUID.test(m[1]))return json(400,{error:'Identifiant invalide.'});const r=await sql`UPDATE drugs SET actif=NOT actif WHERE id=${m[1]} RETURNING actif`;
      if(!r.length)return json(404,{error:'Introuvable.'});await audit(me.id,'drug_toggled',ip,{drug:m[1],actif:r[0].actif});return json(200,{actif:r[0].actif});}
  }
  return null;
}
