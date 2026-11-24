// pacs-agent/config.js
//
// Configuration de l'agent, lue depuis l'environnement. Lancé avec
// `node pacs-agent/agent.js`, les variables sont à poser avant (ou via un
// .env chargé par le process qui démarre l'agent — pm2, un service Windows,
// etc., voir pacs-agent/README.md).
import path from "path";
import { fileURLToPath } from "url";

function requis(nom) {
  const valeur = process.env[nom];
  if (!valeur) {
    throw new Error(`Variable d'environnement ${nom} manquante — voir pacs-agent/README.md`);
  }
  return valeur;
}

export const config = {
  totalisUrl: process.env.TOTALIS_URL || "http://localhost:3000/api",
  companyId: requis("SITE_COMPANY_ID"),
  siteToken: requis("SITE_TOKEN"),

  orthancUrl: process.env.ORTHANC_URL || "http://localhost:8042",
  orthancUser: process.env.ORTHANC_USER || undefined,
  orthancPassword: process.env.ORTHANC_PASSWORD || undefined,

  // Dossier "Database" du plugin Worklists d'Orthanc (worklists.json).
  worklistDir: process.env.WORKLIST_DIR || "C:/Orthanc/worklists",

  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 15000),
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS || 60000),

  // A cote de ce fichier, quel que soit le dossier d'ou l'agent est lance.
  stateFile: process.env.STATE_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), ".state.json"),
};
