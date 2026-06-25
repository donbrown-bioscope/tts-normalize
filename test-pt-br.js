// Golden tests for Brazilian Portuguese (pt-br) normalization + en/es/fr/it
// regression guard. Run: node test-pt-br.js
const { normalizeForTTS } = require('./index');

const PT = [
  // cardinals — "e" connector, cem vs cento, gendered hundreds/dois/um
  ['Tomar 200 mg por dia', 'Tomar duzentos miligramas por dia'],
  ['1 mg', 'um miligrama'],
  ['21 mg', 'vinte e um miligramas'],
  ['28 dias', 'vinte e oito dias'],
  ['23 casos', 'vinte e três casos'],
  ['80 mg', 'oitenta miligramas'],
  ['100 mg', 'cem miligramas'],
  ['101 pacientes', 'cento e um pacientes'],
  ['108 casos', 'cento e oito casos'],
  ['380 mg', 'trezentos e oitenta miligramas'],
  ['2500 mg', 'dois mil e quinhentos miligramas'],
  ['1000 participantes', 'mil participantes'],
  ['80000 casos', 'oitenta mil casos'],
  ['200000 casos', 'duzentos mil casos'],
  // thousands vs decimal (mixed source formatting incl. spaced thousands)
  ['10,000 participantes', 'dez mil participantes'],
  ['10 000 participantes', 'dez mil participantes'],
  ['mais de 1,000 pessoas', 'mais de mil pessoas'],
  ['99,5 % dos participantes', 'noventa e nove vírgula cinco por cento dos participantes'],
  ['redução de 50%', 'redução de cinquenta por cento'],
  ['3.5 g de café', 'três vírgula cinco gramas de café'],
  // units — feminine agreement (caloria/hora/libra) drives uma/duas/duzentas
  ['glicemia de 95 mg/dL', 'glicemia de noventa e cinco miligramas por decilitro'],
  ['500 µg de vitamina', 'quinhentos microgramas de vitamina'],
  ['1 cal', 'uma caloria'],
  ['200 kcal', 'duzentas quilocalorias'],
  ['2 hr', 'duas horas'],
  ['21 lb', 'vinte e uma libras'],
  ['1 hr', 'uma hora'],
  ['5 hr', 'cinco horas'],
  ['72 bpm', 'setenta e dois batimentos por minuto'],
  ['37 °C', 'trinta e sete graus Celsius'],
  ['1 °C', 'um grau Celsius'],
  // currency / ranges / symbols (symbol before AND after; R$ wins over $)
  ['custa $50', 'custa cinquenta dólares'],
  ['custa 50 $', 'custa cinquenta dólares'],
  ['custa 50€', 'custa cinquenta euros'],
  ['apenas 1€', 'apenas um euro'],
  ['R$ 100', 'cem reais'],
  ['de 5–10 mg', 'de cinco a dez miligramas'],
  ['EPA + DHA', 'EPA mais DHA'],
  ['EPA & DHA', 'EPA e DHA'],
  // blood pressure / ratios
  ['pressão de 120/80 mmHg', 'pressão de cento e vinte por oitenta milímetros de mercúrio'],
  ['140/90', 'cento e quarenta por noventa'],
  // mixed thousands+decimal, comparison/math, markdown, abbreviations
  ['uma taxa de 40,028.5', 'uma taxa de quarenta mil e vinte e oito vírgula cinco'],
  ['valor p < 0,05', 'valor p menor que zero vírgula zero cinco'],
  ['risco ≥ 3 vezes', 'risco maior ou igual a três vezes'],
  ['uma variação de ±3 mg', 'uma variação de mais ou menos três miligramas'],
  ['cerca de ~10%', 'cerca de aproximadamente dez por cento'],
  ['**Resultado** principal', 'Resultado principal'],
  ['o * marcador principal', 'o marcador principal'],
  ['o Dr. Silva e a Dra. Souza', 'o doutor Silva e a doutora Souza'],
  ['um estudo nos EUA vs placebo, etc.', 'um estudo nos Estados Unidos versus placebo, etcétera'],
  // scientific letter+number, ISO dates, scientific units
  ['vitamina B12 e D3', 'vitamina B doze e D três'],
  ['omega-3 e CoQ10', 'ômega três e CoQ dez'],
  ['níveis de T3 e T4', 'níveis de T três e T quatro'],
  // PCSK9 is now a learned letter-spell entry; TP53/SIRT1 are not, so stay verbatim.
  ['o gene PCSK9 e TP53 e SIRT1', 'o gene P C S K nove e TP53 e SIRT1'],
  // Learned gene/acronym letter-spelling (manual-scan additions): number spoken
  // as a cardinal, embedded in the spelled letters.
  ['inibidor de PCSK9', 'inibidor de P C S K nove'],
  ['marcador CD38 elevado', 'marcador C D trinta e oito elevado'],
  ['fatores OCT4 e SOX2', 'fatores O C T quatro e S O X dois'],
  ['agonista GLP-1RA', 'agonista G L P um R A'],
  ['via LKB1-AMPK em Thr172', 'via L K B um-A M P K em T H R cento e setenta e dois'],
  // Word-bounded: must NOT letter-spell when the symbol is a prefix of a longer token.
  ['o gene BCL2L1 difere de BCL2', 'o gene BCL2L1 difere de B C L dois'],
  ['publicado em 2026-06-20', 'publicado em vinte de junho de dois mil e vinte e seis'],
  ['desde 2026-06-01', 'desde primeiro de junho de dois mil e vinte e seis'],
  ['sinal de 100 Hz e 60 dB', 'sinal de cem hertz e sessenta decibéis'],
  ['uma proteína de 50 kDa', 'uma proteína de cinquenta quilodáltons'],
  ['200 ppm de cloro', 'duzentas partes por milhão de cloro'],
  ['concentração de 5 mM', 'concentração de cinco milimolar'],
  // Roman numerals in clinical contexts (scoped to a leading keyword)
  ['o ensaio de fase III PROTEUS', 'o ensaio de fase três PROTEUS'],
  ['tumor em estágio IV', 'tumor em estágio quatro'],
  ['estudo de fase II', 'estudo de fase dois'],
  ['diabetes tipo II', 'diabetes tipo dois'],
  // A bare Roman-looking letter without the clinical keyword is left untouched
  ['a vitamina V e o grupo I', 'a vitamina V e o grupo I'],
  // Learned terms (seeded; grown by the weekly gap-scan) — word-bounded.
  ['a OMS recomenda', 'a O M S recomenda'],
  ['o DNA e RNA', 'o D N A e R N A'],
  ['colesterol LDL e HDL', 'colesterol L D L e H D L'],
  ['níveis de ATP e de BDNF', 'níveis de A T P e de B D N F'],
  ['uma TC, um EEG e a PCR', 'uma T C, um E E G e a P C R'],
  // millions
  ['1000000 de células', 'um milhão de células'],
  ['2000000 de pessoas', 'dois milhões de pessoas'],
  // HTML tag stripping (inline <em>/<sub> in translated summaries)
  ['expansão de <em>Faecalibacterium</em> e <sub>2</sub> em 12 %',
    'expansão de Faecalibacterium e dois em doze por cento'],
  ['o gene <em>APOE4</em> é um fator de risco', 'o gene APOE4 é um fator de risco'],
  // Compound / product codes: digit-by-digit tail (3–4 digits), not a cardinal
  ['RLS-1496 reduziu as lesões', 'RLS um quatro nove seis reduziu as lesões'],
  ['inibidor BPC-157', 'inibidor BPC um cinco sete'],
  ['tratado com AC220', 'tratado com AC dois dois zero'],
  // Learned-acronym guard: must NOT eat a LETTERS-NNNN code prefix, yet still
  // letter-spell standalone. (LDL is seeded.)
  ['LDL-5678 e o LDL', 'LDL cinco seis sete oito e o L D L'],
  // 2-digit tails still read as numbers (COVID-19, not a code)
  ['a pandemia de COVID-19', 'a pandemia de COVID-dezenove'],
  // Must NOT mangle longer tokens that merely contain a seeded acronym
  ['mRNA e ATPase', 'mRNA e ATPase'],
];

// Guard that the pt locale param didn't disturb the en/es/fr/it paths.
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

let pass = 0, fail = 0;
function run(label, cases, opts) {
  console.log(`\n── ${label} ──`);
  for (const [input, expected] of cases) {
    const got = normalizeForTTS(input, opts);
    if (got === expected) { pass++; }
    else { fail++; console.log(`  ✗ "${input}"\n      exp: ${expected}\n      got: ${got}`); }
  }
}
run('Brazilian Portuguese', PT, { locale: 'pt-br' });
run('English regression (default)', EN_REGRESSION, undefined);
run('Spanish regression (locale es)', ES_REGRESSION, { locale: 'es' });
run('French regression (locale fr)', FR_REGRESSION, { locale: 'fr' });
run('Italian regression (locale it)', IT_REGRESSION, { locale: 'it' });

// Default (no opts) must still route to the English pipeline; pt-br and pt alias.
console.log('\n── Dispatch: default === {locale:en}; pt-br === pt ──');
for (const s of ['Take 200mg of NMN daily', 'NAD+ levels decline by 50%', 'over 1,000 people']) {
  if (normalizeForTTS(s) === normalizeForTTS(s, { locale: 'en' })) pass++;
  else { fail++; console.log(`  ✗ default !== en for "${s}"`); }
}
for (const s of ['200 mg por dia', 'a OMS e o DNA', '2500 mg']) {
  if (normalizeForTTS(s, { locale: 'pt-br' }) === normalizeForTTS(s, { locale: 'pt' })) pass++;
  else { fail++; console.log(`  ✗ pt-br !== pt for "${s}"`); }
}
console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
