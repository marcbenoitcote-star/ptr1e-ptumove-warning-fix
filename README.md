# PTR1e PTUMove Warning Fix

Petit module de compatibilite pour **Pokemon Tabletop Reunited 4.4.3.37** sur Foundry VTT 13.

Il supprime les centaines d'avertissements suivants sans remplacer le systeme PTR ni modifier ses compendiums :

```text
PTUMove#item is deprecated. The collection now contains PTUMove items directly; use the move itself.
```

## Fonctionnement

Dans PTR 4.4.3.37, le getter obsolete `PTUMove#item` affiche un avertissement puis retourne simplement le mouvement lui-meme. Ce module conserve exactement ce resultat (`return this`) mais retire l'appel qui produit l'avertissement.

La version 0.2.0 memorise silencieusement les acces obsoletes et ajoute un audit manuel en lecture seule. Aucun Actor, Item ou Rule Element n'est modifie.

Le correctif refuse de s'activer avec une autre version du systeme afin de ne pas masquer un changement ulterieur de PTR.

## Installation

Dans Foundry ou Forge, installer le module avec ce manifeste :

```text
https://github.com/marcbenoitcote-star/ptr1e-ptumove-warning-fix/releases/latest/download/module.json
```

Il est aussi possible d'installer `module.zip` manuellement ou de copier ce dossier dans `Data/modules/ptr1e-ptumove-warning-fix`.

Ensuite :

1. Activer **PTR1e PTUMove Warning Fix** dans le monde.
2. Recharger completement la page.
3. Vider la console, changer de scene, ouvrir plusieurs fiches et effectuer un jet d'attaque puis de degats.

## Diagnostic dans la console

Executer cette commande dans la console du navigateur :

```js
game.modules.get("ptr1e-ptumove-warning-fix").api.report()
```

Le rapport affiche deux tableaux :

1. Les acces `PTUMove#item`, regroupes par Actor et Move. Ils sont informatifs et n'indiquent pas que les donnees sont corrompues.
2. Les problemes de donnees corrigibles trouves dans les Actors du monde et les Tokens de la scene active.

L'audit recherche actuellement :

- les Moves dont `system.damageBase` vaut `"-"` ;
- les Rule Elements `ApplyEffect` sans `selectors` utilisables ;
- les Rule Elements `ApplyEffect` sans UUID.

Commandes supplementaires :

```js
game.modules.get("ptr1e-ptumove-warning-fix").api.reportAccesses()
game.modules.get("ptr1e-ptumove-warning-fix").api.scanData()
game.modules.get("ptr1e-ptumove-warning-fix").api.clearAccesses()
```

`clearAccesses()` vide uniquement le rapport en memoire pour la page courante. Il ne supprime aucun document Foundry.

## Resultat attendu

- Aucun message `PTUMove#item is deprecated`.
- Un rapport manuel donnant le nom et l'UUID des Actors et Items concernes.
- Les mouvements, jets et degats continuent de fonctionner normalement.
- Le systeme actif reste `ptu` version `4.4.3.37`.

Ce module ne corrige pas les autres erreurs de donnees ou avertissements presents dans la console.
