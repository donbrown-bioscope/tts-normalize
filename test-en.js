// Golden tests for Roman-numeral LISTS after a keyword — English, plus one
// check per other locale (they share romanListsAfterKeyword).
// Run: node test-en.js
// Asserts the SPOKEN WORDS: <break>/<phoneme> markup is stripped before
// comparing, so IPA changes elsewhere in the package do not break these.
const { normalizeForTTS } = require('./index');

const plain = s => s.replace(/<break[^>]*\/>/g, '').replace(/<phoneme[^>]*>([^<]*)<\/phoneme>/g, '$1')
  .replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').trim();

const CASES = [
  // Lists after a singular keyword — the mitochondria tutorials (2026-09-28)
  ['Complex I, III, IV, and ATP synthase subunits.', 'Complex one, three, four, and ATP synthase subunits.'],
  ['names like Complex I, II, III, and IV.', 'names like Complex one, two, three, and four.'],
  ['Complex I/III leak electrons.', 'Complex one/three leak electrons.'],
  ['Complex I and III leak electrons.', 'Complex one and three leak electrons.'],
  // Plural keywords
  ['Complexes I, III and IV pump protons.', 'Complexes one, three and four pump protons.'],
  ['Complexes I through IV make up the chain.', 'Complexes one through four make up the chain.'],
  ['complexes I and II feed coenzyme Q.', 'complexes one and two feed coenzyme-Q.'],
  ['Types I and II diabetes differ.', 'Types one and two diabetes differ.'],
  ['Phases II and III enrolled 400 people.', 'Phases two and three enrolled four hundred people.'],
  // Ranges keep the package's "phase one two" convention
  ['Complexes I–IV form the chain.', 'Complexes one four form the chain.'],
  ['Complex I-III function.', 'Complex one three function.'],
  ['Complexes I-IV form the chain.', 'Complexes one four form the chain.'],
  // Unchanged behavior
  ['Complex I pumps protons.', 'Complex one pumps protons.'],
  ['Complex V, also called ATP synthase.', 'Complex five, also called ATP synthase.'],
  // Must NOT change: no keyword, lowercase, or the IV = intravenous reading
  ['The drug was given IV.', 'The drug was given IV.'], // spelled I-V via phonemes; stripped here
  ['a type i error', 'a type i error'],
];

// [input, want, locale]
const LOCALE_CASES = [
  ['los complejos I, III y IV', 'los complejos uno, tres y cuatro', 'es'],
  ['complejos I-IV', 'complejos un cuatro', 'es'], // "un": es apocope, same as the existing 'fase I-II' → 'fase un dos'
  ['les complexes I, III et IV', 'les complexes un, trois et quatre', 'fr'],
  ['i complessi I, III e IV', 'i complessi uno, tre e quattro', 'it'],
  ['os complexos I, III e IV', 'os complexos um, três e quatro', 'pt-br'],
  ['die Komplexe I, III und IV', 'die Komplexe eins, drei und vier', 'de'],
];

let pass = 0, fail = 0;
for (const [input, want, locale] of [...CASES, ...LOCALE_CASES]) {
  const got = plain(normalizeForTTS(input, locale ? { locale } : undefined));
  if (got === plain(want) || got.replace(/-/g, ' ') === plain(want).replace(/-/g, ' ')) pass++;
  else { fail++; console.log(`✗ ${JSON.stringify(input)}\n    want: ${want}\n    got:  ${got}`); }
}
console.log(fail ? `✗ ${fail} FAILED, ${pass} passed` : `✓ ALL PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
