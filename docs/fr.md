# SOMA Connect

Pilotez vos **SOMA Smart Shades** (moteurs de stores enrouleurs) et **SOMA
Tilt** (moteurs de stores vénitiens) depuis Gladys, par l'API HTTP locale de
votre pont **SOMA Connect**.

> Intégration non officielle, sans lien avec SOMA (Wazombi Labs). Elle n'a
> **jamais été testée avec un vrai SOMA Connect** : elle suit l'API utilisée
> par pysoma, la bibliothèque du fabricant. Vos retours sont les bienvenus.

## Fonctionnement

- Gladys ne parle qu'en **HTTP** à SOMA Connect, sur votre réseau local (port
  3000). Le lien Bluetooth vers les stores reste dans SOMA Connect : Gladys n'a
  pas besoin de Bluetooth. Pas de compte, pas de cloud.
- Chaque appareil listé par SOMA Connect devient un **volet** dans l'onglet
  Découverte, avec :
  - **Ouverture / fermeture** : ouvrir, fermer et **arrêter** ;
  - **Position** : de 0 % (fermé) à 100 % (ouvert) ;
  - **Batterie** (%), lue au plus une fois par heure (chaque lecture réveille
    le store).
- Un **Tilt** oriente les lames : 100 % = lames à plat (ouvert), 0 % = fermé
  vers le bas. Un Tilt fermé vers le haut (depuis l'application SOMA) se lit
  fermé ; Gladys ne ferme que vers le bas.

## Mise en route

1. Appairez vos stores à SOMA Connect dans l'application SOMA, et vérifiez que
   SOMA Connect est sur votre réseau.
2. Donnez à SOMA Connect une adresse fixe dans votre box (réservation DHCP).
3. Dans Gladys, saisissez son **adresse IP** (port 3000 par défaut ; un autre
   port : `192.168.1.50:3001`) et enregistrez. Appuyez sur **Tester la
   connexion**.
4. Dans l'onglet **Découverte**, ajoutez les stores.

## Commandes

- **Ouvrir, fermer et la position** partent vers SOMA Connect dans les 3,5 s
  de votre clic, ou sont refusées sans rien envoyer. Chaque store prend ses
  mouvements un par un (4 en attente au plus) ; des stores différents bougent
  côte à côte, une scène peut donc bouger tous vos stores d'un coup.
- L'accusé de réception dit que **SOMA Connect a accepté** la commande. La
  position n'est **confirmée** que par une lecture qui la montre (à 2 % près) :
  le store est relu 2, 5, 20, 45 et 90 s après une commande. Un store qui n'a
  pas atteint sa position après la dernière lecture reçoit un badge
  d'avertissement et une ligne dans le statut.
- Une commande qui a pu atteindre SOMA Connect sans réponse est annoncée
  « envoyée, sans confirmation », et non « non envoyée ».

### Arrêt

L'arrêt passe devant : il ne prend aucune file, n'attend aucune lecture, ne
dépend d'aucune option, et passe à travers une pause demandée par SOMA Connect
et l'espacement des essais après une panne. Il fonctionne dès le redémarrage,
avant toute lecture (l'adresse, le micrologiciel et les stores sont gardés
dans `/data`). Il annule les mouvements de ce store pas encore partis : un
mouvement demandé avant un arrêt ne part pas après lui. Une lecture muette
depuis une seconde est coupée pour lui laisser la place.

Un arrêt est refusé, ou ne part pas, dans ces cas seulement :

- le store est inconnu de l'intégration (jamais listé par SOMA Connect, et pas
  gardé dans `/data`), ou aucune adresse de SOMA Connect n'est saisie ni
  gardée ;
- un mouvement de ce store demandé **après** l'arrêt a été accepté par SOMA
  Connect entre-temps (c'est ce mouvement que vous avez demandé en dernier) ;
- SOMA Connect est injoignable, ou répond une erreur, pendant 3,5 s (essai
  toutes les 250 ms) : l'arrêt est alors **gardé** (aussi dans `/data`) et
  renvoyé avec les lectures suivantes (au moins une fois par minute), 3 fois
  au plus ; le statut et le badge le disent, et disent quand il est abandonné.

Si les lectures après un arrêt montrent que le store bouge encore, l'arrêt
est renvoyé (3 fois au plus).

## Lectures

- À chaque intervalle (60 s par défaut, de 30 à 3600 s) : la liste des
  appareils, puis la position de chaque store. Pas plus souvent que
  l'intervalle, sauf les lectures après une commande, même après un
  redémarrage, une reconnexion ou le bouton de test.
- Un store hors de portée Bluetooth de SOMA Connect est affiché « non lu » et
  son badge injoignable ; les autres continuent.
- SOMA Connect injoignable : nouvel essai après 30 s, 1, 2 puis 5 min (pas
  plus souvent que l'intervalle). Un « trop de demandes » (HTTP 429) ou une
  erreur 5xx met en pause les lectures et les mouvements (de 1 min à 6 h,
  gardée dans `/data`) ; la pause ne retient pas l'arrêt.
- Une position n'est publiée que tant qu'elle est récente ; rien d'ancien
  n'est republié comme neuf.

## Limites

- Un seul SOMA Connect, 32 appareils au plus.
- Le niveau de lumière du panneau solaire n'est pas encore lu (son unité n'est
  pas connue).
- Le type d'un appareil (store ou Tilt) changé dans SOMA Connect s'applique
  après un **Scan** dans l'onglet Découverte.
- Jamais testée avec un vrai SOMA Connect : la forme des adresses du
  micrologiciel 3 et suivants, les réponses et le temps de réponse de SOMA
  Connect restent à vérifier.
