// pacs-agent/totalisClient.js
//
// Appelle le préfixe /api/pacs/agent/:companyId/* exposé par Totalis
// (routers/dossier/imagerie/pacsAgent.routes.js), authentifié par le jeton
// de site — jamais le cookie `auth.js` utilisé par le navigateur.
import axios from "axios";

export function creerClientTotalis({ totalisUrl, companyId, siteToken }) {
  const http = axios.create({
    baseURL: `${totalisUrl}/pacs/agent/${companyId}`,
    headers: { Authorization: `Bearer ${siteToken}` },
    timeout: 15000,
  });

  return {
    async getWorklist(curseur) {
      const { data } = await http.get("/worklist", {
        params: curseur ? { curseur } : {},
      });
      return data;
    },

    async ackWorklist(accessionNumbers) {
      const { data } = await http.post("/worklist/ack", { accessionNumbers });
      return data;
    },

    async signalerEtude(etude) {
      const { data } = await http.post("/etudes", etude);
      return data;
    },

    async heartbeat(payload) {
      const { data } = await http.post("/heartbeat", payload);
      return data;
    },
  };
}
