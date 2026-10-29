# App running

Une petite app web mobile, une par coureur, au-dessus d'intervals.icu :

- **Connexion** : chaque coureur ne voit que ses données.
- **Ma semaine** : une carte par séance prévue ou faite, et le bilan en bas (km, durée, score, séances faites).
- **Détail d'une séance** : prévu vs réalisé, part facile / soutenu / dur, et **l'avis du coach** généré par Claude Code.
- **Profil** : objectif et « Ce que mon coach doit savoir sur moi ».

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
| `<pool>/apps/app-running/config` | `/config` | `users.json` (comptes des coureurs) |
| `<pool>/apps/app-running/data` | `/data` | avis du coach en cache + connexion Claude |

Les dossiers des projets des coureurs (là où sont leurs notes / `CLAUDE.md`) sont montés tels quels dans `/runners/running` et `/runners/fiouf`.
L'utilisateur `apps` (568) doit pouvoir y écrire : l'app y enregistre `CONTEXTE.md` depuis la page Profil.

**2. Accès à l'image** : le dépôt est privé, donc l'image aussi. Au choix :
- GitHub › Packages › running-fiouf › Package settings › *Change visibility* › Public (l'image ne contient aucun secret) ;
- ou, dans TrueNAS, Apps › Configuration › *Manage Container Images* / registre `ghcr.io` avec un token GitHub `read:packages`.

**3. Secrets** :
- `SESSION_SECRET` : `openssl rand -hex 32`.
- `CLAUDE_CODE_OAUTH_TOKEN` : sur une machine où Claude Code est connecté, `claude setup-token`. C'est ce qui permet au conteneur de lancer Claude avec ton abonnement.

**4. `users.json`** dans le dataset `config`, à partir de `users.example.json`, un bloc par coureur :
- `athleteId` : `i768176` (Running), `i769106` (Fiouf).
- `apiKey` : intervals.icu › Settings › Developer Settings › API Key, **sur le compte du coureur**.
- `dir` : `/runners/running` ou `/runners/fiouf`.
- `password` : `docker run --rm ghcr.io/asayet44/running-fiouf node server.js hash 'mot de passe'`.

**5. Lancer** : Apps › Discover Apps › ⋮ › *Install via YAML*, coller `docker-compose.yml` en remplaçant `<pool>`, les chemins et les deux secrets.
L'app répond sur `http://<IP du TrueNAS>:3000`.

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
