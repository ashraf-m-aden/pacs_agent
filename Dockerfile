# ============================================================
#  Agent PACS de site — image de production
#  Tourne sur le PC Orthanc d'un hôpital. Voir docker-compose.yml
#  pour les deux montages indispensables (worklists + état).
# ============================================================
FROM node:22-alpine

# Sécurité : ne pas tourner en root (même convention que le backend).
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Couche de cache séparée : les dépendances ne changent qu'avec
# package*.json. `--omit=dev` écarte pm2 (rangé en devDependencies) : sous
# Docker, c'est `restart: unless-stopped` qui redémarre l'agent, un
# superviseur de processus dans le conteneur ferait doublon.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# /data porte le fichier d'état (curseur worklist + séquence /changes
# d'Orthanc). Créé et donné à appuser ICI : un volume monté sur un dossier
# inexistant appartiendrait à root, et l'agent ne pourrait pas y écrire.
RUN mkdir -p /data && chown -R appuser:appgroup /app /data
USER appuser

ENV NODE_ENV=production \
    STATE_FILE=/data/.state.json \
    WORKLIST_DIR=/worklists

# L'agent n'expose aucun port : toutes ses connexions sont sortantes (vers
# Orthanc en local et vers Totalis). Rien à EXPOSE, rien à ouvrir.

# Pas de serveur HTTP à interroger : la santé se lit sur la fraîcheur du
# fichier d'état, réécrit à chaque cycle worklist. S'il cesse d'être touché,
# l'agent ne synchronise plus (Totalis injoignable, jeton invalide, boucle
# bloquée) — même quand le process, lui, est toujours vivant.
HEALTHCHECK --interval=60s --timeout=10s --start-period=45s --retries=3 \
  CMD node -e "const f=process.env.STATE_FILE,m=require('fs').statSync(f).mtimeMs,a=Date.now()-m,l=3*Number(process.env.POLL_INTERVAL_MS||15000);if(a>l){console.error('etat fige depuis '+Math.round(a/1000)+'s');process.exit(1)}"

# `node agent.js` et non `npm start` : le script npm passe --env-file=.env,
# or .env n'est volontairement PAS dans l'image (voir .dockerignore). La
# configuration arrive par l'environnement, via `env_file` du compose.
CMD ["node", "agent.js"]
