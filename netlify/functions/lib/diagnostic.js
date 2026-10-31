// Diagnostic SANS données personnelles : uniquement des compteurs et des codes d'erreur techniques, à partager pour le dépannage.
export async function diagnostic(q){
  const one=async(s)=>q(s,[]);const kv=async(s)=>Object.fromEntries((await one(s)).map(r=>[r.k,Number(r.n)]));
  return {genere_le:new Date().toISOString(),
    comptes_par_role_et_statut:await kv(`SELECT role||'/'||status AS k,count(*)::int n FROM users GROUP BY 1`),
    evenements_audit_24h:await kv(`SELECT event AS k,count(*)::int n FROM audit_log WHERE at>now()-interval '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 40`),
    rendez_vous_par_statut:await kv(`SELECT status AS k,count(*)::int n FROM appointments GROUP BY 1`),
    paiements_par_statut:await kv(`SELECT status AS k,count(*)::int n FROM payments GROUP BY 1`),
    anomalies_paiement:{reussis_sans_recu:(await one(`SELECT count(*)::int n FROM payments p WHERE p.status IN ('succeeded','refund_pending','refunded') AND p.paid_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM receipts r WHERE r.payment_id=p.id)`))[0].n,
      en_attente_plus_d_une_heure:(await one(`SELECT count(*)::int n FROM payments WHERE status='pending' AND created_at<now()-interval '1 hour'`))[0].n,
      remboursements_en_attente:(await one(`SELECT count(*)::int n FROM payments WHERE status='refund_pending'`))[0].n},
    webhooks_par_resultat:await kv(`SELECT coalesce(outcome,'sans_resultat') AS k,count(*)::int n FROM webhook_events GROUP BY 1`),
    notifications_envois:await kv(`SELECT channel||'/'||status AS k,count(*)::int n FROM outbox GROUP BY 1`),
    erreurs_envoi:(await one(`SELECT channel,left(coalesce(last_error,''),80) AS erreur,count(*)::int n FROM outbox WHERE last_error IS NOT NULL GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10`)),
    consultations_evenements:await kv(`SELECT event AS k,count(*)::int n FROM consultation_events GROUP BY 1`),
    consultations_par_etat:await kv(`SELECT CASE WHEN ended_at IS NOT NULL THEN 'terminee' WHEN opened_at IS NOT NULL THEN 'ouverte' WHEN patient_waiting_at IS NOT NULL THEN 'patient_en_attente' ELSE 'creee' END AS k,count(*)::int n FROM consultation_rooms GROUP BY 1`),
    commandes_pharmacie:await kv(`SELECT status AS k,count(*)::int n FROM pharmacy_orders GROUP BY 1`),
    missions_domicile:await kv(`SELECT status AS k,count(*)::int n FROM missions GROUP BY 1`),
    stock_negatif_ou_incoherent:(await one(`SELECT count(*)::int n FROM pharmacy_stock WHERE quantite<0`))[0].n,
    litiges_ouverts:(await one(`SELECT count(*)::int n FROM care_disputes WHERE status='ouvert'`))[0].n,
    demandes_suppression_en_attente:(await one(`SELECT count(*)::int n FROM deletion_requests WHERE status='pending'`))[0].n};
}
