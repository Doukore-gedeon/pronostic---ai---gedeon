# Pronostic IA Gédéon — modèle V7.1

V7.1 conserve le moteur V7 et corrige plusieurs points opérationnels :

- 10 derniers matchs pondérés par récence.
- Split domicile/extérieur dans les données disponibles.
- Modèle de buts Poisson.
- Signal de prédiction API-Football + forme locale.
- Qualité des données et accord entre signaux.
- Modèle corners séparé lorsque les données historiques sont suffisantes.
- Probabilité, cote théorique, cote marché et edge.
- TOP PICK / TOP CORNER PICK / NO BET.
- Historique SQLite des prédictions enregistrées avant le match.
- Accuracy, Brier Score et calibration.
- Règlement des prédictions par lots de fixtures pour limiter les appels API.
- Recherche de cotes plus tolérante aux variantes de noms de marchés.
- Suppression d'un appel H2H inutile.
- Règlement automatique limité à une fois toutes les 10 minutes via `/api/performance`.

Important : les probabilités et la confiance sont des sorties expérimentales du modèle, pas des garanties de résultat.
