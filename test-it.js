// Golden tests for Italian (it) normalization + en/es/fr regression guard.
// Run: node test-it.js
const { normalizeForTTS } = require('./index');

const IT = [
  // cardinals — vowel elision before uno/otto, accented -tré, concatenated words
  ['Prendere 200 mg al giorno', 'Prendere duecento milligrammi al giorno'],
  ['1 mg', 'un milligrammo'],
  ['21 mg', 'ventuno milligrammi'],
  ['28 giorni', 'ventotto giorni'],
  ['23 casi', 'ventitré casi'],
  ['31 giorni', 'trentuno giorni'],
  ['80 mg', 'ottanta milligrammi'],
  ['100 mg', 'cento milligrammi'],
  ['101 pazienti', 'centouno pazienti'],
  ['108 cellule', 'centotto cellule'],
  ['380 mg', 'trecentottanta milligrammi'],
  ['2500 mg', 'duemilacinquecento milligrammi'],
  ['1000 partecipanti', 'mille partecipanti'],
  ['80000 cellule', 'ottantamila cellule'],
  ['200000 persone', 'duecentomila persone'],
  // thousands vs decimal (mixed source formatting incl. Italian spaced thousands)
  ['10,000 partecipanti', 'diecimila partecipanti'],
  ['10 000 partecipanti', 'diecimila partecipanti'],
  ['oltre 1,000 persone', 'oltre mille persone'],
  ['99,5 % dei partecipanti', 'novantanove virgola cinque per cento dei partecipanti'],
  ['riduzione del 50%', 'riduzione del cinquanta per cento'],
  ['3.5 g di caffè', 'tre virgola cinque grammi di caffè'],
  // units
  ['glicemia di 95 mg/dL', 'glicemia di novantacinque milligrammi per decilitro'],
  ['500 µg di vitamina', 'cinquecento microgrammi di vitamina'],
  ['1 cal', 'una caloria'],
  ['200 kcal', 'duecento chilocalorie'],
  ['21 lb', 'ventuno libbre'],
  ['1 hr', "un'ora"],
  ['5 hr', 'cinque ore'],
  ['72 bpm', 'settantadue battiti al minuto'],
  ['37 °C', 'trentasette gradi Celsius'],
  ['1 °C', 'un grado Celsius'],
  // currency / ranges / symbols (symbol before AND after; euro is invariable)
  ['costa $50', 'costa cinquanta dollari'],
  ['costa 50 $', 'costa cinquanta dollari'],
  ['costa 50€', 'costa cinquanta euro'],
  ['solo 1€', 'solo un euro'],
  ['da 5–10 mg', 'da cinque a dieci milligrammi'],
  ['EPA + DHA', 'EPA più DHA'],
  ['EPA & DHA', 'EPA e DHA'],
  // blood pressure / ratios
  ['pressione di 120/80 mmHg', 'pressione di centoventi su ottanta millimetri di mercurio'],
  ['140/90', 'centoquaranta su novanta'],
  // mixed thousands+decimal, comparison/math, markdown, abbreviations
  ['un tasso di 40,028.5', 'un tasso di quarantamilaventotto virgola cinque'],
  ['valore p < 0,05', 'valore p minore di zero virgola zero cinque'],
  ['rischio ≥ 2 volte', 'rischio maggiore o uguale a due volte'],
  ['una variazione di ±3 mg', 'una variazione di più o meno tre milligrammi'],
  ['circa ~10%', 'circa circa dieci per cento'],
  ['**Risultato** chiave', 'Risultato chiave'],
  ['il * marcatore principale', 'il marcatore principale'],
  ['il Dott. Rossi e la Dott.ssa Bianchi', 'il dottor Rossi e la dottoressa Bianchi'],
  ['uno studio negli USA vs placebo, ecc.', 'uno studio negli Stati Uniti contro placebo, eccetera'],
  // scientific letter+number, ISO dates, scientific units
  ['vitamina B12 e D3', 'vitamina B dodici e D tre'],
  ['omega-3 e CoQ10', 'omega tre e CoQ dieci'],
  ['livelli di T3 e T4', 'livelli di T tre e T quattro'],
  ['il gene PCSK9 e TP53 e SIRT1', 'il gene PCSK9 e TP53 e SIRT1'],
  ['pubblicato il 2026-06-20', 'pubblicato il venti giugno duemilaventisei'],
  ['dal 2026-06-01', 'dal primo giugno duemilaventisei'],
  ['segnale di 100 Hz e 60 dB', 'segnale di cento hertz e sessanta decibel'],
  ['una proteina di 50 kDa', 'una proteina di cinquanta chilodalton'],
  ['200 ppm di cloro', 'duecento parti per milione di cloro'],
  ['concentrazione di 5 mM', 'concentrazione di cinque millimolare'],
  // Roman numerals in clinical contexts (scoped to a leading keyword)
  ['il trial di fase III PROTEUS', 'il trial di fase tre PROTEUS'],
  ['tumore in stadio IV', 'tumore in stadio quattro'],
  ['studio di fase II', 'studio di fase due'],
  ['diabete di tipo II', 'diabete di tipo due'],
  // A bare Roman-looking letter without the clinical keyword is left untouched
  ['la vitamina V e il gruppo I', 'la vitamina V e il gruppo I'],
  // Learned terms (seeded; grown by the weekly gap-scan) — word-bounded.
  ["L'OMS raccomanda", "L'O M S raccomanda"],
  ['il DNA e RNA', 'il D N A e R N A'],
  ['colesterolo LDL e HDL', 'colesterolo L D L e H D L'],
  ["livelli di ATP e di BDNF", 'livelli di A T P e di B D N F'],
  ['una TC, un EEG e la PCR', 'una T C, un E E G e la P C R'],
  // millions
  ['1000000 di cellule', 'un milione di cellule'],
  ['2000000 di persone', 'due milioni di persone'],
  // HTML tag stripping (inline <em>/<sub> in translated summaries)
  ['espansione di <em>Faecalibacterium</em> e <sub>2</sub> nel 12 %',
    'espansione di Faecalibacterium e due nel dodici per cento'],
  ['il gene <em>APOE4</em> è un fattore di rischio', 'il gene APOE4 è un fattore di rischio'],
  // Compound / product codes: digit-by-digit tail (3–4 digits), not a cardinal
  ['RLS-1496 ha ridotto le lesioni', 'RLS uno quattro nove sei ha ridotto le lesioni'],
  ['inibitore BPC-157', 'inibitore BPC uno cinque sette'],
  ['trattato con AC220', 'trattato con AC due due zero'],
  // A learned acronym must not eat the prefix of a LETTERS-NNNN code, yet still
  // letter-spell standalone (guard for the gap-scan × compound-code mix).
  ['TNF-1234 e il TNF', 'TNF uno due tre quattro e il T N F'],
  // 2-digit tails still read as numbers (COVID-19, not a code)
  ['la pandemia di COVID-19', 'la pandemia di COVID-diciannove'],
  // Must NOT mangle longer tokens that merely contain a seeded acronym
  ['mRNA e ATPasi', 'mRNA e ATPasi'],
  // "IL" is intentionally NOT seeded (collides with the Italian article "il")
  ['IL-6 e TNF-α', 'IL-sei e T N F-α'],
];

// Guard that the it locale param didn't disturb the en/es/fr paths.
const EN_REGRESSION = [
  ['over 1,000 people', 'over one thousand people'],
  ['Blood glucose: 95 mg/dL', 'Blood glucose: ninety five milligrams per deciliter'],
];
const ES_REGRESSION = [
  ['Tomar 200 mg al día', 'Tomar doscientos miligramos al día'],
  ['1 cal', 'una caloría'],
];
const FR_REGRESSION = [
  ['1 mg', 'un milligramme'],
  ['80 mg', 'quatre-vingts milligrammes'],
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
run('Italian', IT, { locale: 'it' });
run('English regression (default)', EN_REGRESSION, undefined);
run('Spanish regression (locale es)', ES_REGRESSION, { locale: 'es' });
run('French regression (locale fr)', FR_REGRESSION, { locale: 'fr' });

// Default (no opts) must still route to the English pipeline.
console.log('\n── Dispatch: default === {locale:en} ──');
for (const s of ['Take 200mg of NMN daily', 'NAD+ levels decline by 50%', 'over 1,000 people']) {
  if (normalizeForTTS(s) === normalizeForTTS(s, { locale: 'en' })) pass++;
  else { fail++; console.log(`  ✗ default !== en for "${s}"`); }
}
console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
