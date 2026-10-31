# App running

Une petite app web mobile, une par coureur, au-dessus d'intervals.icu :

- **Création de compte dans l'app** : e-mail, mot de passe et clé API intervals.icu (vérifiée), au premier passage.
- **Connexion** : chaque coureur ne voit que ses données.
- **Ma semaine** : une carte par séance prévue ou faite, et le bilan en bas (km, durée, score, séances faites).
- **Détail d'une séance faite** : prévu vs réalisé, part facile / soutenu / dur, et **l'avis du coach** généré par Claude Code (avec « Refaire l'analyse »).
  En dessous, l'onglet repliable **Analyse détaillée** : carte du parcours (OpenStreetMap), résumé, temps au km et courbe d'allure.
- **Progrès** : km par semaine sur les 12 dernières semaines, détail de la semaine choisie et série de semaines actives.
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

## Connecter à Claude.ai (connecteur MCP)

L'app est aussi un connecteur pour Claude.ai : depuis n'importe quel projet Claude, on peut lire le profil du coureur
(notes, paramètres, historique), lui **ajouter une note** pour le coach, **corriger ses paramètres** et lire **les derniers avis du coach**.
Les séances elles-mêmes restent dans intervals.icu (connecteurs déjà existants).

1. Rendre l'app joignable en HTTPS depuis internet, **uniquement pour les adresses `/mcp/…`**. Par exemple :
   - Tailscale Funnel : `tailscale funnel --bg --set-path /mcp http://<IP du TrueNAS>:3000/mcp`
   - Cloudflare Tunnel : une règle d'entrée `path: ^/mcp/` vers `http://<IP du TrueNAS>:3000`, puis `http_status:404` pour le reste.
2. Mettre cette adresse dans `PUBLIC_URL` (compose), ex. `https://fiouf-case.xxx.ts.net`.
3. Chaque coureur, dans **Profil › Connecter à Claude**, clique sur « Créer mon lien Claude » et colle le lien dans
   Claude.ai › Paramètres › Connecteurs › *Ajouter un connecteur personnalisé*.

Le lien contient un secret propre au coureur (pas d'OAuth) : qui l'a peut lire et modifier ses notes et paramètres.
« Changer le lien » en crée un nouveau et désactive l'ancien.

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
| `PUBLIC_URL` | adresse HTTPS publique, pour afficher le lien du connecteur Claude |
