// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, refusals of commands, badges,
// feature names), in English and French.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

/** Feature names, by key. */
const LABELS = {
  state: { en: 'Open / close', fr: 'Ouverture / fermeture' },
  position: { en: 'Position', fr: 'Position' },
  battery: { en: 'Battery', fr: 'Batterie' },
};

/** The label of a key in a language. */
export function label(key, language = 'fr') {
  return LABELS[key]?.[language] ?? LABELS[key]?.en ?? key;
}

/** One text of a { en, fr } pair, in a language. */
export const word = (pair, language = 'fr') => pair?.[language] ?? pair?.en ?? '';

/** Pairs joined by a space (undefined ones skipped). */
export const join = (...pairs) => {
  const list = pairs.filter(Boolean);
  return {
    en: list.map((p) => p.en).join(' '),
    fr: list.map((p) => p.fr).join(' '),
  };
};

/** A duration: "45 s", "3 min", "2 h" (59.6 s is "1 min", never "60 s"). */
export function age(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) {
    return `${s} s`;
  }
  const min = Math.round(s / 60);
  return min < 90 ? `${min} min` : `${Math.round(min / 60)} h`;
}

const trim = (text, max = LIMITS.badgeMessage) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Why a request failed, in English and French (never an address). */
export function reasonOf(err) {
  const http = err?.status !== undefined ? ` (HTTP ${err.status})` : '';
  switch (err?.kind) {
    case 'unreachable':
      return { en: 'no connection', fr: 'pas de connexion' };
    case 'timeout':
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case 'late':
      return { en: 'connection too slow', fr: 'connexion trop lente' };
    case 'cut':
      return { en: 'read cut for a stop', fr: 'lecture coupée pour un arrêt' };
    case 'invalid':
      return { en: 'not an HTTP answer', fr: 'pas une réponse HTTP' };
    case 'tooLarge':
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case 'format':
      return {
        en: `not an answer of SOMA Connect${http}`,
        fr: `pas une réponse de SOMA Connect${http}`,
      };
    case 'refused':
      return {
        en: 'SOMA Connect answered an error (shade out of Bluetooth reach?)',
        fr: 'SOMA Connect a répondu une erreur (store hors de portée Bluetooth ?)',
      };
    case 'notFound':
      return { en: 'unknown request (HTTP 404)', fr: 'demande inconnue (HTTP 404)' };
    case 'rate':
      return { en: 'too many requests (HTTP 429)', fr: 'trop de demandes (HTTP 429)' };
    case 'server':
    case 'http':
      return { en: `error${http}`, fr: `erreur${http}` };
    default:
      return { en: 'unexpected error', fr: 'erreur inattendue' };
  }
}

/** The state of one shade, for the connection status. */
function shadeLine(name, s) {
  const n = name;
  const notes = [];
  if (s.battery !== undefined) {
    notes.push({ en: `battery ${s.battery} %`, fr: `batterie ${s.battery} %` });
  }
  if (s.notReached) {
    notes.push({
      en: `did not reach ${s.notReached.target} % (read ${s.notReached.read} %)`,
      fr: `n'a pas atteint ${s.notReached.target} % (lu ${s.notReached.read} %)`,
    });
  }
  if (s.unconfirmed) {
    notes.push({
      en: 'last command not confirmed yet',
      fr: 'dernière commande pas encore confirmée',
    });
  }
  if (s.stop) {
    notes.push(
      s.stop.given
        ? {
            en: `a stop could not be sent, given up after ${s.stop.resends} tries`,
            fr: `un arrêt n'a pas pu partir, abandonné après ${s.stop.resends} essais`,
          }
        : {
            en: `a stop did not get through: sent again at the next read (${s.stop.resends}/${LIMITS.stopResends})`,
            fr: `un arrêt n'est pas passé : renvoyé à la prochaine lecture (${s.stop.resends}/${LIMITS.stopResends})`,
          },
    );
  }
  const tail = notes.length > 0 ? `; ${notes.map((x) => x.en).join('; ')}` : '';
  const tailFr = notes.length > 0 ? ` ; ${notes.map((x) => x.fr).join(' ; ')}` : '';
  switch (s.kind) {
    case 'ok':
      return s.position === undefined
        ? { en: `${n}: connected${tail}.`, fr: `${n} : connecté${tailFr}.` }
        : {
            en: `${n}: ${s.position} % open${tail}.`,
            fr: `${n} : ouvert à ${s.position} %${tailFr}.`,
          };
    case 'waiting':
      return { en: `${n}: not read yet${tail}.`, fr: `${n} : pas encore lu${tailFr}.` };
    default:
      return {
        en: `${n}: not read (${s.reason.en})${tail}.`,
        fr: `${n} : non lu (${s.reason.fr})${tailFr}.`,
      };
  }
}

/** Status texts. */
export const T = {
  noAddress: {
    en: 'Type the IP address of your SOMA Connect.',
    fr: "Saisissez l'adresse IP de votre SOMA Connect.",
  },
  invalid: {
    en: 'The address of SOMA Connect is not understood: type an IP address (or a host name), like 192.168.1.50.',
    fr: "L'adresse de SOMA Connect n'est pas comprise : saisissez une adresse IP (ou un nom d'hôte), par exemple 192.168.1.50.",
  },
  local: {
    en: 'Names in .local are not resolved inside the container: type the IP address.',
    fr: "Les noms en .local ne sont pas résolus dans le conteneur : saisissez l'adresse IP.",
  },
  credentialsInHost: {
    en: 'The address holds an "@": SOMA Connect takes no login, type the IP address alone. Nothing was sent.',
    fr: "L'adresse contient un « @ » : SOMA Connect ne prend pas d'identifiant, saisissez l'adresse IP seule. Rien n'a été envoyé.",
  },
  configRetry: (wait) => ({
    en: `The configuration of Gladys is not read yet; tried again in ${wait}.`,
    fr: `La configuration de Gladys n'est pas encore lue ; nouvel essai dans ${wait}.`,
  }),
  connecting: (address) => ({
    en: `SOMA Connect (${address}): connecting…`,
    fr: `SOMA Connect (${address}) : connexion…`,
  }),
  bridgeOk: (address, version, count, interval) => ({
    en: `SOMA Connect (${address}${version ? `, firmware ${version}` : ''}): connected, ${count} device(s), read every ${interval} s.`,
    fr: `SOMA Connect (${address}${version ? `, micrologiciel ${version}` : ''}) : connecté, ${count} appareil(s), lu toutes les ${interval} s.`,
  }),
  bridgeDown: (address, reason, wait) => ({
    en: `SOMA Connect (${address}): unreachable (${reason.en}); tried again in ${wait}. Check its IP address and that it is powered.`,
    fr: `SOMA Connect (${address}) : injoignable (${reason.fr}) ; nouvel essai dans ${wait}. Vérifiez son adresse IP et son alimentation.`,
  }),
  bridgeNotSoma: (address, reason, wait) => ({
    en: `${address} does not answer like SOMA Connect (${reason.en}); tried again in ${wait}. Check the address and the port (3000).`,
    fr: `${address} ne répond pas comme SOMA Connect (${reason.fr}) ; nouvel essai dans ${wait}. Vérifiez l'adresse et le port (3000).`,
  }),
  paused: (address, reason, wait) => ({
    en: `SOMA Connect (${address}): asked to slow down (${reason.en}), paused for ${wait}. The pause does not hold a stop.`,
    fr: `SOMA Connect (${address}) : demande de ralentir (${reason.fr}), en pause pour ${wait}. La pause ne retient pas l'arrêt.`,
  }),
  noDevices: {
    en: 'SOMA Connect lists no shade: pair them in the SOMA app first.',
    fr: "SOMA Connect ne liste aucun store : appairez-les d'abord dans l'application SOMA.",
  },
  duplicates: (n) => ({
    en: `${n} entry(ies) of list_devices repeat a MAC address: only the first one is kept.`,
    fr: `${n} entrée(s) de list_devices répètent une adresse MAC : seule la première est gardée.`,
  }),
  dropped: (n) => ({
    en: `${n} device(s) over the limit of 32 are left out.`,
    fr: `${n} appareil(s) au-delà de la limite de 32 sont ignorés.`,
  }),
  kindChanged: {
    en: 'The type of a device changed in SOMA Connect: press "Scan" in the Discovery tab to apply it.',
    fr: "Le type d'un appareil a changé dans SOMA Connect : appuyez sur « Scanner » dans l'onglet Découverte pour l'appliquer.",
  },
  orphans: (names) => ({
    en: `No longer listed by SOMA Connect: ${names}.`,
    fr: `Plus listés par SOMA Connect : ${names}.`,
  }),
  shadeLine,
  test: {
    recent: (wait) => ({
      en: `Read less than an interval ago: the next read in ${wait}.`,
      fr: `Lu il y a moins d'un intervalle : prochaine lecture dans ${wait}.`,
    }),
  },
  badge: {
    unconfirmed: {
      en: 'Last command not confirmed yet',
      fr: 'Dernière commande pas encore confirmée',
    },
    notReached: (target, read) => ({
      en: trim(`Did not reach ${target} % (read ${read} %)`),
      fr: trim(`N'a pas atteint ${target} % (lu ${read} %)`),
    }),
    stop: {
      en: 'A stop did not get through',
      fr: "Un arrêt n'est pas passé",
    },
  },
};

/** Refusals of commands (the ack of Gladys shows them). */
export const ERRORS = {
  generic: { en: 'Unexpected error.', fr: 'Erreur inattendue.' },
  readOnly: {
    en: 'This feature cannot be changed.',
    fr: 'Cette fonctionnalité ne peut pas être modifiée.',
  },
  badValue: {
    en: 'Value not understood: nothing sent.',
    fr: 'Valeur non comprise : rien envoyé.',
  },
  unknownDevice: {
    en: 'This device is not listed by SOMA Connect: nothing sent.',
    fr: "Cet appareil n'est pas listé par SOMA Connect : rien envoyé.",
  },
  notLoaded: {
    en: 'The configuration is not loaded yet: nothing sent.',
    fr: "La configuration n'est pas encore chargée : rien envoyé.",
  },
  noAddress: {
    en: 'No address of SOMA Connect: nothing sent.',
    fr: 'Aucune adresse de SOMA Connect : rien envoyé.',
  },
  stopped: {
    en: 'Cancelled by a stop: nothing sent.',
    fr: 'Annulée par un arrêt : rien envoyé.',
  },
  configChanged: {
    en: 'The configuration changed meanwhile: nothing sent.',
    fr: 'La configuration a changé entre-temps : rien envoyé.',
  },
  busy: (n) => ({
    en: `${n} commands of this shade already wait: nothing sent.`,
    fr: `${n} commandes de ce store attendent déjà : rien envoyé.`,
  }),
  paused: (wait) => ({
    en: `SOMA Connect asked to slow down: paused for ${wait} more, nothing sent (the pause does not hold a stop).`,
    fr: `SOMA Connect a demandé de ralentir : en pause encore ${wait}, rien envoyé (la pause ne retient pas l'arrêt).`,
  }),
  tooSlow: {
    en: 'SOMA Connect could not be reached in time: nothing sent.',
    fr: "SOMA Connect n'a pas pu être joint à temps : rien envoyé.",
  },
  notSent: (reason) => ({
    en: `Not sent: ${reason.en}.`,
    fr: `Non envoyée : ${reason.fr}.`,
  }),
  refused: (reason) => ({
    en: `Refused: ${reason.en}. Nothing done.`,
    fr: `Refusée : ${reason.fr}. Rien n'a été fait.`,
  }),
  sentUnconfirmed: (reason) => ({
    en: `Sent, without confirmation (${reason.en}): the shade is read again in a few seconds.`,
    fr: `Envoyée, sans confirmation (${reason.fr}) : le store est relu dans quelques secondes.`,
  }),
  stopNotSent: (reason) => ({
    en: `Stop not sent (${reason.en}): sent again at the next read.`,
    fr: `Arrêt non envoyé (${reason.fr}) : renvoyé à la prochaine lecture.`,
  }),
};
