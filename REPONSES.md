# REPONSES

## Partie 1 - Revue de code

### Extrait A - composant React ListingList

| Problème | Gravité | Correction proposée |
|---|---|---|
| Le `useEffect` n'a pas de tableau de dépendances, donc il se relance après chaque rendu. Comme il fait des `setState`, ça donne une boucle infinie de requêtes : chaque visiteur envoie des appels à l'API en continu. | Critique | Mettre `[city]` en dépendances. |
| Pas de gestion d'erreur : pas de `.catch` et `r.ok` n'est pas vérifié. Si le réseau coupe, on reste bloqué sur "Chargement...". Si l'API renvoie une erreur 500 en JSON, `listings.map` plante et la page devient blanche. | Haute | Vérifier `r.ok`, ajouter un `.catch` avec un état `error`, et remettre `loading` à false dans tous les cas. |
| Race condition : si `city` change vite, l'ancienne réponse peut arriver après la nouvelle, et on affiche les annonces de la mauvaise ville. Il y a aussi des `setState` après le démontage. | Moyenne | `AbortController` et une fonction de cleanup dans le `useEffect`. |
| `l.price.toLocaleString()` plante si le prix est `null` (par exemple "prix sur demande") et casse toute la liste. En plus, le format change selon la langue du navigateur. | Moyenne | Tester `price != null` et utiliser `Intl.NumberFormat("fr-FR")`. |
| `city` est mis dans l'URL sans encodage : un espace, un `&` ou un `#` cassent la requête ou ajoutent des paramètres. Si `city` est vide, on envoie `city=undefined`. | Moyenne | `URLSearchParams`, et ne rien faire si `city` est vide. |
| Pas de `key` sur les `<li>`. | Faible | `key={l.id}` |

Version corrigée (avec le nouveau format de réponse de l'API, voir l'extrait B) :

```jsx
import { useEffect, useState } from "react";

const priceFormat = new Intl.NumberFormat("fr-FR");

export function ListingList({ city }) {
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!city) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch(`/api/listings?${new URLSearchParams({ city })}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((data) => {
        if (!controller.signal.aborted) setListings(data.items || []);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setError("Impossible de charger les annonces.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [city]);

  if (loading) return <p>Chargement...</p>;
  if (error) return <p>{error}</p>;
  if (listings.length === 0) return <p>Aucune annonce pour cette ville.</p>;

  return (
    <ul>
      {listings.map((l) => (
        <li key={l.id}>
          {l.title} - {l.price != null ? priceFormat.format(l.price) + " Ar" : "Prix sur demande"}
        </li>
      ))}
    </ul>
  );
}
```

### Extrait B - route GET /api/listings

Corrigé dans `src/routes/listings.js`.

| Problème | Gravité | Correction proposée |
|---|---|---|
| Injection SQL : `city` est concaténé directement dans la requête. Avec `city=' OR '1'='1`, on récupère toute la table, et on peut faire bien pire. | Critique | Requête paramétrée (`$1`) et validation de `city`. |
| N+1 : pour N annonces, on fait 1 + 2N requêtes, l'une après l'autre. Pour 500 annonces, ça fait 1001 requêtes pour une seule recherche. Pendant un pic de trafic, le pool de connexions sature et tout ralentit. | Critique | Charger les agences et les photos de toute la page en 2 requêtes (`WHERE id = ANY($1)`), donc 3 requêtes au total. |
| Pas de pagination : `page` est lu mais jamais utilisé, et il n'y a pas de LIMIT. On renvoie toute la ville, et ça grossit avec le nombre d'annonces. | Haute | LIMIT/OFFSET avec 20 annonces par page, `page` validé, et un champ `hasMore`. |
| Aucune gestion d'erreur. Avec Express 4, si la requête SQL échoue, la promesse rejetée n'est pas gérée : la requête reste bloquée, et depuis Node 15 le process peut crasher (unhandled rejection). | Haute | try/catch avec `next(err)`, et un middleware d'erreur qui renvoie un 500 simple. |
| `SELECT *` : on renvoie toutes les colonnes au front, y compris d'éventuelles infos internes (sur les agences par exemple). | Moyenne | Lister les colonnes. |
| `row.agency` contient le résultat de la requête (un tableau) et pas l'agence : le front reçoit `agency: [{...}]`. | Moyenne | Récupérer l'objet agence, via une Map par id. |

Notes :
- J'ai changé le format de la réponse : `{ items, page, pageSize, hasMore }` au lieu d'un tableau. Comme le site n'est pas encore en prod, ça me paraît acceptable, mais il faut adapter le front (c'est fait dans la version corrigée de A).
- Il faut aussi des index : `listings (city, created_at DESC)` et `photos (listing_id)`. Je ne les ai pas mis dans le dépôt, faute de migrations.
- J'ai ajouté un `Cache-Control: public, max-age=30`. Les résultats de recherche sont les mêmes pour tout le monde, donc un CDN peut absorber une bonne partie du trafic. La durée est à voir avec le client.

### Extrait C - webhook de paiement

Corrigé dans `src/routes/paymentWebhook.js`.

| Problème | Gravité | Correction proposée |
|---|---|---|
| Rien ne vérifie que la requête vient bien du prestataire. N'importe qui peut envoyer un `payment.succeeded` avec un `booking_id` et obtenir une réservation payée gratuitement. | Critique | Vérifier la signature HMAC sur le body brut (`express.raw` au lieu de `express.json`), avec `timingSafeEqual`. |
| Pas d'idempotence, alors que le prestataire réessaie jusqu'à 5 fois : le client peut recevoir plusieurs emails, et le CRM plusieurs notifications, pour le même paiement. | Haute | Enregistrer l'id de l'événement avec une contrainte unique (`ON CONFLICT DO NOTHING`) et ignorer les doublons. |
| On attend l'email et le CRM (2 à 8 s) avant de répondre. On peut dépasser les 10 s : le prestataire croit alors que l'appel a échoué et renvoie l'événement, ce qui aggrave les doublons. | Haute | Répondre dès que le paiement est enregistré. L'email et le CRM sont ajoutés dans une table `jobs`, dans la même transaction, puis traités par un worker. |
| Pas de try/catch : si l'email ou le CRM plante, il n'y a pas de réponse (ou un crash), et le prestataire réessaie. Une panne du CRM ne devrait pas faire échouer un paiement. | Haute | Renvoyer 500 seulement si l'enregistrement en base échoue. Il y a alors un rollback, donc le réessai est utile. |
| On fait confiance au contenu du webhook : on ne vérifie ni que la réservation existe, ni le montant ; le statut est écrasé même si la réservation est annulée ; et le reçu part à l'email donné dans le payload. | Haute | Lire la réservation en base, vérifier le montant et la devise, passer à `paid` seulement depuis `pending`, et utiliser l'email enregistré en base. Si quelque chose ne correspond pas, on répond quand même 200 (réessayer n'y changerait rien), mais on log une erreur pour qu'un humain vérifie. |

Tables utilisées par la correction (pas créées dans le dépôt) : `payment_events (event_id PRIMARY KEY, payload, created_at)` et `jobs (id, type, payload, status, attempts)`.

## Partie 2 - Connecteur CRM

Code dans `src/crm/crmClient.js`, tests dans `test/crmClient.test.js`.

Comment je l'ai fait :
- **Timeout** : 5 s par tentative, avec un `AbortController`.
- **Quand réessayer** : sur 429, 500, 502 et 503 (j'ai ajouté 408 et 504, qui sont aussi temporaires), sur un timeout et sur une erreur réseau. Pas de réessai sur les autres 4xx : un 400 ou un 401 ne va pas se corriger tout seul. Pour le 401, le message d'erreur dit de vérifier le token.
- **Nombre d'essais** : 3 tentatives maximum. Entre deux tentatives, on attend au plus 500 ms, puis au plus 1 s (backoff exponentiel). La durée exacte est tirée au hasard entre 50 et 100 % de ce maximum, pour éviter que tous les appels en échec réessaient en même temps.
- **429** : j'attends la durée du `Retry-After`. S'il demande plus de 10 s, j'abandonne tout de suite plutôt que de bloquer : c'est à l'appelant de replanifier.
- **Idempotence** : une clé `Idempotency-Key` est générée une seule fois par lead et renvoyée à chaque tentative. Le cas qui compte, c'est le timeout : le CRM a peut-être créé le lead sans qu'on reçoive la réponse. Avec la même clé, il doit renvoyer le lead existant au lieu d'en créer un deuxième. Ça suppose que le CRM gère cet en-tête (à confirmer avec leur doc). On peut aussi passer sa propre clé, par exemple l'id du formulaire enregistré en base, pour que ça marche même après un redémarrage du serveur.
- **Token** : il est lu dans `CRM_API_TOKEN` et sert uniquement dans l'en-tête `Authorization`. Les erreurs et les logs ne contiennent que l'id de l'annonce, le status, le code, le numéro de tentative, le délai et la clé d'idempotence. Je ne mets pas non plus le body d'erreur du CRM dans les messages, car il peut contenir des données personnelles.

Tests : les deux demandés (429 puis succès, 500 trois fois puis abandon), plus quatre autres :
- un 400 n'est pas réessayé ;
- un timeout ne crée pas de doublon ;
- un `Retry-After` trop long fait abandonner ;
- le token n'apparaît nulle part.

`fetch` et `sleep` sont injectés : les tests ne font aucun appel réseau et n'attendent pas vraiment.

Limite : `createLead` peut prendre environ 16 s si le CRM ne répond plus (3 timeouts de 5 s, plus les attentes), et jusqu'à 35 s s'il renvoie des 429 avec `Retry-After: 10`. Il ne faut donc pas l'appeler pendant la requête du formulaire de contact. Il faut d'abord enregistrer le contact en base, puis appeler le CRM depuis une tâche en arrière-plan. Je ne l'ai pas fait ici.

## Partie 3 - Gestion d'incident

### 3.1 Vendredi 21h40

**21h40 - alerte et appel du client.** J'acquitte l'alerte et je préviens mon binôme. Au client, je réponds court : "Je vois le problème, c'est lié à l'afflux de la campagne, je suis dessus. Je vous rappelle à 22h00 au plus tard, même si ce n'est pas réglé." Je lui demande de suspendre les envois de SMS restants.

**21h40-21h50 - premières vérifications.**
- Dashboards : trafic par rapport à d'habitude, erreurs et latence par route, instances Node (CPU, mémoire, redémarrages).
- Base : connexions utilisées par rapport au maximum du pool, CPU, requêtes en cours (`pg_stat_activity`).
- Logs : le type d'erreur (attente de connexion, timeout, mémoire).
- Déploiement récent ? Si oui, je fais d'abord un rollback.

**Hypothèses.** La plus probable : le SMS envoie tout le monde sur une recherche par ville, et l'extrait B fait 1 + 2N requêtes, sans LIMIT. Le pool sature, les requêtes attendent une connexion (d'où les 9 s), puis tombent en timeout. On le voit si `pg_stat_activity` est plein de `SELECT url FROM photos ...`. Autres pistes : pas d'index sur `city` (CPU de la base à 100 %), ou des instances Node à court de mémoire à cause des réponses énormes.

**21h50-22h00 - limiter les dégâts, même sans connaître la cause.**
- Cache de `/api/listings` sur le CDN ou le proxy, pendant 30 à 60 s. Tout le monde cherche les mêmes villes : gros effet, et facile à retirer.
- Hotfix d'une ligne (`LIMIT 20`), et index créés avec `CREATE INDEX CONCURRENTLY`, qui ne bloque pas les écritures.
- Pas d'instances Node en plus si c'est la base qui sature : plus d'instances, c'est plus de connexions, donc pire.
- En dernier recours, une limite de débit au proxy : des 503 rapides plutôt que tout laisser s'empiler. Le webhook de paiement et le formulaire de contact restent hors limite.

**22h00 - point avec le client.** Je lui dis ce qui a été fait, le résultat mesuré ("35 % d'erreurs au début, 2 % maintenant") et l'heure du prochain point. Ensuite, un point toutes les 30 min jusqu'au retour à la normale. Je ne promets rien que je n'ai pas vérifié, et je note les heures et les actions pour le post-mortem.

**Le lendemain.**
- Je vérifie la nuit et je garde les mitigations.
- Je déploie la vraie correction de B, avec les index, puis je fais un test de charge (k6) à 2 fois le pic de la veille avant la prochaine campagne.
- Je rejoue ce qui a été perdu (formulaires de contact, webhooks en erreur).
- J'envoie au client un post-mortem court : ce qui s'est passé, la durée, la cause, et ce qu'on change, avec une date.
- Je lui demande de nous prévenir quelques jours avant chaque campagne.

### 3.2 Alertes avant le lancement

1. Taux de 5xx : au-dessus de 2 % sur 5 min, message à l'équipe ; au-dessus de 5 % sur 2 min, appel d'astreinte. Grafana + Prometheus.
2. Latence p95 au-dessus de 1,5 s sur 5 min (le p95 se dégrade avant la médiane). Grafana.
3. Base : connexions au-dessus de 80 % du pool, ou CPU au-dessus de 80 % pendant 5 min. postgres_exporter + Grafana.
4. Sonde externe chaque minute (accueil, recherche, `/health`), alerte après 2 échecs de suite. Elle détecte aussi les pannes de DNS, de certificat ou d'hébergeur. UptimeRobot.
