# Test technique TanàImmo

Mon rendu pour le test technique TARAM Group (Développeur Web React - maintenance et fiabilité).

Les réponses écrites (partie 1, explications de la partie 2) sont dans [REPONSES.md](REPONSES.md).

## Lancer les tests

Il faut Node.js 22 ou plus. Il n'y a ni base de données ni service externe à installer : tout est simulé en mémoire.

```bash
npm install
npm test
```

`npm install` sert seulement à installer Express, utilisé par `src/app.js` et son test.

Les tests n'ont besoin d'aucune variable d'environnement. Celles de l'application sont listées dans `.env.example` : il n'y a aucun secret dans le dépôt.

## Organisation

- `src/routes/listings.js` : extrait B corrigé
- `src/routes/paymentWebhook.js` : extrait C corrigé
- `src/app.js` : montage des routes dans Express (body brut pour le webhook, middleware d'erreur)
- `src/crm/crmClient.js` : connecteur CRM (partie 2)
- `test/` : les tests (node:test)

## Ce qui est fait

- **Partie 1** : les tableaux des 3 extraits et l'extrait A corrigé sont dans REPONSES.md. Les extraits B et C sont corrigés dans le code, avec des tests.
- **Partie 2** : `createLead` gère :
  - un timeout de 5 s ;
  - des retries avec backoff exponentiel, en respectant Retry-After ;
  - aucun retry sur les 4xx définitives, et 3 tentatives maximum ;
  - une clé d'idempotence ;
  - un token qui n'apparaît ni dans les logs ni dans les messages d'erreur.

  Il y a les 2 tests demandés, plus 4 autres.

## Ce qui n'est pas fait

- Le worker qui traite la table `jobs` (envoi du reçu et notification CRM après un paiement).
- Les migrations SQL (index, tables `payment_events` et `jobs`). Elles sont seulement décrites dans REPONSES.md.
- Le SQL n'a pas été testé sur un vrai PostgreSQL. Comme la base est simulée, les tests vérifient la logique (nombre de requêtes, paramètres, rollback), mais pas la syntaxe.
- L'appel de `createLead` depuis une file de tâches (il ne faut pas l'appeler pendant la requête du formulaire).
- Pas de test de charge, ni de test du composant React.

## Hypothèses

- `db.query(sql, params)` renvoie directement les lignes, comme dans les extraits, et `db.transaction(fn)` fait un commit ou un rollback.
- Webhook : la signature est un HMAC-SHA256 du body, envoyé dans l'en-tête `X-Signature`, et chaque événement a un `id` qui ne change pas d'un réessai à l'autre. À adapter selon la doc du prestataire.
- Le CRM gère l'en-tête `Idempotency-Key`.
- Certains noms de colonnes absents des extraits (`agencies.name`, `bookings.amount`, etc.) sont supposés.

## Temps passé

- Lecture du sujet et des extraits : 24 min
- Partie 1 (revue des extraits, correction de A, B et C, tests) : 25 min
- Partie 2 (connecteur CRM et tests) : 15 min
