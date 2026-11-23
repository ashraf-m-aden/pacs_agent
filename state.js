// pacs-agent/state.js
//
// Curseur worklist et séquence /changes persistés dans un fichier local —
// pas de base de données pour un agent qui ne vit que pour ça. Sans cette
// persistance, un redémarrage de l'agent rejouerait tout l'historique
// Orthanc depuis le début à chaque fois.
import fs from "fs";

const ETAT_INITIAL = {
  curseurWorklist: null,
  derniereSequenceChanges: 0,
};

export function lireEtat(cheminFichier) {
  try {
    const brut = fs.readFileSync(cheminFichier, "utf8");
    return { ...ETAT_INITIAL, ...JSON.parse(brut) };
  } catch {
    return { ...ETAT_INITIAL };
  }
}

export function ecrireEtat(cheminFichier, etat) {
  fs.writeFileSync(cheminFichier, JSON.stringify(etat, null, 2));
}
