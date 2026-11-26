// pacs-agent/agent.js
//
// Point d'entrée de l'agent de synchronisation PACS d'un site — connexions
// SORTANTES uniquement (vers Totalis et vers Orthanc en local), comme
// l'exige le doc PACS. Six boucles indépendantes : worklist descendante,
// études montantes, configuration des modalités dans Orthanc, commandes
// déposées par Totalis, découverte des appareils refusés (log d'Orthanc),
// battement de cœur.
import { config } from "./config.js";
import { creerClientTotalis } from "./totalisClient.js";
import { creerClientOrthanc } from "./orthancClient.js";
import { ecrireFichierWorklist, supprimerFichierWorklist } from "./worklistWriter.js";
import { calculerSyncModalites, lireReponseModalites } from "./modalitesSync.js";
import { analyserLignes, agregerRejets, lireNouveautes } from "./orthancLog.js";
import { lireEtat, ecrireEtat } from "./state.js";
import { dateEtudeVersISO } from "./dicomDates.js";

const VERSION_AGENT = "0.3.0";

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
        const remoteAet = await orthanc.getRemoteAetEtude(changement.ID);

        await totalis.signalerEtude({
          studyInstanceUID: study.MainDicomTags?.StudyInstanceUID,
          orthancId: changement.ID,
          accessionNumber: study.MainDicomTags?.AccessionNumber,
          patientId: study.PatientMainDicomTags?.PatientID,
          dateEtude: dateEtudeVersISO(study.MainDicomTags?.StudyDate),
          modalites,
          remoteAet,
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

// ── Modalités : inventaire Totalis → DicomModalities d'Orthanc ──────────
// Ce qui rend le site capable de PARLER à ses appareils : sans entrée dans
// la configuration DICOM d'Orthanc, pas de C-ECHO possible. La décision de
// quoi écrire/supprimer vit dans modalitesSync.js (module pur, testé) ;
// cette boucle ne fait que l'appliquer.
export async function cycleModalites() {
  const inventaire = await totalis.getModalites();
  const { noms, configs } = lireReponseModalites(await orthanc.getModalites());

  const { aDeclarer, aSupprimer, modalitesGerees } = calculerSyncModalites({
    aPublier: inventaire.aPublier ?? [],
    nomsOrthanc: noms,
    configsOrthanc: configs,
    modalitesGerees: etat.modalitesGerees ?? {},
  });

  // On n'enregistre dans l'état que ce qui a RÉELLEMENT abouti : noter une
  // déclaration qui a échoué ferait croire au cycle suivant que l'entrée
  // est à jour dans Orthanc, et elle n'y serait jamais écrite.
  const gereesConfirmees = { ...modalitesGerees };

  for (const m of aDeclarer) {
    try {
      await orthanc.declarerModalite(m.nomOrthanc, m);
      log(`modalité déclarée dans Orthanc : ${m.nomOrthanc} (${m.aeTitle}@${m.host}:${m.port})`);
    } catch (e) {
      delete gereesConfirmees[m.nomOrthanc];
      log(`échec déclaration de ${m.nomOrthanc} : ${e.message}`);
    }
  }

  for (const nom of aSupprimer) {
    try {
      await orthanc.supprimerModalite(nom);
      log(`modalité retirée d'Orthanc : ${nom}`);
    } catch (e) {
      // On la garde comme gérée : la suppression sera retentée au cycle
      // suivant, plutôt que d'oublier qu'elle nous appartient — l'oublier
      // la laisserait pour toujours dans Orthanc.
      gereesConfirmees[nom] = etat.modalitesGerees?.[nom] ?? "";
      log(`échec retrait de ${nom} : ${e.message}`);
    }
  }

  etat.modalitesGerees = gereesConfirmees;
  ecrireEtat(config.stateFile, etat);
}

// ── Commandes déposées par Totalis ──────────────────────────────────────
// Totalis (cloud) ne peut ouvrir aucune connexion vers le réseau de
// l'hôpital : un bouton « Tester cet appareil » ne peut donc pas répondre
// dans la requête HTTP de l'utilisateur. Il dépose une commande, que cette
// boucle vient chercher, exécute en local, et dont elle reposte le verdict.
export async function cycleCommandes() {
  const { commandes = [] } = await totalis.getCommandes();

  for (const commande of commandes) {
    let resultat;

    if (commande.type === "ECHO_MODALITE") {
      if (!commande.modalite?.nomOrthanc) {
        resultat = { ok: false, message: "Commande sans modalité cible" };
      } else {
        // echoModalite ne lève pas : un appareil éteint est un résultat de
        // test, pas une panne. Le verdict part donc tel quel vers Totalis.
        resultat = await orthanc.echoModalite(commande.modalite.nomOrthanc);
      }
    } else {
      // Un agent plus ancien que le serveur peut recevoir un type qu'il ne
      // connaît pas. On le clôt en échec explicite plutôt que de le laisser
      // EN_COURS pour toujours : côté interface, « non supporté par l'agent
      // de ce site » est exploitable, un test sans réponse ne l'est pas.
      resultat = {
        ok: false,
        message: `Type de commande inconnu de l'agent ${VERSION_AGENT} : ${commande.type}`,
      };
    }

    try {
      await totalis.posterResultatCommande(commande.id, resultat);
      log(`commande ${commande.type} ${commande.id} → ${resultat.ok ? "OK" : `échec (${resultat.message})`}`);
    } catch (e) {
      // Le résultat est perdu : la commande restera EN_COURS côté Totalis.
      // Pas de file de reprise ici (cf. "Limites connues" du README) — la
      // commande expire, et l'utilisateur peut relancer le test.
      log(`résultat de la commande ${commande.id} non remonté : ${e.message}`);
    }
  }
}

// ── Appareils refusés : log d'Orthanc → Totalis ─────────────────────────
// Un appareil non déclaré est refusé avant d'avoir envoyé quoi que ce soit :
// seul le log d'Orthanc garde sa trace (voir orthancLog.js). On ne remonte
// que AE Title, IP, type de requête et dates. L'envoi part à chaque cycle,
// même vide : Totalis sait ainsi que la lecture du log fonctionne, et voit
// passer les lignes non comprises (format changé par une mise à jour).
export async function cycleAeDecouverts() {
  const { texte, curseur } = lireNouveautes(config.orthancLogDir, etat.curseurLogOrthanc);
  const { rejets, nonComprises } = analyserLignes(texte);
  const aeDecouverts = agregerRejets(rejets);

  await totalis.signalerAeDecouverts({ aeDecouverts, lignesNonComprises: nonComprises });

  // Curseur avancé seulement après l'envoi : un Totalis injoignable fait
  // relire le même morceau au cycle suivant, rien n'est perdu.
  etat.curseurLogOrthanc = curseur;
  ecrireEtat(config.stateFile, etat);

  if (aeDecouverts.length) {
    log(`appareils refusés par Orthanc : ${aeDecouverts.map((a) => `${a.aeTitle}@${a.ip}`).join(", ")}`);
  }
  if (nonComprises) {
    log(`log Orthanc : ${nonComprises} ligne(s) de rejet au format inconnu — découverte peut-être aveugle`);
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
    versionAgent: VERSION_AGENT,
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
// (`node agent.js`) — pas quand un script de test importe un cycle pour
// l'appeler une seule fois.
import { pathToFileURL } from "url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  log(`agent ${VERSION_AGENT} démarré — établissement ${config.companyId}, Orthanc ${config.orthancUrl}, Totalis ${config.totalisUrl}`);
  planifier(cycleWorklist, config.pollIntervalMs, "worklist");
  planifier(cycleEtudes, config.pollIntervalMs, "études");
  // Les commandes suivent la cadence rapide : un utilisateur qui clique
  // « Tester » attend devant son écran.
  planifier(cycleCommandes, config.pollIntervalMs, "commandes");
  // L'inventaire des appareils bouge rarement (saisie en administration) :
  // le relire toutes les 15 s n'apporterait rien et ferait écrire Orthanc
  // pour rien. Il suit donc la cadence lente du battement de cœur.
  planifier(cycleModalites, config.heartbeatIntervalMs, "modalités");
  if (config.orthancLogDir) {
    planifier(cycleAeDecouverts, config.heartbeatIntervalMs, "appareils refusés");
  } else {
    log("ORTHANC_LOG_DIR non défini : découverte des appareils refusés désactivée");
  }
  planifier(cycleHeartbeat, config.heartbeatIntervalMs, "heartbeat");
}
