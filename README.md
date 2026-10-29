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

## Installation sur le serveur (là où tourne Claude Code)

```sh
git clone https://github.com/asayet44/running-fiouf app-running && cd app-running
cp users.example.json users.json
node server.js hash 'mot-de-passe-du-coureur'   # à coller dans "password"
```

Dans `users.json`, pour chaque coureur :

- `athleteId` : l'id intervals.icu (ex. `i769106`), visible dans l'URL de son profil.
- `apiKey` : intervals.icu › Settings › Developer Settings › API Key, **sur le compte du coureur**.
- `dir` : le dossier de son projet Claude (celui qui contient ses notes). Il doit exister.

Lancer :

```sh
SESSION_SECRET=$(openssl rand -hex 32) PORT=3000 node server.js
npm test   # vérifie la logique
```

Pour qu'elle tourne en permanence, un service systemd suffit (ou une « Custom App » TrueNAS qui lance la même commande) :

```ini
[Service]
WorkingDirectory=/chemin/app-running
Environment=SESSION_SECRET=<secret fixe, sinon tout le monde est déconnecté au redémarrage>
Environment=PORT=3000
ExecStart=/usr/bin/node server.js
Restart=always
User=<l'utilisateur sous lequel Claude Code est connecté>
```

Le service doit tourner sous **le même utilisateur que Claude Code**, sinon `claude` ne sera pas connecté.

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
