# Agent PACS (site)

Fait le lien entre Totalis (cloud) et le PACS Orthanc installé sur le site.

Cinq boucles, toutes en connexions **sortantes** — Totalis ne peut initier
aucune connexion vers le réseau de l'hôpital :

| Boucle | Cadence | Rôle |
|---|---|---|
| `worklist` | `POLL_INTERVAL_MS` (15 s) | publie la worklist dans Orthanc (fichiers `.wl`) |
| `études` | 15 s | remonte vers Totalis les études reçues (`/changes` d'Orthanc) |
| `commandes` | 15 s | exécute les actions demandées depuis l'interface (C-ECHO) |
| `modalités` | `HEARTBEAT_INTERVAL_MS` (60 s) | reflète l'inventaire des appareils dans la config DICOM d'Orthanc |
| `heartbeat` | 60 s | signale que l'agent est vivant |

L'agent **ne parle jamais DICOM lui-même** : il passe par l'API REST
d'Orthanc (port 8042), qui parle le DICOM à sa place. C'est ce qui lui
permet de déclarer des appareils et de lancer des C-ECHO sans embarquer de
pile DICOM.

**Dépôt autonome.** Aucun import du backend Totalis, ses propres dépendances
(`axios`, `dcmjs`). Sur un site, on déploie **uniquement ce dépôt** sur le PC
Orthanc — le serveur Totalis n'y est jamais installé.

Documentation complémentaire, qui vit dans le dépôt **backend** parce qu'elle
décrit autant le côté Totalis que l'agent :

- `docs/pacs-agent-deploiement-site.md` — procédure complète d'installation
  sur un site : génération du jeton dans Totalis, et comment joindre un
  backend Totalis qui n'est pas exposé directement sur Internet.
- Doc de référence « Totalis HIS — Intégration PACS (Orthanc + OHIF) » pour
  le circuit fonctionnel complet.

## Prérequis

- Orthanc en cours d'exécution, avec le plugin **Worklists activé** et
  pointé vers un dossier réel (`worklists.json` : `"Enable": true`,
  `"Database": "<chemin>"` — nécessite les droits admin pour l'éditer sous
  Windows, voir `C:\Program Files\Orthanc Server\Configuration\`).
- Un jeton d'agent pour l'établissement : `POST /api/company/:companyId/pacs-agent/token`
  (rôle `ADMINISTRATEUR` ou `SUPER ADMIN`) — le jeton n'est montré qu'une
  fois, à copier dans `SITE_TOKEN` tout de suite.
- **`"DicomModalitiesInDatabase": true`** dans `orthanc.json` pour la boucle
  `modalités`. Sans ça, les appareils que l'agent déclare par l'API REST
  disparaissent au redémarrage d'Orthanc : l'agent les redéclarerait au
  cycle suivant, mais entre les deux le site ne peut plus faire de C-ECHO et
  les tests de l'interface échouent sans raison apparente.

## Appareils (modalités) et C-ECHO

L'inventaire des appareils est tenu **dans Totalis** (onglet PACS de « Gérer
le centre ») ; l'agent le reflète dans la configuration DICOM d'Orthanc par
`PUT`/`DELETE /modalities/{nom}`, donc à chaud, sans éditer `orthanc.json`
ni redémarrer Orthanc.

⚠️ **L'agent ne touche que les entrées qu'il a lui-même créées.** Orthanc ne
marque pas l'origine d'une entrée de `DicomModalities` : l'agent mémorise
donc les siennes dans son fichier d'état (`modalitesGerees`). Une modalité
configurée à la main par un technicien du site n'est jamais ni écrasée ni
supprimée — et au tout premier démarrage, l'état étant vide, l'agent ne gère
rien et ne supprime donc rien.

Le **C-ECHO** (« ping DICOM ») n'est pas déclenché par l'agent de lui-même :
un utilisateur clique « Tester » dans Totalis, ce qui dépose une commande
que la boucle `commandes` vient chercher. Le verdict est reposté et s'affiche
sur la fiche de l'appareil. C'est le seul moyen de vérifier qu'un triplet
IP / port / AE Title est correct, puisque Totalis n'a aucune route réseau
vers le LAN de l'hôpital.

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
| `STATE_FILE` | non | `.state.json` à côté de `config.js` | Curseur worklist, séquence `/changes` Orthanc, et modalités déclarées par l'agent |

## Lancer

### Docker (recommandé)

```powershell
Copy-Item .env.example .env   # puis remplir .env (dont WORKLIST_HOST_DIR)
docker compose up -d --build
docker compose logs -f
```

Docker remplace pm2 : `restart: unless-stopped` relance l'agent après un
crash **et** au démarrage de la machine, sans `pm2 resurrect` ni
`pm2-windows-startup`. Et contrairement à pm2, une modification de `.env`
est bien reprise par un simple `docker compose up -d` (pm2 gardait
l'environnement en cache, cf. la procédure de déploiement).

Trois points à connaître, tous dans `docker-compose.yml` :

- **`WORKLIST_HOST_DIR`** est le chemin du dossier worklists d'Orthanc **sur
  l'hôte** ; il est monté sur `/worklists` dans le conteneur. Il doit valoir
  exactement le `"Database"` de `worklists.json`. Le montage est en syntaxe
  longue avec `create_host_path: false` exprès : un chemin erroné fait
  échouer le démarrage au lieu de créer un dossier vide que personne ne lit.
- **Orthanc est sur l'hôte**, donc joint par `host.docker.internal:8042` et
  pas `localhost` (qui désignerait le conteneur). `extra_hosts` rend ce nom
  valable aussi sous Linux.
- **Le fichier d'état** vit dans un volume nommé (`/data/.state.json`), sinon
  chaque `--build` repartirait du curseur zéro et rejouerait tout
  l'historique des `/changes` d'Orthanc.
- **`.env` n'est jamais dans l'image** (`.dockerignore`) : il contient le
  jeton de site, et une couche d'image se lit même après suppression du
  fichier. La config est injectée au démarrage via `env_file`.

L'agent n'expose aucun port : toutes ses connexions sont sortantes.

### Sans Docker (lancement direct ou pm2)

Depuis ce dossier (Node ≥ 20.12) :

```powershell
npm install
Copy-Item .env.example .env   # puis remplir .env (dont WORKLIST_DIR)
npm start                     # = node --env-file=.env agent.js
```

En service continu : `npx pm2 start ecosystem.config.cjs` (voir la
procédure de déploiement). `pm2` est en `devDependencies` — installé par
`npm install`, écarté de l'image Docker par `npm ci --omit=dev`.

## Tests

```powershell
npm install   # dcmjs est nécessaire aux tests
npm test      # = node --test
```

Runner intégré à Node (≥ 20), pas vitest : ce dépôt est cloné sur les PC
Orthanc des hôpitaux, lui ajouter des dizaines de Mo de dépendances de test
pour dix assertions serait un mauvais échange. Avant l'extraction du dépôt
backend, c'était son vitest qui les exécutait.

Les tests couvrent les fonctions pures (`worklistWriter.js`,
`dicomDates.js`) — jamais `agent.js`, qui démarre ses boucles au chargement
du module.

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
- Si le **résultat** d'une commande n'arrive pas à remonter (coupure juste
  après le C-ECHO), la commande reste `EN_COURS` côté Totalis puis expire :
  l'utilisateur doit relancer le test. Le C-ECHO, lui, a bien eu lieu.
- Le message d'échec d'un C-ECHO vient d'Orthanc tel quel. Sous Windows, sa
  partie localisée peut arriver mal encodée (« L­ƒp¢tion a r¢si »), le
  diagnostic utile restant lisible en tête (`TCP Initialization Error …
  Timeout`). Cosmétique, côté Orthanc, pas côté agent.
- La boucle `modalités` ne détecte pas une entrée `DicomModalities` modifiée
  à la main **si** la version d'Orthanc ne répond pas à `GET /modalities?expand`
  (elle retombe alors sur l'empreinte mémorisée). Vérifié présent sur
  Orthanc 1.12 / API v32.
- MPPS et Storage Commitment ne sont pas câblés (voir le plan d'étapes) :
  le statut d'un examen ne remonte pas depuis l'appareil.
