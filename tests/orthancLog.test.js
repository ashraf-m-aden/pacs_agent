/**
 * ════════════════════════════════════════════════════════════════════════
 *  Découverte des AE Titles refusés, depuis le log d'Orthanc
 * ════════════════════════════════════════════════════════════════════════
 *
 *  Les lignes ci-dessous sont copiées d'un vrai log (Orthanc 1.13, Mac,
 *  2026-11-26) : ce sont elles qui comptent, pas un format supposé. Si une
 *  mise à jour d'Orthanc change ce texte, ces tests ne le verront pas — c'est
 *  le rôle du compteur `nonComprises`, remonté à Totalis.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyserLignes,
  agregerRejets,
  dateLigne,
  trouverFichierLog,
  lireNouveautes,
} from "../orthancLog.js";

const AUTORISATION =
  'W1126 09:07:59.527584          DICOM-0 main.cpp:429] DICOM authorization rejected  for AET FUJI-SIM on IP 127.0.0.1: This AET is not listed in configuration option "DicomModalities"';
const REQUETE =
  'W1126 09:07:59.528612          DICOM-0 CommandDispatcher.cpp:845] Rejected FindWorklist request from remote DICOM modality with AET "FUJI-SIM" and hostname "127.0.0.1"';
const BRUIT = [
  'W1126 09:05:38.252350             MAIN OrthancConfiguration.cpp:79] Reading the configuration file: /Users/x/orthanc.json',
  "W1126 09:05:38.397065             MAIN main.cpp:1438] DICOM server listening with AET ORTHANC on port: 4242",
];
const MAINTENANT = new Date(2026, 10, 26, 12, 0, 0);

describe("analyserLignes", () => {
  it("compte un rejet une seule fois, avec son type, à partir de ses deux lignes", () => {
    const { rejets, nonComprises } = analyserLignes([...BRUIT, AUTORISATION, REQUETE].join("\n"), {
      maintenant: MAINTENANT,
    });
    assert.equal(nonComprises, 0);
    assert.equal(rejets.length, 1);
    assert.equal(rejets[0].aeTitle, "FUJI-SIM");
    assert.equal(rejets[0].ip, "127.0.0.1");
    assert.equal(rejets[0].typeRequete, "FindWorklist");
    assert.deepEqual(rejets[0].date, new Date(2026, 10, 26, 9, 7, 59));
  });

  it("tolère les fins de ligne Windows", () => {
    const { rejets } = analyserLignes(`${AUTORISATION}\r\n${REQUETE}\r\n`, { maintenant: MAINTENANT });
    assert.equal(rejets.length, 1);
    assert.equal(rejets[0].typeRequete, "FindWorklist");
  });

  it("découvre encore l'appareil si une seule des deux lignes est reconnue", () => {
    const seuleAutorisation = analyserLignes(AUTORISATION, { maintenant: MAINTENANT });
    assert.equal(seuleAutorisation.rejets.length, 1);
    assert.equal(seuleAutorisation.rejets[0].typeRequete, null);

    const seuleRequete = analyserLignes(REQUETE, { maintenant: MAINTENANT });
    assert.equal(seuleRequete.rejets.length, 1);
    assert.equal(seuleRequete.rejets[0].typeRequete, "FindWorklist");
  });

  it("lit une IP v6 sans avaler le ':' du motif", () => {
    const ligne = AUTORISATION.replace("127.0.0.1", "::1");
    assert.equal(analyserLignes(ligne).rejets[0].ip, "::1");
  });

  it("signale une ligne de rejet au format inconnu au lieu de l'ignorer", () => {
    const formatChange = "W1126 10:00:00.000000 DICOM-0 x.cpp:1] Association rejected by policy for CT_SALLE1";
    const { rejets, nonComprises } = analyserLignes(formatChange);
    assert.equal(rejets.length, 0);
    assert.equal(nonComprises, 1);
  });

  it("ne remonte rien d'un log sans rejet", () => {
    assert.deepEqual(analyserLignes(BRUIT.join("\n")), { rejets: [], nonComprises: 0 });
  });
});

describe("dateLigne", () => {
  it("rattache à l'année précédente un log de décembre relu en janvier", () => {
    const janvier = new Date(2027, 0, 2, 8, 0, 0);
    const d = dateLigne("W1231 23:59:00.000000 x", janvier);
    assert.equal(d.getFullYear(), 2026);
  });

  it("rend null sans en-tête glog", () => {
    assert.equal(dateLigne("pas une ligne de log"), null);
  });
});

describe("agregerRejets", () => {
  it("regroupe par AE Title + IP, et garde la plage de dates et les types", () => {
    const d = (h) => new Date(2026, 10, 26, h, 0, 0);
    const agrege = agregerRejets([
      { aeTitle: "FUJI-SIM", ip: "127.0.0.1", typeRequete: "FindWorklist", date: d(10) },
      { aeTitle: "FUJI-SIM", ip: "127.0.0.1", typeRequete: "FindWorklist", date: d(9) },
      { aeTitle: "FUJI-SIM", ip: "127.0.0.1", typeRequete: "Echo", date: d(11) },
      { aeTitle: "FUJI-SIM", ip: "192.168.1.20", typeRequete: null, date: d(10) },
    ]);
    assert.equal(agrege.length, 2);
    const local = agrege.find((a) => a.ip === "127.0.0.1");
    assert.equal(local.nb, 3);
    assert.deepEqual(local.typesRequete, ["Echo", "FindWorklist"]);
    assert.equal(local.premiereVue, d(9).toISOString());
    assert.equal(local.derniereVue, d(11).toISOString());
    assert.deepEqual(agrege.find((a) => a.ip === "192.168.1.20").typesRequete, []);
  });
});

describe("lecture incrémentale du dossier de logs", () => {
  let dossier;
  beforeEach(() => {
    dossier = fs.mkdtempSync(path.join(os.tmpdir(), "orthanc-logs-"));
  });
  afterEach(() => {
    fs.rmSync(dossier, { recursive: true, force: true });
  });

  const ecrire = (nom, contenu, mtime) => {
    const p = path.join(dossier, nom);
    fs.writeFileSync(p, contenu);
    if (mtime) fs.utimesSync(p, mtime, mtime);
    return fs.realpathSync(p);
  };

  it("choisit le fichier le plus récent par date, pas par nom", () => {
    ecrire("Orthanc.log.20261126-999999.1", "ancien\n", new Date(2026, 0, 1));
    const recent = ecrire("Orthanc.log.20261126-000001.2", "recent\n", new Date(2026, 5, 1));
    ecrire("autre.txt", "x\n", new Date(2027, 0, 1));
    assert.equal(trouverFichierLog(dossier), recent);
  });

  it("ne relit jamais deux fois la même ligne, et attend la fin d'une ligne en cours", () => {
    const fichier = ecrire("Orthanc.log.1", `${AUTORISATION}\n${REQUETE}\nW1126 09:08:00 ligne en cour`);

    const premier = lireNouveautes(dossier, null);
    assert.equal(analyserLignes(premier.texte).rejets.length, 1);
    assert.ok(!premier.texte.includes("ligne en cour"));

    fs.appendFileSync(fichier, "s d'ecriture\n");
    const second = lireNouveautes(dossier, premier.curseur);
    assert.equal(second.texte, "W1126 09:08:00 ligne en cours d'ecriture\n");

    const troisieme = lireNouveautes(dossier, second.curseur);
    assert.equal(troisieme.texte, "");
  });

  it("termine l'ancien fichier quand Orthanc redémarre sur un nouveau", () => {
    const ancien = ecrire("Orthanc.log.1", "debut\n", new Date(2026, 0, 1));
    const curseur = lireNouveautes(dossier, null).curseur;
    fs.appendFileSync(ancien, `${REQUETE}\n`);
    fs.utimesSync(ancien, new Date(2026, 0, 1), new Date(2026, 0, 1));
    ecrire("Orthanc.log.2", `${REQUETE.replace("FUJI-SIM", "CT_SALLE1")}\n`, new Date(2026, 5, 1));

    const { texte } = lireNouveautes(dossier, curseur);
    const aes = analyserLignes(texte).rejets.map((r) => r.aeTitle).sort();
    assert.deepEqual(aes, ["CT_SALLE1", "FUJI-SIM"]);
  });

  it("repart du début d'un fichier tronqué", () => {
    const fichier = ecrire("Orthanc.log.1", `${REQUETE}\n${REQUETE}\n`);
    const curseur = lireNouveautes(dossier, null).curseur;
    fs.writeFileSync(fichier, `${REQUETE}\n`);
    assert.equal(analyserLignes(lireNouveautes(dossier, curseur).texte).rejets.length, 1);
  });
});
