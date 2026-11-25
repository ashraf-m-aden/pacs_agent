// pacs-agent/orthancClient.js
//
// Client REST du PACS Orthanc local (port 8042 par défaut) — jamais le port
// DICOM (4242), qui n'est parlé que par les modalités elles-mêmes.
import axios from "axios";

export function creerClientOrthanc({ orthancUrl, orthancUser, orthancPassword }) {
  const http = axios.create({
    baseURL: orthancUrl,
    auth: orthancUser ? { username: orthancUser, password: orthancPassword } : undefined,
    timeout: 15000,
  });

  return {
    /** Flux d'évènements depuis la séquence `since` (StableStudy nous intéresse). */
    async getChanges(since) {
      const { data } = await http.get("/changes", { params: { since, limit: 100 } });
      return data; // { Changes: [...], Done, Last }
    },

    async getStudy(orthancId) {
      const { data } = await http.get(`/studies/${orthancId}`);
      return data; // { MainDicomTags, PatientMainDicomTags, Series: [...], ... }
    },

    async getStudyStatistics(orthancId) {
      const { data } = await http.get(`/studies/${orthancId}/statistics`);
      return data; // { CountInstances, CountSeries, DiskSize, ... }
    },

    /** Modalités (ex. ["CT"]) à partir des séries de l'étude — pas dans MainDicomTags par défaut. */
    async getModalitesEtude(seriesIds) {
      const modalites = new Set();
      for (const seriesId of seriesIds) {
        const { data } = await http.get(`/series/${seriesId}`);
        const m = data?.MainDicomTags?.Modality;
        if (m) modalites.add(m);
      }
      return [...modalites];
    },

    /**
     * AE Title DE L'APPAREIL qui a effectivement envoyé l'étude — à ne pas
     * confondre avec `Modality` (le type d'examen, ci-dessus). Orthanc
     * l'enregistre comme métadonnée par instance (`RemoteAET`) sur tout ce
     * qui arrive en DICOM (pas sur un import REST/manuel, qui n'en a pas).
     * Sert à detecter automatiquement les appareils du site sans jamais
     * avoir à lire leur AE Title local dans un menu verrouille.
     */
    async getRemoteAetEtude(orthancStudyId) {
      const { data: instances } = await http.get(`/studies/${orthancStudyId}/instances`);
      const premiere = instances?.[0];
      if (!premiere?.ID) return null;
      try {
        const { data } = await http.get(`/instances/${premiere.ID}/metadata/RemoteAET`);
        const aet = typeof data === "string" ? data.trim() : "";
        return aet || null;
      } catch {
        // Pas de metadata RemoteAET (ex: instance importee autrement qu'en
        // DICOM) : ce n'est pas une erreur, juste rien a detecter.
        return null;
      }
    },

    async getSystemInfo() {
      const { data } = await http.get("/system");
      return data;
    },

    // ── Configuration DICOM des appareils du site ───────────────────
    // C'est ici que le site devient capable de PARLER aux modalités :
    // sans entrée dans `DicomModalities`, Orthanc refuse le C-ECHO. On
    // passe par l'API REST plutôt que par orthanc.json — donc à chaud,
    // sans redémarrer Orthanc ni éditer un fichier sous droits admin.
    //
    // ⚠️ Côté Orthanc, `DicomModalitiesInDatabase: true` est nécessaire
    // pour que ces déclarations survivent à un redémarrage du serveur.

    /** `?expand` rend la config complète quand la version d'Orthanc le sait. */
    async getModalites() {
      const { data } = await http.get("/modalities?expand");
      return data;
    },

    /** Idempotent : rejouer un PUT identique ne change rien. */
    async declarerModalite(nom, { aeTitle, host, port }) {
      await http.put(`/modalities/${encodeURIComponent(nom)}`, {
        AET: aeTitle,
        Host: host,
        Port: Number(port),
      });
    },

    async supprimerModalite(nom) {
      await http.delete(`/modalities/${encodeURIComponent(nom)}`);
    },

    /**
     * C-ECHO — le « ping DICOM ». Ouvre une association DICOM et la
     * referme : si ça passe, le triplet IP/port/AE Title est bon des deux
     * côtés. Orthanc parle le DICOM à notre place, l'agent ne fait que du
     * HTTP — c'est tout l'intérêt de passer par son API REST.
     *
     * Rend `{ ok, message }` plutôt que de lever : un appareil éteint est
     * un RÉSULTAT de test, pas une panne de l'agent.
     */
    async echoModalite(nom) {
      try {
        await http.post(`/modalities/${encodeURIComponent(nom)}/echo`, {}, { timeout: 20000 });
        return { ok: true, message: "C-ECHO réussi" };
      } catch (e) {
        // Orthanc répond 500 avec un corps JSON quand l'association
        // échoue. `Details` d'abord, et c'est tout l'intérêt : vérifié sur
        // un Orthanc 1.12, il porte le diagnostic exploitable
        // (« connecting to AET "CT1": TCP Initialization Error … Timeout »)
        // là où `Message` se limite à « Error in the network protocol ».
        // Un technicien peut agir sur le premier, pas sur le second.
        const donnees = e.response?.data;
        const detail =
          donnees?.Details ||
          donnees?.Description ||
          donnees?.Message ||
          (typeof donnees === "string" && donnees ? donnees : null) ||
          e.message;
        return { ok: false, message: String(detail).slice(0, 400) };
      }
    },
  };
}
