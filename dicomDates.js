// pacs-agent/dicomDates.js
//
// Conversions DICOM DA/TM ↔ ISO, isolées dans un module pur (sans effet de
// bord) pour rester testables sans démarrer l'agent.

/**
 * DICOM DA ("20261124") n'est PAS un format que `new Date()` sait lire : côté
 * serveur, Mongoose caste silencieusement en Invalid Date. Il faut le
 * convertir en ISO ("2026-11-24") avant de l'envoyer à Totalis.
 */
export function dateEtudeVersISO(studyDate) {
  if (!studyDate || studyDate.length !== 8) return undefined;
  return `${studyDate.slice(0, 4)}-${studyDate.slice(4, 6)}-${studyDate.slice(6, 8)}`;
}
