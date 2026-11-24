# Agent PACS (site)

Fait le lien entre Totalis (cloud) et le PACS Orthanc installé sur le site.
Trois boucles : publie la worklist dans Orthanc (fichiers `.wl`), remonte les
études reçues vers Totalis, envoie un battement de cœur. Voir le doc de
référence "Totalis HIS — Intégration PACS (Orthanc + OHIF)" pour le circuit
complet, et [`docs/pacs-agent-deploiement-site.md`](../docs/pacs-agent-deploiement-site.md)
pour la procédure complète d'installation sur un site (y compris comment
joindre un backend Totalis non exposé directement sur Internet).

Ce dossier vit dans le dépôt backend pour réutiliser ses dépendances
(`axios`, `dcmjs`) sans gérer un second `node_modules` — mais c'est un
processus à part, lancé indépendamment du serveur Express.

## Prérequis

- Orthanc en cours d'exécution, avec le plugin **Worklists activé** et
  pointé vers un dossier réel (`worklists.json` : `"Enable": true`,
  `"Database": "<chemin>"` — nécessite les droits admin pour l'éditer sous
  Windows, voir `C:\Program Files\Orthanc Server\Configuration\`).
- Un jeton d'agent pour l'établissement : `POST /api/company/:companyId/pacs-agent/token`
  (rôle `ADMINISTRATEUR` ou `SUPER ADMIN`) — le jeton n'est montré qu'une
  fois, à copier dans `SITE_TOKEN` tout de suite.

## Variables d'environnement

| Variable | Obligatoire | Défaut | Rôle |
|---|---|---|---|
| `SITE_COMPANY_ID` | oui | — | `_id` Mongo de l'établissement |
| `SITE_TOKEN` | oui | — | Jeton d'agent (voir ci-dessus) |
| `TOTALIS_URL` | non | `http://localhost:3000/api` | Base de l'API Totalis |
| `ORTHANC_URL` | non | `http://localhost:8042` | API REST d'Orthanc (pas le port DICOM 4242) |
| `ORTHANC_USER` / `ORTHANC_PASSWORD` | non | — | Si l'authentification Orthanc est activée |
| `WORKLIST_DIR` | non | `C:/Orthanc/worklists` | Doit correspondre à `Database` dans `worklists.json` |
| `POLL_INTERVAL_MS` | non | `15000` | Cadence worklist + études |
| `HEARTBEAT_INTERVAL_MS` | non | `60000` | Cadence battement de cœur |
| `STATE_FILE` | non | `pacs-agent/.state.json` | Curseur worklist + séquence `/changes` Orthanc |

## Lancer

```powershell
$env:SITE_COMPANY_ID = "..."
$env:SITE_TOKEN = "..."
node pacs-agent/agent.js
```

## Vérifier le générateur de worklist sans toucher à Orthanc ni Totalis

```powershell
node pacs-agent/scripts/smoke-test-worklist.js
```
Écrit un `.wl` d'exemple et le relit avec `dcmjs` pour confirmer qu'il est
bien formé — utile en l'absence de DCMTK (`findscu`/`dcmdump`) sur la machine.

## Limites connues (circuit minimal, à affiner à l'usage)

- `PatientName` est reconstruit depuis `Patient.name` (texte libre) par une
  heuristique "premier mot = prénom" — imprécis si le nom saisi a un format
  différent. Un vrai correctif demande des champs nom/prénom séparés côté
  `Patient`.
- Le battement de cœur n'envoie pas encore l'espace disque réel
  (`disqueLibreGo`).
- Pas de file de retry persistée au-delà du fichier d'état : un échec HTTP
  vers Totalis est simplement relogué au prochain cycle (15 s plus tard),
  sans backoff exponentiel séparé — suffisant pour valider le circuit, à
  muscler avant un vrai déploiement.
