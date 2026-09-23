# Test technique TanàImmo

Mon rendu pour le test technique TARAM Group (Développeur Web React - maintenance et fiabilité).

Les réponses écrites (partie 1) sont dans [REPONSES.md](REPONSES.md).

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
- `test/` : les tests (node:test)

## Ce qui est fait

- **Partie 1** : les tableaux des 3 extraits et l'extrait A corrigé sont dans REPONSES.md. Les extraits B et C sont corrigés dans le code, avec des tests.

## Ce qui n'est pas fait

- Le worker qui traite la table `jobs` (envoi du reçu et notification CRM après un paiement).
- Les migrations SQL (index, tables `payment_events` et `jobs`). Elles sont seulement décrites dans REPONSES.md.
- Le SQL n'a pas été testé sur un vrai PostgreSQL. Comme la base est simulée, les tests vérifient la logique (nombre de requêtes, paramètres, rollback), mais pas la syntaxe.
- Pas de test de charge, ni de test du composant React.

## Hypothèses

- `db.query(sql, params)` renvoie directement les lignes, comme dans les extraits, et `db.transaction(fn)` fait un commit ou un rollback.
- Webhook : la signature est un HMAC-SHA256 du body, envoyé dans l'en-tête `X-Signature`, et chaque événement a un `id` qui ne change pas d'un réessai à l'autre. À adapter selon la doc du prestataire.
- Certains noms de colonnes absents des extraits (`agencies.name`, `bookings.amount`, etc.) sont supposés.

## Temps passé

- Lecture du sujet et des extraits : 24 min
- Partie 1 (revue des extraits, correction de A, B et C, tests) : 25 min
