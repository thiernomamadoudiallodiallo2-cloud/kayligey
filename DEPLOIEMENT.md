# Déployer Kayligey (Netlify + Neon) — pas à pas

## 0. Windows : préparer le terminal (PowerShell)
Toutes les commandes `npm run ...` lisent maintenant automatiquement le fichier `.env` à la racine du projet : **plus besoin** d'écrire `DATABASE_URL=...` devant la commande (cette syntaxe ne fonctionne pas sous PowerShell).
```powershell
node -v                      # doit afficher v20 ou plus ; sinon installer Node LTS depuis nodejs.org
cd C:\chemin\vers\kayligey   # le dossier qui contient package.json
npm install
copy .env.example .env       # puis ouvrir .env avec le Bloc-notes et remplir DATABASE_URL, APP_ORIGIN, etc.
```
Le fichier `.env` n'est jamais envoyé sur GitHub (il est dans `.gitignore`).

Durée : 1 à 2 h. **Ne pas ouvrir au public avant d'avoir fait `CONFORMITE.md`.**

## 1. Base de données (Neon)
1. Créer un compte sur neon.tech, un projet « kayligey », choisir une région proche (Europe ou autre selon la décision de conformité, voir CONFORMITE.md §3).
2. Copier la chaîne de connexion (avec `sslmode=require`) : c'est `DATABASE_URL`.
3. Sur votre ordinateur : `npm install`, puis `npm run migrate`.
4. Créer le premier administrateur : `npm run create-admin` (avec `DATABASE_URL`, `ADMIN_TEL` et `ADMIN_PASSWORD` dans le fichier `.env`) (mot de passe de 10+ caractères, lettres et chiffres). Ne conservez ces valeurs nulle part ensuite.
5. Activer la restauration à un instant donné (point-in-time restore) dans les réglages Neon et noter la durée de rétention du forfait.

## 2. Netlify
1. Mettre le dossier dans un dépôt GitHub **privé** (ne jamais publier `.env`).
2. Netlify > Add new site > Import from Git. Build command : vide. Publish directory : `public` (déjà dans `netlify.toml`).
3. Site settings > Environment variables, ajouter :

| Variable | Obligatoire | Rôle |
|---|---|---|
| `DATABASE_URL` | oui | connexion Neon |
| `APP_ORIGIN` | oui | `https://votre-site.netlify.app` (ou domaine final) : contrôle CSRF et retours de paiement |
| `DOC_LINK_SECRET` | oui | 32+ caractères aléatoires (sous Windows : `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) : liens de téléchargement |
| `WAVE_API_KEY`, `WAVE_WEBHOOK_SECRET` | pour payer en ligne | voir §3 ; sans elles : « règlement sur place » |
| `WAVE_SIGNING_SECRET` | optionnel | signature des requêtes sortantes si activée chez Wave |
| `COMMISSION_BPS` | optionnel | 1000 = 10 % |
| `RESEND_API_KEY`, `MAIL_FROM` | pour e-mails | domaine d'envoi vérifié chez Resend |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | pour SMS | y compris le code de réinitialisation du mot de passe |
| `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` | pour la vidéo | console Twilio > Video > Tools > API Keys (le secret n'est affiché qu'une fois) ; `TWILIO_ACCOUNT_SID` est aussi requis |
| `BACKUP_KEY` | pour sauvegardes | 16+ caractères ; **à conserver dans un gestionnaire de mots de passe : sans elle, aucune restauration** |

4. Déployer. Les fonctions `api` (toutes les routes `/api/*`) et `cron-notifications` (toutes les 5 minutes : rappels, envois, purge) sont détectées automatiquement. Vérifier dans Netlify > Functions que la tâche planifiée apparaît.
5. Domaine personnalisé + HTTPS : Domain management (certificat automatique). Mettre à jour `APP_ORIGIN`, puis redéployer.

## 3. Wave (paiement)
1. Compte Wave Business, accès au portail développeur, créer une clé API (`WAVE_API_KEY`).
2. Enregistrer `https://VOTRE-DOMAINE/api/webhooks/wave` comme URL de webhook ; copier le secret de webhook (`WAVE_WEBHOOK_SECRET`). Un seul webhook par clé : utiliser une clé distincte pour les tests.
3. Faire un paiement de test de bout en bout (réservation > paiement > webhook > rendez-vous « Confirmé » > reçu), puis un remboursement (annulation par le médecin). Vérifier `/api/admin/reconciliation` (aucune anomalie).

## 4. Vérifications après déploiement
- `npm run smoke` (avec `SITE_URL=https://VOTRE-DOMAINE` dans `.env`) : en-têtes de sécurité, API protégée, webhook, 404, robots.
- Créer un patient, un médecin ; valider le médecin avec l'admin ; réserver, payer, écrire un message, déposer un document, signer une ordonnance, autoriser/retirer le partage. Contrôler que les notifications arrivent (e-mail/SMS si configurés).
- **Vidéo** : avec deux appareils (idéalement un smartphone en 4G et un ordinateur), réserver un rendez-vous vidéo, payer, ouvrir la salle côté médecin, rejoindre côté patient ; couper le réseau 20 secondes (vérifier la reconnexion), passer en audio seul, refuser la caméra, terminer la consultation. Si la console Twilio reste vide, la clé API ou le compte sont mal configurés (les erreurs apparaissent dans `consultation_events` et `audit_log`).
- Tester sur un vrai smartphone (réseau 3G/4G) et un ordinateur.

## 5. Sauvegardes et restauration
- Sauvegarde logique chiffrée : `npm run backup` (`DATABASE_URL` et `BACKUP_KEY` dans `.env`) (fichier `.kbk`). Une version automatique quotidienne est fournie dans `.github/workflows/backup.yml` (secrets GitHub `DATABASE_URL`, `BACKUP_KEY`).
- **Restauration** : créer une base **neuve**, `npm run migrate`, puis `npm run restore fichier.kbk` (avec `DATABASE_URL` pointant vers la base neuve). La restauration refuse une base non vide.
- **À faire une fois avant l'ouverture : restaurer une sauvegarde réelle dans une base de test et ouvrir le site dessus.** Les tests automatiques prouvent la logique, pas votre configuration.
- Les **documents** (Netlify Blobs) ne sont pas dans la sauvegarde logique : prévoir leur export séparé (API Netlify Blobs) ou accepter ce risque en connaissance de cause.
- Neon propose aussi le retour à un instant donné : c'est le premier recours en cas d'erreur humaine.

## 6. Exploitation
- Journal d'audit (table `audit_log`), échecs d'envoi (`/api/admin/notifications`), anomalies de paiement (`/api/admin/reconciliation`) : à consulter chaque jour au début.
- Incident de sécurité : suspendre les comptes concernés (`/api/admin/users/:id/status`), changer `DOC_LINK_SECRET`, `WAVE_*`, `DATABASE_URL`, puis redéployer ; prévenir les personnes concernées et la CDP selon l'avis juridique.
- Mise à jour : `npm run migrate` avant chaque déploiement qui modifie `db/schema.sql` (les instructions sont idempotentes).
