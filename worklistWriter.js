// pacs-agent/worklistWriter.js
//
// Traduit une entrée de worklist Totalis (JSON, voir pacsAgent.routes.js
// côté serveur) en fichier DICOM `.wl` dans le dossier "Database" du plugin
// Worklists d'Orthanc. Un fichier par Accession Number, nommé d'après lui :
// le retrait (annulation) n'a qu'à supprimer ce même fichier.
import fs from "fs";
import path from "path";
import { createRequire } from "module";

// Build CommonJS de dcmjs, pas `import dcmjs from "dcmjs"` : dcmjs 0.52.x
// expose son build ESM en .js sans "type": "module", que Node refuse de
// charger ("Unexpected token 'export'").
const dcmjs = createRequire(import.meta.url)("dcmjs");

const { DicomMetaDictionary, DicomDict } = dcmjs.data;

// SOP Class "Modality Worklist Information Model - FIND", fixe par la norme.
const SOP_CLASS_WORKLIST = "1.2.840.10008.5.1.4.31";
const TRANSFER_SYNTAX_EXPLICIT_LE = "1.2.840.10008.1.2.1";

/**
 * Longueur maximale du VR `SH` (Short String) selon la norme DICOM. Trois
 * tags ecrits ici en heritent, et tous les trois recoivent l'Accession
 * Number : (0008,0050) AccessionNumber, (0040,1001) RequestedProcedureID et
 * (0040,0009) ScheduledProcedureStepID.
 */
export const SH_MAX = 16;

/**
 * Previent si une valeur depasse son VR, SANS la tronquer — et c'est
 * volontaire.
 *
 * Tronquer ici serait pire que ne rien faire : Totalis rapproche l'etude en
 * comparant la chaine EXACTE (`findOne({ idCompany, accessionNumber })`, cf.
 * `POST /pacs/agent/:companyId/etudes`). Un `.wl` portant une valeur deja
 * tronquee ferait revenir l'appareil avec cette valeur, que Totalis ne
 * retrouverait pas : l'examen resterait non rapproche. La bonne correction
 * est en amont — depuis le 2026-11-25, `genererAccessionNumber` produit 16
 * caracteres au plus et refuse d'en rendre un plus long.
 *
 * Ce garde-fou sert aux demandes creees AVANT ce correctif, dont le numero
 * depasse encore : il rend visible dans les logs la cause d'un appareil qui
 * « ne voit rien », ou d'une etude qui atterrit dans « Etudes a rapprocher »
 * sans raison apparente.
 */
function avertirSiTropLong(dataset) {
  const aVerifier = [
    ["AccessionNumber (0008,0050)", dataset.AccessionNumber],
    ["RequestedProcedureID (0040,1001)", dataset.RequestedProcedureID],
    [
      "ScheduledProcedureStepID (0040,0009)",
      dataset.ScheduledProcedureStepSequence?.[0]?.ScheduledProcedureStepID,
    ],
  ];
  for (const [tag, valeur] of aVerifier) {
    if (typeof valeur === "string" && valeur.length > SH_MAX) {
      console.warn(
        `[worklist] ${tag} = "${valeur}" fait ${valeur.length} caracteres, ` +
          `pour un VR SH plafonne a ${SH_MAX} par la norme DICOM. ` +
          "L'appareil peut le tronquer en le lisant, et le rapprochement automatique " +
          "echouera alors cote Totalis (comparaison de chaine exacte). " +
          "Demande anterieure au format court du 2026-11-25.",
      );
    }
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** DA (YYYYMMDD) / TM (HHMMSS) locaux — l'agent tourne physiquement sur le site. */
export function versDateHeureDicom(date) {
  const d = new Date(date);
  const da = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const tm = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return { da, tm };
}

/**
 * "Jean Dupont" → "Dupont^Jean" (heuristique). Le PatientName DICOM attend
 * des composantes séparées par `^` (famille^prénom^...) ; `Patient.name`
 * côté Totalis est un texte libre saisi à l'accueil, pas déjà structuré.
 * À affiner (champ nom/prénom séparés) si la casse réelle s'avère trop
 * approximative à l'usage — suffisant pour faire fonctionner le circuit.
 */
export function versPatientNameDicom(nom) {
  if (!nom) return "";
  if (nom.includes("^")) return nom;
  const mots = nom.trim().split(/\s+/);
  if (mots.length < 2) return mots[0] || "";
  const [prenom, ...reste] = mots;
  return `${reste.join(" ")}^${prenom}`;
}

function construireDataset(entree) {
  const { da, tm } = versDateHeureDicom(entree.datePlanifiee);
  const studyInstanceUID = DicomMetaDictionary.uid();

  return {
    SpecificCharacterSet: "ISO_IR 100",
    AccessionNumber: entree.accessionNumber,
    ReferringPhysicianName: versPatientNameDicom(entree.prescripteur || ""),
    PatientName: versPatientNameDicom(entree.patient?.nom),
    PatientID: entree.patient?.id || "",
    PatientBirthDate: (entree.patient?.dateNaissance || "").replace(/-/g, ""),
    PatientSex: entree.patient?.sexe || "",
    StudyInstanceUID: studyInstanceUID,
    RequestedProcedureDescription: entree.libelle || "",
    RequestedProcedureID: entree.accessionNumber,
    ScheduledProcedureStepSequence: [
      {
        ScheduledStationAETitle: entree.aeTitleCible || "",
        ScheduledProcedureStepStartDate: da,
        ScheduledProcedureStepStartTime: tm,
        Modality: entree.modaliteType,
        ScheduledPerformingPhysicianName: "",
        ScheduledProcedureStepDescription: entree.libelle || "",
        ScheduledProcedureStepID: entree.accessionNumber,
        ScheduledProcedureStepStatus: "SCHEDULED",
      },
    ],
  };
}

function cheminFichier(worklistDir, accessionNumber) {
  // L'Accession Number est généré par Totalis (voir imagerie.service.js) et
  // ne contient que [A-Z0-9-] : sûr à utiliser tel quel comme nom de fichier.
  return path.join(worklistDir, `${accessionNumber}.wl`);
}

export function ecrireFichierWorklist(worklistDir, entree) {
  const dataset = construireDataset(entree);
  avertirSiTropLong(dataset);

  const meta = {
    TransferSyntaxUID: TRANSFER_SYNTAX_EXPLICIT_LE,
    MediaStorageSOPClassUID: SOP_CLASS_WORKLIST,
    MediaStorageSOPInstanceUID: dataset.StudyInstanceUID,
  };

  const dicomDict = new DicomDict(DicomMetaDictionary.denaturalizeDataset(meta));
  dicomDict.dict = DicomMetaDictionary.denaturalizeDataset(dataset);

  fs.mkdirSync(worklistDir, { recursive: true });
  fs.writeFileSync(cheminFichier(worklistDir, entree.accessionNumber), Buffer.from(dicomDict.write()));
}

export function supprimerFichierWorklist(worklistDir, accessionNumber) {
  const p = cheminFichier(worklistDir, accessionNumber);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
