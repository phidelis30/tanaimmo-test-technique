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
