// pacs-agent/ecosystem.config.cjs
//
// Mise en service de l'agent PACS d'un site sous pm2. A lancer depuis le
// dossier de l'agent (pacs-agent/, ou sa copie seule sur le PC Orthanc) :
//
//   npx pm2 start ecosystem.config.cjs
//
// Extension .cjs DELIBEREE : pm2 charge les fichiers ecosystem avec son
// propre require() interne, qui echoue sur un .js ordinaire des que
// package.json porte "type": "module" (c est le cas de pacs-agent/ comme du
// backend — "require is not defined", teste le 2026-11-24). .cjs force Node
// a traiter ce fichier en CommonJS, ce que le require() de pm2 attend.
//
// Voir docs/pacs-agent-deploiement-site.md pour la procedure complete
// (generation du jeton, TOTALIS_URL, test de connectivite, persistance au
// demarrage de Windows).
//
// Les valeurs reelles (jeton, id d etablissement, URL du site) vivent dans
// .env a cote de ce fichier, JAMAIS ici (ce fichier est commite) : voir
// .env.example pour le gabarit a copier sur chaque machine de site.
//
// process.loadEnvFile (Node >= 20.12) plutot que dotenv : l agent n a ainsi
// aucune dependance en dehors de son propre package.json. Il s execute quand
// pm2 CHARGE ce fichier (pm2 start, ou restart ecosystem.config.cjs
// --update-env), pas lors d un restart par nom.
const path = require("path");

process.loadEnvFile(path.join(__dirname, ".env"));

module.exports = {
  apps: [
    {
      name: "pacs-agent",
      script: path.join(__dirname, "agent.js"),
      cwd: __dirname,
      // Jamais plusieurs instances : deux agents sur le meme site
      // ecriraient/liraient le meme WORKLIST_DIR et le meme fichier d etat,
      // avec des traitements en double a la cle.
      instances: 1,
      exec_mode: "fork",
      // Les cycles ecrivent .state.json (et des .wl si WORKLIST_DIR est
      // dans ce dossier) : watch: true redemarrerait l agent en boucle sur
      // ses propres ecritures.
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        SITE_COMPANY_ID: process.env.SITE_COMPANY_ID,
        SITE_TOKEN: process.env.SITE_TOKEN,
        TOTALIS_URL: process.env.TOTALIS_URL,
        ORTHANC_URL: process.env.ORTHANC_URL,
        ORTHANC_USER: process.env.ORTHANC_USER,
        ORTHANC_PASSWORD: process.env.ORTHANC_PASSWORD,
        WORKLIST_DIR: process.env.WORKLIST_DIR,
        POLL_INTERVAL_MS: process.env.POLL_INTERVAL_MS,
        HEARTBEAT_INTERVAL_MS: process.env.HEARTBEAT_INTERVAL_MS,
        STATE_FILE: process.env.STATE_FILE,
      },
    },
  ],
};
