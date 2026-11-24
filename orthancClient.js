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
  };
}
