import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createCrmClient } from "../src/crm/crmClient.js";
import { fakeLogger } from "./helpers.js";

const TOKEN = "secret-token-123";
const lead = {
  listingId: "L42",
  name: "Rakoto",
  phone: "0340000000",
  email: "rakoto@example.com",
  message: "Toujours disponible ?",
};

// mock de l'API CRM : renvoie les réponses dans l'ordre et garde les appels
function mockCrm(...responses) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (!next) throw new Error("appel en trop");
    return next(options);
  };
  return { fetch, calls };
}

const reply = (status, body, headers) => () =>
  new Response(body ? JSON.stringify(body) : null, { status, headers });

function makeClient(fetch, extra = {}) {
  const delays = [];
  const logger = fakeLogger();
  const crm = createCrmClient({
    token: TOKEN,
    fetch,
    sleep: async (ms) => {
      delays.push(ms); // pas de vraie attente dans les tests
    },
    random: () => 1, // pas d'aléatoire dans le backoff
    logger,
    ...extra,
  });
  return { crm, delays, logger };
}

describe("crmClient.createLead", () => {
  it("429 puis succès", async () => {
    const { fetch, calls } = mockCrm(
      reply(429, { error: "too many requests" }, { "Retry-After": "2" }),
      reply(201, { id: "lead_1", createdAt: "2026-09-24T10:00:00Z" })
    );
    const { crm, delays } = makeClient(fetch);

    const result = await crm.createLead(lead);

    assert.deepEqual(result, { id: "lead_1", createdAt: "2026-09-24T10:00:00Z" });
    assert.equal(calls.length, 2);
    assert.deepEqual(delays, [2000]); // on a attendu le Retry-After
    assert.equal(calls[0].options.headers.Authorization, "Bearer " + TOKEN);

    // même clé d'idempotence sur les 2 essais
    const key = calls[0].options.headers["Idempotency-Key"];
    assert.ok(key);
    assert.equal(calls[1].options.headers["Idempotency-Key"], key);
  });

  it("500 trois fois puis abandon", async () => {
    const { fetch, calls } = mockCrm(reply(500), reply(500), reply(500));
    const { crm, delays } = makeClient(fetch);

    await assert.rejects(crm.createLead(lead), { name: "CrmError", status: 500, attempts: 3 });
    assert.equal(calls.length, 3);
    assert.deepEqual(delays, [500, 1000]); // backoff exponentiel
  });

  it("ne réessaie pas sur un 400", async () => {
    const { fetch, calls } = mockCrm(reply(400, { error: "telephone invalide" }));
    const { crm } = makeClient(fetch);

    await assert.rejects(crm.createLead(lead), { status: 400, retryable: false });
    assert.equal(calls.length, 1);
  });

  it("ne crée pas de doublon quand on réessaie après un timeout", async () => {
    // le CRM crée le lead au 1er appel mais ne répond jamais
    const leads = new Map();
    const fetch = async (url, options) => {
      const key = options.headers["Idempotency-Key"];
      if (!leads.has(key)) {
        leads.set(key, { id: "lead_" + (leads.size + 1), createdAt: "2026-09-24T10:00:00Z" });
        return new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return new Response(JSON.stringify(leads.get(key)), { status: 201 });
    };
    const { crm } = makeClient(fetch, { timeoutMs: 20 });

    const result = await crm.createLead(lead);

    assert.equal(result.id, "lead_1");
    assert.equal(leads.size, 1);
  });

  it("abandonne tout de suite si Retry-After est trop long", async () => {
    const { fetch, calls } = mockCrm(reply(429, null, { "Retry-After": "3600" }));
    const { crm, delays } = makeClient(fetch);

    await assert.rejects(crm.createLead(lead), { status: 429 });
    assert.equal(calls.length, 1);
    assert.deepEqual(delays, []);
  });

  it("ne met jamais le token dans l'erreur ni dans les logs", async () => {
    const { fetch } = mockCrm(reply(401, { error: "bad token" }));
    const { crm, logger } = makeClient(fetch);

    const err = await crm.createLead(lead).catch((e) => e);

    assert.equal(err.status, 401);
    assert.ok(!inspect(err, { depth: 5 }).includes(TOKEN));
    assert.ok(!inspect(logger.logs, { depth: 5 }).includes(TOKEN));
  });
});
