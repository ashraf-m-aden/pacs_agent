// pacs-agent/orthancLog.js
//
// Découverte des appareils que personne n'a encore déclarés. Un appareil
// inconnu d'Orthanc est REFUSÉ avant d'avoir pu envoyer quoi que ce soit
// (C-FIND worklist non autorisé) : il n'existe donc nulle part, ni dans une
// étude reçue (ce que lit detecterModalite() côté Totalis), ni dans l'API
// REST d'Orthanc. Le seul endroit où il laisse une trace est le log
// d'Orthanc, au moment du rejet :
//
//   W1126 09:07:59.527584 DICOM-0 main.cpp:429] DICOM authorization rejected  for AET FUJI-SIM on IP 127.0.0.1: This AET is not listed in configuration option "DicomModalities"
//   W1126 09:07:59.528612 DICOM-0 CommandDispatcher.cpp:845] Rejected FindWorklist request from remote DICOM modality with AET "FUJI-SIM" and hostname "127.0.0.1"
//
// (Orthanc 1.13, relevé sur Mac ; même texte sous Windows — note le double
// espace de "rejected  for", d'où les \s+ ci-dessous.)
//
// Ce module ne remonte QUE l'AE Title, l'IP, le type de requête refusée et
// l'heure : jamais le reste de la ligne ni d'autres lignes du log, qui
// peuvent contenir des données patient. Les parties pures (analyse,
// agrégation) sont séparées de la lecture disque pour être testables.
import fs from "fs";
import path from "path";

// Ligne émise par le dispatcher : la seule qui porte le TYPE de requête.
const RE_REQUETE_REJETEE =
  /Rejected\s+(\w+)\s+request\s+from\s+remote\s+DICOM\s+modality\s+with\s+AET\s+"([^"]*)"\s+and\s+hostname\s+"([^"]*)"/;

// Ligne d'autorisation, qui la précède. Gardée en filet de sécurité : si une
// version d'Orthanc change le texte de l'une des deux, l'autre suffit encore
// à découvrir l'appareil. L'IP est suivie d'un ":" (motif du refus) — y
// compris en IPv6 ("on IP ::1: …"), d'où le quantificateur paresseux.
const RE_AUTORISATION_REFUSEE = /authorization\s+rejected\s+for\s+AET\s+(\S+)\s+on\s+IP\s+(\S+?):?(?:\s|$)/;

// Tout ce qui parle de rejet sans correspondre aux deux motifs ci-dessus est
// compté comme « non compris » et remonté à Totalis : c'est le signal qu'une
// mise à jour d'Orthanc a changé le format et que la découverte est aveugle.
const RE_INDICE_REJET = /\brejected\b/i;

// En-tête glog : niveau, MMJJ (ou AAAAMMJJ selon les versions), heure locale.
const RE_HORODATAGE = /^[IWEF](\d{4}|\d{8})\s+(\d{2}):(\d{2}):(\d{2})/;

/**
 * Heure d'une ligne de log, ou null si l'en-tête est absent. glog n'écrit
 * pas toujours l'année : on prend celle de `maintenant`, et l'année
 * précédente si la date tombe dans le futur (log de fin décembre relu en
 * janvier).
 */
export function dateLigne(ligne, maintenant = new Date()) {
  const m = RE_HORODATAGE.exec(ligne);
  if (!m) return null;
  const [, jour, hh, mi, ss] = m;
  let annee;
  let mmjj = jour;
  if (jour.length === 8) {
    annee = Number(jour.slice(0, 4));
    mmjj = jour.slice(4);
  } else {
    annee = maintenant.getFullYear();
  }
  const mois = Number(mmjj.slice(0, 2)) - 1;
  const j = Number(mmjj.slice(2));
  let date = new Date(annee, mois, j, Number(hh), Number(mi), Number(ss));
  if (jour.length === 4 && date.getTime() > maintenant.getTime() + 24 * 3600 * 1000) {
    date = new Date(annee - 1, mois, j, Number(hh), Number(mi), Number(ss));
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Extrait les rejets d'un morceau de log.
 * @returns {{ rejets: Array<{aeTitle, ip, typeRequete: string|null, date: Date}>, nonComprises: number }}
 */
export function analyserLignes(texte, { maintenant = new Date() } = {}) {
  const rejets = [];
  let nonComprises = 0;

  for (const ligne of texte.split(/\r?\n/)) {
    if (!ligne) continue;

    const requete = RE_REQUETE_REJETEE.exec(ligne);
    if (requete) {
      const aeTitle = requete[2].trim();
      const ip = requete[3].trim();
      const precedent = rejets[rejets.length - 1];
      // Les deux lignes d'un même rejet se suivent : on complète celle
      // d'autorisation plutôt que de compter l'appareil deux fois.
      if (precedent && precedent.typeRequete === null && precedent.aeTitle === aeTitle && precedent.ip === ip) {
        precedent.typeRequete = requete[1];
      } else {
        rejets.push({ aeTitle, ip, typeRequete: requete[1], date: dateLigne(ligne, maintenant) ?? maintenant });
      }
      continue;
    }

    const autorisation = RE_AUTORISATION_REFUSEE.exec(ligne);
    if (autorisation) {
      rejets.push({
        aeTitle: autorisation[1].trim(),
        ip: autorisation[2].trim(),
        typeRequete: null,
        date: dateLigne(ligne, maintenant) ?? maintenant,
      });
      continue;
    }

    if (RE_INDICE_REJET.test(ligne)) nonComprises++;
  }

  return { rejets: rejets.filter((r) => r.aeTitle), nonComprises };
}

/**
 * Regroupe les rejets par appareil (AE Title + IP) : un appareil qui
 * interroge sa worklist toutes les 30 s ne doit pas produire 120 entrées
 * par heure.
 */
export function agregerRejets(rejets) {
  const parAppareil = new Map();
  for (const r of rejets) {
    const cle = `${r.aeTitle}|${r.ip}`;
    let a = parAppareil.get(cle);
    if (!a) {
      a = { aeTitle: r.aeTitle, ip: r.ip, typesRequete: new Set(), premiereVue: r.date, derniereVue: r.date, nb: 0 };
      parAppareil.set(cle, a);
    }
    if (r.typeRequete) a.typesRequete.add(r.typeRequete);
    if (r.date < a.premiereVue) a.premiereVue = r.date;
    if (r.date > a.derniereVue) a.derniereVue = r.date;
    a.nb++;
  }
  return [...parAppareil.values()].map((a) => ({
    ...a,
    typesRequete: [...a.typesRequete].sort(),
    premiereVue: a.premiereVue.toISOString(),
    derniereVue: a.derniereVue.toISOString(),
  }));
}

/**
 * Fichier de log en cours d'Orthanc : le plus récent PAR DATE DE
 * MODIFICATION, jamais par nom — le nom porte l'heure de démarrage et le PID
 * (`Orthanc.log.20261126-090538.67777`), et sur Mac `Orthanc.log` est un lien
 * vers lui. Rend le chemin réel, pour qu'un lien et sa cible ne comptent
 * qu'une fois.
 */
export function trouverFichierLog(dossier) {
  let plusRecent = null;
  for (const nom of fs.readdirSync(dossier)) {
    if (!/^orthanc.*\.log/i.test(nom)) continue;
    let reel;
    let stat;
    try {
      reel = fs.realpathSync(path.join(dossier, nom));
      stat = fs.statSync(reel);
    } catch {
      continue; // lien cassé, fichier supprimé entre-temps
    }
    if (!stat.isFile()) continue;
    if (!plusRecent || stat.mtimeMs > plusRecent.mtimeMs) plusRecent = { chemin: reel, mtimeMs: stat.mtimeMs };
  }
  return plusRecent?.chemin ?? null;
}

/** Lit au plus `maxOctets` à partir de `position`, en s'arrêtant à la dernière fin de ligne complète. */
function lireDepuis(fichier, position, maxOctets) {
  const taille = fs.statSync(fichier).size;
  if (position > taille) position = 0; // fichier tronqué ou recréé
  const longueur = Math.min(taille - position, maxOctets);
  if (longueur <= 0) return { texte: "", position };

  const tampon = Buffer.alloc(longueur);
  const fd = fs.openSync(fichier, "r");
  try {
    fs.readSync(fd, tampon, 0, longueur, position);
  } finally {
    fs.closeSync(fd);
  }

  // Une ligne en cours d'écriture par Orthanc sera relue entière au cycle
  // suivant. Exception : un morceau sans aucune fin de ligne qui remplit
  // tout `maxOctets` — on l'avance quand même, sinon on bloquerait à jamais.
  const finLigne = tampon.lastIndexOf(0x0a);
  const utile = finLigne >= 0 ? finLigne + 1 : longueur === maxOctets ? longueur : 0;
  return { texte: tampon.subarray(0, utile).toString("utf8"), position: position + utile };
}

/**
 * Nouveautés du log depuis le dernier passage.
 *
 * Au changement de fichier (Orthanc redémarré), on termine d'abord la fin
 * de l'ancien : sans ça, les rejets survenus entre le dernier cycle et le
 * redémarrage seraient perdus — or c'est typiquement en redémarrant
 * Orthanc après un réglage qu'on teste un nouvel appareil.
 *
 * @param {string} dossier
 * @param {{fichier: string, position: number}|null} curseur
 * @returns {{ texte: string, curseur: {fichier, position}|null }}
 */
export function lireNouveautes(dossier, curseur, { maxOctets = 5 * 1024 * 1024 } = {}) {
  const fichier = trouverFichierLog(dossier);
  if (!fichier) return { texte: "", curseur };

  let texte = "";
  let position = 0;

  if (curseur?.fichier === fichier) {
    position = curseur.position;
  } else if (curseur?.fichier && fs.existsSync(curseur.fichier)) {
    texte = lireDepuis(curseur.fichier, curseur.position, maxOctets).texte;
  }

  const lu = lireDepuis(fichier, position, maxOctets);
  return { texte: texte + lu.texte, curseur: { fichier, position: lu.position } };
}
