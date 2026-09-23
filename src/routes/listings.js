// Extrait B corrigé : GET /api/listings?city=...&page=...
// Comme dans l'extrait, on suppose que db.query(sql, params) renvoie directement les lignes.

export const PAGE_SIZE = 20;

export function createListingsHandler({ db }) {
  return async (req, res, next) => {
    const { city, page = "1" } = req.query;

    // city peut être un tableau si on appelle ?city=a&city=b
    if (typeof city !== "string" || !city.trim() || city.length > 100) {
      return res.status(400).json({ error: "city invalide" });
    }
    if (typeof page !== "string" || !/^[1-9]\d{0,5}$/.test(page)) {
      return res.status(400).json({ error: "page invalide" });
    }
    const pageNum = Number(page);

    try {
      // on demande une ligne de plus pour savoir s'il y a une page suivante (sans COUNT)
      const rows = await db.query(
        `SELECT id, title, price, city, created_at, agency_id
         FROM listings
         WHERE city = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [city.trim(), PAGE_SIZE + 1, (pageNum - 1) * PAGE_SIZE]
      );

      const hasMore = rows.length > PAGE_SIZE;
      const items = await addAgenciesAndPhotos(db, rows.slice(0, PAGE_SIZE));

      // les résultats sont les mêmes pour tout le monde, un cache court aide pendant les pics
      res.set("Cache-Control", "public, max-age=30");
      res.json({ items, page: pageNum, pageSize: PAGE_SIZE, hasMore });
    } catch (err) {
      next(err);
    }
  };
}

// 2 requêtes pour toute la page au lieu de 2 par annonce
async function addAgenciesAndPhotos(db, listings) {
  if (listings.length === 0) return [];

  const listingIds = listings.map((l) => l.id);
  const agencyIds = [...new Set(listings.map((l) => l.agency_id))];

  const [agencies, photos] = await Promise.all([
    db.query("SELECT id, name, phone FROM agencies WHERE id = ANY($1)", [agencyIds]),
    db.query("SELECT listing_id, url FROM photos WHERE listing_id = ANY($1) ORDER BY id", [listingIds]),
  ]);

  const agenciesById = new Map(agencies.map((a) => [a.id, a]));

  return listings.map(({ agency_id, ...listing }) => ({
    ...listing,
    agency: agenciesById.get(agency_id) || null,
    photos: photos.filter((p) => p.listing_id === listing.id).map((p) => ({ url: p.url })),
  }));
}
