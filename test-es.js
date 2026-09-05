// Golden tests for Spanish (es) normalization + English regression guard.
// Run: node test-es.js
const { normalizeForTTS } = require('./index');

const ES = [
  // Pronunciation helpers are cut from spoken text in every locale (the
  // strip is hoisted above the locale dispatch in normalizeForTTS).
  ['La glicación (en inglés, glycation, pronunciado gly-KAY-shun) daña.', 'La glicación (en inglés, glycation) daña.'],
  // cardinals
  ['Tomar 200 mg al día', 'Tomar doscientos miligramos al día'],
  ['1 mg', 'un miligramo'],
  ['21 mg', 'veintiún miligramos'],
  ['100 mg', 'cien miligramos'],
  ['101 estudios', 'ciento un estudios'],
  ['2500 mg', 'dos mil quinientos miligramos'],
  ['1000 participantes', 'mil participantes'],
  ['31 días', 'treinta y un días'],
  // thousands vs decimal (mixed source formatting)
  ['10,000 participantes', 'diez mil participantes'],
  ['más de 1,000 personas', 'más de mil personas'],
  ['El 99,5 % de los participantes', 'El noventa y nueve coma cinco por ciento de los participantes'],
  ['reducción del 50%', 'reducción del cincuenta por ciento'],
  ['3.5 g de omega', 'tres coma cinco gramos de omega'],
  // units
  ['glucosa de 95 mg/dL', 'glucosa de noventa y cinco miligramos por decilitro'],
  ['500 µg de vitamina', 'quinientos microgramos de vitamina'],
  ['1 cal', 'una caloría'],
  ['200 kcal', 'doscientas kilocalorías'],
  ['21 lb', 'veintiuna libras'],
  ['72 bpm', 'setenta y dos latidos por minuto'],
  ['37 °C', 'treinta y siete grados Celsius'],
  // currency / ranges / symbols
  ['cuesta $50', 'cuesta cincuenta dólares'],
  ['de 5–10 mg', 'de cinco a diez miligramos'],
  ['EPA + DHA', 'EPA más DHA'],
  // apocope before accented noun (ñ/á…) + blood pressure
  ['durante 21 años', 'durante veintiún años'],
  ['1 año de seguimiento', 'un año de seguimiento'],
  ['uno de cada diez', 'uno de cada diez'],
  ['presión de 120/80 mmHg', 'presión de ciento veinte sobre ochenta milímetros de mercurio'],
  ['140/90', 'ciento cuarenta sobre noventa'],
  // Tier 1: mixed thousands+decimal, comparison/math symbols, markdown, abbreviations
  ['una tasa de 40,028.5', 'una tasa de cuarenta mil veintiocho coma cinco'],
  ['valor p < 0.05', 'valor p menor que cero coma cero cinco'],
  ['riesgo ≥ 2 veces', 'riesgo mayor o igual que dos veces'],
  ['un cambio de ±3 mg', 'un cambio de más o menos tres miligramos'],
  ['aproximadamente ~10%', 'aproximadamente aproximadamente diez por ciento'],
  ['EPA & DHA', 'EPA y DHA'],
  ['**Hallazgo** clave', 'Hallazgo clave'],
  ['el * marcador principal', 'el marcador principal'],
  ['el Dr. Smith y la Dra. Ruiz', 'el doctor Smith y la doctora Ruiz'],
  ['un estudio en EE. UU. vs. placebo, etc.', 'un estudio en Estados Unidos versus placebo, etcétera'],
  // Tier 2: scientific letter+number, ISO dates, ordinals, scientific units
  ['tomar vitamina B12 y D3', 'tomar vitamina B doce y D tres'],
  ['omega-3 y CoQ10', 'omega tres y CoQ diez'],
  ['niveles de T3 y T4', 'niveles de T tres y T cuatro'],
  ['el gen PCSK9 y TP53 y SIRT1', 'el gen P C S K nueve y T P cincuenta y tres y SIRT1'],
  // A single-letter unit (L) glued to a digit inside a letter-led gene symbol
  // must NOT be consumed as a measurement ("2L" → litros). Lookbehind guard.
  ['el gen BCL2L1 regula la apoptosis', 'el gen BCL2L1 regula la apoptosis'],
  ['publicado el 2026-06-20', 'publicado el veinte de junio de dos mil veintiséis'],
  ['desde el 2026-06-01', 'desde el primero de junio de dos mil veintiséis'],
  ['la 2.ª fase del 1.º ensayo', 'la segunda fase del primero ensayo'],
  ['señal de 100 Hz y 60 dB', 'señal de cien hercios y sesenta decibelios'],
  ['una proteína de 50 kDa', 'una proteína de cincuenta kilodaltons'],
  ['200 ppm de cloro', 'doscientas partes por millón de cloro'],
  ['concentración de 5 mM', 'concentración de cinco milimolar'],
  // Learned terms (data-driven, grown by the weekly gap-scan) — word-bounded.
  ['La FDA aprobó el fármaco', 'La F D A aprobó el fármaco'],
  ['terapia CAR-T para el SNC', 'terapia CAR T para el S N C'],
  ['un estudio sobre TDAH', 'un estudio sobre T D A H'],
  // millions
  ['1000000 de células', 'un millón de células'],
  ['2000000 personas', 'dos millones personas'],
  // HTML tag stripping (inline <em>/<sub> in translated summaries)
  ['expansión de <em>Faecalibacterium</em> y <sub>2</sub> en 12 %',
    'expansión de Faecalibacterium y dos en doce por ciento'],
  // Compound / product codes: digit-by-digit tail (3–4 digits), not a cardinal.
  // (Leading "uno" apocopates to "un" via step 8 — acceptable for a spelled code.)
  ['RLS-1496 redujo las lesiones', 'RLS un cuatro nueve seis redujo las lesiones'],
  ['inhibidor BPC-157 y AC220', 'inhibidor BPC un cinco siete y AC dos dos cero'],
  // A learned acronym must not eat the prefix of a LETTERS-NNNN code, yet should
  // still be letter-spelled standalone (guard for the gap-scan × compound-code mix).
  ['BCR-1234 y el BCR', 'BCR un dos tres cuatro y el B C R'],
  // 2-digit tails still read as numbers (COVID-19, not a code)
  ['la pandemia de COVID-19', 'la pandemia de COVID-diecinueve'],
  // Seeded acronyms (letter-spelled)
  ['el colesterol LDL y HDL', 'el colesterol L D L y H D L'],
  ['niveles de NAD y TNF', 'niveles de N A D y T N F'],
  ['niveles de ATP, PCR y TSH', 'niveles de A T P, P C R y T S H'],
  ['el DNA y el RNA', 'el D N A y el R N A'],
  ['AST y GGT elevadas', 'A S T y G G T elevadas'],
  // Must NOT mangle longer tokens that merely contain a seeded acronym
  ['ARNm y ATPasa', 'ARNm y ATPasa'],
  // Roman numerals in clinical contexts (scoped to a leading keyword)
  ['el ensayo de fase III PROTEUS', 'el ensayo de fase tres PROTEUS'],
  ['tumor en estadio IV', 'tumor en estadio cuatro'],
  ['estudio de fase II', 'estudio de fase dos'],
  ['diabetes de tipo II', 'diabetes de tipo dos'],
  // Numerales sueltos (sin palabra clave) — antes se deletreaban letra a letra.
  ['Luis XIV reinó', 'Luis catorce reinó'],
  ['Angiotensina II', 'Angiotensina dos'],
  ['la sección XXIII', 'la sección veintitrés'],
  ['grado III de toxicidad', 'grado tres de toxicidad'],
  // A bare Roman-looking letter without the clinical keyword is left untouched
  ['la vitamina V y el grupo I', 'la vitamina V y el grupo I'],
];

// Guard that adding the locale param didn't disturb the English path. We do NOT
// hardcode IPA output here (the shared package's English IPA evolves via the PL
// project); instead we assert the default dispatch routes to the English
// pipeline and stable number/unit expansion still works.
const EN_REGRESSION = [
  ['over 1,000 people', 'over one thousand people'],
  ['Blood glucose: 95 mg/dL', 'Blood glucose: ninety five milligrams per deciliter'],
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
run('Spanish', ES, { locale: 'es' });
run('English regression (locale en)', EN_REGRESSION, undefined);

// Default (no opts) must route to the English pipeline, identical to {locale:'en'}.
console.log('\n── Dispatch: default === {locale:en} ──');
for (const s of ['Take 200mg of NMN daily', 'NAD+ levels decline by 50%', 'over 1,000 people']) {
  if (normalizeForTTS(s) === normalizeForTTS(s, { locale: 'en' })) pass++;
  else { fail++; console.log(`  ✗ default !== en for "${s}"`); }
}
console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
