/**
 * ════════════════════════════════════════════════════════════════════════
 *  Agent PACS — fonctions pures
 * ════════════════════════════════════════════════════════════════════════
 *
 *  N'importe jamais agent.js directement : ce fichier démarre l'agent
 *  (boucles setInterval, appels HTTP) au chargement du module. Les
 *  conversions testables en isolation vivent dans des modules purs
 *  (dicomDates.js, worklistWriter.js) précisément pour pouvoir être
 *  importées sans effet de bord.
 *
 *  Runner : `node --test` (intégré à Node ≥ 20), pas vitest. Ce dépôt est
 *  cloné sur les PC Orthanc des hôpitaux ; lui ajouter une dépendance de
 *  test de plusieurs dizaines de Mo pour dix assertions serait un mauvais
 *  échange. Avant l'extraction du dépôt backend, c'était son vitest qui
 *  les exécutait — il n'y a plus de runner à emprunter.
 *
 *      npm test
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dcmjs from "dcmjs";
import {
  versPatientNameDicom,
  versDateHeureDicom,
  ecrireFichierWorklist,
  supprimerFichierWorklist,
  SH_MAX,
} from "../worklistWriter.js";
import { dateEtudeVersISO } from "../dicomDates.js";

describe("versPatientNameDicom", () => {
  it("convertit 'Prénom Nom' en 'Nom^Prénom'", () => {
    assert.equal(versPatientNameDicom("Jean Dupont"), "Dupont^Jean");
  });

  it("laisse un nom déjà au format DICOM inchangé", () => {
    assert.equal(versPatientNameDicom("Dupont^Jean"), "Dupont^Jean");
  });

  it("laisse un nom à un seul mot inchangé", () => {
    assert.equal(versPatientNameDicom("Madonna"), "Madonna");
  });

  it("traite le premier mot comme prénom sur un nom composé", () => {
    assert.equal(versPatientNameDicom("Jean Pierre Dupont"), "Pierre Dupont^Jean");
  });

  it("rend une chaîne vide sans lever pour un nom absent", () => {
    assert.equal(versPatientNameDicom(""), "");
    assert.equal(versPatientNameDicom(undefined), "");
  });
});

describe("versDateHeureDicom", () => {
  it("formate en DA/TM locaux à partir d'une date ISO", () => {
    const { da, tm } = versDateHeureDicom("2026-11-24T08:05:03");
    assert.equal(da, "20261124");
    assert.equal(tm, "080503");
  });
});

describe("dateEtudeVersISO", () => {
  it("convertit un DA DICOM en date ISO exploitable par Mongoose", () => {
    assert.equal(dateEtudeVersISO("20261124"), "2026-11-24");
    // Preuve du bug que ça corrige : new Date("20261124") est Invalid Date,
    // alors que new Date(dateEtudeVersISO("20261124")) est valide.
    assert.ok(Number.isNaN(new Date("20261124").getTime()));
    assert.ok(!Number.isNaN(new Date(dateEtudeVersISO("20261124")).getTime()));
  });

  it("rend undefined pour une valeur absente ou mal formée", () => {
    assert.equal(dateEtudeVersISO(undefined), undefined);
    assert.equal(dateEtudeVersISO("2026"), undefined);
  });
});

describe("écriture/suppression du fichier .wl", () => {
  // Relatif à CE fichier, pas au cwd : le test doit passer qu'il soit lancé
  // depuis la racine du dépôt ou depuis tests/.
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp-worklist");

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("écrit un DICOM valide et relisible, puis le supprime proprement", () => {
    const entree = {
      accessionNumber: "TEST-CT26-000001",
      patient: { id: "P0001", nom: "Jean Dupont", dateNaissance: "1980-04-12", sexe: "M" },
      modaliteType: "CT",
      aeTitleCible: "CT_TEST",
      datePlanifiee: "2026-11-24T08:30:00",
      libelle: "Scanner thoracique",
      prescripteur: "Dr Test",
      priorite: "ROUTINE",
    };

    ecrireFichierWorklist(dir, entree);

    const fichier = path.join(dir, `${entree.accessionNumber}.wl`);
    assert.ok(fs.existsSync(fichier), "le fichier .wl doit être écrit");

    const buffer = fs.readFileSync(fichier);
    const dicomData = dcmjs.data.DicomMessage.readFile(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    );
    const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicomData.dict);

    assert.equal(dataset.AccessionNumber, entree.accessionNumber);
    assert.equal(dataset.PatientID, entree.patient.id);
    assert.equal(dataset.PatientBirthDate, "19800412");
    assert.equal(dataset.ScheduledProcedureStepSequence[0].ScheduledStationAETitle, "CT_TEST");
    assert.equal(dataset.ScheduledProcedureStepSequence[0].Modality, "CT");

    supprimerFichierWorklist(dir, entree.accessionNumber);
    assert.ok(!fs.existsSync(fichier), "le fichier .wl doit être supprimé");
  });

  it("supprimerFichierWorklist ne lève pas si le fichier n'existe déjà plus", () => {
    assert.doesNotThrow(() => supprimerFichierWorklist(dir, "INEXISTANT"));
  });
});

describe("garde-fou de longueur des tags SH", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp-worklist-sh");

  const entree = (accessionNumber) => ({
    accessionNumber,
    patient: { id: "P0001", nom: "Jean Dupont", dateNaissance: "1980-04-12", sexe: "M" },
    modaliteType: "CT",
    aeTitleCible: "CT_TEST",
    datePlanifiee: "2026-11-24T08:30:00",
    libelle: "Scanner thoracique",
  });

  /** Capture console.warn le temps d'un appel. */
  function avecWarnCapture(fn) {
    const origine = console.warn;
    const messages = [];
    console.warn = (...args) => messages.push(args.join(" "));
    try {
      fn();
    } finally {
      console.warn = origine;
    }
    return messages;
  }

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ne dit rien pour un Accession Number de 16 caracteres ou moins", () => {
    const messages = avecWarnCapture(() =>
      ecrireFichierWorklist(dir, entree("TEST-CT26-000001")),
    );
    assert.equal(messages.length, 0);
  });

  it("avertit pour les trois tags SH quand le numero depasse 16, SANS tronquer", () => {
    // Ancien format, encore present en base pour les demandes anterieures au
    // 2026-11-25 : 20 caracteres.
    const tropLong = "HPPDC-DX-2026-000001";
    assert.ok(tropLong.length > SH_MAX);

    const messages = avecWarnCapture(() => ecrireFichierWorklist(dir, entree(tropLong)));

    // Un avertissement par tag concerne : AccessionNumber,
    // RequestedProcedureID, ScheduledProcedureStepID.
    assert.equal(messages.length, 3);
    assert.ok(messages.some((m) => m.includes("(0008,0050)")));
    assert.ok(messages.some((m) => m.includes("(0040,1001)")));
    assert.ok(messages.some((m) => m.includes("(0040,0009)")));

    // La valeur est ecrite TELLE QUELLE : tronquer ferait revenir l'appareil
    // avec une chaine que Totalis ne retrouverait pas (comparaison exacte),
    // et l'etude resterait non rapprochee.
    const buffer = fs.readFileSync(path.join(dir, `${tropLong}.wl`));
    const dicomData = dcmjs.data.DicomMessage.readFile(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    );
    const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicomData.dict);
    assert.equal(dataset.AccessionNumber, tropLong);
  });
});
