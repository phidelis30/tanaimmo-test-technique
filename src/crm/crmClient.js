import { randomUUID } from "node:crypto";

// Connecteur CRM (partie 2) : POST {CRM_BASE_URL}/v1/leads
// Les choix (retries, idempotence, token) sont expliqués dans REPONSES.md, partie 2.

const RETRYABLE_STATUS = [408, 429, 500, 502, 503, 504];

export class CrmError extends Error {
  constructor(message, { status, code, retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = "CrmError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.attempts = 0;
  }
}

export function createCrmClient(options = {}) {
  const {
    baseUrl = process.env.CRM_BASE_URL || "https://crm.example.com",
    token = process.env.CRM_API_TOKEN,
    timeoutMs = 5000,
    maxAttempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 10000,
    // injectés dans les tests
    fetch = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    logger = console,
  } = options;

  async function createLead(lead, { idempotencyKey = randomUUID() } = {}) {
    if (!token) {
      throw new CrmError("CRM_API_TOKEN n'est pas défini", { code: "MISSING_TOKEN" });
    }
    checkLead(lead);

    const body = JSON.stringify({
      listingId: lead.listingId,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      message: lead.message,
    });

    // la même clé est envoyée à chaque tentative
    for (let attempt = 1; ; attempt++) {
      try {
        return await sendOnce(body, idempotencyKey);
      } catch (err) {
        err.attempts = attempt;
        const info = { listingId: lead.listingId, idempotencyKey, attempt, status: err.status, code: err.code };

        if (!err.retryable || attempt >= maxAttempts) {
          logger.error("CRM createLead abandonne", info);
          throw err;
        }

        const delay = err.retryAfterMs ?? backoff(attempt);
        if (delay > maxDelayMs) {
          // on ne bloque pas l'appelant trop longtemps, il pourra replanifier
          logger.error("CRM createLead abandonne, Retry-After trop long", { ...info, delay });
          throw err;
        }

        logger.warn("CRM createLead, nouvel essai", { ...info, delay });
        await sleep(delay);
      }
    }
  }

  async function sendOnce(body, idempotencyKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(`${baseUrl}/v1/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey,
        },
        body,
        signal: controller.signal,
      });

      if (res.ok) {
        const data = await res.json();
        return { id: data.id, createdAt: data.createdAt };
      }
    } catch (err) {
      // timeout ou erreur réseau : on peut réessayer, la clé d'idempotence évite les doublons
      const isTimeout = controller.signal.aborted;
      throw new CrmError(isTimeout ? `timeout CRM (${timeoutMs} ms)` : "erreur reseau vers le CRM", {
        code: isTimeout ? "TIMEOUT" : "NETWORK",
        retryable: true,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    // Réponse HTTP en erreur. Le body n'est pas mis dans le message (il peut contenir des données perso).
    res.body?.cancel().catch(() => {});
    const hint = res.status === 401 ? " (verifier CRM_API_TOKEN)" : "";
    const error = new CrmError(`CRM a repondu ${res.status}${hint}`, {
      status: res.status,
      code: "HTTP_" + res.status,
      retryable: RETRYABLE_STATUS.includes(res.status),
    });
    if (res.status === 429) {
      error.retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    }
    throw error;
  }

  // max 500 ms, puis 1 s, 2 s... et on tire au hasard entre 50 et 100 % de ce max,
  // pour que tous les appels en échec ne réessaient pas au même moment
  function backoff(attempt) {
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    return Math.round(delay / 2 + (random() * delay) / 2);
  }

  return { createLead };
}

function checkLead(lead) {
  if (!lead || !lead.listingId || !lead.name || (!lead.phone && !lead.email)) {
    throw new CrmError("lead invalide : listingId, name et phone ou email sont obligatoires", {
      code: "INVALID_LEAD",
    });
  }
}

// Retry-After est en secondes d'après la doc du CRM, mais la norme HTTP autorise aussi une date
function parseRetryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

// createLead(lead) comme demandé dans l'énoncé, configuré avec les variables d'environnement
let defaultClient;
export function createLead(lead, options) {
  if (!defaultClient) defaultClient = createCrmClient();
  return defaultClient.createLead(lead, options);
}
