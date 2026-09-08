#!/usr/bin/env node
/**
 * scripts/rederive-cached-chains.js — bring cached letter chains back in step
 * with the builders.
 *
 * data/learned-ipa.json is consulted BEFORE the chain builders run, so a cached
 * entry wins outright. Every builder change therefore leaves the cache saying
 * the old thing, silently and forever: the 0.36.0 vowel-vowel seam fix and the
 * 0.38.0 rhotic seam fix both missed every chain that was already cached.
 *
 * Which entries are safe to regenerate is NOT a question of the `source` label.
 * "a-r-i-a" is tagged auto-llm and holds /ˈɑːriə/ -- the word "aria", not the
 * letters A-R-I-A. Regenerating by label would have said "A-R-I-A" out loud.
 *
 * So the test here is PROVENANCE: recompute what a builder would have emitted
 * for this key under each historical seam rule. If the cached IPA matches one
 * of those, the entry IS builder output and can be safely re-derived under
 * today's rule. If it matches none, a human or an LLM chose it deliberately --
 * leave it alone and report it.
 *
 * Usage:
 *   node scripts/rederive-cached-chains.js            # dry run (default)
 *   node scripts/rederive-cached-chains.js --write    # apply
 *   node scripts/rederive-cached-chains.js --verbose  # list skipped entries too
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { buildFastChainIpa } = require('../index.js');

const WRITE   = process.argv.includes('--write');
const VERBOSE = process.argv.includes('--verbose');
const IPA_PATH = path.join(__dirname, '..', 'data', 'learned-ipa.json');

const LETTER_IPA = {
  A:'eɪ',B:'biː',C:'siː',D:'diː',E:'iː',F:'ɛf',G:'dʒiː',H:'eɪtʃ',I:'aɪ',J:'dʒeɪ',
  K:'keɪ',L:'ɛl',M:'ɛm',N:'ɛn',O:'oʊ',P:'piː',Q:'kjuː',R:'ɑːr',S:'ɛs',T:'tiː',
  U:'juː',V:'viː',W:'ˈdʌbəl.juː',X:'ɛks',Y:'waɪ',Z:'ziː',
};
const DIGIT_IPA = {
  '0':'zɪroʊ','1':'wʌn','2':'tuː','3':'θriː','4':'fɔːr',
  '5':'faɪv','6':'sɪks','7':'ˈsɛvən','8':'eɪt','9':'naɪn',
};
const IPA_VOWELS = 'aeiouɛɪɑɔʊəæ';
const endsVowel   = s => IPA_VOWELS.includes(s.replace(/[ːˑˈˌ.]+$/, '').at(-1) ?? '');
const startsVowel = s => IPA_VOWELS.includes(s.replace(/^[ˈˌ.]+/, '')[0] ?? '');

// The two historical seam rules, reimplemented here on purpose: this script has
// to know what the builders USED to emit, which the builders themselves no
// longer can tell it.
//   era 0 — pre-0.36.0: glued, no breaks at all.
//   era 1 — 0.36.0..0.37.4: a break only at a vowel-vowel seam.
function historicalChainIpa(letters, era) {
  const ipa = letters.map(l => LETTER_IPA[l] ?? DIGIT_IPA[l] ?? l.toLowerCase());
  if (ipa.length === 1) return `ˈ${ipa[0]}`;
  const seam = (l, r) => era >= 1 && endsVowel(l) && startsVowel(r);
  let head = '';
  for (const part of ipa.slice(0, -1)) {
    if (head && seam(head, part)) head += '.';
    head += part;
  }
  const tail = ipa.at(-1);
  return `ˌ${head}${seam(head, tail) ? '.' : ''}ˈ${tail}`;
}

// A key is chain-shaped if every segment is one alphanumeric character
// ("r-n-a"), or if the whole key is a short run of them ("rna").
function keyToLetters(key) {
  if (key.includes('-')) {
    const parts = key.split('-');
    return parts.every(p => /^[a-z0-9]$/.test(p)) ? parts.map(p => p.toUpperCase()) : null;
  }
  return /^[a-z0-9]{2,10}$/.test(key) ? key.toUpperCase().split('') : null;
}

const cache = JSON.parse(fs.readFileSync(IPA_PATH, 'utf-8'));
const rederived = [];
const skipped = [];

for (const [key, entry] of Object.entries(cache)) {
  if (!entry || typeof entry !== 'object' || !entry.ipa) continue;
  const letters = keyToLetters(key);
  if (!letters) continue;
  const current = buildFastChainIpa(letters.join('-'));
  if (entry.ipa === current) continue;                       // already in step
  const era = [0, 1].find(e => historicalChainIpa(letters, e) === entry.ipa);
  if (era === undefined) {
    skipped.push([key, entry.ipa, entry.source]);            // deliberate — leave it
    continue;
  }
  rederived.push([key, entry.ipa, current, era, entry.source]);
  if (WRITE) {
    entry.ipa = current;
    entry.rederived = new Date().toISOString().slice(0, 10);
  }
}

console.log(`cache entries:            ${Object.keys(cache).length}`);
console.log(`builder-output, restated: ${rederived.length}`);
console.log(`chain-shaped but chosen:  ${skipped.length}  (left untouched)`);
for (const [k, was, now, era] of rederived) {
  console.log(`  ${k.padEnd(18)} ${was.padEnd(30)} -> ${now}   (era ${era})`);
}
if (VERBOSE && skipped.length) {
  console.log('\nleft alone — cached IPA is not builder output for these letters:');
  for (const [k, ipa, src] of skipped) console.log(`  ${k.padEnd(18)} ${ipa.padEnd(30)} ${src}`);
}
if (WRITE) {
  const sorted = {};
  for (const k of Object.keys(cache).sort()) sorted[k] = cache[k];
  fs.writeFileSync(IPA_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf-8');
  console.log(`\nwrote ${IPA_PATH}`);
} else {
  console.log('\ndry run — pass --write to apply');
}
