// pacs-agent/agent.js
//
// Point d'entrée de l'agent de synchronisation PACS d'un site — connexions
// SORTANTES uniquement (vers Totalis et vers Orthanc en local), comme
// l'exige le doc PACS. Trois boucles indépendantes : worklist descendante,
// études montantes, battement de cœur.
import { config } from "./config.js";
import { creerClientTotalis } from "./totalisClient.js";
import { creerClientOrthanc } from "./orthancClient.js";
import { ecrireFichierWorklist, supprimerFichierWorklist } from "./worklistWriter.js";
import { lireEtat, ecrireEtat } from "./state.js";
import { dateEtudeVersISO } from "./dicomDates.js";

const totalis = creerClientTotalis(config);
const orthanc = creerClientOrthanc(config);
const etat = lireEtat(config.stateFile);

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// ── Worklist descendante : Totalis → fichiers .wl lus par Orthanc ───────
export async function cycleWorklist() {
  const reponse = await totalis.getWorklist(etat.curseurWorklist);

  for (const entree of reponse.aPublier) {
    ecrireFichierWorklist(config.worklistDir, entree);
  }
  for (const accessionNumber of reponse.aRetirer) {
    supprimerFichierWorklist(config.worklistDir, accessionNumber);
  }
  if (reponse.aPublier.length) {
    await totalis.ackWorklist(reponse.aPublier.map((e) => e.accessionNumber));
  }

  etat.curseurWorklist = reponse.curseur;
  ecrireEtat(config.stateFile, etat);

  if (reponse.aPublier.length || reponse.aRetirer.length) {
    log(`worklist : ${reponse.aPublier.length} publiée(s), ${reponse.aRetirer.length} retirée(s)`);
  }
}

// ── Études montantes : /changes Orthanc → Totalis ───────────────────────
// Lire /changes plutôt qu'un webhook garantit qu'aucune étude n'est perdue
// si l'agent redémarre : il reprend à la dernière séquence traitée. On
// épuise toutes les pages disponibles (Done=false) avant de rendre la main,
// pour ne pas prendre de retard si plusieurs études arrivent d'un coup.
export async function cycleEtudes() {
  let continuer = true;
  while (continuer) {
    const { Changes, Done } = await orthanc.getChanges(etat.derniereSequenceChanges);

    for (const changement of Changes) {
      etat.derniereSequenceChanges = changement.Seq;

      if (changement.ChangeType !== "StableStudy" || changement.ResourceType !== "Study") continue;

      try {
        const study = await orthanc.getStudy(changement.ID);
        const stats = await orthanc.getStudyStatistics(changement.ID);
        const modalites = await orthanc.getModalitesEtude(study.Series || []);

        await totalis.signalerEtude({
          studyInstanceUID: study.MainDicomTags?.StudyInstanceUID,
          orthancId: changement.ID,
          accessionNumber: study.MainDicomTags?.AccessionNumber,
          patientId: study.PatientMainDicomTags?.PatientID,
          dateEtude: dateEtudeVersISO(study.MainDicomTags?.StudyDate),
          modalites,
          nbSeries: stats.CountSeries,
          nbInstances: stats.CountInstances,
          tailleOctets: stats.DiskSize,
        });

        log(`étude signalée : ${study.MainDicomTags?.AccessionNumber || changement.ID}`);
      } catch (e) {
        // On avance quand même le curseur (etat.derniereSequenceChanges est déjà
        // mis à jour ci-dessus) : une étude qui échoue à répétition ne doit pas
        // bloquer la remontée de toutes celles qui suivent. Elle restera visible
        // côté Totalis dans la file "à rapprocher" une fois reçue plus tard, ou
        // devra être réconciliée manuellement si l'échec est définitif.
        log(`erreur sur l'étude ${changement.ID} : ${e.message}`);
      }
    }

    ecrireEtat(config.stateFile, etat);
    continuer = Changes.length > 0 && Done === false;
  }
}

// ── Battement de cœur ───────────────────────────────────────────────────
export async function cycleHeartbeat() {
  let versionOrthanc;
  try {
    versionOrthanc = (await orthanc.getSystemInfo()).Version;
  } catch {
    versionOrthanc = undefined;
  }

  await totalis.heartbeat({
    versionAgent: "0.1.0",
    versionOrthanc,
    disqueLibreGo: undefined, // TODO : brancher un vrai calcul d'espace disque
    fileAttente: 0,
  });
}

function planifier(tache, intervalleMs, nom) {
  const executer = async () => {
    try {
      await tache();
    } catch (e) {
      log(`erreur ${nom} : ${e.message}`);
    }
  };
  executer();
  setInterval(executer, intervalleMs);
}

// Ne démarre les boucles que si ce fichier est exécuté directement
// (`node pacs-agent/agent.js`) — pas quand un script de test importe
// cycleWorklist/cycleEtudes/cycleHeartbeat pour les appeler une seule fois.
import { pathToFileURL } from "url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  log(`agent démarré — établissement ${config.companyId}, Orthanc ${config.orthancUrl}, Totalis ${config.totalisUrl}`);
  planifier(cycleWorklist, config.pollIntervalMs, "worklist");
  planifier(cycleEtudes, config.pollIntervalMs, "études");
  planifier(cycleHeartbeat, config.heartbeatIntervalMs, "heartbeat");
}
