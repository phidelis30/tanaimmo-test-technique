import crypto from "node:crypto";

// Extrait C corrigé : POST /webhooks/payment
//
// Hypothèses (à vérifier dans la doc du prestataire) :
// - header X-Signature = HMAC-SHA256 (hex) du body brut, avec un secret partagé
// - chaque événement a un id qui reste le même quand le prestataire réessaie
// - l'événement contient booking_id, amount et currency

export function isValidSignature(rawBody, signature, secret) {
  if (!secret || typeof signature !== "string") return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

export function createPaymentWebhookHandler({ db, secret, logger = console }) {
  return async (req, res) => {
    // req.body doit être le body brut (express.raw) : la signature est calculée sur les octets reçus
    if (!Buffer.isBuffer(req.body) || !isValidSignature(req.body, req.headers["x-signature"], secret)) {
      // utile pour repérer un secret mal configuré ou quelqu'un qui essaie de forger des paiements
      logger.warn("webhook paiement : signature invalide", { ip: req.ip });
      return res.status(401).send("invalid signature");
    }

    let event;
    try {
      event = JSON.parse(req.body.toString());
    } catch {
      return res.status(400).send("invalid json");
    }
    if (!event || event.id == null) {
      return res.status(400).send("missing event id");
    }

    if (event.type !== "payment.succeeded") {
      return res.status(200).send("ignored");
    }

    try {
      const result = await db.transaction((tx) => handlePaymentSucceeded(tx, event));
      if (result === "unknown_booking" || result === "amount_mismatch") {
        // inutile de faire réessayer le prestataire, mais quelqu'un doit regarder
        logger.error("webhook paiement a verifier", { eventId: event.id, bookingId: event.booking_id, result });
      }
      res.status(200).send("ok");
    } catch (err) {
      // rollback : rien n'est enregistré, le 500 fait réessayer le prestataire
      logger.error("webhook paiement en erreur", { eventId: event.id, error: err.message });
      res.status(500).send("error");
    }
  };
}

async function handlePaymentSucceeded(tx, event) {
  // idempotence : si l'événement est déjà connu on ne refait rien
  const inserted = await tx.query(
    "INSERT INTO payment_events (event_id, payload) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
    [event.id, JSON.stringify(event)]
  );
  if (inserted.length === 0) return "duplicate";

  // on vérifie avec nos données au lieu de croire le payload
  const [booking] = await tx.query(
    "SELECT id, status, amount, currency FROM bookings WHERE id = $1 FOR UPDATE",
    [event.booking_id]
  );
  if (!booking) return "unknown_booking";
  if (Number(booking.amount) !== Number(event.amount) || booking.currency !== event.currency) {
    return "amount_mismatch";
  }
  if (booking.status !== "pending") return "already_" + booking.status;

  await tx.query(
    "UPDATE bookings SET status = 'paid', paid_at = now() WHERE id = $1 AND status = 'pending'",
    [booking.id]
  );

  // Email et CRM sont trop lents pour être faits ici (le CRM met 2 à 8 s).
  // On crée des jobs dans la même transaction, un worker les traite ensuite avec ses propres retries.
  // Le worker prendra l'email du client en base, pas celui envoyé dans le webhook.
  await tx.query(
    "INSERT INTO jobs (type, payload) VALUES ('send_receipt', $1), ('crm_notify_payment', $1)",
    [JSON.stringify({ bookingId: booking.id })]
  );
  return "paid";
}
