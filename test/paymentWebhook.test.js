import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createPaymentWebhookHandler } from "../src/routes/paymentWebhook.js";
import { fakeRes, fakeLogger } from "./helpers.js";

const SECRET = "test-secret";
const event = { id: "evt_1", type: "payment.succeeded", booking_id: 42, amount: 350000, currency: "MGA" };

// base en mémoire avec une transaction simplifiée : on remet l'état d'avant si ça plante
function fakeDb({ failOnJobs = false } = {}) {
  let data = {
    events: [],
    bookings: { 42: { id: 42, status: "pending", amount: 350000, currency: "MGA" } },
    jobs: [],
  };

  async function query(sql, params) {
    if (sql.startsWith("INSERT INTO payment_events")) {
      if (data.events.includes(params[0])) return [];
      data.events.push(params[0]);
      return [{ event_id: params[0] }];
    }
    if (sql.startsWith("SELECT")) {
      const booking = data.bookings[params[0]];
      return booking ? [{ ...booking }] : [];
    }
    if (sql.startsWith("UPDATE bookings")) {
      data.bookings[params[0]].status = "paid";
      return [];
    }
    if (sql.startsWith("INSERT INTO jobs")) {
      if (failOnJobs) {
        failOnJobs = false;
        throw new Error("connexion perdue");
      }
      data.jobs.push("send_receipt", "crm_notify_payment");
      return [];
    }
    throw new Error("requete inattendue : " + sql);
  }

  return {
    get data() {
      return data;
    },
    async transaction(fn) {
      const backup = structuredClone(data);
      try {
        return await fn({ query });
      } catch (err) {
        data = backup;
        throw err;
      }
    },
  };
}

function signedRequest(evt, secret = SECRET) {
  const body = Buffer.from(JSON.stringify(evt));
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return { body, headers: { "x-signature": signature } };
}

async function send(db, req, logger = fakeLogger()) {
  const res = fakeRes();
  await createPaymentWebhookHandler({ db, secret: SECRET, logger })(req, res);
  return res;
}

describe("POST /webhooks/payment", () => {
  it("refuse une requête mal signée", async () => {
    const db = fakeDb();
    const res = await send(db, signedRequest(event, "mauvais-secret"));

    assert.equal(res.statusCode, 401);
    assert.equal(db.data.bookings[42].status, "pending");
  });

  it("marque la réservation payée et crée les jobs email + CRM", async () => {
    const db = fakeDb();
    const res = await send(db, signedRequest(event));

    assert.equal(res.statusCode, 200);
    assert.equal(db.data.bookings[42].status, "paid");
    assert.deepEqual(db.data.jobs, ["send_receipt", "crm_notify_payment"]);
  });

  it("ne traite pas deux fois le même événement", async () => {
    const db = fakeDb();
    await send(db, signedRequest(event));
    const res = await send(db, signedRequest(event));

    assert.equal(res.statusCode, 200);
    assert.equal(db.data.jobs.length, 2);
  });

  it("ne passe pas en payé si le montant ne correspond pas", async () => {
    const db = fakeDb();
    const logger = fakeLogger();
    const res = await send(db, signedRequest({ ...event, amount: 1000 }), logger);

    assert.equal(res.statusCode, 200);
    assert.equal(db.data.bookings[42].status, "pending");
    assert.equal(logger.logs[0][0], "error");
  });

  it("renvoie 500 si la base plante, et le réessai du prestataire marche", async () => {
    const db = fakeDb({ failOnJobs: true });

    const first = await send(db, signedRequest(event));
    assert.equal(first.statusCode, 500);
    assert.equal(db.data.events.length, 0); // rollback

    const retry = await send(db, signedRequest(event));
    assert.equal(retry.statusCode, 200);
    assert.equal(db.data.bookings[42].status, "paid");
  });
});
