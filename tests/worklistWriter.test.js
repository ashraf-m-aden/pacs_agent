/**
 * ════════════════════════════════════════════════════════════════════════
 *  Agent PACS — fonctions pures (pacs-agent/)
 * ════════════════════════════════════════════════════════════════════════
 *
 *  N'importe jamais pacs-agent/agent.js directement : ce fichier démarre
 *  l'agent (boucles setInterval, appels HTTP) au chargement du module. Les
 *  conversions testables en isolation vivent dans des modules purs
 *  (dicomDates.js, worklistWriter.js) précisément pour pouvoir être
 *  importées sans effet de bord.
 *
 *  Vit DANS le dossier de l'agent, pas dans app/tests/ : `dcmjs` est une
 *  dépendance de l'agent seul (pacs-agent/package.json), le backend ne la
 *  déclare plus. Depuis ce fichier, la résolution de `dcmjs` remonte vers
 *  pacs-agent/node_modules — ce qui ne marcherait pas depuis app/tests/.
 *  Lancé par le vitest du backend quand même (voir `include` dans
 *  vitest.config.js, et `npm run test:agent`), pour ne pas imposer un
 *  second runner à un dossier qu'on copie sur les PC des hôpitaux.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dcmjs from "dcmjs";
import {
  versPatientNameDicom,
  versDateHeureDicom,
  ecrireFichierWorklist,
  supprimerFichierWorklist,
} from "../worklistWriter.js";
import { dateEtudeVersISO } from "../dicomDates.js";

describe("pacs-agent — versPatientNameDicom", () => {
  it("convertit 'Prénom Nom' en 'Nom^Prénom'", () => {
    expect(versPatientNameDicom("Jean Dupont")).toBe("Dupont^Jean");
  });

  it("laisse un nom déjà au format DICOM inchangé", () => {
    expect(versPatientNameDicom("Dupont^Jean")).toBe("Dupont^Jean");
  });

  it("laisse un nom à un seul mot inchangé", () => {
    expect(versPatientNameDicom("Madonna")).toBe("Madonna");
  });

  it("traite le premier mot comme prénom sur un nom composé", () => {
    expect(versPatientNameDicom("Jean Pierre Dupont")).toBe("Pierre Dupont^Jean");
  });

  it("rend une chaîne vide sans lever pour un nom absent", () => {
    expect(versPatientNameDicom("")).toBe("");
    expect(versPatientNameDicom(undefined)).toBe("");
  });
});

describe("pacs-agent — versDateHeureDicom", () => {
  it("formate en DA/TM locaux à partir d'une date ISO", () => {
    const { da, tm } = versDateHeureDicom("2026-11-24T08:05:03");
    expect(da).toBe("20261124");
    expect(tm).toBe("080503");
  });
});

describe("pacs-agent — dateEtudeVersISO", () => {
  it("convertit un DA DICOM en date ISO exploitable par Mongoose", () => {
    expect(dateEtudeVersISO("20261124")).toBe("2026-11-24");
    // Preuve du bug que ça corrige : new Date("20261124") est Invalid Date,
    // alors que new Date(dateEtudeVersISO("20261124")) est valide.
    expect(Number.isNaN(new Date("20261124").getTime())).toBe(true);
    expect(Number.isNaN(new Date(dateEtudeVersISO("20261124")).getTime())).toBe(false);
  });

  it("rend undefined pour une valeur absente ou mal formée", () => {
    expect(dateEtudeVersISO(undefined)).toBeUndefined();
    expect(dateEtudeVersISO("2026")).toBeUndefined();
  });
});

describe("pacs-agent — écriture/suppression du fichier .wl", () => {
  // Relatif à CE fichier, pas au cwd : le test doit passer qu'il soit lancé
  // depuis la racine du backend ou depuis le dossier de l'agent.
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp-worklist");

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("écrit un DICOM valide et relisible, puis le supprime proprement", () => {
    const entree = {
      accessionNumber: "TEST-CT-2026-000001",
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
    expect(fs.existsSync(fichier)).toBe(true);

    const buffer = fs.readFileSync(fichier);
    const dicomData = dcmjs.data.DicomMessage.readFile(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    );
    const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicomData.dict);

    expect(dataset.AccessionNumber).toBe(entree.accessionNumber);
    expect(dataset.PatientID).toBe(entree.patient.id);
    expect(dataset.PatientBirthDate).toBe("19800412");
    expect(dataset.ScheduledProcedureStepSequence[0].ScheduledStationAETitle).toBe("CT_TEST");
    expect(dataset.ScheduledProcedureStepSequence[0].Modality).toBe("CT");

    supprimerFichierWorklist(dir, entree.accessionNumber);
    expect(fs.existsSync(fichier)).toBe(false);
  });

  it("supprimerFichierWorklist ne lève pas si le fichier n'existe déjà plus", () => {
    expect(() => supprimerFichierWorklist(dir, "INEXISTANT")).not.toThrow();
  });
});
