import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createApp } from "../src/app.js";
import { fakeLogger } from "./helpers.js";

// Ici on teste surtout le montage dans Express (body brut pour le webhook, middleware d'erreur),
// la logique des routes est déjà testée dans les autres fichiers.

async function withServer(db, fn) {
  const app = createApp({ db, webhookSecret: "test-secret", logger: fakeLogger() });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

describe("app express", () => {
  it("vérifie la signature du webhook sur le body brut", async () => {
    const db = { transaction: async () => "paid" };
    const body = JSON.stringify({ id: "evt_1", type: "payment.succeeded", booking_id: 7, amount: 120000, currency: "MGA" });
    const signature = crypto.createHmac("sha256", "test-secret").update(body).digest("hex");

    await withServer(db, async (url) => {
      const post = (payload) =>
        fetch(url + "/webhooks/payment", {
          method: "POST",
          headers: { "content-type": "application/json", "x-signature": signature },
          body: payload,
        });

      const ok = await post(body);
      assert.equal(ok.status, 200);

      // body modifié avec l'ancienne signature
      const tampered = await post(body.replace("120000", "1"));
      assert.equal(tampered.status, 401);
    });
  });

  it("renvoie un 500 sans détail technique si la base plante", async () => {
    const db = {
      query: async () => {
        throw new Error("connexion refusee par postgres");
      },
    };

    await withServer(db, async (url) => {
      const res = await fetch(url + "/api/listings?city=Antananarivo");
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Erreur interne" });
    });
  });
});
