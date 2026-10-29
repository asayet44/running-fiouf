# App running

Une petite app web mobile, une par coureur, au-dessus d'intervals.icu :

- **Création de compte dans l'app** : e-mail, mot de passe et clé API intervals.icu (vérifiée), au premier passage.
- **Connexion** : chaque coureur ne voit que ses données.
- **Ma semaine** : une carte par séance prévue ou faite, et le bilan en bas (km, durée, score, séances faites).
- **Détail d'une séance faite** : prévu vs réalisé, part facile / soutenu / dur, et **l'avis du coach** généré par Claude Code (avec « Refaire l'analyse »).
- **Détail d'une séance à venir** : le déroulé étape par étape avec les zones visées en bpm.
- **Profil** : prénom, « Ce que mon coach doit savoir sur moi », et **Mes paramètres** (FC max, seuil, repos, allure seuil, VO2max, zones)
  remplis depuis intervals.icu, corrigeables à la main, avec l'historique de leur évolution.

Les données sont relues en direct sur intervals.icu à chaque ouverture de page.

Pas de dépendance ni de build : un seul fichier `server.js` (Node 22+).

## Comment marche l'avis du coach

Le bouton « Demander l'avis du coach » lance sur le serveur :

```
claude -p --model opus --effort medium --output-format json --tools "" --no-session-persistence
```

dans le dossier `dir` du coureur. Claude y lit donc automatiquement le `CLAUDE.md` du projet du coureur (ses notes). Le prompt contient en plus :
la séance réalisée, la séance prévue, les séances des 7 prochains jours, le texte du Profil (`CONTEXTE.md` dans ce même dossier) et les 3 derniers avis.
L'avis est gardé dans `data/<coureur>/<activité>.json` : il n'est généré qu'une fois.

Ça utilise le compte Claude déjà connecté sur le serveur : pas de clé API Anthropic.

## Installation sur TrueNAS (Docker)

À chaque push sur `main`, GitHub publie l'image `ghcr.io/asayet44/running-fiouf:latest` (onglet Actions).

**1. Datasets à créer** (Datasets › Add Dataset, preset *Apps*, propriétaire `apps` / uid 568) :

| Dataset | Monté dans le conteneur | Contenu |
|---|---|---|
| `<pool>/apps/app-running/config` | `/config` | `users.json`, créé et rempli par l'app à chaque création de compte |
| `<pool>/apps/app-running/data` | `/data` | avis du coach en cache + connexion Claude |

Par défaut, le contexte de chaque coureur est le texte de sa page Profil (gardé dans `data`) : colles-y ses notes de coureur.
Optionnel : si les dossiers des projets Claude des coureurs sont sur le TrueNAS, monte-les sous `/runners/` (ligne commentée du compose) ;
chaque coureur choisit alors le sien à la création de son compte et Claude y lit aussi son `CLAUDE.md`.
L'utilisateur `apps` (568) doit pouvoir y écrire : l'app y enregistre `CONTEXTE.md` depuis la page Profil.

**2. Accès à l'image** : le dépôt est privé, donc l'image aussi. Au choix :
- GitHub › Packages › running-fiouf › Package settings › *Change visibility* › Public (l'image ne contient aucun secret) ;
- ou, dans TrueNAS, Apps › Configuration › *Manage Container Images* / registre `ghcr.io` avec un token GitHub `read:packages`.

**3. Secrets** :
- `SESSION_SECRET` : `openssl rand -hex 32`.
- `CLAUDE_CODE_OAUTH_TOKEN` : sur une machine où Claude Code est connecté, `claude setup-token`. C'est ce qui permet au conteneur de lancer Claude avec ton abonnement.

**4. Lancer** : Apps › Discover Apps › ⋮ › *Install via YAML*, coller `docker-compose.yml` en remplaçant `<pool>`, les chemins et les deux secrets.
L'app répond sur `http://<IP du TrueNAS>:3000` : chaque coureur clique sur « Créer mon compte ».
Pour que seuls tes coureurs puissent créer un compte, ajoute `SIGNUP_CODE` et donne-leur ce code.

Sans Docker : `SESSION_SECRET=... node server.js` (Node 22+), sous l'utilisateur où Claude Code est connecté.

## Sécurité

Pas de limite de tentatives de connexion : n'exposez pas l'app directement sur Internet. Passez par un VPN (Tailscale, WireGuard)
ou un reverse proxy HTTPS. Derrière un proxy HTTPS qui envoie `X-Forwarded-Proto: https`, le cookie de session passe en `Secure`.

## Variables

| Variable | Défaut |
|---|---|
| `SESSION_SECRET` | obligatoire, 16 caractères min. |
| `PORT` | `3000` |
| `USERS_FILE` | `./users.json` |
| `DATA_DIR` | `./data` |
| `CLAUDE_BIN` | `claude` |
| `RUNNERS_DIR` | `./runners` (`/runners` dans Docker) |
| `SIGNUP_CODE` | vide = création de compte libre |
