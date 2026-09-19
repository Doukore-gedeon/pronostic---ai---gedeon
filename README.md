
# Pronostic IA Gédéon V7.1

V7.1 est une évolution orientée **mesure réelle** : elle ne prétend pas être infaillible.
Elle combine forme récente, modèle de Poisson, signal API-Football, qualité des données,
accord entre modèles, marchés de buts/BTTS/corners, comparaison avec les cotes disponibles,
et surtout un historique des prédictions réellement vérifiées.

## Nouveautés V7.1

- Analyse automatique des 10 derniers matchs.
- Pondération des matchs récents.
- Séparation domicile/extérieur dans les données préparées.
- Modèle de buts de Poisson.
- Modèle corners séparé lorsque les statistiques de corners sont suffisamment disponibles.
- Marchés : 1X2, Over 1.5/2.5/3.5, BTTS, corners 7.5/8.5/9.5/10.5.
- **NO BET** si la qualité des données ou l'accord des modèles est insuffisant.
- TOP PICK + TOP CORNER PICK.
- Comparaison probabilité modèle / probabilité implicite de la cote quand une cote est disponible.
- Historique local SQLite.
- Brier score.
- Calibration par tranches de probabilité.
- Statistiques par marché.
- Version du modèle enregistrée pour chaque prédiction.
- Correction du règlement des prédictions et règlement déclenché par l'API de performance.
- Cache serveur et regroupement des fixtures historiques pour limiter les appels API.

## Installation

Pré-requis : Node.js 22.5+.

```bash
npm install
```

Définir la clé API sans la mettre dans le frontend :

Linux/macOS :
```bash
export API_FOOTBALL_KEY="TA_CLE_API_FOOTBALL"
npm start
```

Windows PowerShell :
```powershell
$env:API_FOOTBALL_KEY="TA_CLE_API_FOOTBALL"
npm start
```

Puis ouvrir :
`http://localhost:3000`

## Important sur l'API

La clé doit rester côté serveur. Ne la mets jamais dans `public/index.html`.

Le projet est conçu pour limiter les appels avec cache et requêtes groupées. API-Football indique que
`/fixtures?ids=...` peut regrouper jusqu'à 20 fixtures et retourner les données disponibles pour ces matchs.

Le forfait gratuit API-Football affiche actuellement 100 requêtes/jour. La V7.1 évite donc les rafraîchissements automatiques agressifs.

## Ce que signifie la "confiance"

La confiance V7.1 est un indicateur interne basé sur :
- probabilité du modèle,
- qualité des données,
- accord entre modèles.

Ce n'est **pas** une probabilité garantie de gagner un pari.

## Calibration

Après avoir enregistré suffisamment de prédictions et attendu les résultats réels,
la page Performance affiche des tranches comme 60–70 %, 70–80 %, etc.

Exemple d'interprétation :
si 100 prédictions annoncées à 70–80 % ont réellement gagné 72 fois,
le modèle est plutôt bien calibré sur cette tranche.

Avec peu de matchs, une tranche n'est pas statistiquement fiable : la V7.1 affiche le nombre
d'observations pour éviter de tirer des conclusions trop vite.

## Limites

- Les données et statistiques disponibles varient selon la compétition, la saison et le match.
- Les cotes peuvent manquer.
- Le modèle corners devient disponible seulement lorsque suffisamment de données sont présentes.
- V7.1 n'est pas un système de garantie de gains.
- SQLite convient pour une utilisation personnelle/prototype. Une version multi-utilisateur
  devra passer à PostgreSQL et à un vrai worker/scheduler.

## API utilisées

- `/fixtures`
- `/predictions`
- `/fixtures/headtohead`
- `/odds`

La documentation officielle API-Football doit être consultée avant toute mise en production.
