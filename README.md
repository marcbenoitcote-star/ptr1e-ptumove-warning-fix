# PTR1e PTUMove Warning Fix

Petit module de compatibilite pour **Pokemon Tabletop Reunited 4.4.3.37** sur Foundry VTT 13.

Il supprime les centaines d'avertissements suivants sans remplacer le systeme PTR ni modifier ses compendiums :

```text
PTUMove#item is deprecated. The collection now contains PTUMove items directly; use the move itself.
```

## Fonctionnement

Dans PTR 4.4.3.37, le getter obsolete `PTUMove#item` affiche un avertissement puis retourne simplement le mouvement lui-meme. Ce module conserve exactement ce resultat (`return this`) mais retire l'appel qui produit l'avertissement.

La version 0.4.0 memorise silencieusement les acces obsoletes et ajoute quatre garde-fous cibles :

- un DB egal a `"-"` est traite comme un Move sans degats au lieu d'etre evalue comme une formule invalide ;
- une frequence absente ou inconnue ne bloque plus l'envoi de l'attaque et des degats. Le Move continue sans consommer sa frequence et la console indique les donnees a corriger ;
- le Struggle temporaire d'un Dresseur est retrouve dans `actor.attacks`, comme sur la fiche Pokemon, au lieu d'etre cherche uniquement parmi les Items permanents ;
- un Rule Element `ActiveEffectLike` deja invalide est laisse inactif sans reconstruire et reafficher la meme erreur a chaque preparation de l'Actor.

Aucun Actor, Item ou Rule Element n'est modifie automatiquement.

Le filtrage `ActiveEffectLike` couvre les schemas incomplets, les choix injectes absents, les chemins Actor invalides et les formules vides. Les erreurs sont memorisees une seule fois par Actor, Item, index de regle et valeur, avec un compteur de repetitions. Si le choix ou la donnee est corrige plus tard, la regle est automatiquement acceptee lors de la prochaine preparation de l'Actor.

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

Le rapport affiche quatre tableaux :

1. Les acces `PTUMove#item`, regroupes par Actor et Move. Ils sont informatifs et n'indiquent pas que les donnees sont corrompues.
2. Les Struggles temporaires lances par le correctif de la fiche Dresseur.
3. Les problemes rencontres pendant la session, avec l'Actor, l'Item, leurs UUID, l'index de regle et la valeur fautive.
4. Les problemes de donnees corrigibles trouves dans les Actors du monde et les Tokens de la scene active.

L'audit recherche actuellement :

- les Moves dont `system.damageBase` vaut `"-"` ;
- les Moves dont `system.frequency.type` est absent ou inconnu ;
- les Rule Elements `ApplyEffect` sans `selectors` utilisables ;
- les Rule Elements `ApplyEffect` sans UUID ;
- les Rule Elements `ActiveEffectLike` sans chemin, mode ou valeur valide ;
- les injections `ActiveEffectLike` non resolues, par exemple un choix `rulesSelections` absent ;
- les chemins `ActiveEffectLike` absents de l'Actor et les formules vides.

Commandes supplementaires :

```js
game.modules.get("ptr1e-ptumove-warning-fix").api.reportAccesses()
game.modules.get("ptr1e-ptumove-warning-fix").api.reportStruggleUses()
game.modules.get("ptr1e-ptumove-warning-fix").api.reportRuntimeIssues()
game.modules.get("ptr1e-ptumove-warning-fix").api.scanData()
game.modules.get("ptr1e-ptumove-warning-fix").api.clearAccesses()
game.modules.get("ptr1e-ptumove-warning-fix").api.clearStruggleUses()
game.modules.get("ptr1e-ptumove-warning-fix").api.clearRuntimeIssues()
```

`clearAccesses()` vide uniquement le rapport en memoire pour la page courante. Il ne supprime aucun document Foundry.

## Resultat attendu

- Aucun message `PTUMove#item is deprecated`.
- Aucun message `resolveDbFormula: failed to evaluate formula "-"`.
- Un Move avec un DB valide continue jusqu'aux degats meme si sa frequence est invalide.
- Le clic sur un Struggle dans une fiche Dresseur lance l'attaque temporaire.
- Les `ActiveEffectLike` invalides ne saturent plus la console a chaque recalcul d'Actor.
- Un rapport manuel donnant le nom et l'UUID des Actors et Items concernes.
- Les mouvements, jets et degats continuent de fonctionner normalement.
- Le systeme actif reste `ptu` version `4.4.3.37`.

Le module reduit le bruit et la charge de preparation, mais il ne devine pas les choix de classe manquants et ne repare pas automatiquement les donnees. L'audit indique les documents a corriger pour restaurer ensuite l'automatisation de chaque regle.
