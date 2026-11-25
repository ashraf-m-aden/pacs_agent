/**
 * ════════════════════════════════════════════════════════════════════════
 *  Synchronisation des modalités vers DicomModalities d'Orthanc
 * ════════════════════════════════════════════════════════════════════════
 *
 *  Le risque que ces tests verrouillent n'est pas de rater une
 *  déclaration — déclarer un appareil inexistant est sans conséquence, le
 *  C-ECHO échouera et le dira. C'est de SUPPRIMER une entrée que l'agent
 *  n'a pas créée : un technicien du site a pu configurer un appareil à la
 *  main dans Orthanc, et l'effacer casse la production sans trace.
 *
 *  D'où la règle tenue ici : l'agent ne touche que ce qu'il a lui-même
 *  déclaré, mémorisé dans `modalitesGerees` du fichier d'état — Orthanc ne
 *  marquant pas l'origine d'une entrée de sa configuration.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculerSyncModalites,
  lireReponseModalites,
  empreinte,
} from "../modalitesSync.js";

const ct = {
  id: "1",
  nomOrthanc: "CT_SALLE1",
  aeTitle: "CT_SALLE1",
  host: "192.168.14.50",
  port: 104,
};

describe("calculerSyncModalites — déclaration", () => {
  it("déclare une modalité absente d'Orthanc", () => {
    const r = calculerSyncModalites({
      aPublier: [ct],
      nomsOrthanc: [],
      modalitesGerees: {},
    });

    assert.deepEqual(r.aDeclarer.map((m) => m.nomOrthanc), ["CT_SALLE1"]);
    assert.deepEqual(r.aSupprimer, []);
    assert.equal(r.modalitesGerees.CT_SALLE1, empreinte(ct));
  });

  it("ne redéclare pas une modalité déjà à jour", () => {
    const r = calculerSyncModalites({
      aPublier: [ct],
      nomsOrthanc: ["CT_SALLE1"],
      modalitesGerees: { CT_SALLE1: empreinte(ct) },
    });

    assert.deepEqual(r.aDeclarer, []);
    assert.deepEqual(r.aSupprimer, []);
  });

  it("redéclare quand l'IP a changé côté Totalis", () => {
    const deplace = { ...ct, host: "192.168.14.99" };
    const r = calculerSyncModalites({
      aPublier: [deplace],
      nomsOrthanc: ["CT_SALLE1"],
      modalitesGerees: { CT_SALLE1: empreinte(ct) },
    });

    assert.deepEqual(r.aDeclarer.map((m) => m.host), ["192.168.14.99"]);
    assert.equal(r.modalitesGerees.CT_SALLE1, empreinte(deplace));
  });

  it("corrige une entrée qu'on a modifiée à la main dans Orthanc", () => {
    // Orthanc a répondu à `?expand` : on compare à la source de vérité
    // plutôt qu'à notre empreinte, ce qui rattrape une dérive côté serveur.
    const r = calculerSyncModalites({
      aPublier: [ct],
      nomsOrthanc: ["CT_SALLE1"],
      configsOrthanc: { CT_SALLE1: { AET: "CT_SALLE1", Host: "10.0.0.1", Port: 104 } },
      modalitesGerees: { CT_SALLE1: empreinte(ct) },
    });

    assert.deepEqual(r.aDeclarer.map((m) => m.nomOrthanc), ["CT_SALLE1"]);
  });

  it("ne voit pas de changement sur un port égal mais de type différent", () => {
    // Orthanc peut rendre le port en chaîne selon la version : sans
    // comparaison numérique, l'agent réécrirait l'entrée à chaque cycle.
    const r = calculerSyncModalites({
      aPublier: [ct],
      nomsOrthanc: ["CT_SALLE1"],
      configsOrthanc: { CT_SALLE1: { AET: "CT_SALLE1", Host: "192.168.14.50", Port: "104" } },
      modalitesGerees: { CT_SALLE1: empreinte(ct) },
    });

    assert.deepEqual(r.aDeclarer, []);
  });
});

describe("calculerSyncModalites — ce qu'on ne touche JAMAIS", () => {
  it("laisse intacte une entrée présente dans Orthanc que l'agent n'a pas déclarée", () => {
    // Le cas qui casse un site : le technicien a saisi ECHO_GYN à la main,
    // Totalis ne la connaît pas. Elle ne doit être ni écrasée ni supprimée.
    const r = calculerSyncModalites({
      aPublier: [ct],
      nomsOrthanc: ["CT_SALLE1", "ECHO_GYN"],
      modalitesGerees: { CT_SALLE1: empreinte(ct) },
    });

    assert.deepEqual(r.aDeclarer, []);
    assert.deepEqual(r.aSupprimer, []);
    assert.equal("ECHO_GYN" in r.modalitesGerees, false);
  });

  it("ne supprime rien au tout premier démarrage, même avec un Orthanc déjà peuplé", () => {
    // `modalitesGerees` vide = agent qui démarre (ou qui vient d'être mis à
    // jour) : il ne gère rien encore, donc il n'a rien à retirer. Sans
    // cette propriété, une première exécution balaierait la configuration
    // existante du site.
    const r = calculerSyncModalites({
      aPublier: [],
      nomsOrthanc: ["CT_SALLE1", "ECHO_GYN", "IRM"],
      modalitesGerees: {},
    });

    assert.deepEqual(r.aSupprimer, []);
    assert.deepEqual(r.aDeclarer, []);
  });

  it("n'essaie pas de supprimer une entrée gérée déjà absente d'Orthanc", () => {
    const r = calculerSyncModalites({
      aPublier: [],
      nomsOrthanc: [],
      modalitesGerees: { CT_SALLE1: empreinte(ct) },
    });

    assert.deepEqual(r.aSupprimer, []);
    assert.equal("CT_SALLE1" in r.modalitesGerees, false);
  });
});

describe("calculerSyncModalites — retrait", () => {
  it("retire d'Orthanc un appareil retiré côté Totalis", () => {
    const r = calculerSyncModalites({
      aPublier: [],
      nomsOrthanc: ["CT_SALLE1"],
      modalitesGerees: { CT_SALLE1: empreinte(ct) },
    });

    assert.deepEqual(r.aSupprimer, ["CT_SALLE1"]);
    assert.equal("CT_SALLE1" in r.modalitesGerees, false);
  });

  it("retire aussi un appareil dont on a effacé l'IP ou le port", () => {
    // Cas discret : la fiche existe toujours dans Totalis mais quitte
    // `aPublier` faute d'adresse. Sans ce retrait, Orthanc garderait une
    // entrée pointant vers une adresse qui n'est plus la bonne, et le
    // C-ECHO continuerait de répondre sur l'ancien appareil.
    const r = calculerSyncModalites({
      aPublier: [],
      nomsOrthanc: ["CT_SALLE1"],
      modalitesGerees: { CT_SALLE1: empreinte(ct) },
    });

    assert.deepEqual(r.aSupprimer, ["CT_SALLE1"]);
  });

  it("gère déclaration et retrait dans le même cycle", () => {
    const nouveau = { ...ct, nomOrthanc: "CT_NEUF", aeTitle: "CT_NEUF" };
    const r = calculerSyncModalites({
      aPublier: [nouveau],
      nomsOrthanc: ["CT_SALLE1"],
      modalitesGerees: { CT_SALLE1: empreinte(ct) },
    });

    assert.deepEqual(r.aDeclarer.map((m) => m.nomOrthanc), ["CT_NEUF"]);
    assert.deepEqual(r.aSupprimer, ["CT_SALLE1"]);
    assert.deepEqual(Object.keys(r.modalitesGerees), ["CT_NEUF"]);
  });
});

describe("lireReponseModalites", () => {
  it("accepte la liste de noms (Orthanc sans ?expand)", () => {
    const r = lireReponseModalites(["ct1", "mr1"]);
    assert.deepEqual(r.noms, ["ct1", "mr1"]);
    assert.equal(r.configs, null);
  });

  it("accepte l'objet nom → configuration (Orthanc avec ?expand)", () => {
    const r = lireReponseModalites({ ct1: { AET: "CT1", Host: "1.2.3.4", Port: 104 } });
    assert.deepEqual(r.noms, ["ct1"]);
    assert.equal(r.configs.ct1.AET, "CT1");
  });

  it("ne lève pas sur une réponse inattendue", () => {
    assert.deepEqual(lireReponseModalites(null), { noms: [], configs: null });
    assert.deepEqual(lireReponseModalites("?!"), { noms: [], configs: null });
  });
});
