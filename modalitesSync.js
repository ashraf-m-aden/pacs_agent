// pacs-agent/modalitesSync.js
//
// Décide ce qu'il faut écrire dans la configuration DICOM d'Orthanc pour
// qu'elle reflète l'inventaire des appareils tenu dans Totalis. Module pur
// (aucun appel réseau) précisément pour être testable : c'est la partie où
// une erreur se voit mal et coûte cher — déclarer un appareil inexistant
// est sans gravité, SUPPRIMER l'entrée qu'un technicien a saisie à la main
// casse un site en production.
//
// Règle d'or : l'agent ne touche QUE les entrées qu'il a lui-même créées.
// Elles sont mémorisées dans le fichier d'état (`modalitesGerees`), ce qui
// est le seul moyen fiable de les distinguer : Orthanc ne marque pas
// l'origine d'une entrée de `DicomModalities`.

/**
 * Signature d'une modalité telle que déclarée dans Orthanc. Sert à détecter
 * un changement d'IP ou de port sans avoir à relire la configuration
 * d'Orthanc (que les versions anciennes n'exposent pas).
 */
export function empreinte({ aeTitle, host, port }) {
  return `${aeTitle}|${host}|${port}`;
}

/**
 * @param {object} args
 * @param {Array<{id,nomOrthanc,aeTitle,host,port}>} args.aPublier
 *        Inventaire Totalis — l'état cible.
 * @param {Array<string>} args.nomsOrthanc
 *        Noms déjà présents dans `GET /modalities`.
 * @param {Record<string,object>|null} args.configsOrthanc
 *        Configurations réelles si Orthanc a répondu à `?expand`, sinon
 *        `null` : on retombe alors sur l'empreinte mémorisée.
 * @param {Record<string,string>} args.modalitesGerees
 *        nomOrthanc → empreinte, pour les entrées créées par l'agent.
 * @returns {{aDeclarer: Array, aSupprimer: Array<string>, modalitesGerees: Record<string,string>}}
 */
export function calculerSyncModalites({
  aPublier = [],
  nomsOrthanc = [],
  configsOrthanc = null,
  modalitesGerees = {},
}) {
  const presentDansOrthanc = new Set(nomsOrthanc);
  const cible = new Map(aPublier.map((m) => [m.nomOrthanc, m]));

  const aDeclarer = aPublier.filter((m) => {
    if (!presentDansOrthanc.has(m.nomOrthanc)) return true;

    // Orthanc a donné sa configuration : on compare à la source, ce qui
    // rattrape aussi une entrée modifiée à la main sur le serveur.
    const conf = configsOrthanc?.[m.nomOrthanc];
    if (conf) {
      return (
        conf.AET !== m.aeTitle ||
        conf.Host !== m.host ||
        Number(conf.Port) !== Number(m.port)
      );
    }

    // Sinon, l'empreinte mémorisée est le seul point de comparaison. Une
    // entrée presente dans Orthanc mais que l'agent n'a jamais declaree est
    // consideree a jour : elle vient du technicien du site, on n'y touche
    // pas (ni pour l'ecraser, ni pour la supprimer plus bas).
    const connue = modalitesGerees[m.nomOrthanc];
    return connue !== undefined && connue !== empreinte(m);
  });

  // Convergence : tout ce que l'agent gère et qui n'est plus dans
  // l'inventaire cible sort d'Orthanc. Couvre le retrait d'un appareil
  // (`enabled: false` côté Totalis) ET le cas plus discret d'une fiche dont
  // on a effacé l'IP ou le port — elle quitte `aPublier` sans être
  // « retirée », et laisserait sinon dans Orthanc une entrée pointant vers
  // une adresse qui n'est plus la bonne.
  const aSupprimer = Object.keys(modalitesGerees).filter(
    (nom) => !cible.has(nom) && presentDansOrthanc.has(nom),
  );

  // L'état reflète ce qu'on aura déclaré après application : on repart des
  // entrées gérées encore à l'inventaire, plus celles qu'on (re)déclare.
  const suivant = {};
  for (const [nom, empreinteConnue] of Object.entries(modalitesGerees)) {
    if (cible.has(nom)) suivant[nom] = empreinteConnue;
  }
  for (const m of aDeclarer) {
    suivant[m.nomOrthanc] = empreinte(m);
  }

  return { aDeclarer, aSupprimer, modalitesGerees: suivant };
}

/**
 * Normalise la réponse de `GET /modalities` — Orthanc rend soit la liste
 * des noms, soit (avec `?expand`) un objet nom → configuration selon sa
 * version. On veut les deux informations sans faire dépendre l'agent d'une
 * version précise d'Orthanc.
 */
export function lireReponseModalites(data) {
  if (Array.isArray(data)) {
    return { noms: data.map(String), configs: null };
  }
  if (data && typeof data === "object") {
    return { noms: Object.keys(data), configs: data };
  }
  return { noms: [], configs: null };
}
