// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. The version is
// never pinned (the Release workflow bumps it): only its shape and that the
// four places agree.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, LANGUAGES, POLL_INTERVAL } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics, and one version in the four places', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-soma-connect:${manifest.version}`);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(manifest.version, pkg.version);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/LM1LC3N7/gladys-soma-connect/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['lighting']);
  // keywords and countries need gladys_version >= 5.3.0: not yet (TODO.md).
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`)
      .replace(/\*\*/g, '')
      .replace(/\s*\n>?\s*/g, ' ');
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+SOMA|sans\s+lien\s+avec\s+SOMA/);
    assert.match(
      docs,
      /never\s+been\s+tested\s+with\s+a\s+real\s+SOMA\s+Connect|jamais\s+été\s+testée\s+avec\s+un\s+vrai\s+SOMA\s+Connect/,
    );
  }
  assert.match(read('README.md'), /never been tested with a real SOMA Connect/);
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('the MIT notice of pysoma ships with the code; no name in the LICENSE', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /ratsept\/pysoma/);
  assert.match(notices, /Copyright \(c\) 2019 Wazombi Labs OÜ/);
  assert.match(notices, /Permission is hereby granted/);
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY .*LICENSE/);
  assert.match(dockerfile, /COPY .*THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Louis|Milcent|LM1LC3N7|Wazombi|Gladys/i);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('the configuration matches the code; no secret, no gladys_ key', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    if (fields[key].default !== undefined || value !== '') {
      assert.deepEqual(fields[key].default, value, key);
    }
  }
  for (const field of manifest.config_schema.filter((f) => f.type !== 'section')) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
    // The core keeps the GLADYS_* keys for itself: such a key never arrives.
    assert.doesNotMatch(field.key, /^gladys_/i);
    assert.notEqual(field.type, 'secret');
  }
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  for (const option of fields.language.options) {
    assert.equal(typeof option.value, 'string');
  }
  assert.equal(fields.address.required, true);
  assert.deepEqual(
    [fields.poll_interval.min, fields.poll_interval.max],
    [POLL_INTERVAL.min, POLL_INTERVAL.max],
  );
  const intro = fields.intro;
  assert.equal(intro.type, 'section');
  for (const lang of ['en', 'fr']) {
    assert.ok(intro.description[lang].length <= 1000, `intro.${lang} over 1000 characters`);
  }
  assert.ok(intro.links.every((l) => l.url.startsWith('https://')));
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', field.key);
  }
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.ok(handlers.includes('onSetValue'), 'the commands go through onSetValue');
  for (const item of manifest.actions) {
    assert.ok(item.timeout_seconds >= 5 && item.timeout_seconds <= 120, item.key);
  }
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
});

test('no Bluetooth, no cloud, no imitation of an app', () => {
  const code = ['src/app.js', 'src/soma/client.js', 'src/soma/http.js', 'src/constants.js']
    .map(read)
    .join('\n');
  assert.doesNotMatch(
    code,
    /require\(['"]noble|from ['"](?:noble|bleak|@abandonware)|['"]user-agent['"]/i,
  );
  assert.doesNotMatch(code, /https:\/\//);
  assert.doesNotMatch(read('package.json'), /bluetooth|noble|bleak/i);
});
