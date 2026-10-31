# Premier essai de Kayligey sur une version de TEST

But : trouver ce que les tests automatiques ne peuvent pas voir (vrais appareils, vrais réseaux, vrais fournisseurs). **Ne jamais faire cet essai sur la base de production, ni avec de vraies données médicales.**

## 0. Préparer un environnement séparé
1. **Base de test** : dans Neon, créer un projet (ou une branche) « kayligey-test ». `DATABASE_URL` de test ≠ production.
2. **Site de test** : second site Netlify « kayligey-test » relié au même dépôt, avec ses propres variables (voir `DEPLOIEMENT.md`). Utiliser des clés de test quand le fournisseur en propose ; sinon des montants minimes (100 à 500 FCFA) et rembourser.
3. Sur votre ordinateur :
   ```
   npm install
   npm run migrate
   npm run seed-test -- --video
   ```
   (Dans `.env` : `DATABASE_URL=<base de TEST>` et `KAY_ALLOW_SEED=oui-base-de-test`. Sous Windows, ne mettez jamais `VAR=valeur` devant la commande.)
   ```
   ```
   Le script crée 6 comptes `[TEST]` (admin, 2 patients, médecin, infirmier à domicile, pharmacien), un médecin et une officine vérifiés, 2 médicaments fictifs et un **rendez-vous vidéo qui commence dans 5 minutes**. Il affiche **une seule fois** un mot de passe commun. Il refuse de s'exécuter si la base contient un vrai compte.
   Téléphones de test : 700000001 admin · 700000002 patient 1 · 700000003 patient 2 · 700000004 médecin · 700000005 infirmier · 700000006 pharmacien.
4. `SITE_URL=https://kayligey-test.netlify.app npm run smoke` : tout doit être « OK ».

## 1. Scénarios (cochez, notez l'heure et ce qui diffère)
Pour chaque scénario : **Résultat attendu** / ce qu'il faut me rapporter si ça diffère (message exact, capture d'écran, appareil, navigateur, réseau).

| # | Qui | À faire | Résultat attendu |
|---|---|---|---|
| S1 | Tous | Se connecter avec chacun des 6 comptes, puis se déconnecter ; rouvrir l'onglet après déconnexion | Chaque rôle voit son propre espace ; après déconnexion, retour à l'accueil, aucune donnée visible |
| S2 | Visiteur | 5 mauvais mots de passe sur le compte 700000003 | Compte verrouillé 15 min, message clair (même avec le bon mot de passe) |
| S3 | Nouveau | S'inscrire comme patient (vrai numéro) ; s'inscrire comme médecin | Patient connecté directement ; médecin « en attente » ; l'admin valide dans « Demandes d'inscription », puis le médecin peut se connecter |
| S4 | Patient 1 | Chercher « Médecine générale », ouvrir le médecin, réserver un créneau. En parallèle, Patient 2 tente **le même créneau** dans un autre navigateur | Un seul obtient le créneau ; l'autre reçoit « n'est plus disponible » |
| S5 | Patient 1 | Payer avec Wave (montant minimal) ; revenir sur le site | Rendez-vous « Confirmé » en quelques secondes ; reçu disponible ; médecin notifié ; `/api/admin/reconciliation` sans anomalie |
| S6 | Patient 1 / Médecin | Annuler (a) en tant que patient > 2 h avant, (b) en tant que médecin | Remboursement « effectué » (ou « en attente » si Wave ne répond pas, avec reprise par l'admin) |
| S7 | Patient 1 + Médecin | **Vidéo, 2 appareils** : le rendez-vous de test s'ouvre 10 min avant. Patient : « Rejoindre » (salle d'attente). Médecin : « Ouvrir la consultation ». Puis : couper le Wi-Fi 20 s ; passer en audio seul ; refuser la caméra ; terminer | Le patient attend tant que le médecin n'a pas ouvert ; son et image dans les deux sens ; message « reconnexion » puis « rétablie » ; audio seul fonctionne ; le médecin termine, le rendez-vous passe à « terminé » |
| S8 | Patient / Médecin | Messagerie : envoyer un message, une pièce jointe, couper le réseau et renvoyer | « lu » apparaît ; pas de doublon après renvoi ; la pièce jointe s'ouvre côté médecin |
| S9 | Médecin / Patient | Note médicale (brouillon puis finalisée), ordonnance (signer, voir côté patient, annuler), dépôt de document, autorisation puis retrait du partage | Le patient ne voit pas les brouillons ; une note finalisée n'est plus modifiable ; après retrait du partage, le médecin n'accède plus au dossier ; le journal des accès est rempli |
| S10 | Patient 1 | Ajouter un enfant, prendre un rendez-vous pour lui, saisir poids/taille et un vaccin | Le médecin voit l'enfant ; aucun accès au dossier du parent ; aucune courbe de référence affichée (normal) |
| S11 | Patient / Pharmacien | Commander le médicament libre ; commander le médicament « sur ordonnance » (d'abord sans ordonnance : refus attendu) ; traiter la commande, remise | L'ordonnance est exigée ; stock décrémenté ; ordonnance « délivrée » après remise ; impossible de la réutiliser |
| S12 | Patient / Infirmier | Demande de soins, devis, choix, réalisation, confirmation, avis | L'infirmier ne voit pas l'adresse avant confirmation ; l'avis n'est possible qu'après confirmation |
| S13 | Tous | Notifications (application, e-mail, SMS si configurés), mot de passe oublié | Rappel la veille et 1 h avant ; aucun message ne contient de détail médical ; le code de réinitialisation arrive par SMS |
| S14 | Patient 2 | Copier le lien d'un document du Patient 1 dans son navigateur ; ouvrir `/api/admin/pending` | Refus (403/401) ; un lien de téléchargement expire en 5 min |
| S15 | Vous | `npm run backup`, créer une base neuve, `npm run migrate`, `npm run restore`, ouvrir le site de test dessus | Les comptes, rendez-vous et dossiers sont identiques |
| S17 | Patient | Bouton « Urgence : obtenir de l'aide » et, dans l'assistant, un cas « rouge » | Le 1515 et le 18 s'appellent en un tap ; la position GPS s'affiche (ou message si refusée) ; le SMS à un proche s'ouvre dans l'application SMS du téléphone ; **aucun texte ne dit qu'une alerte a été envoyée à Kayligey ou à un hôpital** |
| S16 | Vous | Refaire S4, S7 et S11 sur **un smartphone** (4G, puis réseau faible) | Pages lisibles, boutons utilisables au pouce, vidéo ou audio utilisable |

## 2. Quand quelque chose échoue
- **Navigateur** : console développeur (F12) > Console et Réseau ; noter l'URL de la requête en échec et son code.
- **Serveur** : Netlify > Logs > Functions (`api`, `cron-notifications`).
- **Données** : `npm run diagnostic > diagnostic.json` produit des **compteurs sans aucune donnée personnelle** (événements d'audit, paiements par statut, anomalies, échecs d'envoi, événements vidéo…) : c'est ce fichier qu'il faut me transmettre.

## 3. Compte rendu à me renvoyer
```
Appareils/navigateurs/réseaux utilisés :
S1 ok/ko — S2 ok/ko — … S17 ok/ko
Pour chaque « ko » : étapes exactes, message affiché, capture, heure
diagnostic.json joint (oui/non)
Impressions : lenteurs, textes incompris, boutons difficiles à trouver
```

## 4. Décision avant ouverture au public
Ouvrir seulement si : tous les scénarios sont « ok » sur au moins un smartphone réel ; la restauration (S15) a fonctionné ; `CONFORMITE.md` §3 est traité avec un juriste ; les messages affichés aux utilisateurs (conditions, remboursement, confidentialité) ont été relus. **Le SOS reste désactivé tant qu'un service réel de réception d'alertes n'est pas branché** : l'application renvoie vers le 1515.
