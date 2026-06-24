// Golden tests for French (fr) normalization + en/es regression guard.
// Run: node test-fr.js
const { normalizeForTTS } = require('./index');

const FR = [
  // cardinals — the tricky 70/80/90 cases + "et un" + plural cents/vingts
  ['Prendre 200 mg par jour', 'Prendre deux cents milligrammes par jour'],
  ['1 mg', 'un milligramme'],
  ['21 mg', 'vingt et un milligrammes'],
  ['71 jours', 'soixante et onze jours'],
  ['80 mg', 'quatre-vingts milligrammes'],
  ['81 comprimés', 'quatre-vingt-un comprimés'],
  ['97 cas', 'quatre-vingt-dix-sept cas'],
  ['100 mg', 'cent milligrammes'],
  // Bare number before an arbitrary noun stays masculine "un" (no noun-gender
  // dictionary — same limitation as the Spanish path; gender is only resolved
  // for known units, e.g. "1 cal" → "une calorie" below).
  ['101 patients', 'cent un patients'],
  ['380 mg', 'trois cent quatre-vingts milligrammes'],
  ['2500 mg', 'deux mille cinq cents milligrammes'],
  ['1000 participants', 'mille participants'],
  ['80000 cellules', 'quatre-vingt mille cellules'],
  ['200000 personnes', 'deux cent mille personnes'],
  ['31 jours', 'trente et un jours'],
  // thousands vs decimal (mixed source formatting incl. French spaced thousands)
  ['10,000 participants', 'dix mille participants'],
  ['10 000 participants', 'dix mille participants'],
  ['plus de 1,000 personnes', 'plus de mille personnes'],
  ['99,5 % des participants', 'quatre-vingt-dix-neuf virgule cinq pour cent des participants'],
  ['réduction de 50%', 'réduction de cinquante pour cent'],
  ['3.5 g de café', 'trois virgule cinq grammes de café'],
  // units
  ['glycémie de 95 mg/dL', 'glycémie de quatre-vingt-quinze milligrammes par décilitre'],
  ['500 µg de vitamine', 'cinq cents microgrammes de vitamine'],
  ['1 cal', 'une calorie'],
  ['200 kcal', 'deux cents kilocalories'],
  ['21 lb', 'vingt et une livres'],
  ['72 bpm', 'soixante-douze battements par minute'],
  ['37 °C', 'trente-sept degrés Celsius'],
  ['1 °C', 'un degré Celsius'],
  // currency / ranges / symbols (currency symbol before AND after)
  ['coûte $50', 'coûte cinquante dollars'],
  ['coûte 50 $', 'coûte cinquante dollars'],
  ['de 5–10 mg', 'de cinq à dix milligrammes'],
  ['EPA + DHA', 'EPA plus DHA'],
  ['EPA & DHA', 'EPA et DHA'],
  // blood pressure / ratios
  ['tension de 120/80 mmHg', 'tension de cent vingt sur quatre-vingts millimètres de mercure'],
  ['140/90', 'cent quarante sur quatre-vingt-dix'],
  // mixed thousands+decimal, comparison/math, markdown, abbreviations
  ['un taux de 40,028.5', 'un taux de quarante mille vingt-huit virgule cinq'],
  ['valeur p < 0,05', 'valeur p inférieur à zéro virgule zéro cinq'],
  ['risque ≥ 2 fois', 'risque supérieur ou égal à deux fois'],
  ['une variation de ±3 mg', 'une variation de plus ou moins trois milligrammes'],
  ['environ ~10%', 'environ environ dix pour cent'],
  ['**Résultat** clé', 'Résultat clé'],
  ['le * marqueur principal', 'le marqueur principal'],
  ['le Dr. Martin et la Dre Dubois', 'le docteur Martin et la docteure Dubois'],
  ['une étude aux É.-U. vs placebo, etc.', 'une étude aux États-Unis contre placebo, et cetera'],
  // scientific letter+number, ISO dates, ordinals, scientific units
  ['vitamine B12 et D3', 'vitamine B douze et D trois'],
  ['oméga-3 et CoQ10', 'oméga trois et CoQ dix'],
  ['taux de T3 et T4', 'taux de T trois et T quatre'],
  ['le gène PCSK9 et TP53 et SIRT1', 'le gène PCSK9 et TP53 et SIRT1'],
  // A single-letter unit (L) glued to a digit inside a letter-led gene symbol
  // must NOT be consumed as a measurement ("2L" → litres). Lookbehind guard.
  ['le gène BCL2L1 régule l\'apoptose', 'le gène BCL2L1 régule l\'apoptose'],
  ['publié le 2026-06-20', 'publié le vingt juin deux mille vingt-six'],
  ['depuis le 2026-06-01', 'depuis le premier juin deux mille vingt-six'],
  ['la 2e phase du 1er essai', 'la deuxième phase du premier essai'],
  ['en 1re ligne', 'en première ligne'],
  ['signal de 100 Hz et 60 dB', 'signal de cent hertz et soixante décibels'],
  ['une protéine de 50 kDa', 'une protéine de cinquante kilodaltons'],
  ['200 ppm de chlore', 'deux cents parties par million de chlore'],
  ['concentration de 5 mM', 'concentration de cinq millimolaire'],
  // Learned terms (seeded; grown by the weekly gap-scan) — word-bounded.
  ["L'OMS recommande", "L'O M S recommande"],
  ['le VIH et le TDAH', 'le V I H et le T D A H'],
  // millions
  ['1000000 de cellules', 'un million de cellules'],
  ['2000000 personnes', 'deux millions personnes'],
  // HTML tag stripping (inline <em>/<sub> in translated summaries)
  ['expansion de <em>Faecalibacterium</em> et <sub>2</sub> chez 12 %',
    'expansion de Faecalibacterium et deux chez douze pour cent'],
  ['le gène <em>APOE4</em> est un facteur de risque', 'le gène APOE4 est un facteur de risque'],
  // Compound / product codes: digit-by-digit tail (3–4 digits), not a cardinal
  ['RLS-1496 a réduit les lésions', 'RLS un quatre neuf six a réduit les lésions'],
  ['inhibiteur BPC-157', 'inhibiteur BPC un cinq sept'],
  ['traité avec AC220', 'traité avec AC deux deux zéro'],
  // A learned acronym must not eat the prefix of a LETTERS-NNNN code, yet should
  // still be letter-spelled standalone (guard for the gap-scan × compound-code mix).
  ['TNF-1234 et le TNF', 'TNF un deux trois quatre et le T N F'],
  // 2-digit tails still read as numbers (COVID-19, not a code)
  ['la pandémie de COVID-19', 'la pandémie de COVID-dix-neuf'],
  // Seeded acronyms (letter-spelled)
  ['le taux de LDL et de HDL', 'le taux de L D L et de H D L'],
  ['une IRM cérébrale et le NAD', 'une I R M cérébrale et le N A D'],
  ["taux d'ATP et de BDNF", "taux d'A T P et de B D N F"],
  ['une TDM, un EEG et la CRP', 'une T D M, un E E G et la C R P'],
  ['le DNA et le RNA', 'le D N A et le R N A'],
  // Must NOT mangle longer tokens that merely contain a seeded acronym
  ['mRNA et ATPase', 'mRNA et ATPase'],
  // fr keeps "IL" as-is (no es-style spelling — avoids the French word "il")
  ['IL-6 et TNF-α', 'IL-six et T N F-α'],
  // Roman numerals in clinical contexts (scoped to a leading keyword)
  ["l'essai de phase III PROTEUS", "l'essai de phase trois PROTEUS"],
  ['tumeur au stade IV', 'tumeur au stade quatre'],
  ['étude de phase II', 'étude de phase deux'],
  ['diabète de type II', 'diabète de type deux'],
  ['grade III de toxicité', 'grade trois de toxicité'],
  // A bare Roman-looking letter without the clinical keyword is left untouched
  ['la vitamine V et le groupe I', 'la vitamine V et le groupe I'],
];

// Guard that the fr locale param didn't disturb the en/es paths.
const EN_REGRESSION = [
  ['over 1,000 people', 'over one thousand people'],
  ['Blood glucose: 95 mg/dL', 'Blood glucose: ninety five milligrams per deciliter'],
];
const ES_REGRESSION = [
  ['Tomar 200 mg al día', 'Tomar doscientos miligramos al día'],
  ['1 cal', 'una caloría'],
];

let pass = 0, fail = 0;
function run(label, cases, opts) {
  console.log(`\n── ${label} ──`);
  for (const [input, expected] of cases) {
    const got = normalizeForTTS(input, opts);
    if (got === expected) { pass++; }
    else { fail++; console.log(`  ✗ "${input}"\n      exp: ${expected}\n      got: ${got}`); }
  }
}
run('French', FR, { locale: 'fr' });
run('English regression (default)', EN_REGRESSION, undefined);
run('Spanish regression (locale es)', ES_REGRESSION, { locale: 'es' });

// Default (no opts) must still route to the English pipeline.
console.log('\n── Dispatch: default === {locale:en} ──');
for (const s of ['Take 200mg of NMN daily', 'NAD+ levels decline by 50%', 'over 1,000 people']) {
  if (normalizeForTTS(s) === normalizeForTTS(s, { locale: 'en' })) pass++;
  else { fail++; console.log(`  ✗ default !== en for "${s}"`); }
}
console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
