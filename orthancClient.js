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

    async getSystemInfo() {
      const { data } = await http.get("/system");
      return data;
    },
  };
}
