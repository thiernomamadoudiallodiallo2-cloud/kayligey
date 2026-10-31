# Kayligey — rapport de tests, intégrations restantes et validations avant ouverture

## 1. Rapport de tests (83 tests automatiques + vérifications d'interface)
Environnement : PostgreSQL embarqué (PGlite, une seule connexion), faux serveurs Wave / Resend / Twilio, stockage de fichiers en mémoire, interface chargée dans un faux navigateur (jsdom) avec un faux serveur. **Aucun test n'a été fait sur un vrai déploiement, une vraie base distante, de vrais fournisseurs ni de vrais appareils.**

| # | Parcours demandé | Résultat | Limites restantes |
|---|---|---|---|
| 1 | Création d'un compte patient | Réussi (auto) | Pas de vérification du numéro de téléphone |
| 2 | Connexion / déconnexion | Réussi (cookie HttpOnly/Secure/SameSite, jeton haché, invalidation serveur, expiration, verrouillage, compte suspendu) | MFA non implémentée |
| 3 | Réinitialisation du mot de passe | Réussi avec un faux SMS (code à usage unique, 5 essais, sessions révoquées) | Sans SMS configuré, le code n'est pas livré |
| 4 | Inscription et validation d'un médecin | Réussi (compte « en attente », validation admin, vérification du profil) | Pas de dépôt de justificatifs : l'admin atteste les avoir contrôlés |
| 5 | Inscription et validation d'un prestataire | Réussi (n° d'inscription exigé pour les professions réglementées, vérification admin, retrait si modifié) | Pas de dépôt de justificatifs en ligne |
| 6 | Recherche d'un médecin | Réussi | — |
| 7 | Réservation d'un créneau | Réussi (retenue 15 min si paiement en ligne) | — |
| 8 | Même créneau, deux patients | Réussi (un seul gagne ; index unique) | Concurrence réelle multi-connexions à rejouer sur Neon |
| 9 | Annulation et reprogrammation | Réussi (règle des 2 h, remboursement) | — |
| 10 | Téléconsultation et échec réseau | Réussi côté serveur (salle d'attente verrouillée, jetons limités à une salle et un utilisateur, fenêtre horaire, fin de consultation, absences, panne du service). Interface testée avec un **faux SDK** : reconnexion, audio seul, secours messagerie, SDK absent | **Jamais testé avec de vraies caméras, de vrais navigateurs ni de vrais réseaux** ; test réel avec un compte Twilio obligatoire ; qualité en Afrique de l'Ouest à mesurer |
| 11 | Envoi et lecture d'un document | Réussi (contenu vérifié, lien 5 min lié à l'utilisateur) | Pas d'antimalware ; Netlify Blobs réel non testé |
| 12 | Création et lecture d'une ordonnance | Réussi (brouillon > signée > annulée, immuable, vérification publique) | Signature simple, pas qualifiée ; pas de statut « délivrée » |
| 13 | Gestion des enfants | Réussi (isolation, autorisations, carnet, ordonnance avec poids) | Pas d'OMS/percentiles ; représentant déclaratif |
| 14 | Commande de pharmacie | Réussi (catalogue vide administrable, stock par officine sans survente, ordonnance obligatoire et « délivrée » irréversible, paiement, annulation/refus avec remise en stock et remboursement) | **Aucun catalogue ni prix fournis** ; règles de délivrance, substances contrôlées et partenaires à faire valider par des pharmaciens |
| 15 | Demande de soins à domicile | Réussi (demande, devis, choix atomique, paiement Wave, réalisation, avis, litige, remboursement, confidentialité de l'adresse) | Classement réglementé/non médical à valider ; confirmation et versement automatiques non faits |
| 16 | Paiement confirmé / échoué / attente / remboursement | Réussi contre un faux Wave (signature, relecture, montant, rejeu, paiement tardif, remboursement, reprise admin) | **Valider avec un vrai compte Wave** ; chemin « échoué » peu couvert ; Orange/Free Money absents |
| 17 | Réception d'une notification | Réussi (application ; e-mail/SMS contre faux serveurs ; 5 tentatives) | Fournisseurs réels non testés |
| 18 | Accès non autorisé à un dossier | Réussi (lien de soin + autorisation, expiration, révocation, admin exclu, enfants/adultes séparés) | — |
| 19 | Patient vers fonctions admin | Réussi (matrice de rôles sur 17 routes) | — |
| 20 | Urgence SOS et échec de transmission | **Corrigé pour être honnête** : il n'y a plus d'« alerte » simulée. Le bouton ouvre une aide qui affiche le 1515 et le 18 (appel en un tap), la position (GPS avec autorisation, ou saisie manuelle) et prépare un SMS à un proche que la personne envoie elle-même. L'ancien enregistrement local d'alertes avec données de santé a été supprimé | **Aucune alerte n'est transmise à un hôpital ou aux secours** : à n'ajouter qu'avec un service de réception réel, des contacts d'urgence validés par zone et des règles de triage validées par des professionnels |
| 21 | Sauvegarde et restauration | Réussi en logique (chiffrement, altération détectée, base identique, séquences, immuabilité conservée) | Restauration réelle à tester ; fichiers Blobs hors sauvegarde |
| 22 | Smartphone et ordinateur | **Non testé sur appareils** (CSS adaptatif seulement) | Test manuel obligatoire |
| 23 | Erreurs JavaScript | 0 erreur sur les parcours simulés (patient, médecin, admin) | Les modules non migrés n'ont pas été re-testés un par un |
| 24 | Migration des données existantes | **Partiel** : le profil local est retrouvé par téléphone | Rendez-vous, dossiers et paiements locaux **ne sont pas migrés** vers le serveur |

Sécurité transversale testée : CSRF et origine sur 16 routes d'écriture, injections SQL dans filtres et connexion, corps JSON malformés, absence de fuite d'erreur, purge des données techniques, demande de suppression de compte (anonymisation, conservation du dossier médical). `npm audit` : 0 vulnérabilité connue dans les dépendances de production au moment du test.

## 2. Intégrations externes encore nécessaires
| Intégration | État | Condition |
|---|---|---|
| Wave Business | Code prêt, testé sur faux serveur | Compte, clé API, secret de webhook, test réel |
| Orange Money, Free Money | Non réalisé | Contrat marchand + documentation API officielle |
| E-mail (Resend) | Code prêt | Domaine d'envoi vérifié |
| SMS (Twilio ou fournisseur local) | Code Twilio prêt | Expéditeur autorisé au Sénégal, coûts ; un opérateur local peut être préférable |
| Visioconférence (Twilio Video) | Code prêt, testé sur faux SDK/faux API | Compte Twilio, clé API Video, test réel sur appareils ; vérifier pays d'hébergement des médias et sous-traitance |
| Antimalware sur fichiers | Non réalisé | Service d'analyse (ex. ClamAV hébergé) |
| Transmission d'alertes d'urgence | Volontairement non réalisée | Service de réception réel, contacts d'urgence validés par zone, procédure en cas d'échec de transmission, validation médicale |
| Catalogue de médicaments et prix | À fournir | Données validées par un pharmacien (aucun médicament ni prix n'est inventé) |
| Tables OMS, calendrier vaccinal | Non réalisé | Données officielles validées par un pédiatre / programme national |
| Authentification multifacteur | Non réalisé | TOTP ou SMS ; au minimum pour médecins et admins |

## 3. Points à faire valider avant l'ouverture au public (je ne peux pas les valider moi-même)
**Protection des données (Sénégal).** La loi n° 2008-12 du 25 janvier 2008 est appliquée par la CDP (Commission de Protection des Données Personnelles). D'après les avis publiés par la CDP, une déclaration est la règle, mais **l'autorisation préalable s'applique notamment au traitement de données de santé et au stockage de données à l'étranger** ; le consentement préalable des personnes est exigé et l'article 71 impose des mesures de sécurité adaptées. Formulaires : cdp.sn. À faire avec un juriste : dépôt de la demande d'autorisation, choix de la région d'hébergement (Neon/Netlify sont hors du Sénégal), contrat avec les sous-traitants (Neon, Netlify, Wave, Resend, Twilio), durées de conservation, procédure de notification des incidents, mentions légales et politique de confidentialité. Un projet de réforme de la loi a été évoqué : vérifier la version en vigueur.
**Vidéo.** Traitement des flux audio/vidéo par Twilio (sous-traitant hors du Sénégal) : à mentionner dans l'information des patients et le dossier CDP ; aucune consultation n'est enregistrée par la plateforme ; règles sur le consentement à la téléconsultation et l'identification du patient.
**Santé et télémédecine.** Cadre de la télémédecine et de la prescription à distance, Ordre des médecins (vérification des diplômes et numéros d'ordre), valeur juridique de la signature d'ordonnance, règles de conservation du dossier médical, responsabilité de la plateforme.
**Médical.** Règles de triage du SOS et de l'assistant, contenu des FAQ et conseils d'urgence, calendrier vaccinal et courbes de croissance, relecture des messages envoyés aux patients.
**Pharmacie.** Règles de délivrance (ordonnance, substances contrôlées, ordonnances renouvelables), contenu et statut « sur ordonnance » du catalogue, prix, vérification des autorisations d'ouverture, responsabilité du pharmacien et de la plateforme, vente à distance et livraison de médicaments.
**Soins à domicile.** Qualifications exigées par catégorie, classement réglementé/non médical des catégories, règle de remboursement des annulations, responsabilité de la plateforme entre patient et prestataire.
**Paiement et finances.** Contrat Wave, commission et conditions de remboursement affichées aux utilisateurs, fiscalité, comptabilité des montants à verser aux médecins (versement non automatisé).
**Sécurité.** Test d'intrusion par un tiers, revue du CSP (`unsafe-inline` requis tant que l'interface reste un fichier unique), MFA, journalisation centralisée et alertes, plan de réponse aux incidents, test de restauration réel, revue des accès aux comptes d'hébergement.
**Ne revendiquez aucune certification ou conformité** (CDP, HDS, ISO…) tant qu'elle n'est pas obtenue.

## 4. Ce qui reste en stockage navigateur (à ne pas utiliser avec de vraies données)
SOS, tableaux de bord et statistiques locales, calendrier, anciens rendez-vous et dossiers locaux. Un avertissement est affiché sur ces écrans.
