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

    /** Inventaire des appareils à refléter dans la config d'Orthanc. */
    async getModalites() {
      const { data } = await http.get("/modalites");
      return data;
    },

    /**
     * Commandes à exécuter en local. Totalis ne peut initier aucune
     * connexion vers le site : c'est l'agent qui vient chercher le travail.
     * Cet appel les passe EN_COURS côté serveur — elles ne sont donc pas
     * resservies au cycle suivant, même si leur exécution échoue ici.
     */
    async getCommandes() {
      const { data } = await http.get("/commandes");
      return data;
    },

    /** Appareils refusés par Orthanc, relevés dans son log. */
    async signalerAeDecouverts({ aeDecouverts, lignesNonComprises }) {
      const { data } = await http.post("/ae-decouverts", { aeDecouverts, lignesNonComprises });
      return data;
    },

    async posterResultatCommande(id, { ok, message }) {
      const { data } = await http.post(`/commandes/${id}/resultat`, { ok, message });
      return data;
    },
  };
}
