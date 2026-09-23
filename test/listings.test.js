import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createListingsHandler } from "../src/routes/listings.js";
import { fakeRes } from "./helpers.js";

// fausse base : garde les requêtes reçues et renvoie des données en dur
function fakeDb(listings = []) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("FROM listings")) {
        const [city, limit, offset] = params;
        return listings.filter((l) => l.city === city).slice(offset, offset + limit);
      }
      if (sql.includes("FROM agencies")) {
        return [{ id: 1, name: "Agence Tana", phone: "0340000000" }];
      }
      if (sql.includes("FROM photos")) {
        return params[0].map((id) => ({ listing_id: id, url: `/photos/${id}.jpg` }));
      }
      throw new Error("requete inattendue : " + sql);
    },
  };
}

function makeListings(n) {
  const listings = [];
  for (let i = 1; i <= n; i++) {
    listings.push({ id: i, title: "Annonce " + i, price: 100000000, city: "Antananarivo", agency_id: 1 });
  }
  return listings;
}

async function get(db, query) {
  const res = fakeRes();
  let error;
  await createListingsHandler({ db })({ query }, res, (err) => (error = err));
  return { res, error };
}

describe("GET /api/listings", () => {
  it("fait 3 requêtes au total et pas 1 + 2N", async () => {
    const db = fakeDb(makeListings(20));
    const { res } = await get(db, { city: "Antananarivo" });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 20);
    assert.equal(db.queries.length, 3);
    assert.equal(res.body.items[0].agency.name, "Agence Tana");
    assert.deepEqual(res.body.items[0].photos, [{ url: "/photos/1.jpg" }]);
  });

  it("passe city en paramètre (pas d'injection SQL)", async () => {
    const db = fakeDb(makeListings(3));
    const city = "x' OR '1'='1";
    const { res } = await get(db, { city });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.items, []);
    assert.ok(!db.queries[0].sql.includes(city));
    assert.equal(db.queries[0].params[0], city);
  });

  it("pagine par 20", async () => {
    const db = fakeDb(makeListings(25));

    const page1 = await get(db, { city: "Antananarivo" });
    assert.equal(page1.res.body.items.length, 20);
    assert.equal(page1.res.body.hasMore, true);

    const page2 = await get(db, { city: "Antananarivo", page: "2" });
    assert.equal(page2.res.body.items.length, 5);
    assert.equal(page2.res.body.hasMore, false);
  });

  it("renvoie 400 si city ou page sont invalides", async () => {
    const db = fakeDb();
    const badQueries = [{}, { city: "" }, { city: ["a", "b"] }, { city: "Tana", page: "0" }, { city: "Tana", page: "abc" }];

    for (const query of badQueries) {
      const { res } = await get(db, query);
      assert.equal(res.statusCode, 400);
    }
    assert.equal(db.queries.length, 0);
  });

  it("passe l'erreur à next() si la base plante", async () => {
    const db = {
      query: async () => {
        throw new Error("db down");
      },
    };
    const { res, error } = await get(db, { city: "Antananarivo" });

    assert.equal(error.message, "db down");
    assert.equal(res.body, undefined);
  });
});
