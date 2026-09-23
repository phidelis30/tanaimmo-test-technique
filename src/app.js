import express from "express";
import { createListingsHandler } from "./routes/listings.js";
import { createPaymentWebhookHandler } from "./routes/paymentWebhook.js";

export function createApp({ db, webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET, logger = console }) {
  const app = express();

  app.get("/api/listings", createListingsHandler({ db }));

  // express.raw et pas express.json, sinon on ne peut pas vérifier la signature
  app.post(
    "/webhooks/payment",
    express.raw({ type: "application/json", limit: "100kb" }),
    createPaymentWebhookHandler({ db, secret: webhookSecret, logger })
  );

  // on log le détail mais on ne renvoie jamais l'erreur brute au client
  app.use((err, req, res, next) => {
    logger.error("erreur non geree", { path: req.path, error: err.message });
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "Erreur interne" });
  });

  return app;
}
