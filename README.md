# Kayligey — projet backend + frontend

**À lire dans l'ordre :** `DEPLOIEMENT.md` (mise en ligne pas à pas), `ESSAI.md` (premier essai sur une version de test, 17 scénarios), `CONFORMITE.md` (rapport de tests, intégrations restantes, validations obligatoires avant ouverture), puis ce fichier (référence technique par étape).
Commandes : `npm test` (83 tests), `npm run migrate`, `npm run create-admin`, `npm run backup`, `npm run restore`, `npm run smoke`, `npm run seed-test` (base de TEST uniquement), `npm run diagnostic`.

## Référence technique (étapes 1 à 8)

## Architecture
- `public/index.html` : frontend actuel (pas encore branché à l'API, voir « Reste à faire »).
- `netlify/functions/api.js` : API unique (`/api/*`), Netlify Functions.
- Base PostgreSQL (Neon recommandé, compatible Netlify) : `db/schema.sql`.
- Sessions : jeton aléatoire dans un cookie HttpOnly/Secure/SameSite=Strict, seul son hash SHA-256 est stocké.
- Mots de passe : bcrypt (coût 12), jamais en clair.

## Routes
| Méthode | Route | Accès |
|---|---|---|
| POST | /api/auth/register | public (patient actif ; médecin/prestataire « pending ») |
| POST | /api/auth/login | public, limité (20/15 min/IP, verrou compte après 5 échecs) |
| POST | /api/auth/logout | connecté |
| GET | /api/auth/me | connecté |
| POST | /api/auth/reset-request, /api/auth/reset-confirm | public, limité |
| GET | /api/admin/pending | admin |
| POST | /api/admin/users/:id/status | admin, journalisé |
### Étape 2 : médecins, créneaux, rendez-vous
| Méthode | Route | Accès |
|---|---|---|
| GET | /api/doctors?q&specialite&ville&mode&langue | public, médecins vérifiés uniquement |
| GET | /api/doctors/:id/slots | public |
| POST | /api/doctor/profile | médecin (toute modif. du n° d'ordre ou de la spécialité retire la vérification) |
| GET/POST | /api/doctor/slots, POST /api/doctor/slots/:id/close | médecin vérifié |
| POST | /api/admin/doctors/:id/verify | admin, journalisé |
| POST | /api/appointments | patient : réservation atomique (une seule instruction SQL) |
| GET | /api/appointments | patient ou médecin : uniquement les siens |
| POST | /api/appointments/:id/cancel, /reschedule | patient (jusqu'à 2 h avant) ; médecin (annulation) |
Réservation, reprogrammation et annulation sont des instructions SQL uniques (CTE) : le créneau change d'état et le rendez-vous est créé, ou rien. Un index unique partiel interdit deux rendez-vous confirmés sur un créneau.

### Étape 3 : paiements (Wave)
| Méthode | Route | Accès |
|---|---|---|
| GET | /api/payments/config | public : paiement en ligne activé ou non (Orange Money et Free Money : non disponibles) |
| POST | /api/payments/checkout | patient : crée une session Wave pour son rendez-vous « pending_payment » (réutilisée si déjà créée) |
| POST | /api/webhooks/wave | Wave uniquement : signature `Wave-Signature` (HMAC-SHA256, tolérance 5 min) vérifiée, puis **la session est relue auprès de Wave** (statut, montant, devise, référence) avant toute confirmation |
| GET | /api/payments, /api/payments/:id/receipt | patient : les siens |
| GET | /api/doctor/revenue | médecin : montants confirmés à lui verser |
| GET | /api/admin/reconciliation, /api/admin/payments | admin : anomalies (sans reçu, écart de grand livre, en attente > 1 h, remboursements en attente) |
| POST | /api/admin/payments/:id/sync, /refund | admin : resynchroniser avec Wave, relancer un remboursement |
Principes : créneau retenu 15 min en attente de paiement ; le retour navigateur n'est jamais une preuve ; webhook rejouable sans doublon (reçu et écritures uniques) ; paiement tardif remboursé automatiquement ; remboursement marqué « refunded » seulement si Wave répond OK, sinon « refund_pending ». Si `WAVE_API_KEY`, `WAVE_WEBHOOK_SECRET` ou `APP_ORIGIN` manque, le paiement en ligne est désactivé et la réservation passe en « règlement sur place ».
Variables : `WAVE_API_KEY`, `WAVE_WEBHOOK_SECRET`, `APP_ORIGIN`, optionnelles `WAVE_SIGNING_SECRET` (signature des requêtes sortantes), `COMMISSION_BPS` (points de base, 1000 = 10 %).
Mise en place Wave : compte Wave Business, clé API (portail développeur), enregistrement de l'URL `https://VOTRE-SITE/api/webhooks/wave` auprès de Wave pour obtenir le secret de webhook. Un seul endpoint de webhook par clé : utiliser une clé distincte pour les tests.

### Étape 4 : notifications et rappels
| Méthode | Route | Accès |
|---|---|---|
| GET | /api/notifications | connecté : les siennes + nombre de non lues |
| POST | /api/notifications/read | connecté : `{ids:[...]}` ou `{all:true}` (uniquement les siennes) |
| GET/POST | /api/notifications/prefs | connecté : rappels, e-mail, SMS (SMS désactivé par défaut) |
| GET | /api/admin/notifications | admin : canaux configurés, envois par statut, derniers échecs |
Fonctionnement : chaque événement (réservation, paiement confirmé, annulation, reprogrammation, remboursement, profil vérifié) crée une notification **dans l'application** (toujours), puis met en file un envoi e-mail et/ou SMS **uniquement si le canal est configuré** et choisi par l'utilisateur. Une tâche planifiée (`cron-notifications.js`, toutes les 5 min) crée les rappels J-1 et H-1 (une seule fois) et envoie la file : 5 tentatives avec délais croissants, puis statut « failed » visible par l'admin. Les messages ne contiennent jamais de motif, de spécialité ni de donnée médicale. Le code de réinitialisation du mot de passe part par SMS dès que Twilio est configuré (sinon l'événement `reset_not_delivered` est journalisé).
Variables : e-mail `RESEND_API_KEY`, `MAIL_FROM` (domaine vérifié chez Resend) ; SMS `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. Les fonctions planifiées Netlify s'exécutent sur la version publiée du site.

### Étape 5 : dossier médical, ordonnances, documents
Règle d'accès au dossier d'un patient par un médecin : **rendez-vous confirmé/terminé depuis moins d'un an ET autorisation explicite du patient** (durée choisie, révocable). Aucune route n'ouvre le contenu médical à l'administrateur ni aux prestataires ; il n'existe pas d'« accès d'urgence » (à concevoir avec un cadre juridique avant de l'ajouter). Chaque lecture par un tiers, dépôt ou téléchargement est inscrit dans un journal que le patient consulte.
| Route | Rôle |
|---|---|
| GET /api/record, POST /api/record/entries, GET /api/record/export | patient : son dossier, ajouts (allergies, antécédents, constantes validées, vaccinations), copie JSON |
| GET/POST /api/record/access, POST /api/record/access/:id/revoke | patient : autoriser / retirer un médecin, journal des accès |
| GET /api/doctor/patients, GET /api/patients/:id/record | médecin : ses patients ; dossier si lien + autorisation |
| POST /api/patients/:id/notes, /api/entries/:id/edit, /finalize, /amend | médecin : note en brouillon (versionnée), finalisation, correction par ajout |
| POST /api/prescriptions, /:id/edit, /:id/sign, /:id/cancel, GET /api/prescriptions | médecin vérifié ; patient : ordonnances signées/annulées |
| GET /api/prescriptions/verify/:numero | public : valide/annulée, médecin, date (aucune donnée patient ni médicament) |
| POST /api/documents, GET /api/documents, GET /api/documents/:id/link, GET /api/documents/:id/file?t= | dépôt (PDF/JPEG/PNG vérifiés par le contenu, 4 Mo), lien signé de 5 min lié à l'utilisateur, autorisation revérifiée au téléchargement |
Immuabilité : des déclencheurs PostgreSQL interdisent de modifier ou supprimer une note finalisée ou le contenu d'une ordonnance signée, même en cas de bug applicatif. Les fichiers sont dans Netlify Blobs (clés opaques, jamais d'URL publique).
Variable : `DOC_LINK_SECRET` (chaîne aléatoire d'au moins 32 caractères) ; sans elle, les liens de téléchargement sont refusés (503).

### Étape 6 : messagerie sécurisée patient ↔ médecin
| Route | Accès |
|---|---|
| GET /api/conversations, POST /api/conversations | patient ou médecin ; ouverture seulement avec un lien de soin (rendez-vous < 1 an) |
| GET /api/conversations/:id/messages?after= | participants uniquement ; marque les messages de l'autre partie comme lus (accusé de lecture) |
| POST /api/conversations/:id/messages | `clientId` (UUID) obligatoire : un renvoi après coupure réseau ne crée pas de doublon ; pièce jointe = un document du dossier du patient ; 60 messages/h max |
L'administrateur et les prestataires n'ont aucun accès. Quand la prise en charge se termine, la conversation reste lisible mais l'envoi est bloqué. Les notifications ne contiennent jamais le texte du message (1 notification max par tranche de 10 min). Joindre un document à un message le partage avec le médecin destinataire. **Pas de temps réel** : interrogation toutes les 8 s ; pas de modération ni de signalement ; la messagerie des prestataires de soins à domicile reste locale tant que ce module n'est pas migré.

### Étape 7 : pédiatrie, enfants et personnes à charge
| Route | Accès |
|---|---|
| GET/POST /api/dependents | parent (patient) : ses personnes à charge (10 max) ; création avec certification « parent ou représentant légal » |
| GET /api/dependents/:id/record | parent, ou médecin avec rendez-vous **pour cet enfant** ET autorisation du parent |
| POST /api/dependents/:id/growth, /vaccines | parent, ou médecin avec rendez-vous pour cet enfant (provenance « parent / médecin » conservée) |
| POST /api/dependents/:id/growth/:eid/void, /vaccines/:eid/void | auteur ou parent ; l'entrée reste visible, barrée (jamais supprimée : déclencheur SQL) |
| GET/POST /api/dependents/:id/access, /access/:doctor/revoke | parent : partage du carnet par médecin, durée choisie |
| GET /api/dependents/:id/export, POST /archive | parent : carnet de santé en JSON ; retrait de la personne |
| GET /api/doctor/children | médecin : enfants avec lien de soin |
Règles : un parent n'accède qu'à SES enfants (404 sinon) ; le rendez-vous d'un enfant ne donne **aucun** lien de soin avec le parent adulte (dossier, ordonnances et partage adulte distincts) ; une ordonnance pédiatrique exige le **poids** de l'enfant et un lien de soin pour cet enfant ; les rappels (prochaine dose saisie par un humain, 7 jours avant) ne contiennent ni nom d'enfant ni nom de vaccin.
**Volontairement absent** : courbes de référence OMS, percentiles / z-scores, calcul de dose pédiatrique, calendrier vaccinal pré-rempli. Ces données exigent des tables officielles et une validation par un pédiatre (et le programme élargi de vaccination du Sénégal) ; les inventer serait dangereux. L'interface affiche la courbe des seules mesures de l'enfant avec cet avertissement.
**Limites** : notes médicales, documents et messages ne sont pas rattachés à un enfant précis (ils restent au niveau du compte du parent) ; un seul représentant par enfant (pas de co-parent ni de tutelle vérifiée : la certification est déclarative) ; pas de justificatif de filiation.

### Étape 9 : soins à domicile
Parcours : prestataire (profil + justificatifs vérifiés par l'admin) > patient publie une demande (catégorie, zone, date, besoin court) > prestataires vérifiés de la bonne catégorie et zone envoient un devis (un seul par prestataire) > le patient compare (tri par coût total, note moyenne issue d'avis réels) et choisit > **une seule instruction SQL** attribue la demande, accepte le devis, refuse les autres et crée la mission > paiement Wave (retenue 30 min) ou règlement sur place > le prestataire déclare l'intervention terminée > le patient confirme > avis (possible uniquement après confirmation) ; litiges examinés par l'admin (remboursement tracé).
| Route | Accès |
|---|---|
| GET /api/care/categories, /api/care/providers | public (prestataires vérifiés) |
| POST/GET /api/provider/profile, GET /api/provider/requests, POST /api/provider/requests/:id/quote, GET /api/provider/quotes, /missions, /revenue | prestataire |
| POST/GET /api/care/requests, POST /api/care/requests/:id/accept, /cancel, GET /api/care/missions | patient |
| POST /api/missions/:id/cancel, declare-done, confirm-done, review, dispute | patient ou prestataire selon l'action |
| GET /api/admin/providers/pending, POST /api/admin/providers/:id/verify, GET /api/admin/disputes, POST /api/admin/disputes/:id/resolve | admin |
Confidentialité : les prestataires ne voient ni identité ni adresse avant confirmation (et paiement) ; l'adresse n'est communiquée qu'au prestataire retenu ; les notifications ne contiennent ni adresse ni nature des soins. Annulation par le patient : remboursement automatique si au moins 24 h avant la date souhaitée (règle à faire valider et à afficher), toujours si c'est le prestataire qui annule ou après décision de litige. Les paiements de missions utilisent le même registre, reçus et rapprochement que les rendez-vous.
**Limites** : la classification « profession réglementée / non médicale » des catégories est un choix technique à faire valider juridiquement ; pas de dépôt de justificatifs en ligne ; confirmation automatique après délai et versement automatique au prestataire non réalisés ; pas de planning horaire précis (date souhaitée seulement) ; pas de messagerie patient ↔ prestataire (la messagerie reste patient ↔ médecin) ; prestataires toujours à vérifier manuellement.

### Étape 10 : pharmacie
Acteurs : **pharmacien** (nouveau rôle ; s'inscrit en « en attente », l'admin vérifie l'autorisation d'ouverture), patient, admin. **Aucun médicament ni prix n'est fourni : le catalogue démarre vide** ; l'admin y ajoute des médicaments avec leur statut « sur ordonnance » (à faire valider par un pharmacien), chaque officine publie ses prix et quantités.
| Route | Accès |
|---|---|
| GET /api/pharmacy/list, /list/:id/stock, /catalogue | public (officines vérifiées ; « disponible / stock faible » sans quantités exactes) |
| POST/GET /api/pharmacy/profile, POST/GET /api/pharmacy/stock, GET /api/pharmacy/orders, POST /api/pharmacy/orders/:id/accept, ready, handover, reject | pharmacien |
| POST /api/pharmacy/orders, GET /api/pharmacy/my-orders, POST /api/pharmacy/orders/:id/cancel, POST /api/payments/checkout `{orderId}` | patient |
| GET /api/admin/pharmacies/pending, POST /api/admin/pharmacies/:id/verify, GET/POST /api/admin/drugs, POST /api/admin/drugs/:id/toggle | admin |
Règles : un médicament « sur ordonnance » exige une **ordonnance signée, au nom du patient, non annulée ni déjà délivrée, liée à une seule commande** ; à la remise le pharmacien doit confirmer avoir vérifié l'ordonnance et l'identité, et l'ordonnance passe à « délivrée » dans la même instruction (statut irréversible, protégé par déclencheur SQL : pas de double délivrance) ; le stock est décrémenté dans l'instruction qui crée la commande, avec une contrainte `CHECK (quantite>=0)` qui interdit toute survente même en concurrence ; annulation, refus ou expiration de la retenue (30 min) remettent le stock ; paiement Wave, reçu, remboursement et rapprochement identiques aux rendez-vous ; l'identité du patient, l'adresse et l'ordonnance ne sont visibles du pharmacien qu'après paiement/confirmation ; notifications sans nom de médicament.
**Limites** : aucun prix ni catalogue vérifié fournis (à charge des officines et d'un pharmacien conseil) ; pas de substances contrôlées/stupéfiants gérés spécifiquement ; ordonnances papier non gérées ; livraison = frais fixes par officine, sans suivi de livreur ; pas d'import CSV de stock ; pas d'interactions médicamenteuses ni de contrôle de posologie (volontairement) ; remboursement partiel et retours non gérés.

### Étape 11 : consultation vidéo / audio (Twilio Video)
Parcours : rendez-vous « vidéo » ou « audio » confirmé (et payé) > la salle ouvre **10 min avant** l'heure et ferme 30 min après la fin > le patient se signale en **salle d'attente** (le médecin est notifié, sans détail) > **seul le médecin ouvre la salle** (création côté serveur : 2 participants maximum, aucun enregistrement) > le patient reçoit alors son jeton et rejoint > le médecin termine (rendez-vous « terminé », salle fermée chez Twilio).
| Route | Accès |
|---|---|
| GET /api/consultations/config | public : vidéo configurée ou non, « jamais enregistrée » |
| GET /api/consultations/:rdv/status | patient ou médecin du rendez-vous |
| POST .../wait | patient (salle d'attente) |
| POST .../start, .../end | médecin |
| POST .../join | patient (après ouverture) ou médecin (reprise) |
| POST .../event | participants : joined, left, reconnecting, reconnected, audio_only, media_error, sdk_error, room_error |
| POST .../report-absence | patient (médecin absent > 15 min : annulation + remboursement automatique) ou médecin (patient jamais arrivé : « absent », sans remboursement automatique, règle à valider) |
Sécurité : jeton d'accès JWT (HS256, format Twilio) limité à **une salle et une identité** (`u_<id>`, aucun nom), durée bornée par la fin du créneau + 45 min (2 h max) pour permettre la reconnexion ; nom de salle aléatoire de 32 caractères, jamais dérivé de l'identifiant du rendez-vous ; clés uniquement dans l'environnement ; le SDK `twilio-video` 2.36.1 est **hébergé dans `public/vendor/`** avec contrôle d'intégrité (SRI) : aucune ressource externe chargée, la CSP n'autorise que les connexions vers `*.twilio.com`.
Résilience : reconnexion automatique du SDK avec message d'état, bouton « Se reconnecter » (nouveau jeton) après coupure franche, **audio seul** en un clic ou automatique si la caméra est refusée/absente, secours par la **messagerie** si le module vidéo ne charge pas ou si Twilio est indisponible, journal d'événements pour diagnostiquer.
Variables : `TWILIO_ACCOUNT_SID` (déjà utilisée pour les SMS), `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` (clé API créée dans la console Twilio, rubrique Video), optionnelle `TWILIO_VIDEO_ROOM_TYPE` (défaut `group`).
**Statut de Twilio Video (vérifié le 24/10/2026)** : le journal officiel de Twilio du 21/10/2024 annule la fin de vie annoncée (« Twilio Video will remain a standalone product ») et la FAQ actuelle confirme qu'il n'est pas abandonné et accepte de nouveaux clients ; les bannières « EOL » qui subsistent dans certains dépôts GitHub sont périmées. Le code isole le prestataire dans `lib/twilio-video.js` (jeton, création/fermeture de salle) et le client dans un seul bloc : changer de prestataire ne touche ni les règles d'accès ni les tests d'accès.
**Limites** : **non testé avec de vrais navigateurs, caméras et réseaux** (les tests simulent le SDK et l'API Twilio) ; consultation à deux seulement (pas d'accompagnant) ; partage d'écran, chat intégré et enregistrement non prévus (le chat passe par la messagerie) ; pas de test de débit avant l'appel (seulement un conseil « audio seul » quand le réseau est faible) ; la qualité en Afrique de l'Ouest dépend du réseau des utilisateurs et du routage de Twilio : à mesurer avant ouverture ; pas de solution de secours par appel téléphonique classique (cela exposerait des numéros).

Les requêtes POST exigent l'en-tête `X-Requested-With: kayligey` (anti-CSRF) et l'origine `APP_ORIGIN`.

## Variables d'environnement (Netlify > Site settings)
`DATABASE_URL`, `APP_ORIGIN`. Pour le premier admin (local uniquement) : `ADMIN_TEL`, `ADMIN_PASSWORD`.

## Déploiement
1. Créer une base Neon, copier `DATABASE_URL`.
2. `npm install` puis `npm run migrate` (variables dans `.env`).
3. `npm run create-admin` (`DATABASE_URL`, `ADMIN_TEL`, `ADMIN_PASSWORD` dans `.env`).
4. Pousser le dossier sur GitHub, connecter le dépôt à Netlify, définir les variables, déployer. Netlify installe les dépendances des fonctions.
5. `npm test` pour les tests unitaires.

## Limites connues (à ne pas ignorer)
- **Dossier médical :** testé sur PostgreSQL embarqué et avec un stockage de fichiers simulé en mémoire ; **Netlify Blobs réel non testé**. Aucune analyse antimalware (statut « non_analyse » affiché). Signature d'ordonnance = signature électronique **simple** (compte authentifié, empreinte du contenu), pas une signature qualifiée : à faire valider (Ordre des médecins, cadre sénégalais). Pas de statut « délivrée » (pas de rôle pharmacien). Chiffrement au repos : celui de l'hébergeur de base de données et de Blobs, pas de chiffrement applicatif par champ.
- Pédiatrie (courbes de croissance, carnet), vaccinations structurées, examens avec résultats, constantes en graphiques, suppression/rétention des données, sauvegardes et restauration testées : **non réalisés**.
- Conformité CDP, hébergement des données de santé, durées de conservation : validation juridique requise avant ouverture.
- **Notifications :** formats d'API Resend vérifiés dans sa documentation ; Twilio (formulaire To/From/Body, authentification Basic) d'après sa documentation habituelle, à valider avec un compte réel. Testés uniquement contre de faux serveurs. Vérifier auprès du fournisseur SMS l'expéditeur autorisé au Sénégal et les coûts. Pas de notifications « push » ni de temps réel : l'application interroge le serveur toutes les 60 s.
- Aucune vérification du numéro de téléphone à l'inscription pour l'instant.
- **Interface branchée sur l'API** (annuaire, créneaux, réservation, paiement Wave, mes rendez-vous, reprogrammation, annulation, reçus ; médecin : profil, créneaux, rendez-vous ; admin : comptes et médecins à valider). Les vues `medecins`, `rdv`, `agenda` (médecin) et `demandes` (admin) sont remplacées. **Pas encore migrés** : tableau de bord, calendrier, statistiques, les quelques écrans de statistiques et de calendrier locaux, qui lisent encore les anciennes données locales et peuvent donc afficher des rendez-vous qui n'existent pas sur le serveur.
- Tests d'intégration exécutés sur PostgreSQL embarqué (PGlite, connexion unique) : la logique est vérifiée, mais pas la concurrence réelle de plusieurs connexions ; à rejouer sur Neon.
- Justificatifs : l'admin atteste les avoir contrôlés ; le dépôt de fichiers n'existe pas encore.
- Paiements testés contre un **faux serveur Wave** (formats issus de docs.wave.com) : à valider avec un vrai compte Wave en mode test avant ouverture. Les noms d'événements du webhook ne sont pas utilisés pour décider ; seule la relecture de la session fait foi.
- Non réalisé : Orange Money et Free Money (pas d'API vérifiée ni de contrat), portefeuille interne, versement automatique aux médecins (le grand livre calcule les montants à verser), reçu PDF, remboursement partiel, litiges. Salle d'attente et visioconférence : étape suivante.
- Règles de commission et remboursement (2 h avant) à faire valider juridiquement et à afficher aux utilisateurs.
- La vérification du téléphone et l'envoi du code de réinitialisation exigent un fournisseur SMS : sans lui, **aucun code n'est livré** (événement `reset_not_delivered` dans le journal).
- Pas encore d'authentification multifacteur ni de validation des justificatifs (fichiers) : le statut « pending » est levé manuellement par un admin.
- Tests testés : utilitaires et refus CSRF. Les routes n'ont pas été testées contre une vraie base : à faire après l'étape de migration.
- **Frontend branché** : connexion, inscription et déconnexion passent par l'API (aucun repli local). Le compte administrateur codé en dur a été supprimé : créez-le avec `npm run create-admin`.
- Les données métier (rendez-vous, dossiers, paiements…) restent dans `localStorage` jusqu'aux étapes suivantes : aucune donnée médicale réelle ne doit y être saisie.
- Comptes locaux existants : au premier login serveur, le profil local est retrouvé par numéro de téléphone et conservé ; il faut d'abord créer le compte serveur correspondant (inscription).
- Le site ne fonctionne plus en ouvrant le fichier seul : l'API doit être déployée (Netlify).

## Mise à jour (28 oct. 2026)
- Nouveau `POST /api/auth/change-password` (mot de passe actuel exigé, 10 caractères minimum, autres appareils déconnectés, journalisé). L'écran « Profil » l'utilise désormais : avant, le changement ne restait que dans le navigateur.
- Écran de connexion : « Mot de passe oublié » branché sur `reset-request` / `reset-confirm` (code par SMS ; sans fournisseur SMS configuré, aucun code n'est envoyé et le message l'indique).
- Règle de mot de passe alignée entre interface et serveur (10 caractères).
- Libellé du rôle « pharmacien » corrigé (« undefined » affiché sur son tableau de bord).
- Rendez-vous synchronisés depuis le serveur à chaque connexion et navigation : le tableau de bord, le calendrier et les statistiques (patient et médecin) affichent désormais les vrais rendez-vous, et non plus d'anciennes données locales de démonstration. Les boutons « Rejoindre » / « Ouvrir la consultation » ouvrent la salle vidéo sécurisée du serveur (plus Google Meet / Jitsi pour ces rendez-vous). Le statut « vérifié » du médecin est lu sur le serveur.
- Reste local au navigateur (non migré) : stats et tableaux de bord de l'administrateur et du prestataire, messagerie des prestataires, portefeuille/parrainage. Ne pas y saisir de vraies données.
