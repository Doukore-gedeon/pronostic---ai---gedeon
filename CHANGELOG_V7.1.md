# Gédéon V7.1 — changements

- Correction d'un appel H2H inutile qui consommait une requête API à chaque analyse.
- Règlement des prédictions groupé jusqu'à 20 fixtures au lieu d'une requête par prédiction.
- Règlement de `/api/performance` limité à une fois toutes les 10 minutes.
- Détection plus robuste des marchés de cotes : 1X2, Over/Under, BTTS et corners.
- Version du moteur passée à V7.1.
