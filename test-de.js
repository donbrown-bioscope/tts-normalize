// Golden tests for German (de) normalization + en/es/fr/it/pt regression guard.
// Run: node test-de.js
const { normalizeForTTS } = require('./index');

const DE = [
  // cardinals — compound single-word, units-before-tens "und", ß forms
  ['200 mg täglich', 'zweihundert Milligramm täglich'],
  ['1 mg', 'ein Milligramm'],
  ['21 mg', 'einundzwanzig Milligramm'],
  ['28 Tage', 'achtundzwanzig Tage'],
  ['30 Studien', 'dreißig Studien'],
  ['16 und 17', 'sechzehn und siebzehn'],
  ['66 Fälle', 'sechsundsechzig Fälle'],
  ['77 Patienten', 'siebenundsiebzig Patienten'],
  ['80 mg', 'achtzig Milligramm'],
  ['100 mg', 'einhundert Milligramm'],
  ['101 Patienten', 'einhunderteins Patienten'],
  ['380 mg', 'dreihundertachtzig Milligramm'],
  ['2500 mg', 'zweitausendfünfhundert Milligramm'],
  ['1000 Teilnehmer', 'eintausend Teilnehmer'],
  ['80000 Fälle', 'achtzigtausend Fälle'],
  ['200000 Fälle', 'zweihunderttausend Fälle'],
  // thousands vs decimal (mixed source formatting incl. spaced thousands)
  ['10,000 Teilnehmer', 'zehntausend Teilnehmer'],
  ['10 000 Teilnehmer', 'zehntausend Teilnehmer'],
  ['mehr als 1,000 Menschen', 'mehr als eintausend Menschen'],
  ['99,5 % der Teilnehmer', 'neunundneunzig Komma fünf Prozent der Teilnehmer'],
  ['Reduktion von 50%', 'Reduktion von fünfzig Prozent'],
  ['3,5 g Kaffee', 'drei Komma fünf Gramm Kaffee'],
  ['3.5 g Kaffee', 'drei Komma fünf Gramm Kaffee'],
  // units — invariable measure nouns vs feminine count-nouns (ein/eine at 1)
  ['Blutzucker von 95 mg/dL', 'Blutzucker von fünfundneunzig Milligramm pro Deziliter'],
  ['500 µg Vitamin', 'fünfhundert Mikrogramm Vitamin'],
  ['1 cal', 'eine Kalorie'],
  ['200 kcal', 'zweihundert Kilokalorien'],
  ['2 hr', 'zwei Stunden'],
  ['1 hr', 'eine Stunde'],
  ['5 hr', 'fünf Stunden'],
  ['5 kg', 'fünf Kilogramm'],
  ['10 km', 'zehn Kilometer'],
  ['72 bpm', 'zweiundsiebzig Schläge pro Minute'],
  ['37 °C', 'siebenunddreißig Grad Celsius'],
  ['1 °C', 'ein Grad Celsius'],
  // currency / ranges / symbols (symbol before AND after)
  ['kostet $50', 'kostet fünfzig Dollar'],
  ['kostet 50 $', 'kostet fünfzig Dollar'],
  ['kostet 50€', 'kostet fünfzig Euro'],
  ['nur 1€', 'nur ein Euro'],
  ['von 5–10 mg', 'von fünf bis zehn Milligramm'],
  ['EPA + DHA', 'E P A plus D H A'],
  ['EPA & DHA', 'E P A und D H A'],
  // blood pressure / ratios
  ['Blutdruck von 120/80 mmHg', 'Blutdruck von einhundertzwanzig zu achtzig Millimeter Quecksilbersäule'],
  ['140/90', 'einhundertvierzig zu neunzig'],
  // mixed thousands+decimal, comparison/math, markdown, abbreviations
  ['eine Rate von 40,028.5', 'eine Rate von vierzigtausendachtundzwanzig Komma fünf'],
  ['p-Wert < 0,05', 'p-Wert kleiner als null Komma null fünf'],
  ['Risiko ≥ 3 mal', 'Risiko größer oder gleich drei mal'],
  ['eine Schwankung von ±3 mg', 'eine Schwankung von plus minus drei Milligramm'],
  ['etwa ~10%', 'etwa ungefähr zehn Prozent'],
  ['**Ergebnis** Haupt', 'Ergebnis Haupt'],
  ['der * Hauptmarker', 'der Hauptmarker'],
  ['Dr. Schmidt und Prof. Weber', 'Doktor Schmidt und Professor Weber'],
  ['eine Studie vs. Placebo, etc.', 'eine Studie versus Placebo, et cetera'],
  // scientific letter+number, ISO dates, scientific units
  ['Vitamin B12 und D3', 'Vitamin B zwölf und D drei'],
  ['omega-3 und CoQ10', 'Omega drei und CoQ zehn'],
  ['Werte von T3 und T4', 'Werte von T drei und T vier'],
  // Gene symbols stay verbatim (no learned entry, no 3–4 digit code tail).
  ['das Gen PCSK9 und TP53 und SIRT1', 'das Gen PCSK9 und TP53 und SIRT1'],
  ['veröffentlicht am 2026-06-20', 'veröffentlicht am zwanzigster Juni zweitausendsechsundzwanzig'],
  ['seit 2026-06-01', 'seit erster Juni zweitausendsechsundzwanzig'],
  ['Signal von 100 Hz und 60 dB', 'Signal von einhundert Hertz und sechzig Dezibel'],
  ['ein Protein von 50 kDa', 'ein Protein von fünfzig Kilodalton'],
  ['200 ppm Chlor', 'zweihundert Teile pro Million Chlor'],
  ['Konzentration von 5 mM', 'Konzentration von fünf millimolar'],
  // Roman numerals in clinical contexts (scoped to a leading keyword)
  ['die Studie der Phase III', 'die Studie der Phase drei'],
  ['Tumor im Stadium IV', 'Tumor im Stadium vier'],
  ['Studie der Phase II', 'Studie der Phase zwei'],
  ['Diabetes Typ II', 'Diabetes Typ zwei'],
  // A bare Roman-looking letter without the clinical keyword is left untouched
  ['das Vitamin V und die Gruppe I', 'das Vitamin V und die Gruppe I'],
  // Learned terms (seeded; grown by the weekly gap-scan) — word-bounded.
  ['die WHO empfiehlt', 'die W H O empfiehlt'],
  ['das DNA und RNA', 'das D N A und R N A'],
  ['Cholesterin LDL und HDL', 'Cholesterin L D L und H D L'],
  ['Werte von ATP und BDNF', 'Werte von A T P und B D N F'],
  // millions
  ['1000000 Zellen', 'eine Million Zellen'],
  ['2000000 Menschen', 'zwei Millionen Menschen'],
  // HTML tag stripping (inline <em>/<sub> in translated summaries)
  ['Expansion von <em>Faecalibacterium</em> um 12 %', 'Expansion von Faecalibacterium um zwölf Prozent'],
  ['das Gen <em>APOE4</em> ist ein Risikofaktor', 'das Gen APOE4 ist ein Risikofaktor'],
  // Compound / product codes: digit-by-digit tail (3–4 digits), not a cardinal
  ['RLS-1496 reduzierte die Läsionen', 'RLS eins vier neun sechs reduzierte die Läsionen'],
  ['Inhibitor BPC-157', 'Inhibitor BPC eins fünf sieben'],
  ['behandelt mit AC220', 'behandelt mit AC zwei zwei null'],
  // Learned-acronym guard: must NOT eat a LETTERS-NNNN code prefix, yet still
  // letter-spell standalone. (LDL is seeded.)
  ['LDL-5678 und das LDL', 'LDL fünf sechs sieben acht und das L D L'],
  // 2-digit tails still read as numbers (COVID-19, not a code)
  ['die COVID-19 Pandemie', 'die COVID-neunzehn Pandemie'],
  // Must NOT mangle longer tokens that merely contain a seeded acronym
  ['mRNA und ATPase', 'mRNA und ATPase'],
  // Expanded medical-acronym seed (top ~50) — letter-spelled, case-sensitive.
  ['erhöhtes CRP und TSH', 'erhöhtes C R P und T S H'],
  ['ein MRT und ein CT', 'ein M R T und ein C T'],
  ['NAD+ und NMN', 'N A D plus und N M N'],
  ['EPA und DHA', 'E P A und D H A'],
  ['die ALT- und AST-Werte', 'die A L T- und A S T-Werte'],
  // Case-sensitivity guard: the all-caps acronym ALS is spelled, the German
  // function word "als" (lowercase) is left untouched.
  ['ALS unterscheidet sich von anderen als erwartet', 'A L S unterscheidet sich von anderen als erwartet'],
  // Gap-scan finds (de corpus): more acronyms + hyphenated/extended clinical Roman.
  ['erhöhtes IL und HIV-Risiko', 'erhöhtes I L und H I V-Risiko'],
  ['das KI betrug', 'das K I betrug'],
  ['PD-L1 und CD8', 'P D L eins und C D acht'],
  ['eine Phase-III-Studie', 'eine Phase drei-Studie'],
  ['mitochondrialer Komplex I', 'mitochondrialer Komplex eins'],
  ['Kollagen Typ III', 'Kollagen Typ drei'],
  ['Faktor V Leiden', 'Faktor fünf Leiden'],
  // Bare numerals (no keyword) — previously letter-spelled by the ALL-CAPS pass.
  ['Ludwig XIV regierte', 'Ludwig vierzehn regierte'],
  ['Angiotensin II Rezeptor', 'Angiotensin zwei Rezeptor'],
  ['Kapitel VII', 'Kapitel sieben'],
  // Ambiguous bare tokens stay abbreviations.
  ['XX und XY Chromosomen', 'XX und XY Chromosomen'],
  // Gene-symbol pass (gap-scan finds): letter-clusters spell + speak the number,
  // word-form genes read as words. Genes NOT curated stay verbatim (see PCSK9
  // test above) — there is intentionally no blanket gene rule.
  ['erhöhtes FGF21 und GDF15', 'erhöhtes F G F einundzwanzig und G D F fünfzehn'],
  ['GPX4 reguliert Ferroptose', 'G P X vier reguliert Ferroptose'],
  ['HER2-positiv', 'Her zwei-positiv'],
  ['PINK1 und Mitophagie', 'Pink eins und Mitophagie'],
  ['das Gen FURIN', 'das Gen Furin'],
  ['p-tau217 im Plasma', 'p-tau zweihundertsiebzehn im Plasma'],
  ['FOXN1 im Thymus', 'Fox N eins im Thymus'],
];

// Guard that the de locale param didn't disturb the en/es/fr/it/pt paths.
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
const IT_REGRESSION = [
  ['100 mg', 'cento milligrammi'],
  ['1 cal', 'una caloria'],
];
const PT_REGRESSION = [
  ['100 mg', 'cem miligramas'],
  ['1 cal', 'uma caloria'],
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
run('German', DE, { locale: 'de' });
run('English regression (default)', EN_REGRESSION, undefined);
run('Spanish regression (locale es)', ES_REGRESSION, { locale: 'es' });
run('French regression (locale fr)', FR_REGRESSION, { locale: 'fr' });
run('Italian regression (locale it)', IT_REGRESSION, { locale: 'it' });
run('Portuguese regression (locale pt-br)', PT_REGRESSION, { locale: 'pt-br' });

// Default (no opts) must still route to the English pipeline; de-DE aliases de.
console.log('\n── Dispatch: default === {locale:en}; de-DE === de ──');
for (const s of ['Take 200mg of NMN daily', 'NAD+ levels decline by 50%', 'over 1,000 people']) {
  if (normalizeForTTS(s) === normalizeForTTS(s, { locale: 'en' })) pass++;
  else { fail++; console.log(`  ✗ default !== en for "${s}"`); }
}
for (const s of ['200 mg täglich', 'das DNA und RNA', '2500 mg']) {
  if (normalizeForTTS(s, { locale: 'de-DE' }) === normalizeForTTS(s, { locale: 'de' })) pass++;
  else { fail++; console.log(`  ✗ de-DE !== de for "${s}"`); }
}
console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
