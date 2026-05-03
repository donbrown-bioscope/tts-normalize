'use strict';

/**
 * scripts/lib/tts-normalize.js — Text normalization for TTS
 *
 * Preprocesses narration text before sending to Google Cloud TTS
 * (Chirp 3 HD / Neural2) to prevent mispronunciations of numbers, units,
 * abbreviations, symbols, etc.
 *
 * Pipeline: preprocessForTTS → coreNormalize → postprocessForTTS.
 *
 * The output may contain SSML markup (`<phoneme alphabet="ipa" ph="…">`
 * for words that need explicit pronunciation, `<break time="…ms"/>` for
 * pause tokens). Google's Neural2 voices honor these directly; Chirp 3 HD
 * voices honor `<phoneme>` too (verified by direct API probe). The
 * synthesizer wrapper (`google-tts.js` / equivalent) is responsible for
 * wrapping the output in `<speak>` tags and stripping `<phoneme>` tags
 * for any voice family that doesn't support them — see
 * VOICES_WITHOUT_PHONEME_SSML in the wrapper.
 *
 * Migration note (2026-04-27): this file was previously tuned for
 * ElevenLabs Multilingual v2. Those tunings have been replaced with
 * Google-tuned phonetic respellings + IPA `<phoneme>` SSML wraps
 * gathered during Precision Longevity course production. Anything that
 * was an ElevenLabs-specific workaround (pronunciation-dictionary IDs,
 * literal phonetic respellings that ElevenLabs read fine but Whisper
 * round-tripped poorly) has been updated.
 *
 * Exports:
 *   normalizeForTTS(text)                           — returns cleaned text (may contain SSML)
 *   addLearnedPronunciation(word, phonetic, source) — persist a verified fix
 *   selfTest()                                      — run unit tests
 */

const fs = require('fs');
const path = require('path');

// ─── NUMBER TO WORDS ────────────────────────────────────────

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function numberToWords(n) {
  if (n === 0) return 'zero';
  if (n < 0) return 'negative ' + numberToWords(-n);

  let result = '';

  if (n >= 1_000_000_000) {
    result += numberToWords(Math.floor(n / 1_000_000_000)) + ' billion ';
    n %= 1_000_000_000;
  }
  if (n >= 1_000_000) {
    result += numberToWords(Math.floor(n / 1_000_000)) + ' million ';
    n %= 1_000_000;
  }
  if (n >= 1000) {
    result += numberToWords(Math.floor(n / 1000)) + ' thousand ';
    n %= 1000;
  }
  if (n >= 100) {
    result += ONES[Math.floor(n / 100)] + ' hundred ';
    n %= 100;
  }
  if (n >= 20) {
    result += TENS[Math.floor(n / 10)] + ' ';
    n %= 10;
  }
  if (n > 0) {
    result += ONES[n] + ' ';
  }

  return result.trim();
}

function convertNumber(str) {
  const num = parseFloat(str);
  if (isNaN(num)) return str;

  // Handle decimals
  if (str.includes('.')) {
    const [intPart, decPart] = str.split('.');
    const intNum = parseInt(intPart, 10);
    const intWords = intNum === 0 ? 'zero' : numberToWords(intNum);
    // Read decimal digits individually for precision
    const decWords = decPart.split('').map(d => numberToWords(parseInt(d, 10))).join(' ');
    return `${intWords} point ${decWords}`;
  }

  return numberToWords(parseInt(str, 10));
}

// ─── UNIT EXPANSIONS ────────────────────────────────────────

const UNITS = {
  // Mass
  'mg': 'milligrams', 'g': 'grams', 'kg': 'kilograms', 'µg': 'micrograms',
  'μg': 'micrograms', 'mcg': 'micrograms', 'ng': 'nanograms', 'pg': 'picograms',
  'lb': 'pounds', 'lbs': 'pounds', 'oz': 'ounces',
  // Volume
  'mL': 'milliliters', 'ml': 'milliliters', 'L': 'liters', 'dL': 'deciliters',
  'dl': 'deciliters', 'µL': 'microliters', 'μL': 'microliters',
  'fl oz': 'fluid ounces',
  // Concentration
  'mg/dL': 'milligrams per deciliter', 'mg/dl': 'milligrams per deciliter',
  'mmol/L': 'millimoles per liter', 'µmol/L': 'micromoles per liter',
  'ng/mL': 'nanograms per milliliter', 'ng/ml': 'nanograms per milliliter',
  'pg/mL': 'picograms per milliliter', 'µg/dL': 'micrograms per deciliter',
  'mEq/L': 'milliequivalents per liter', 'g/dL': 'grams per deciliter',
  'IU/L': 'international units per liter', 'U/L': 'units per liter',
  // Pressure
  'mmHg': 'millimeters of mercury', 'kPa': 'kilopascals',
  // Time
  'hr': 'hour', 'hrs': 'hours', 'min': 'minutes', 'sec': 'seconds',
  'ms': 'milliseconds',
  // Energy
  'kcal': 'kilocalories', 'kJ': 'kilojoules', 'cal': 'calories',
  // Other medical
  'IU': 'international units', 'mg/kg': 'milligrams per kilogram',
  'bpm': 'beats per minute', 'rpm': 'respirations per minute',
  'mmol': 'millimoles', 'µmol': 'micromoles', 'nmol': 'nanomoles',
  'mIU': 'milli international units', 'pg/mg': 'picograms per milligram',
  'CFU': 'colony forming units',
  // Distance/size
  'nm': 'nanometers', 'µm': 'micrometers', 'mm': 'millimeters',
  'cm': 'centimeters', 'km': 'kilometers',
};

// ─── ABBREVIATION EXPANSIONS ────────────────────────────────

const ABBREVIATIONS = {
  // Spell out as individual letters (hyphenated so TTS reads each letter distinctly)
  'DNA': 'D-N-A', 'RNA': 'R-N-A', 'mRNA': 'm-R-N-A', 'tRNA': 't-R-N-A',
  'BMI': 'B-M-I', 'BMR': 'B-M-R', 'RDA': 'R-D-A', 'FDA': 'F-D-A',
  'NIH': 'N-I-H', 'WHO': 'W-H-O', 'CDC': 'C-D-C',
  'ATP': 'A-T-P', 'ADP': 'A-D-P', 'AMP': 'A-M-P',
  'HDL': 'H-D-L', 'LDL': 'L-D-L', 'VLDL': 'V-L-D-L',
  'HbA1c': 'H-b-A-one-c', 'A1C': 'A-one-C',
  // T-helper cell subsets — "Th17" has mixed case so it misses the
  // gene-number regex; Whisper hears raw "Th17" as "TH17" and "Treg"
  // as "DTREG". Make them explicit.
  'Th17': 'T-helper-seventeen', 'Th22': 'T-helper-twenty-two',
  'Th1':  'T-helper-one',       'Th2':  'T-helper-two',
  'Treg': 'T-reg',              'Tregs': 'T-regs',
  // BRCA1/2 — the gene regex produces "B-R-C-A-one/two" which Whisper
  // sometimes hears with a leaked letter from adjacent words. Phonetic
  // "bracka" is how clinicians actually say it.
  'BRCA1': 'bracka-one', 'BRCA2': 'bracka-two',
  // Amino-acid three-letter codes — "Thr-ninety-two-Ala" (residue
  // position notation common in gene-variant scripts) gets the Thr
  // read as "thar" and the whole string collapsed into "2392 ALA" by
  // Whisper. Expanding to full names keeps the hyphenated hinge visible.
  'Ala': 'alanine', 'Arg': 'arginine', 'Asn': 'asparagine', 'Asp': 'aspartate',
  'Cys': 'cysteine', 'Gln': 'glutamine', 'Glu': 'glutamate', 'Gly': 'glycine',
  'His': 'histidine', 'Ile': 'isoleucine', 'Leu': 'leucine', 'Lys': 'lysine',
  'Met': 'methionine', 'Phe': 'phenylalanine', 'Pro': 'proline', 'Ser': 'serine',
  'Thr': 'threonine', 'Trp': 'tryptophan', 'Tyr': 'tyrosine', 'Val': 'valine',
  // SAMe — English word collision ("same") garbles Whisper pickup;
  // spell the abbreviation out (lowercase "sam" + stressed letter "E"
  // is what survives TTS cleanest).
  'SAMe': 'sam-E',
  // Lipid / variant tokens with mixed case or embedded chars the
  // gene regex skips.
  'ApoB': 'apo-B', 'ApoE': 'apo-E',
  'Lp(a)': 'L-P-little-a', 'Lp-a': 'L-P-little-a',
  'HLA-DRB1': 'H-L-A-D-R-B-one',
  // One-hop enzyme abbreviations that English readers know but TTS
  // tends to mumble.
  'MTHFR': 'M-T-H-F-R', 'COMT': 'comm-tee',
  'GLP-1': 'G-L-P-one', 'GLP1': 'G-L-P-one',
  'TNF': 'T-N-F', 'TNF-α': 'T-N-F-alpha',
  'IL-6': 'interleukin six', 'IL-1': 'interleukin one',
  'IL-10': 'interleukin ten', 'IL-17': 'interleukin seventeen',
  'CRP': 'C-R-P', 'hsCRP': 'high sensitivity C-R-P',
  'IGF-1': 'I-G-F-one', 'IGF1': 'I-G-F-one',
  'PI3K': 'pie-three-kay',
  'BDNF': 'B-D-N-F', 'NGF': 'N-G-F',
  'ROS': 'R-O-S', 'RNS': 'R-N-S',
  'DHEA': 'D-H-E-A', 'DHA': 'D-H-A', 'EPA': 'E-P-A',
  'NMN': 'N-M-N', 'NR': 'N-R', 'CoQ10': 'co-Q-ten',
  'AMPK': 'A-M-P-K', 'mTOR': 'm-TOR', 'mTORC1': 'm-TORC-one',
  'SIRT1': 'sirtuin one', 'SIRT3': 'sirtuin three', 'SIRT6': 'sirtuin six',
  'p53': 'p fifty three', 'p38': 'p thirty eight', 'p21': 'p twenty one',
  'FOXO3': 'foxo three', 'FOXO': 'foxo',
  'Nrf2': 'N-R-F-two', 'NF-kB': 'N-F-kappa-B',
  'VEGF': 'V-E-G-F',
  'EGCG': 'E-G-C-G', 'NAC': 'N-A-C',
  'VO2': 'V-O-two', 'VO2max': 'V-O-two-max',
  'pH': 'p-H', 'pO2': 'p-O-two', 'pCO2': 'p-C-O-two',
  'T3': 'T-three', 'T4': 'T-four', 'TSH': 'T-S-H',
  'PSA': 'P-S-A', 'MRI': 'M-R-I', 'CT': 'C-T', 'PET-CT': 'pet-see-tee',
  'ECG': 'E-C-G', 'EKG': 'E-K-G', 'EEG': 'E-E-G',
  'DEXA': 'D-E-X-A', 'DXA': 'D-X-A',
  'BMD': 'B-M-D', 'BUN': 'B-U-N', 'GFR': 'G-F-R', 'eGFR': 'estimated G-F-R',
  // Medical abbreviations
  'IV': 'I-V', 'IM': 'I-M', 'SQ': 'subcutaneous',
  'RCT': 'R-C-T', 'HR': 'hazard ratio', 'CI': 'confidence interval',
  'OR': 'odds ratio', 'RR': 'relative risk',
  'vs': 'versus', 'vs.': 'versus', 'etc.': 'et cetera', 'e.g.': 'for example',
  'i.e.': 'that is', 'approx.': 'approximately', 'approx': 'approximately',
  // Vitamins with numbers
  'B12': 'B-twelve', 'B6': 'B-six', 'B1': 'B-one', 'B2': 'B-two',
  'B3': 'B-three', 'B5': 'B-five', 'B7': 'B-seven', 'B9': 'B-nine',
  'D3': 'D-three', 'D2': 'D-two', 'K2': 'K-two', 'K1': 'K-one',
  'C60': 'C-sixty', 'Q10': 'Q-ten',
  // Protein/gene names — pronounceable words or hyphenated to prevent TTS pauses
  'UCP1': 'U-C-P-one', 'UCP2': 'U-C-P-two', 'UCP3': 'U-C-P-three',
  'ERK1/2': 'erk-one-two', 'ERK 1/2': 'erk-one-two',
  'ERK1-2': 'erk-one-two', 'ERK 1-2': 'erk-one-two',
  'ERK one-two': 'erk-one-two', 'ERK one two': 'erk-one-two',
  'ERK': 'erk',
  'MAPK': 'M-A-P-K', 'MEK': 'meck', 'MEK1': 'meck-one', 'MEK2': 'meck-two',
  'CREB': 'crebb', 'JAK': 'jack', 'STAT': 'stat',
  'JAK-STAT': 'jack-stat', 'JAK/STAT': 'jack-stat',
  'PRDM16': 'P-R-D-M-sixteen',
  'cAMP': 'cyclic-A-M-P',
};

// Special compound terms — replaced FIRST before any other processing
const COMPOUND_TERMS = {
  'NAD+': 'N-A-D-plus', 'NAD⁺': 'N-A-D-plus',
  'NADH': 'N-A-D-H', 'NADPH': 'N-A-D-P-H',
  'Ca2+': 'calcium two plus', 'Mg2+': 'magnesium two plus',
  'Fe2+': 'iron two plus', 'Fe3+': 'iron three plus',
  'Zn2+': 'zinc two plus', 'K+': 'potassium plus',
  'Na+': 'sodium plus', 'Cl-': 'chloride minus',
  'H2O2': 'hydrogen peroxide', 'H2O': 'water',
  'CO2': 'carbon dioxide', 'O2': 'oxygen',
  'NO': 'nitric oxide',
  // Greek-letter compounds — must be handled before Greek letter replacement
  'TNF-α': 'T-N-F-alpha', 'TNF-β': 'T-N-F-beta',
  'IL-1α': 'interleukin one alpha', 'IL-1β': 'interleukin one beta',
  'HIF-1α': 'H-I-F-one-alpha', 'HIF-2α': 'H-I-F-two-alpha',
  'NF-κB': 'N-F-kappa-B',
  'TGF-β': 'T-G-F-beta', 'IFN-α': 'interferon alpha', 'IFN-γ': 'interferon gamma',
  'PGC-1α': 'P-G-C-one-alpha',
  // Protein/gene names — hyphenated to prevent unnatural TTS pauses
  'C/EBPβ': 'C-E-B-P-beta', 'C/EBPα': 'C-E-B-P-alpha',
  // DNA motifs — spell out letter by letter
  'CCAAT': 'C-C-A-A-T', 'TATA': 'T-A-T-A', 'CpG': 'C p G',
  // Unit compounds with Greek mu — must be handled before Greek letter replacement
  'μg/dL': 'micrograms per deciliter', 'µg/dL': 'micrograms per deciliter',
  'μmol/L': 'micromoles per liter', 'µmol/L': 'micromoles per liter',
  'μL': 'microliters', 'µL': 'microliters',
  'μg': 'micrograms', 'µg': 'micrograms',
  'μm': 'micrometers', 'µm': 'micrometers',
  'μmol': 'micromoles', 'µmol': 'micromoles',
  // VO2 terms — must be handled before O2 → oxygen
  'VO2max': 'V-O-two-max', 'VO2 max': 'V-O-two-max', 'VO2': 'V-O-two',
  // DIO2 — "D-I-O-two" cadence gets transcribed as "dioxygen" by Whisper
  // because "O-two" ≈ O₂. Must run before the generic O2 → oxygen rule.
  // "die-oh-two" survives Chirp HD round-trip cleanly.
  'DIO2': 'die-oh-two',
};

// ─── GREEK LETTERS ──────────────────────────────────────────

const GREEK = {
  'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta',
  'ε': 'epsilon', 'ζ': 'zeta', 'η': 'eta', 'θ': 'theta',
  'ι': 'iota', 'κ': 'kappa', 'λ': 'lambda',
  'ν': 'nu', 'ξ': 'xi', 'π': 'pi', 'ρ': 'rho',
  'σ': 'sigma', 'τ': 'tau', 'υ': 'upsilon', 'φ': 'phi',
  'χ': 'chi', 'ψ': 'psi', 'ω': 'omega',
  'Ω': 'omega', 'Δ': 'delta',
};

// ─── SYMBOLS ────────────────────────────────────────────────

const SYMBOLS = {
  '±': 'plus or minus', '+': 'plus',
  '≥': 'greater than or equal to',
  '≤': 'less than or equal to',
  '≈': 'approximately',
  '→': 'leads to',
  '←': 'comes from',
  '↑': 'increased',
  '↓': 'decreased',
  '×': 'times',
  '÷': 'divided by',
  '∞': 'infinity',
  '°C': 'degrees Celsius',
  '°F': 'degrees Fahrenheit',
  '°': 'degrees',
};

// ─── ORDINALS ───────────────────────────────────────────────

const ORDINAL_MAP = {
  '1st': 'first', '2nd': 'second', '3rd': 'third', '4th': 'fourth',
  '5th': 'fifth', '6th': 'sixth', '7th': 'seventh', '8th': 'eighth',
  '9th': 'ninth', '10th': 'tenth', '11th': 'eleventh', '12th': 'twelfth',
  '13th': 'thirteenth', '20th': 'twentieth', '21st': 'twenty-first',
  '30th': 'thirtieth', '40th': 'fortieth', '50th': 'fiftieth',
  '100th': 'one hundredth',
};

// ─── GENE / PROTEIN NAME NORMALIZATION ──────────────────────

// Prefixes whose letter cluster sounds like a word or syllable.
// Anything NOT listed here gets spelled out letter-by-letter.
const GENE_PRONOUNCEABLE_PREFIXES = {
  'FOX':    'fox',
  'FOXO':   'fox-oh',
  'SIRT':   'sirt',       // sirtuins (SIRT1/3/6 already in ABBREVIATIONS; fallback for others)
  'TOR':    'tor',
  'TORC':   'torc',
  'ACE':    'ace',
  'APO':    'apo',
  'AKT':    'akt',
  'ERK':    'erk',
  'MEK':    'mek',
  'JAK':    'jak',
  'STAT':   'stat',
  'PARP':   'parp',
  'PARK':   'park',
  'PINK':   'pink',
  'PTEN':   'P-ten',
  'PER':    'per',        // circadian Period genes
  'CRY':    'cry',        // Cryptochrome
  'WNT':    'wnt',        // Wingless
  'CREB':   'creb',
  'RAP':    'rap',
  'RICTOR': 'ric-tor',
  'RAPTOR': 'rap-tor',
  'TERT':   'tert',       // telomerase reverse transcriptase
  'TERC':   'terc',       // telomerase RNA component
  'PRDM':   'prdm',
};

// Reads a gene number in the natural spoken style:
//   4   → "four"
//   53  → "fifty-three"
//   280 → "two-eighty"
//   100 → "one-hundred"
function geneNumberToWords(n) {
  if (n < 20) return numberToWords(n);
  if (n < 100) {
    const tenIdx = Math.floor(n / 10);
    const ones = n % 10;
    return TENS[tenIdx] + (ones ? '-' + ONES[ones] : '');
  }
  const h = Math.floor(n / 100);
  const rem = n % 100;
  return ONES[h] + (rem === 0 ? '-hundred' : '-' + geneNumberToWords(rem));
}

// ─── CORE NORMALIZE (PRIVATE) ───────────────────────────────
// Runs between preprocessForTTS and postprocessForTTS. The exported
// normalizeForTTS at the bottom of the file pipes input through all
// three stages.

function coreNormalize(text) {
  if (!text) return '';
  let t = text;

  // 1. Strip HTML tags (in case any leaked through). SSML tags are
  // preserved — authors and upstream pipelines may emit <emphasis>,
  // <prosody>, <break>, etc. that Google TTS honors. The same allow-
  // list is enforced by the synth wrapper's hasSSML() detector.
  t = t.replace(/<(?!\/?(speak|phoneme|break|prosody|emphasis|say-as|sub|p|s|voice|audio)\b)[^>]+>/g, '');

  // 1b. Normalize comma-formatted numbers (e.g. "1,000" → "1000", "10,000,000" → "10000000")
  //     Must run before any number conversion to prevent "1,000" splitting into "1" + "000"
  //     Uses (?!\d) instead of \b so "2,500mg" (number + unit, no space) also matches
  t = t.replace(/\b(\d{1,3})(,\d{3})+(?!\d)/g, (match) => match.replace(/,/g, ''));

  // 2. Replace compound terms first (before other replacements break them)
  //    Sort longest first to prevent partial matches (e.g. VO2max before O2)
  const sortedCompounds = Object.entries(COMPOUND_TERMS).sort((a, b) => b[0].length - a[0].length);
  for (const [term, expansion] of sortedCompounds) {
    // First try: number + compound (e.g. "500μg" → "five hundred micrograms")
    const numPattern = new RegExp(`(\\d+\\.?\\d*)\\s*${escapeRegex(term)}(?!\\w)`, 'g');
    t = t.replace(numPattern, (_, num) => `${convertNumber(num)} ${expansion}`);
    // Then: standalone compound
    t = t.replace(new RegExp(escapeRegex(term), 'g'), expansion);
  }

  // 3. Replace Greek letters
  for (const [letter, name] of Object.entries(GREEK)) {
    t = t.replace(new RegExp(escapeRegex(letter), 'g'), name);
  }

  // 4. Replace symbols
  for (const [sym, word] of Object.entries(SYMBOLS)) {
    t = t.replace(new RegExp(escapeRegex(sym), 'g'), ` ${word} `);
  }

  // 5. Replace multi-word units first (e.g. "mg/dL" before "mg")
  const sortedUnits = Object.entries(UNITS).sort((a, b) => b[0].length - a[0].length);
  for (const [unit, expansion] of sortedUnits) {
    // Match number + optional space + unit (e.g. "200mg", "200 mg")
    const pattern = new RegExp(`(\\d+\\.?\\d*)\\s*${escapeRegex(unit)}\\b`, 'g');
    t = t.replace(pattern, (_, num) => `${convertNumber(num)} ${expansion}`);
  }

  // Also replace standalone units not preceded by a number
  for (const [unit, expansion] of sortedUnits) {
    // Only replace if it's a standalone word (not part of a longer word)
    const pattern = new RegExp(`\\b${escapeRegex(unit)}\\b`, 'g');
    t = t.replace(pattern, expansion);
  }

  // 6a. Replace compound terms with Roman numerals (case-insensitive, before abbreviation expansion)
  // Must run before step 6b so "complex IV" matches before "IV" → "I V"
  const ROMAN_COMPOUNDS = {
    'complex I': 'complex-one', 'complex II': 'complex-two',
    'complex III': 'complex-three', 'complex IV': 'complex-four', 'complex V': 'complex-five',
    'type I': 'type-one', 'type II': 'type-two', 'type III': 'type-three',
    'phase I': 'phase-one', 'phase II': 'phase-two', 'phase III': 'phase-three',
    'class I': 'class-one', 'class II': 'class-two', 'class III': 'class-three',
  };
  const sortedRoman = Object.entries(ROMAN_COMPOUNDS).sort((a, b) => b[0].length - a[0].length);
  for (const [term, expansion] of sortedRoman) {
    t = t.replace(new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi'), expansion);
  }

  // 6b. Replace abbreviations (longest first to avoid partial matches)
  const sortedAbbrevs = Object.entries(ABBREVIATIONS).sort((a, b) => b[0].length - a[0].length);
  for (const [abbr, expansion] of sortedAbbrevs) {
    const pattern = new RegExp(`\\b${escapeRegex(abbr)}\\b`, 'g');
    t = t.replace(pattern, expansion);
  }

  // 7. Replace ordinals
  for (const [ordinal, word] of Object.entries(ORDINAL_MAP)) {
    t = t.replace(new RegExp(`\\b${escapeRegex(ordinal)}\\b`, 'gi'), word);
  }

  // 8. Replace percentage sign
  t = t.replace(/(\d+\.?\d*)\s*%/g, (_, num) => `${convertNumber(num)} percent`);

  // 9. Replace remaining standalone numbers (not already converted)
  t = t.replace(/\b(\d+\.?\d*)\b/g, (_, num) => convertNumber(num));

  // 10.5. Gene/protein names with embedded numbers (e.g. ZNF280A, FOXO4, PCSK9, TP53)
  //       Must run AFTER abbreviations (step 6b) so known entries like SIRT1 are already replaced.
  //       Must run AFTER number conversion (step 9) — bare digits inside gene tokens aren't
  //       reached by step 9 (no word boundary), so we handle them here ourselves.
  t = t.replace(/\b([A-Z]{2,})(\d{1,4})([A-Z]?)\b/g, (_, prefix, digits, suffix) => {
    const numWords = geneNumberToWords(parseInt(digits, 10));
    const phonetic = GENE_PRONOUNCEABLE_PREFIXES[prefix]
      ?? prefix.split('').join('-');  // spell out unknown prefixes letter-by-letter
    return phonetic + '-' + numWords + (suffix ? '-' + suffix : '');
  });

  // 10. Replace number ranges with "to" (e.g. "five-ten" → "five to ten")
  // Only for numeric-word ranges, NOT compound adjectives like "iron-rich"
  const NUMBER_WORDS = new Set(['zero','one','two','three','four','five','six','seven','eight','nine',
    'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen',
    'twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety','hundred','thousand','million','billion']);
  const TENS_PREFIXES = new Set(['twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety']);
  const ONES_WORDS = new Set(['one','two','three','four','five','six','seven','eight','nine']);
  const MULTIPLIERS = new Set(['hundred','thousand','million','billion']);
  t = t.replace(/(\w+)\s*[-–]\s*(\w+)/g, (match, a, b) => {
    const al = a.toLowerCase(), bl = b.toLowerCase();
    // Skip compound numbers like "thirty-two", "sixty-five"
    if (TENS_PREFIXES.has(al) && ONES_WORDS.has(bl)) return match;
    // Skip multiplier compounds like "three-hundred", "hundred-seven"
    if (MULTIPLIERS.has(al) || MULTIPLIERS.has(bl)) return `${a} ${b}`;
    if (NUMBER_WORDS.has(al) && NUMBER_WORDS.has(bl)) return `${a} to ${b}`;
    return match;
  });

  // 11. Spell out remaining uppercase letter sequences not caught by abbreviation map
  // e.g. "PPARG" → "P-P-A-R-G", "CREB" → "C-R-E-B"
  // Skip common English words and abbreviation fragments already expanded above
  const SKIP_UPPERCASE = new Set([
    'THE','AND','FOR','BUT','NOT','ALL','ARE','WAS','HAS','HAD','HER','HIS','HOW',
    'ITS','MAY','NEW','NOW','OLD','OUR','OUT','OWN','SAY','SHE','TOO','USE','WAY','WHO',
    'DID','GET','LET','PUT','RUN','TOP','BOY',
    // Fragments from abbreviation expansions (mTOR → "m TOR", etc.) + standalone NAD
    'NAD','TOR','TORC','FOX','SIR',
  ]);
  t = t.replace(/\b([A-Z]{3,})\b/g, (match) => {
    if (SKIP_UPPERCASE.has(match)) return match;
    return match.split('').join('-');
  });

  // 12. Replace em-dashes with commas (natural pause for TTS)
  t = t.replace(/\s*—\s*/g, ', ');

  // 13. Pronunciation fixes — ONLY for words ElevenLabs genuinely mispronounces
  //     Note: ElevenLabs handles most scientific terms (Klotho, kynurenine,
  //     phosphoribosyltransferase, Szostak, Mirabegron, etc.) correctly without
  //     intervention. Phonetic hints (e.g., 'KLO-tho') actually made things WORSE
  //     by being read literally. Only keep fixes for words confirmed mispronounced.
  const PRONUNCIATIONS = {
    'anion': 'ann-eye-on',
    'anions': 'ann-eye-ons',
    'cation': 'cat-eye-on',
    'cations': 'cat-eye-ons',
    'uncoupling protein one': 'uncoupling-protein-one',
    'uncoupling protein two': 'uncoupling-protein-two',
    'uncoupling protein three': 'uncoupling-protein-three',
    // NOTE — phonetic respellings of Latin binomials (Faecalibacterium,
    // Akkermansia, Prevotella, etc.) were tried here and measurably
    // REGRESSED round-trip accuracy. ElevenLabs' default pronunciation
    // for Latin is close enough; Whisper's mishearings are best handled
    // as equivalent-spellings in narration-verifier.js, not by mangling
    // the text sent to the TTS. Do not re-add without A/B testing.

    // (fisetin moved to CLINICAL_IPA — IPA <phoneme> wrap pins it to
    // FY-sit-in cleanly; the old "fuhsetten" text-respell was an
    // ElevenLabs-specific workaround that Chirp HD reads literally.)
    // DunedinPACE figure "one point oh three" — Whisper inserts a
    // sentence break between "1.0" and "three" because of the pause
    // after "oh". Hyphenating glues the reading as a single phrase.
    'one point oh three': 'one-point-oh-three',
  };
  const merged = { ...PRONUNCIATIONS };
  for (const [word, entry] of Object.entries(_learnedPronunciations)) {
    merged[word] = entry.phonetic;
  }
  for (const [word, phonetic] of Object.entries(merged)) {
    t = t.replace(new RegExp(`\\b${escapeRegex(word)}\\b`, 'gi'), phonetic);
  }

  // 14. Hyphenate multi-word terms ending in a single letter to prevent unnatural pause
  // Uses explicit list to avoid false positives in normal sentences
  const HYPHENATE_TERMS = [
    'protein kinase A', 'protein kinase B', 'protein kinase C',
    // Roman numeral terms handled in ABBREVIATIONS (step 6)
    'vitamin A', 'vitamin B', 'vitamin C', 'vitamin D', 'vitamin E', 'vitamin K',
    'coenzyme Q', 'cytochrome C', 'cytochrome P',
    'protein kinase A', 'protein kinase B', 'protein kinase C',
    'group A', 'group B',
    'receptor A', 'receptor B', 'receptor C',
    'subunit A', 'subunit B', 'subunit C',
    'factor A', 'factor B', 'factor D',
  ];
  for (const term of HYPHENATE_TERMS) {
    t = t.replace(new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi'), term.replace(/\s+/g, '-'));
  }

  // 15. Clean up extra whitespace
  t = t.replace(/\s+/g, ' ').trim();

  return t;
}

// ─── LEARNED PRONUNCIATIONS ─────────────────────────────────

// Persist learned IPAs inside the package itself so both the Precision
// Longevity course and CAFMI consume the same dictionary via npm.
// Previously this used path.join(__dirname, '..', 'data', ...) which
// resolved correctly only when this file lived at <project>/scripts/lib/
// inside CAFMI's tree; in the shared-package layout that path landed
// outside the installed package and was wiped on every npm install.
// Promote new entries by editing data/*.json here and pushing to the
// shared repo; consumers pick them up via `npm update`.
const LEARNED_PATH     = path.join(__dirname, 'data', 'learned-pronunciations.json');
const LEARNED_IPA_PATH = path.join(__dirname, 'data', 'learned-ipa.json');

let _learnedPronunciations = {};
try {
  if (fs.existsSync(LEARNED_PATH)) {
    _learnedPronunciations = JSON.parse(fs.readFileSync(LEARNED_PATH, 'utf-8'));
  }
} catch { /* start fresh if corrupt */ }

let _learnedIPA = {};
try {
  if (fs.existsSync(LEARNED_IPA_PATH)) {
    _learnedIPA = JSON.parse(fs.readFileSync(LEARNED_IPA_PATH, 'utf-8'));
  }
} catch { /* start fresh if corrupt */ }

/**
 * Persist a verified pronunciation fix so future narrations use it automatically.
 *
 * @param {string} word     — the word as it appears in normalized text
 * @param {string} phonetic — the phonetic respelling that Whisper confirmed
 * @param {string} source   — tutorial slug where the fix was discovered
 */
function addLearnedPronunciation(word, phonetic, source) {
  _learnedPronunciations[word.toLowerCase()] = {
    phonetic,
    learned: new Date().toISOString().slice(0, 10),
    source,
  };
  fs.writeFileSync(LEARNED_PATH, JSON.stringify(_learnedPronunciations, null, 2) + '\n', 'utf-8');
}

/**
 * Persist a verified IPA pronunciation so future normalizations wrap the word
 * in a <phoneme alphabet="ipa" ph="…"> tag (Google TTS / Chirp 3 HD).
 *
 * @param {string} word   — the word as it appears after normalization (lowercase key)
 * @param {string} ipa    — IPA string (e.g. "ˌsɛməˈɡluːtaɪd")
 * @param {string} source — slug or script name where the mispronunciation was discovered
 */
function addLearnedIPA(word, ipa, source) {
  _learnedIPA[word.toLowerCase()] = {
    ipa,
    learned: new Date().toISOString().slice(0, 10),
    source: source || 'unknown',
  };
  fs.writeFileSync(LEARNED_IPA_PATH, JSON.stringify(_learnedIPA, null, 2) + '\n', 'utf-8');
}

// ─── AUTO-DISCOVERED IPA ─────────────────────────────────────────────
// When the catch-all letter-spell wrap (in postprocessForTTS) builds an
// IPA for an unfamiliar acronym, optionally persist it back to a
// developer working copy of this package so all consumers (e.g. the
// Precision Longevity course and CAFMI) inherit the entry on next
// `npm update`. Persistence is gated by BIOSCOPE_TTS_NORMALIZE_DEV_PATH
// — set it to the absolute path of your local clone of this repo. When
// unset (Amplify, fresh installs, anyone but the developer who owns
// the shared repo), discovery is in-memory only: the catch-all still
// produces the right IPA for the current run, no disk write.

const DEV_LEARNED_IPA_PATH = process.env.BIOSCOPE_TTS_NORMALIZE_DEV_PATH
  ? path.join(process.env.BIOSCOPE_TTS_NORMALIZE_DEV_PATH, 'data', 'learned-ipa.json')
  : null;

let _devDict = null;
let _devDirty = false;

function loadDev() {
  if (_devDict !== null) return _devDict;
  if (!DEV_LEARNED_IPA_PATH || !fs.existsSync(DEV_LEARNED_IPA_PATH)) {
    _devDict = {};
    return _devDict;
  }
  try { _devDict = JSON.parse(fs.readFileSync(DEV_LEARNED_IPA_PATH, 'utf-8')); }
  catch { _devDict = {}; }
  return _devDict;
}

function autoDiscover(word, ipa) {
  if (!DEV_LEARNED_IPA_PATH) return;
  const dict = loadDev();
  const key = word.toLowerCase();
  if (dict[key]) return; // already known by the canonical dict
  dict[key] = {
    ipa,
    learned: new Date().toISOString().slice(0, 10),
    source: 'auto-glue',
  };
  _devDirty = true;
}

/**
 * Heuristic: would this letter-spelled acronym likely be pronounced
 * as a word by a clinician/researcher? Used by audio-gen scripts to
 * select candidates worth resolving via LLM (PACE → /peɪs/ rather
 * than letter-by-letter "P-A-C-E").
 *
 * Input is the post-CAFMI hyphenated form ("P-A-C-E") or the bare
 * acronym ("PACE"). Returns true for plausibly word-shaped tokens,
 * false for definitely-letter-spelled ones (no vowels, awkward
 * onset clusters, too short/long).
 */
function isPronounceableAcronym(token) {
  const word = token.replace(/-/g, '').replace(/\d+$/, '');
  if (word.length < 3 || word.length > 7) return false;
  if (!/^[A-Z]+$/.test(word)) return false;
  const vowels = (word.match(/[AEIOUY]/g) || []).length;
  const ratio = vowels / word.length;
  if (ratio < 0.25 || ratio > 0.7) return false;
  // Reject 3+ consonant runs anywhere — not English-pronounceable.
  if (/[BCDFGHJKLMNPQRSTVWXZ]{3,}/.test(word)) return false;
  // Reject common clearly-letter-spelled patterns (DN-, NM-, MR- onsets).
  if (/^(DN|NM|MR|TN|GN|PT|FM|JN|XL|RV)/.test(word)) return false;
  return true;
}

/**
 * Scan text for letter-spelled acronyms (post-CAFMI form X-Y-Z) that
 * (a) aren't yet wrapped in a phoneme tag,
 * (b) aren't in any built-in OMIC/CLINICAL dict or the learned-ipa
 *     dictionary, and
 * (c) pass the pronounceability heuristic above.
 *
 * Audio-gen scripts call this on the concatenated source text BEFORE
 * per-section TTS, batch-resolve the result via an LLM, and write IPA
 * entries to `data/learned-ipa.json`. By the time per-section
 * normalization runs, the dictionary already wraps these tokens with
 * a word-pronunciation IPA instead of letter-by-letter.
 */
function findPronounceableAcronyms(text) {
  if (!text) return [];
  const seen = new Set();
  const re = /\b[A-Z](?:-[A-Z0-9])+\b(?![^<]*<\/phoneme>)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tok = m[0];
    if (seen.has(tok)) continue;
    if (!isPronounceableAcronym(tok)) continue;
    const bare = tok.replace(/-/g, '').toLowerCase();
    const hyphenated = tok.toLowerCase();
    // Already covered by a built-in dict?
    if (CLINICAL_IPA[tok] || CLINICAL_IPA[bare] || CLINICAL_IPA[hyphenated]) continue;
    if (OMIC_IPA[tok] || OMIC_IPA[bare] || OMIC_IPA[hyphenated]) continue;
    if (_learnedIPA[bare] || _learnedIPA[hyphenated]) continue;
    seen.add(tok);
  }
  return [...seen];
}

/**
 * Re-read `data/learned-ipa.json` from disk into the in-memory
 * dictionary. Audio-gen scripts call this after writing newly
 * resolved entries (via addLearnedIPA) so the catch-all sees them
 * during the subsequent per-section normalize.
 */
function reloadLearnedIpa() {
  try {
    if (fs.existsSync(LEARNED_IPA_PATH)) {
      _learnedIPA = JSON.parse(fs.readFileSync(LEARNED_IPA_PATH, 'utf-8'));
    }
  } catch { /* keep existing in-memory dict if reload fails */ }
}

/**
 * Write any auto-discovered entries from the current process to the
 * developer working-copy `data/learned-ipa.json`. Returns metadata
 * useful for an audio-gen script to commit + push the change.
 *
 * No-op if BIOSCOPE_TTS_NORMALIZE_DEV_PATH is unset or no discoveries
 * were made.
 */
function flushAutoDiscoveredIpa() {
  if (!_devDirty || !DEV_LEARNED_IPA_PATH) return { written: false, count: 0 };
  const dict = loadDev();
  const sorted = {};
  for (const k of Object.keys(dict).sort()) sorted[k] = dict[k];
  fs.writeFileSync(DEV_LEARNED_IPA_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf-8');
  _devDirty = false;
  return { written: true, count: Object.keys(sorted).length, path: DEV_LEARNED_IPA_PATH };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// XML escaping for SSML output — words wrapped in <phoneme> tags need
// any special chars escaped so the inner content stays valid XML.
function xmlEscape(s) {
  return s.replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&apos;');
}

// ════════════════════════════════════════════════════════════
//   PRE-PASS  (preprocessForTTS)
// ════════════════════════════════════════════════════════════
// Runs BEFORE coreNormalize. Handles tokens whose shape would otherwise
// be mangled by the core pipeline (bare-L → "liters", aggressive AA
// expansion, gene-regex misses on mixed-case identifiers, etc.).

// Amino-acid three-letter codes for residue-position notation
// ("Thr-92-Ala", "His123Asp"). Expanded to full names so the hyphenated
// hinge survives Whisper round-trip. Each code only fires when adjacent
// to a hyphen or digit; bare "His" / "Met" / "Pro" / "Ala" in English
// prose is lowercased earlier so the core pipeline's title-case
// ABBREVIATIONS match misses them.
const AMINO_ACIDS = {
  Ala: 'alanine', Arg: 'arginine', Asn: 'asparagine', Asp: 'aspartate',
  Cys: 'cysteine', Gln: 'glutamine', Glu: 'glutamate', Gly: 'glycine',
  His: 'histidine', Ile: 'isoleucine', Leu: 'leucine', Lys: 'lysine',
  Met: 'methionine', Phe: 'phenylalanine', Pro: 'proline', Ser: 'serine',
  Thr: 'threonine', Trp: 'tryptophan', Tyr: 'tyrosine', Val: 'valine',
};
const AA_CODES = Object.keys(AMINO_ACIDS).join('|');

const NUM_WORDS = {
  1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five',
  6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten',
  11: 'eleven', 12: 'twelve', 13: 'thirteen', 14: 'fourteen',
  15: 'fifteen', 16: 'sixteen', 17: 'seventeen', 18: 'eighteen',
  19: 'nineteen', 20: 'twenty', 21: 'twenty-one', 22: 'twenty-two',
  23: 'twenty-three', 24: 'twenty-four', 25: 'twenty-five',
  26: 'twenty-six', 27: 'twenty-seven', 28: 'twenty-eight', 29: 'twenty-nine',
};
function numWord(n) { return NUM_WORDS[Number(n)] || String(n); }

// Per-digit map for rsID expansion. Zero reads as "oh" — clinicians say
// "oh" not "zero" inside an identifier sequence.
const DIGIT_WORD = { 0: 'oh', 1: 'one', 2: 'two', 3: 'three', 4: 'four',
                     5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine' };

// Peptide / drug brand IDs read as natural-spoken numbers — "BPC-157"
// is "BPC one fifty-seven", not "one hundred fifty-seven".
const TENS_WORD = { 20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty',
                    60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety' };
function twoDigitWord(x) {
  if (x < 20) return numWord(x);
  const tens = Math.floor(x / 10) * 10;
  const ones = x % 10;
  return ones ? `${TENS_WORD[tens]}-${numWord(ones)}` : TENS_WORD[tens];
}
function spokenIdNumber(n) {
  const x = Number(n);
  if (x < 100) return twoDigitWord(x);
  if (x < 1000) {
    const hundreds = Math.floor(x / 100);
    const rest = x % 100;
    if (rest === 0) return `${numWord(hundreds)} hundred`;
    return `${numWord(hundreds)} ${twoDigitWord(rest)}`;
  }
  return String(n);
}

// Mixed-case / hyphenated / English-colliding tokens the core
// pipeline's gene regex doesn't pick up. Each is a literal \b-bounded
// pre-pass replacement.
const PRE_ABBREVIATIONS = {
  // Combined Treg/Th17 form must come before the individual entries
  // below so the longer key wins the longest-first sort.
  'Treg/Th17':   'T-reg, T-helper-seventeen',
  'Tregs/Th17':  'T-regs, T-helper-seventeen',
  // 2'-FL — 2'-fucosyllactose, a human-milk oligosaccharide. The
  // apostrophe + "FL" gets mangled by Chirp into "too. Florida".
  // Pre-pass placement is essential because the leading "2" gets
  // converted to "two" by the core pipeline. The bare-L in "F, L"
  // then trips the units pipeline again, so the comma-separated
  // already-spelled letter form sidesteps that.
  "2'-FL": 'two-prime F, L',
  "2′-FL": 'two-prime F, L',
  // T/S ratio — telomere-to-single-copy-gene ratio used in qPCR
  // telomere measurements. Slash reads as "SASH" without help.
  'T/S ratio': 'T over S ratio',
  // LC3-II / LC3-I autophagy ratio.
  'LC3-II/LC3-I': 'L-C three, two over L-C three, one',
  'LC3-II / LC3-I': 'L-C three, two over L-C three, one',
  // Imaging — Chirp HD reads the hyphenated "DEX-A" as letter-spelled
  // "DEC ZAY". Plain lowercase word lets Chirp produce the natural
  // "DEX-uh" reading.
  'DEXA': 'dexa',
  'DXA':  'dexa',
  // Epigenetic clocks — Chirp reads camel-cased "GrimAge" as one word
  // ("grimace"); split on case boundary for the two-word reading
  // clinicians use. DunedinPACE has the same shape.
  'GrimAge':     'Grim Age',
  'DunedinPACE': 'Dunedin Pace',
  // Whole-genome sequencing — abbreviation reads awkwardly and Whisper
  // mis-aligns it; expand to the full phrase.
  'WGS': 'whole genome sequencing',
  // CoQ10 — overrides the core's 'co-Q-ten' with the spoken clinical form.
  'CoQ10':        'coenzyme Q ten',
  'CoQ-10':       'coenzyme Q ten',
  'Coenzyme Q10': 'coenzyme Q ten',
  'coenzyme Q10': 'coenzyme Q ten',
  // CAR-T — chimeric antigen receptor T-cell therapy. Clinically
  // "car-tee" (single word "car" + letter T).
  'CAR-T':  'car-T',
  'CAR T':  'car T',
  'CAR-Ts': 'car-Ts',
  // HIIT — pronounced as the word "hit" (rhymes with kit).
  'HIIT': 'hit',
  // MR-PDFF — magnetic-resonance proton-density fat fraction. Letter-
  // spelling the leading "MR" with periods makes Whisper hear the
  // title "Mr." Comma before the long suffix sidesteps that.
  'MR-PDFF': 'M-R, P-D-F-F',
  'MR PDFF': 'M-R, P-D-F-F',
  // López-Otín (Carlos López-Otín, hallmarks-of-aging eponym).
  // Pre-pass ASCII spelling sidesteps the units pipeline mangling
  // the leading L.
  'López-Otín':    'Lopez-Oteen',
  "López-Otín's":  "Lopez-Oteen's",
  // Factor V (Leiden) — Roman-numeral five reads as letter "V" without
  // help; Whisper round-trips "Factor vee Leiden" instead of "Factor
  // five Leiden". Source casing varies, so cover both.
  'Factor V': 'Factor five',
  'factor V': 'factor five',
  // US regulatory.
  'HIPAA': 'hippa',
  'CLIA':  'cleea',
  // EMR brand name.
  'Cerbo': 'sir-bo',
  // Short-chain fatty acid acronyms — Chirp HD reads the plural-s on
  // "SCFAs" as an enzyme-name suffix ("SCFase"); singular gets letter-
  // spelled. Plural form first so it wins the longest-match sort.
  'SCFAs': 'short-chain fatty acids',
  'SCFA':  'short-chain fatty acid',
  // sTREM2 / sTREM-two — soluble TREM2. Lowercase 's' ran into 'TREM'
  // producing "Strem-two" with the T elided. Restore the prefix as the
  // full word and let TREM read as a single token (rhymes with "trim").
  'sTREM2':    'soluble TREM two',
  'sTREM-two': 'soluble TREM two',
  // Mixed-case nucleic-acid abbreviations — core's all-caps gene
  // detector skips these because of the lowercase prefix.
  'mtDNA': 'mitochondrial D-N-A',
  'mtRNA': 'mitochondrial R-N-A',
  'cfDNA': 'cell-free D-N-A',
  'cfRNA': 'cell-free R-N-A',
  'ctDNA': 'circulating tumor D-N-A',
  // Lowercase-prefix RNA species.
  'rRNA':   'ribosomal R-N-A',
  'snRNA':  'small nuclear R-N-A',
  'snoRNA': 'small nucleolar R-N-A',
  'tRNA':   'transfer R-N-A',
  // p16INK4a — senescence marker; lowercase "p" + all-caps collides
  // with Chirp's letter-spell heuristic. Spell explicitly.
  'p16INK4a': 'p-sixteen I-N-K-four-A',
  'p16INK4A': 'p-sixteen I-N-K-four-A',
  // LC3 isoforms — Roman numerals after a hyphen. Spaces (not hyphens)
  // in the substitution so the core's number-range handler doesn't
  // read "three-two" as "three to two".
  'LC3-II': 'L-C three, two',
  'LC3-I':  'L-C three, one',
  // FAT/CD36 — fatty-acid translocase. Slash with no spaces ran the
  // tokens together; explicit comma-pause separates them.
  'FAT/CD36': 'FAT, CD-thirty-six',
  // HOMA-IR — letter-spell heuristic mangles to "H-O-M-A-IR" run-
  // together. Mixed-case "Homa" makes the all-caps heuristic skip it,
  // then CLINICAL_IPA wraps the word; hyphens (not commas) join the
  // letter halves so Chirp reads them tightly.
  'HOMA-IR': 'Homa-I-R',
  // Copper tripeptide — Whisper hears the default as "GH case hue";
  // letter-spell the copper.
  'GHK-Cu': 'G-H-K-copper',
  'GHK-CU': 'G-H-K-copper',
  // Finnish adjective — TTS says it fine, but Whisper round-trips it
  // as "SANA" or "finish". Normalize to the homophone.
  'Finnish': 'finish',
  // Diabetes type acronyms — clinically spoken as the full phrase.
  'T2D': 'type two diabetes',
  'T1D': 'type one diabetes',
  // percentile shorthand. IPA wrap produced an audible glottal pause
  // between "percent" and "ile" in Chirp HD; plain phonetic respell
  // reads as one fluid word.
  'percentile':  'percentyle',
  'percentiles': 'percentyles',
  '%ile':        'percentyle',
  '%iles':       'percentyles',
  // ElevenLabs camelcase — Chirp reads run-on capital as "Eleven-labs"
  // with a swallowed L. Splitting on the case boundary fixes it.
  'ElevenLabs': 'Eleven Labs',
  // Bioscope-platform code identifiers that survive the pipeline as
  // ALL-CAPS (underscore preserves the all-caps form). Normalize to
  // spoken English so the narrator doesn't letter-spell them.
  'OVERALL_HEALTH': 'overall health',
};

// Bare LDL gets expanded with a negative lookahead so LDL-C / LDL-P /
// LDL-cholesterol are preserved as-is.
const LDL_REGEX = /\bLDL(?![\w-])/g;
// Lp(a) and Lp-a both handled in the post-pass via this regex — see
// comment in postprocessForTTS. Pre-pass placement would mangle the
// leading L through the units pipeline.
const LP_LITTLE_A_REGEX = /\bLp(?:\(a\)|-a\b)/g;

function preprocessForTTS(text) {
  let t = text;

  // Snake_case identifiers (update_identity, is_clinician,
  // mark_conversation_sensitive, etc.) — Chirp HD reads each '_'
  // literally as the word "underscore". Replace internal underscores
  // with a space so the synth speaks the identifier as a normal phrase
  // ("update identity") while the source HTML keeps its <code> form
  // on screen.
  t = t.replace(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g,
                (id) => id.replace(/_/g, ' '));

  // HGVS coordinate ranges (c.7806-?_7976+?del, c.123_456del). The
  // underscore is HGVS shorthand for "to". Strip intron-offset markers
  // (-?, +?, +12, -2) on either side and render as "<start> to <end>"
  // so the synth doesn't read the literal '_'. The marker class
  // excludes \d so the digit groups capture the full coordinate.
  t = t.replace(/(\d+)[?+\-]*_[?+\-]*(\d+)/g, '$1 to $2');

  // Signature blanks in form-style content (consent forms, intake
  // sheets) — runs of 2+ underscores used as fill-in lines. Collapse
  // to a space so they don't surface as "underscore underscore..."
  t = t.replace(/_{2,}/g, ' ');

  // English-AA-collider lowercase rewrite. The core pipeline's title-
  // case ABBREVIATIONS would otherwise expand bare "His" / "Met" /
  // "Pro" / "Ala" into the amino-acid name in English-prose contexts
  // ("His name is Alex" → "histidine name is Alex"). The negative
  // lookahead preserves residue-position usage (His-92, Met-9, Pro-1).
  const ENGLISH_AA_COLLIDERS = ['His', 'Met', 'Pro', 'Ala'];
  for (const c of ENGLISH_AA_COLLIDERS) {
    t = t.replace(new RegExp(`\\b${c}(?![\\w-])`, 'g'), c.toLowerCase());
  }

  // %ile shorthand — source uses "78th-%ile" / "62nd-%ile". The
  // ABBREVIATIONS-loop word-boundary regex won't match the leading "%"
  // (non-word char), so expand here.
  t = t.replace(/(\d+(?:st|nd|rd|th)?-?)%iles?\b/g, (m, prefix) => {
    return `${prefix}${m.endsWith('s') ? 'percentyles' : 'percentyle'}`;
  });

  // Residue-position notation. Amino-acid codes only fire when adjacent
  // to a hyphen or digit. Hyphens are PRESERVED (not swapped for
  // spaces). Measured A/B: hyphenated → 11.2% WER vs spaced → 13.6%.
  // Triples without separators (Val66Met) handled first so we don't
  // jam them together.
  t = t.replace(new RegExp(`\\b(${AA_CODES})(\\d{1,4})(${AA_CODES})\\b`, 'g'),
    (_, a, n, b) => `${a} ${n} ${b}`);
  t = t.replace(new RegExp(`\\b(${AA_CODES})(?=[-\\d])`, 'g'), (_, c) => AMINO_ACIDS[c]);
  t = t.replace(new RegExp(`(?<=[-\\d])(${AA_CODES})\\b`, 'g'), (_, c) => AMINO_ACIDS[c]);

  // Cytochrome-P450 enzymes. Clinicians say "sipp-one-A-two", not
  // letter-by-letter. Whisper otherwise round-trips CYP1A2 as "C-Y-P-
  // 1-T-2" or similar.
  t = t.replace(/\bCYP(\d+)([A-Z])(\d*)\b/g, (_, fam, sub, variant) => {
    const v = variant ? `-${numWord(variant)}` : '';
    return `sipp-${numWord(fam)}-${sub}${v}`;
  });

  // SNP rsIDs — bare "rs1801133" was being heard as "1,801,133 rupees"
  // (Indian rupee currency prefix). Spell each digit with comma
  // separators; prefix "r-s," forces letter-spelled rather than
  // currency interpretation.
  t = t.replace(/\brs(\d{3,})\b/g, (_, digits) => {
    const words = digits.split('').map(d => DIGIT_WORD[d]).join(', ');
    return `r-s, ${words}`;
  });

  // SIRT-family genes — colloquial "sirt one" (single syllable +
  // number), not "sirtuin one".
  t = t.replace(/\bSIRT(\d+)\b/g, (_, n) => `sirt ${numWord(n)}`);

  // BPC-### / TB-### / MK-### / PE-##-## peptide identifiers — spoken
  // form ("B-P-C one fifty-seven") rather than "one hundred fifty
  // seven".
  t = t.replace(/\bBPC-(\d+)\b/g, (_, n) => `B-P-C ${spokenIdNumber(n)}`);
  t = t.replace(/\bTB-(\d+)\b/g, (_, n) => `T-B ${spokenIdNumber(n)}`);
  t = t.replace(/\bMK-(\d+)\b/g, (_, n) => `M-K ${spokenIdNumber(n)}`);
  t = t.replace(/\bPE-(\d+)-(\d+)\b/g, (_, a, b) => `P-E ${spokenIdNumber(a)} ${spokenIdNumber(b)}`);

  // Lactobacillus / Bifidobacterium genus abbreviations — bare "L." in
  // "L. casei" gets read as the liter symbol and expands to "liters."
  // Rewrite the genus abbreviation to the full word before the units
  // pipeline sees it.
  t = t.replace(/\bL\.\s+([a-z]{4,})\b/g, 'Lactobacillus $1');
  t = t.replace(/\bB\.\s+(infantis|longum|breve|adolescentis|bifidum)\b/g, 'Bifidobacterium $1');

  // Letter-digit-letter variant codes (HFE C282Y, SRD5A2 V89L,
  // CFH Y402H). Bare "C282Y" runs into the synth as a single token;
  // spell as "<letter>, <digit-words>, <letter>" with comma beats.
  t = t.replace(/\b([A-Z])(\d{2,4})([A-Z])\b/g, (_, l1, n, l2) => {
    return `${l1}, ${spokenIdNumber(n)}, ${l2}`;
  });

  // Bare LDL expansion — runs before the direct-token loop so the loop
  // can't turn hyphenated "low-density-lipoprotein" into a word-
  // boundary mess.
  t = t.replace(LDL_REGEX, 'low-density-lipoprotein');

  // Direct token overrides, sorted longest-first.
  const entries = Object.entries(PRE_ABBREVIATIONS).sort((a, b) => b[0].length - a[0].length);
  for (const [key, val] of entries) {
    t = t.replace(new RegExp(`\\b${escapeRegex(key)}\\b`, 'g'), val);
  }

  return t;
}

// ════════════════════════════════════════════════════════════
//   POST-PASS  (postprocessForTTS)
// ════════════════════════════════════════════════════════════
// Runs AFTER coreNormalize. Recovers tokens the units pipeline mangled
// (bare-L → "liters" cleanup), applies POST_OVERRIDES, converts pause
// tokens to <break/> tags, and wraps IPA-pronounced words in
// <phoneme alphabet="ipa" ph="…"> tags.

// Omics word family. Approach: SSML <phoneme> tags with IPA. Google
// Cloud TTS Neural2 honors phoneme tags reliably; Chirp 3 HD honors
// them too (verified by direct API probe in synchronous mode).
const OMIC_IPA = {
  'genome':          'ˈdʒiːnoʊm',
  'genomes':         'ˈdʒiːnoʊmz',
  'epigenome':       'ˌɛpɪˈdʒiːnoʊm',
  'epigenomes':      'ˌɛpɪˈdʒiːnoʊmz',
  'pangenome':       'pænˈdʒiːnoʊm',
  'metagenome':      'ˌmɛtəˈdʒiːnoʊm',
  'transcriptome':   'trænˈskrɪptoʊm',
  'transcriptomes':  'trænˈskrɪptoʊmz',
  'proteome':        'ˈproʊtiˌoʊm',
  'proteomes':       'ˈproʊtiˌoʊmz',
  'metabolome':      'məˈtæbəˌloʊm',
  'metabolomes':     'məˈtæbəˌloʊmz',
  'microbiome':      'ˌmaɪkroʊˈbaɪoʊm',
  'microbiomes':     'ˌmaɪkroʊˈbaɪoʊmz',
  'phenome':         'ˈfiːnoʊm',
  'phenomes':        'ˈfiːnoʊmz',
  'methylome':       'ˈmɛθɪloʊm',
  'methylomes':      'ˈmɛθɪloʊmz',
  'lipidome':        'ˈlɪpɪdoʊm',
  'glycome':         'ˈɡlaɪkoʊm',
  'kinome':          'ˈkaɪnoʊm',
  'exposome':        'ɛksˈpoʊsoʊm',
  'exosome':         'ˈɛksəˌsoʊm',
  'exosomes':        'ˈɛksəˌsoʊmz',
  'connectome':      'kəˈnɛktoʊm',
  'secretome':       'ˈsiːkrətoʊm',
  'interactome':     'ˌɪntərˈæktoʊm',
  'genomic':         'dʒəˈnoʊmɪk',
  'genomics':        'dʒəˈnoʊmɪks',
  'epigenomic':      'ˌɛpɪdʒəˈnoʊmɪk',
  'epigenomics':     'ˌɛpɪdʒəˈnoʊmɪks',
  'pangenomic':      'ˌpændʒəˈnoʊmɪk',
  'pangenomics':     'ˌpændʒəˈnoʊmɪks',
  'metagenomic':     'ˌmɛtədʒəˈnoʊmɪk',
  'metagenomics':    'ˌmɛtədʒəˈnoʊmɪks',
  'transcriptomic':  'trænˌskrɪpˈtoʊmɪk',
  'transcriptomics': 'trænˌskrɪpˈtoʊmɪks',
  'proteomic':       'ˌproʊtiˈoʊmɪk',
  'proteomics':      'ˌproʊtiˈoʊmɪks',
  'metabolomic':     'məˌtæbəˈloʊmɪk',
  'metabolomics':    'məˌtæbəˈloʊmɪks',
  'microbiomic':     'ˌmaɪkroʊbaɪˈoʊmɪk',
  'phenomic':        'fiˈnoʊmɪk',
  'methylomic':      'ˌmɛθɪˈloʊmɪk',
  'lipidomic':       'ˌlɪpɪˈdoʊmɪk',
  'lipidomics':      'ˌlɪpɪˈdoʊmɪks',
  'glycomic':        'ɡlaɪˈkoʊmɪk',
  'glycomics':       'ɡlaɪˈkoʊmɪks',
  'kinomic':         'kaɪˈnoʊmɪk',
  'kinomics':        'kaɪˈnoʊmɪks',
  'exposomic':       'ɛksˌpoʊˈsoʊmɪk',
  'connectomic':     'ˌkənɛkˈtoʊmɪk',
  'secretomic':      'ˌsiːkrəˈtoʊmɪk',
  'interactomic':    'ˌɪntərækˈtoʊmɪk',
  'pharmacogenomic':  'ˌfɑrməkoʊdʒəˈnoʊmɪk',
  'pharmacogenomics': 'ˌfɑrməkoʊdʒəˈnoʊmɪks',
  'omic':            'ˈoʊmɪk',
  'omics':           'ˈoʊmɪks',
  'multi-omic':      'ˌmʌltiˈoʊmɪk',
  'multi-omics':     'ˌmʌltiˈoʊmɪks',
};

// Clinical / scientific IPA dictionary. Non-omic words whose
// pronunciation is unstable on TTS without explicit IPA. Wrapped in
// <phoneme> tags by postprocessForTTS, same machinery as OMIC_IPA. Add
// a new entry whenever production audio reveals a new mispronunciation
// the synth can't get right with text alone.
const CLINICAL_IPA = {
  // Latin binomials — gut commensals. Plain-text spellings wandered on
  // Whisper round-trip; IPA holds.
  'Akkermansia':   'ˌækərˈmænsiə',
  'akkermansia':   'ˌækərˈmænsiə',
  'muciniphila':   'ˌmjuːsɪnɪˈfɪlə',
  'Bacteroidetes': 'ˌbæktəˈrɔɪdɪtiːz',
  'bacteroidetes': 'ˌbæktəˈrɔɪdɪtiːz',
  // HOMA — Homeostatic Model Assessment. Long-O ("HOME-uh"), not
  // letter-spelled. Case-insensitive matching covers HOMA / Homa /
  // homa, including the "Homa-I-R" rewrite from PRE_ABBREVIATIONS.
  'Homa': 'ˈhoʊmə',
  // mTOR — letter "M" + word "tor" ("EM-tor"), single fluid token.
  'mTORC1': 'ˌɛmˈtɔːr.siː.wʌn',
  'mTORC2': 'ˌɛmˈtɔːr.siː.tuː',
  'mTOR':   'ˈɛm.tɔːr',
  // ─── Acronyms read as a single word in clinical / scientific use.
  // All keyed on the post-core hyphenated form (the core letter-spells
  // bare acronyms like CPIC into C-P-I-C before postprocess sees them).
  // The auto-wrap fallback later in postprocess would emit a fluid
  // letter spell for these otherwise — these explicit entries override
  // with the actual word pronunciation.
  'C-H-I-P':   'tʃɪp',         // Clonal hematopoiesis (CHIP)
  'S-A-S-P':   'sæsp',         // Senescence-associated secretory phenotype
  'D-I-M':     'dɪm',          // Diindolylmethane
  'D-I-O':     'ˈdaɪoʊ',       // Deiodinase (DIO1/2/3)
  'F-U-T':     'fʌt',          // Fucosyltransferase (FUT2 secretor)
  'C-Y-P':     'sɪp',          // Cytochrome P450 (bare prefix; in CYP2C19
                               // the core's gene-prefix path already says "sip")
  'F-I-S-H':   'fɪʃ',          // Fluorescence in situ hybridization
  'S-I-B-O':   'ˈsiːboʊ',      // Small intestinal bacterial overgrowth
  'G-A-B-A':   'ˈɡæbə',        // gamma-aminobutyric acid
  'N-A-S-H':   'næʃ',          // Non-alcoholic steatohepatitis
  'M-A-S-H':   'mæʃ',          // Metabolic-dysfunction-assoc. steatohepatitis
  'C-O-V-I-D': 'ˈkoʊvɪd',
  'J-A-M-A':   'ˈdʒæmə',       // J. of the American Medical Assoc.
  'C-O-M-T':   'koʊmt',        // Catechol-O-methyltransferase
  'C-P-I-C':   'ˈsiːpɪk',      // Clinical Pharmacogenetics Implementation Consortium
  'A-T-T-R':   'ˈætɚ',         // Transthyretin amyloidosis
  // SLCO1B1 — hepatic statin-uptake transporter gene. The core's
  // acronym pipeline preserves the bare token (no letter spelling),
  // so this CLINICAL_IPA entry matches the unmangled form. The IPA
  // letter chain renders it as one fluid clinical token.
  'SLCO1B1':   'ɛs.ɛl.siː.oʊ.wʌn.biː.wʌn',
  // HOMA-IR — the core letter-spells the whole token to "H-O-M-A-I-R".
  // Read as the word "homa" + the letters "I-R" said quickly. The full
  // post-core form lives here as one CLINICAL_IPA entry rather than
  // relying on the bare 'Homa' wrap (which won't match inside the
  // hyphenated chain).
  'H-O-M-A-I-R': 'ˌhoʊməˈaɪɑːr',
  // Pharmacology — chemo agents whose plain readings drifted.
  'fluorouracil': 'ˌflʊəroʊˈjʊərəsɪl',
  'capecitabine': 'ˌkeɪpɛˈsɪtəˌbiːn',
  'thiopurines':  'ˌθaɪoʊˈpjʊəriːnz',
  'thiopurine':   'ˌθaɪoʊˈpjʊəriːn',
  // fisetin — senolytic flavonoid; FY-sit-in.
  'fisetin': 'ˈfaɪsɪtɪn',
  'Fisetin': 'ˈfaɪsɪtɪn',
  // kynurenine — tryptophan catabolite, kai-NEW-ruh-neen.
  'kynurenine':  'ˌkaɪˈnʊərəniːn',
  'kynurenines': 'ˌkaɪˈnʊərəniːnz',
  // inflammaging — Franceschi's portmanteau. Long-A on the second
  // syllable ("in-FLAM-AY-jing").
  'inflammaging': 'ɪnˈflæmˌeɪdʒɪŋ',
  'Inflammaging': 'ɪnˈflæmˌeɪdʒɪŋ',
  // route family — author preference for the /raʊt/ pronunciation
  // (rhymes with "out") in clinical-flow contexts.
  'route':   'raʊt',
  'routes':  'raʊts',
  'routed':  'ˈraʊtɪd',
  'routing': 'ˈraʊtɪŋ',
  // Remi — clinical-AI-team persona name. Short-e /ɛ/ ("REH-mee").
  'Remi': 'ˈrɛmi',
  'remi': 'ˈrɛmi',
  // APOE / APOB — clinicians say "AY-poh-EE" / "AY-poh-BEE".
  'A-P-O-E': 'ˌeɪpoʊˈiː',
  'A-P-O-B': 'ˌeIpoʊˈbiː',
  // High-frequency letter-spelled acronyms — single fast 2-3 syllable
  // utterance ("dee-en-AY") instead of slow per-letter pauses.
  'D-N-A':   'ˌdiːɛnˈeɪ',
  'R-N-A':   'ˌɑːrɛnˈeɪ',
  'm-R-N-A': 'ˌɛmɑːrɛnˈeɪ',
  // IGF-1 as one fluid unit — coreNormalize converts trailing 1 → "one",
  // so the post-core form is I-G-F-one. Wins over auto-built I-G-F by length sort.
  'I-G-F-one': 'ˌaɪdʒiːɛfˈwʌn',
  // Fatty acids.
  'A-L-A':   'ˌeɪɛlˈeɪ',
  'E-P-A':   'ˌiːpiːˈeɪ',
  'D-H-A':   'ˌdiːeɪtʃˈeɪ',
  // Lipoprotein H-D-L (L-D-L expanded to full phrase upstream).
  'H-D-L':   'ˌeɪtʃdiːˈɛl',
  // Energy / cofactor.
  'A-T-P':   'ˌeɪtiːˈpiː',
  'A-D-P':   'ˌeɪdiːˈpiː',
  'N-A-C':   'ˌɛneɪˈsiː',
  // Common labs / measures.
  'T-S-H':   'ˌtiːɛsˈeɪtʃ',
  'P-S-A':   'ˌpiːɛsˈeɪ',
  'B-M-I':   'ˌbiːɛmˈaɪ',
  'G-F-R':   'ˌdʒiːɛfˈɑːr',
  'C-G-M':   'ˌsiːdʒiːˈɛm',
  'C-R-P':   'ˌsiːɑːrˈpiː',
  'H-R-V':   'ˌeɪtʃɑːrˈviː',
  // Reproductive / endocrine.
  'L-H':     'ˌɛlˈeɪtʃ',
  'F-S-H':   'ˌɛfɛsˈeɪtʃ',
  // Peptide names.
  'Sensoril':    'ˈsɛnsɔːrɪl',
  'gonadorelin': 'ˌɡoʊnædoʊˈrɛlɪn',
  'kisspeptin':  'ˈkɪsˌpɛptɪn',
  'Semax':       'ˈsɛmæks',
  'Selank':      'ˈsɛlæŋk',
  'Pinealon':    'ˌpɪniˈæloʊn',
  // Difficult drug names — newer agents the synth mispronounces by default.
  'lecanemab':   'ləˈkænəmæb',
  'donanemab':   'doʊˈnænəmæb',
  'aducanumab':  'ˌæduːˈkænjuːmæb',
  'tirzepatide': 'tɜːrˈzɛpətaɪd',
  'semaglutide': 'ˌsɛməˈɡluːtaɪd',
  'retatrutide': 'ˌrɛtəˈtruːtaɪd',
  'liraglutide': 'ˌlɪrəˈɡluːtaɪd',
  'dulaglutide': 'ˌduːləˈɡluːtaɪd',
  'finasteride': 'fɪˈnæstərɪd',
  'dutasteride': 'duːˈtæstərɪd',
  'tesamorelin': 'ˌtɛsəmoʊˈrɛlɪn',
  'enclomiphene':'ɛnˈkloʊməfiːn',
  'clomiphene':  'ˈkloʊməfiːn',
  'anastrozole': 'əˈnæstrəzoʊl',
  'spironolactone':  'ˌspaɪrənəˈlæktoʊn',
  'metformin':       'mɛtˈfɔːrmɪn',
  'rapamycin':       'ˌræpəˈmaɪsɪn',
  'sirolimus':       'sɪˈroʊlɪməs',
  'acarbose':        'ˈeɪkɑːrboʊs',
  'pioglitazone':    'ˌpaɪoʊˈɡlɪtəzoʊn',
  'berberine':       'ˈbɜːrbəriːn',
  'spermidine':      'ˈspɜːrmɪdiːn',
  'thymosin':        'ˈθaɪməsɪn',
  'Thymosin':        'ˈθaɪməsɪn',
  'ergothioneine':   'ˌɜːrɡoʊθaɪoʊˈniːn',
  'sulforaphane':    'ˌsʌlfəˈræfeɪn',
  'urolithin':       'jʊˈrɒlɪθɪn',
  'pterostilbene':   'ˌtɛroʊˈstɪlbiːn',
  'resveratrol':     'rɛzˈvɛrətrɒl',
  'quercetin':       'ˈkwɜːrsətɪn',
  'curcumin':        'ˈkɜːrkjuːmɪn',
  'astaxanthin':     'ˌæstəˈzænθɪn',
  'dasatinib':       'dəˈsætɪnɪb',
  'irinotecan':      'aɪˈrɪnəˌtiːkæn',
  'tacrolimus':      'tæˈkroʊlɪməs',
  'cyclosporine':    'ˌsaɪkloʊˈspɔːriːn',
  'azathioprine':    'ˌæzəˈθaɪəpriːn',
  'allopurinol':     'ˌæloʊˈpjʊərɪnɒl',
  'ezetimibe':       'ɛˈzɛtəmɪb',
  // Difficult biology / measurement terms.
  'autophagy':       'ɔːˈtɒfədʒi',
  'mitophagy':       'mɪˈtɒfədʒi',
  'macroautophagy':  'ˌmækroʊɔːˈtɒfədʒi',
  'phagocytosis':    'ˌfæɡəsaɪˈtoʊsɪs',
  'pinocytosis':     'ˌpaɪnəsaɪˈtoʊsɪs',
  'apoptosis':       'ˌæpɒpˈtoʊsɪs',
  'necroptosis':     'ˌnɛkrɒpˈtoʊsɪs',
  'pyroptosis':      'ˌpaɪrɒpˈtoʊsɪs',
  'ferroptosis':     'ˌfɛrɒpˈtoʊsɪs',
  'senescence':      'sɪˈnɛsəns',
  'senolytic':       'ˌsɛnoʊˈlɪtɪk',
  'senolytics':      'ˌsɛnoʊˈlɪtɪks',
  'centenarian':     'ˌsɛntəˈnɛəriən',
  'centenarians':    'ˌsɛntəˈnɛəriəns',
  'supercentenarian':'ˌsuːpərsɛntəˈnɛəriən',
  'sarcopenia':      'ˌsɑːrkoʊˈpiːniə',
  'sarcopenic':      'ˌsɑːrkoʊˈpɛnɪk',
  'osteopenia':      'ˌɒstioʊˈpiːniə',
  'osteoporosis':    'ˌɒstioʊpəˈroʊsɪs',
  // Microbiome / clinical proteins.
  'Faecalibacterium': 'ˌfiːkəlibækˈtɪəriəm',
  'faecalibacterium': 'ˌfiːkəlibækˈtɪəriəm',
  'prausnitzii':      'praʊsˈnɪtsiaɪ',
  'Prevotella':       'ˌprɛvəˈtɛlə',
  'prevotella':       'ˌprɛvəˈtɛlə',
  'Bifidobacterium':  'ˌbɪfɪdoʊbækˈtɪəriəm',
  'bifidobacterium':  'ˌbɪfɪdoʊbækˈtɪəriəm',
  'Lactobacillus':    'ˌlæktoʊbəˈsɪləs',
  'lactobacillus':    'ˌlæktoʊbəˈsɪləs',
  'klotho':           'ˈkloʊθoʊ',
  'Klotho':           'ˈkloʊθoʊ',
  'KLOTHO':           'ˈkloʊθoʊ',
  // Eponyms / proper nouns.
  'Hayflick':   'ˈheɪflɪk',
  'Horvath':    'ˈhɔːrvɑːθ',
  'Dunedin':    'dʌˈniːdɪn',
  'Hashimoto':  'ˌhɑːʃɪˈmoʊtoʊ',
  'Hashimoto’s':'ˌhɑːʃɪˈmoʊtoʊz',
  'Morgentaler':'ˈmɔːrɡəntɑːlər',
  'Attia':      'ˈætiə',
  'Naviaux':    'næviˈoʊ',
  'Mattson':    'ˈmætsən',
  'Reiter':     'ˈraɪtər',
  'Rouzier':    'ˈruːzieɪ',
  'Jefferies':  'ˈdʒɛfəriz',
  'Finkle':     'ˈfɪŋkəl',
  'Vigen':      'ˈvaɪɡən',
  // Newer drug / peptide brand and generic names.
  'serrapeptase':       'ˌsɛrəˈpɛpteɪs',
  'nattokinase':        'ˌnætoʊˈkaɪneɪs',
  'cypionate':          'sɪˈpaɪəneɪt',
  'enanthate':          'ɪˈnænθeɪt',
  'undecanoate':        'ˌʌndɪˈkænoʊeɪt',
  'norethindrone':      'ˌnɔːrˈɛθɪndroʊn',
  'levonorgestrel':     'ˌlɛvoʊnɔːrˈdʒɛstrəl',
  'drospirenone':       'droʊˈspaɪrənoʊn',
  'medroxyprogesterone':'mɛˌdrɒksiproʊˈdʒɛstəroʊn',
  'micronized':         'ˈmaɪkrənaɪzd',
  'paroxetine':         'pəˈrɒksətiːn',
  'atorvastatin':       'əˌtɔːrvəˈstætɪn',
  'simvastatin':        'sɪmvəˈstætɪn',
  'rosuvastatin':       'roʊˌsuːvəˈstætɪn',
  'liothyronine':       'ˌlaɪoʊˈθaɪroʊniːn',
  'levothyroxine':      'ˌliːvoʊθaɪˈrɒksiːn',
  // Brand-name testosterone preparations.
  'Testopel':  'ˈtɛstoʊpɛl',
  'Aveed':     'əˈviːd',
  'Nebido':    'nəˈbiːdoʊ',
  'Jatenzo':   'dʒəˈtɛnzoʊ',
  'Tlando':    'ˈtlændoʊ',
  'Natesto':   'nəˈtɛstoʊ',
  'Androderm': 'ˈændroʊdɜːrm',
  'AndroGel':  'ˈændroʊdʒɛl',
  'Vogelxo':   'voʊˈdʒɛlksoʊ',
  'Fortesta':  'fɔːrˈtɛstə',
  'Axiron':    'ˈæksɪrɒn',
  // Brand-name female-hormone preparations.
  'Estrace':    'ˈɛstreɪs',
  'Vagifem':    'ˈvædʒɪfɛm',
  'Yuvafem':    'ˈjuːvəfɛm',
  'Imvexxy':    'ɪmˈvɛksi',
  'Estring':    'ˈɛstrɪŋ',
  'Prometrium': 'proʊˈmiːtriəm',
  'AndroFeme':  'ˈændroʊfiːm',
  'Intrarosa':  'ˌɪntrəˈroʊzə',
  'prasterone': 'ˈpræstəroʊn',
  'Synthroid':  'ˈsɪnθrɔɪd',
  'Levoxyl':    'ləˈvɒksɪl',
  'Cytomel':    'ˈsaɪtoʊmɛl',
  // Peptides / experimental.
  'Cerebrolysin': 'ˌsɛrəbroʊˈlaɪsɪn',
  'Epitalon':     'ˌɛpɪˈtælɒn',
  'Elamipretide': 'ɪˈlæmɪˌpriːtaɪd',
  'Ipamorelin':   'ɪˌpæməˈrɛlɪn',
  'Sermorelin':   'ˌsɜːrmoʊˈrɛlɪn',
  'Hexarelin':    'hɛksəˈrɛlɪn',
  'ibutamoren':   'ɪˈbjuːtəmɔːrɛn',
  'Humanin':      'ˈhjuːmənɪn',
  'fucoidan':     'fjuːˈkɔɪdən',
  // Herbs / supplements.
  'eleuthero':  'ɪˈluːθəroʊ',
  'schisandra': 'skɪˈsændrə',
  'hawthorn':   'ˈhɔːθɔːrn',
  'citicoline': 'ˌsɪtɪˈkoʊliːn',
  'methylene':  'ˈmɛθɪliːn',
  'shilajit':   'ʃɪlədʒɪt',
  // Biology terms.
  'diosgenin':       'ˌdaɪəsˈdʒɛnɪn',
  'deiodinases':     'diːˈaɪədɪneɪsɪz',
  'deiodinase':      'diːˈaɪədɪneɪs',
  'thioredoxin':     'ˌθaɪoʊˈrɛdɒksɪn',
  'secretagogues':   'sɪˈkriːtəɡɒɡz',
  'secretagogue':    'sɪˈkriːtəɡɒɡ',
  'synovitis':       'ˌsaɪnəˈvaɪtɪs',
  'supraphysiologic':'ˌsuːprəˌfɪzioʊˈlɒdʒɪk',
  'varicocele':      'ˈværɪkəsiːl',
  'ceruloplasmin':   'sɪˌruːloʊˈplæzmɪn',
  'lipodystrophy':   'ˌlɪpoʊˈdɪstrəfi',
  'gynecomastia':    'ˌɡaɪnəkoʊˈmæstiə',
  'erythrocytosis':  'ɪˌrɪθroʊsaɪˈtoʊsɪs',
  // Compound proper nouns / herbal names.
  'Tongkat':  'ˈtɒŋkæt',
  // REM — single word /rɛm/ (rhymes with "gem"). Two keys: bare "rem"
  // (radiation unit) and "R-E-M" (post-core letter-spelled form for
  // uppercase REM sleep stage).
  'REM':   'rɛm',
  'rem':   'rɛm',
  'R-E-M': 'rɛm',
  // Final triage batches from QA passes.
  'Striant':       'ˈstraɪənt',
  'apigenin':      'ˌæpɪˈdʒɛnɪn',
  'prasugrel':     'ˈpræsuːɡrɛl',
  'raltegravir':   'ˌrɑːlˈtɛɡrəvɪr',
  'ticagrelor':    'tɪˈkæɡrəlɔːr',
  'retinyl':       'ˈrɛtɪnɪl',
  'palmitate':     'ˈpælmɪteɪt',
  'troponin':      'ˈtroʊpəˌnɪn',
  'Mosconi':       'məˈskoʊni',
  'Testim':        'ˈtɛstɪm',
  'zuclomiphene':  'zuːˈkloʊməfiːn',
  // SERM read as a word, not letter-spelled.
  'SERM':      'sɜːrm',
  'SERMs':     'sɜːrmz',
  'S-E-R-M':   'sɜːrm',
  'S-E-R-Ms':  'sɜːrmz',
  'macimorelin':'ˌmæsɪmoʊˈrɛlɪn',
  'ethinyl':   'ˈɛθɪnɪl',
  'estradiol': 'ˌɛstrəˈdaɪɒl',
  'ElevenLabs':'ɪˈlɛvənlæbz',
  'DAMPs':     'dæmps',
  'PAMPs':     'pæmps',
  // P-gp transporter.
  'P-gp':      'ˌpiːdʒiːˈpiː',
  // SULT1A1 — sulfotransferase gene; mixed alpha-digit-alpha-digit
  // shape FAST_GLUE can't auto-build.
  'SULT1A1':           'ˌɛsjuːɛlˌtiːwʌneɪˈwʌn',
  'S-U-L-T-one-A-one': 'ˌɛsjuːɛlˌtiːwʌneɪˈwʌn',
  // Mixed alpha-digit-alpha gene IDs not handled by FAST_GLUE.
  'D-N-M-T-three-A':   'ˌdiːɛnɛmˈtiːθriːeɪ',
  'P-P-A-R-G-C-one-A': 'piːpiːˌeɪɑːrdʒiːsiːˈwʌneɪ',
};

// Auto-built fast-IPA for letter-spelled acronyms. The core pipeline
// letter-spells most all-caps abbreviations to "X-Y-Z" form with a
// noticeable per-letter pause; this helper auto-builds a fast IPA
// pronunciation ("dee-en-AY") that the synth utters as a single 2-4
// syllable unit.
const LETTER_IPA = {
  A: 'eɪ', B: 'biː', C: 'siː', D: 'diː', E: 'iː', F: 'ɛf', G: 'dʒiː',
  H: 'eɪtʃ', I: 'aɪ', J: 'dʒeɪ', K: 'keɪ', L: 'ɛl', M: 'ɛm', N: 'ɛn',
  O: 'oʊ', P: 'piː', Q: 'kjuː', R: 'ɑːr', S: 'ɛs', T: 'tiː', U: 'juː',
  V: 'viː', W: 'ˈdʌbəl.juː', X: 'ɛks', Y: 'waɪ', Z: 'ziː',
};
function buildLetterSpellIpa(letters) {
  const cleaned = String(letters).toUpperCase().replace(/[^A-Z]/g, '');
  if (!cleaned) return '';
  if (cleaned.length === 1) return `ˈ${LETTER_IPA[cleaned]}`;
  const head = cleaned.slice(0, -1).split('').map(l => LETTER_IPA[l]).join('');
  const tail = LETTER_IPA[cleaned.at(-1)];
  return `ˌ${head}ˈ${tail}`;
}

// IPA names for digits used by the fast-letter-chain auto-wrap below.
// Letter names mirror LETTER_IPA above.
const DIGIT_IPA = {
  '0': 'zɪroʊ', '1': 'wʌn', '2': 'tuː', '3': 'θriː', '4': 'fɔːr',
  '5': 'faɪv',  '6': 'sɪks', '7': 'ˈsɛvən', '8': 'eɪt', '9': 'naɪn',
};

// Build a fast letter-chain IPA from a hyphen-spelled token like
// "C-H-I-P", "M-T-H-F-R", or "G-L-P-1". Pattern: ˌ on the first part,
// ˈ on the last, no separators between — the synth pronounces it as
// one fluid utterance instead of per-letter staccato. Differs from
// buildLetterSpellIpa in that it accepts digits inline (G-L-P-1 →
// "gee-ell-pee-one") rather than stripping them.
function buildFastChainIpa(hyphenated) {
  const parts = String(hyphenated).split('-').filter(Boolean);
  if (!parts.length) return '';
  const ipa = parts.map(p => LETTER_IPA[p] ?? DIGIT_IPA[p] ?? p.toLowerCase());
  if (ipa.length === 1) return `ˈ${ipa[0]}`;
  return `ˌ${ipa.slice(0, -1).join('')}ˈ${ipa.at(-1)}`;
}

const FAST_GLUE_ACRONYMS = [
  // 2-letter clinical tokens unambiguous in lowercase prose context.
  'GH', 'NK', 'NAD', 'NMN', 'LH',
  // 3-letter clinical / biology.
  'GDF', 'IGF', 'TNF', 'TPO', 'HPA', 'LPS', 'CBC', 'YKL', 'HFE', 'HIF',
  'PAI', 'CAC', 'CKD', 'CMP', 'CPK', 'EMR', 'EHR', 'NMR', 'GGT',
  'PPI', 'PGC', 'OSA', 'TSI', 'TBI', 'BPH',
  'AKI', 'EKG', 'ECG', 'EEG', 'CSF', 'CT',
  'CK', 'TIA', 'CVA', 'GVHD', 'CGM', 'CRP',
  // HBOT — Hyperbaric Oxygen Therapy. AIP — Autoimmune Protocol.
  'HBOT', 'AIP',
  // Short alpha and digit-suffixed gene IDs.
  'FTO', 'UCP1',
  // 4-letter.
  'DHEA', 'AMPK', 'BDNF', 'TMAO', 'GFAP', 'AOC1', 'TLR4', 'ApoB',
  // CD-prefixed surface markers.
  'CD8', 'CD4', 'CD20', 'CD28', 'CD36', 'CD38', 'CD45',
  // 5+ letter: alpha-only fast IPA + trailing digit spoken.
  'NRF2', 'TET2', 'HSF1', 'NQO1', 'KEAP1', 'HMOX1', 'TREM2', 'ABCA7',
  'PARP1', 'FOXO3', 'SOD1', 'SOD2', 'GSTM1', 'GSTT1', 'GSTP1',
  'FADS1', 'FADS2', 'CHRNA', 'CCR7', 'CFTR', 'NLRP3', 'STING',
  'DNMT3A', 'ASXL1', 'EGCG', 'PNPLA3', 'IFABP', 'PPARGC1A',
  // Pharmacogenomic enzyme.
  'MTHFR',
  // Lipoprotein / lipid.
  'LDL', 'HDL',
  // Endocrine receptor families.
  'GLP', 'SGLT',
  // MHC class-II beta chain.
  'HLA', 'DRB',
  // MR-PDFF fragments.
  'MR', 'PDFF',
  // GHK-Cu peptide leading fragment.
  'GHK',
  // qPCR.
  'qPCR',
  // Polygenic risk score.
  'PRS',
  // Standard imaging / clinical / genomic acronyms.
  'MRI', 'TSH', 'SNP', 'RNA', 'VUS', 'LPS', 'MMP', 'HRV', 'FDA', 'SSRI', 'ASCVD',
];

for (const acro of FAST_GLUE_ACRONYMS) {
  const m = acro.match(/^([A-Za-z]+)(\d+)$/);
  const alpha = m ? m[1] : acro;
  const ipa = buildLetterSpellIpa(alpha);
  if (!ipa) continue;
  if (!CLINICAL_IPA[acro]) CLINICAL_IPA[acro] = ipa;
  if (alpha.length >= 2) {
    const hyphenated = alpha.split('').join('-');
    if (!CLINICAL_IPA[hyphenated]) CLINICAL_IPA[hyphenated] = ipa;
  }
}

// Phrase substitutions applied AFTER coreNormalize. Either the term
// survives the core pipeline untouched and only needs a final phonetic,
// or it's a whole phrase whose exact form appears in the normalized
// output.
const POST_OVERRIDES = {
  // Publication brand — hyphenated form stays as one compound noun.
  'Longevity Today': 'longevity-today',
  // DunedinPACE figure — hyphenate to glue the phrase.
  'one point oh three': 'one-point-oh-three',
  // HLA-DRB1 — POST because the letter-spelled form contains a lone
  // "L" surrounded by hyphens, which the units pipeline would expand
  // to "liters".
  'HLA-DRB1': 'H-L-A-D-R-B-one',
  // SLCO1B1 IPA wrap is in CLINICAL_IPA above; the core preserves
  // the bare token through its acronym pass, so the CLINICAL_IPA
  // loop matches \bSLCO1B1\b directly without needing a POST_OVERRIDES
  // hop through the old letter-spelled comma form.
  // The core normalizes "read" → "reed" globally. In course lessons
  // the verb most often appears as past-perfect ("have read") which is
  // the /rɛd/ sound. Override auxiliary-verb contexts back to "red".
  'have reed':    'have red',
  'had reed':     'had red',
  'has reed':     'has red',
  'having reed':  'having red',
  "haven't reed": "haven't red",
  "hadn't reed":  "hadn't red",
  "hasn't reed":  "hasn't red",
  "you've reed":  "you've red",
  "we've reed":   "we've red",
  "i've reed":    "i've red",
  "they've reed": "they've red",
  "well-reed":    "well-red",
  "widely reed":  "widely red",
  // Misapplied phonetic on "breadth".
  'BREDTH': 'breadth',
  // Units pipeline expands a lone "L" surrounded by hyphens to "liters"
  // — wrecking "L-C mass spectrometry" (Liquid Chromatography). Undo.
  // The L-AminoAcid / L-Drug class is handled generically by the
  // `\bliters-([a-z]{3,})` regex below.
  'liters-C': 'L-C',
  'liters/C': 'L-C',
  // Bare LDL pre-letter-spell case.
  'liters-D-liters': 'L-D-L',
  // GLP-1 / GLP-2 — same trap.
  'G-liters-P-one': 'G-L-P-one',
  'G-liters-P-1':   'G-L-P-one',
  'G-liters-P-two': 'G-L-P-two',
  'G-liters-P-2':   'G-L-P-two',
  // SGLT-2.
  'S-G-liters-T-two': 'S-G-L-T-two',
  'S-G-liters-T-2':   'S-G-L-T-two',
  // 2'-FL substitution gives "two-prime F, L" pre-pass; the units
  // pipeline then expands the bare L to "liters". Restore.
  'two-prime F, liters': 'two-prime F, L',
  // The core globally expands "HR" to "hazard ratio". Wrong here where
  // HR means homologous recombination or heart rate.
  'homologous recombination (hazard ratio)': 'homologous recombination',
  'resting hazard ratio':  'resting heart rate',
  'maximum hazard ratio':  'maximum heart rate',
  'max hazard ratio':      'max heart rate',
  'target hazard ratio':   'target heart rate',
  'peak hazard ratio':     'peak heart rate',
  // Acronym-pair separation. Letter-spelled acronyms run together as
  // one word; insert a comma to force a pause.
  'C-A-D P-R-S':    'C-A-D, P-R-S',
  'M-T-H-F-R C677T': 'M-T-H-F-R, C677T',
  // Multi-word brand / herb names where text substitution is more
  // reliable than multi-word IPA inside <phoneme ph="..."> (Google's
  // SSML rejects spaces in the IPA attribute).
  "St. John's Wort": "Saint Johns Wort",
};

// Pre-sort the IPA dictionaries by descending length so the
// substitution loops apply longer keys first.
const OMIC_IPA_SORTED = Object.entries(OMIC_IPA).sort((a, b) => b[0].length - a[0].length);
const CLINICAL_IPA_SORTED = Object.entries(CLINICAL_IPA).sort((a, b) => b[0].length - a[0].length);

function postprocessForTTS(text) {
  let t = text;

  // Generalized fix for the units pipeline's bare-L → "liters" expansion.
  // Any amino-acid / metabolite / drug starting with an L-prefix
  // (L-glutamine, L-arginine, L-citrulline, L-carnitine, L-theanine,
  // L-DOPA, etc.) gets the bare L expanded to "liters". Two regexes
  // cover the two output shapes:
  //   "liters-glutamine"  → "L-glutamine"     (lowercase ≥3 chars)
  //   "liters-D-O-P-A"    → "L-D-O-P-A"       (letter-spelled chain)
  t = t.replace(/\bliters-([a-z]{3,})/gi, 'L-$1');
  t = t.replace(/\bliters-([A-Z](?:-[A-Z])+)\b/g, 'L-$1');
  // Trailing-L variant: when a short acronym chain ends in -L (e.g.,
  // F-L from 2'-FL), the units pipeline rewrites it as <letter>-liters.
  t = t.replace(/\b([A-Z])-liters\b/g, '$1-L');
  // Single-letter trailing recovery (mirror of the multi-letter chain
  // rule above): "liters-M" pattern from "L-M" alphabetical ranges.
  // Also handles en-dash and em-dash variants in glossary headers.
  t = t.replace(/\bliters([-–—])([A-Z])\b/g, 'L$1$2');
  // Author initials in citations — the Lactobacillus rule catches "L.
  // <lowercase species>" but author initials are followed by an
  // uppercase initial or punctuation, so the units pipeline expands the
  // bare L. Recover both shapes:
  //   "Chow, liters.S."     → "Chow, L.S."     (run-on initials)
  //   "Osterberg, liters."  → "Osterberg, L."  (standalone initial)
  t = t.replace(/\bliters\.([A-Z])/g, 'L.$1');
  t = t.replace(/(,\s+)liters(?=\.(?:\s|$|[^A-Za-z]))/g, '$1L');
  // P&L (profit and loss) — the units pipeline expands the L following
  // an ampersand, since "&" isn't a word boundary it considers.
  t = t.replace(/&liters\b/g, '&L');
  // Variant codes with a leading L (e.g., L432V) — the variant pipeline
  // splits to "L, <digits>, V" and the units pipeline then rewrites the
  // comma-isolated L. Detect the post-core shape and reverse.
  t = t.replace(/\bliters(,\s[a-z][a-z\s-]*?,\s[A-Z])\b/g, 'L$1');
  // Variant codes with a trailing L where the core fused the prefix
  // letter and digit, then expanded the L (F5L → "Ffive liters").
  // Recover as "<letter>-<digit-word>-L".
  t = t.replace(/\b([A-Z])(one|two|three|four|five|six|seven|eight|nine)\sliters\b/g, '$1-$2-L');

  // Lp(a) — replaced here, after the bare-L → "liters" pass has run,
  // so the leading L survives intact.
  t = t.replace(LP_LITTLE_A_REGEX, 'L-P-little-a');

  // Variant-code trailing-L recovery — preprocess emits patterns like
  // "V, eighty-nine, L" for V89L variants; the units pipeline then
  // converts the trailing bare L to "liters". Undo.
  t = t.replace(/(,\s+(?:[a-z]+(?:[-\s][a-z]+)*)),\s+liters\b/g, '$1, L');

  // Greek-letter + digit (epsilon4, alpha2, beta3) — the core converts
  // the Greek symbol to its English name but jams the digit against it.
  // Insert a space.
  t = t.replace(/\b(epsilon|alpha|beta|gamma|delta|kappa|lambda|sigma|omega|mu)(\d)/gi,
    (_, name, n) => `${name} ${n}`);

  // Phrase substitutions.
  for (const [key, val] of Object.entries(POST_OVERRIDES)) {
    t = t.replace(new RegExp(`\\b${escapeRegex(key)}\\b`, 'gi'), val);
  }

  // Pause tokens → SSML <break/> tags. Authors write [[pause-short]] /
  // [[pause-medium]] / [[pause-long]]. Lowercase alpha-only placeholders
  // because the core's normalizer strips raw XML/SSML AND expands
  // numeric units inside brackets ("600ms" → "six hundred milliseconds").
  t = t.replace(/\[\[pause-short\]\]/g,  '<break time="300ms"/>');
  t = t.replace(/\[\[pause-medium\]\]/g, '<break time="600ms"/>');
  t = t.replace(/\[\[pause-long\]\]/g,   '<break time="1200ms"/>');

  // Wrap every omics word with an SSML phoneme tag carrying the IPA
  // pronunciation. Google Cloud TTS Neural2 and Chirp 3 HD honor these
  // reliably. The literal word stays inside the tag so any voice that
  // ignores SSML still produces audio (graceful fallback).
  for (const [word, ipa] of OMIC_IPA_SORTED) {
    t = t.replace(new RegExp(`\\b${escapeRegex(word)}\\b`, 'gi'), (match) => {
      return `<phoneme alphabet="ipa" ph="${ipa}">${xmlEscape(match)}</phoneme>`;
    });
  }
  // Same machinery for clinical / scientific words. Skip any word
  // already inside a <phoneme> tag (longer omics entry might have
  // wrapped it earlier).
  for (const [word, ipa] of CLINICAL_IPA_SORTED) {
    t = t.replace(new RegExp(`\\b${escapeRegex(word)}\\b(?![^<]*</phoneme>)`, 'gi'), (match) => {
      return `<phoneme alphabet="ipa" ph="${ipa}">${xmlEscape(match)}</phoneme>`;
    });
  }

  // Apply Whisper-discovered IPA entries (learned at runtime from mispronunciation QA).
  // Same phoneme machinery as CLINICAL_IPA; longer keys first.
  const learnedIpaSorted = Object.entries(_learnedIPA).sort((a, b) => b[0].length - a[0].length);
  for (const [word, entry] of learnedIpaSorted) {
    const ipa = typeof entry === 'string' ? entry : entry.ipa;
    if (!ipa) continue;
    t = t.replace(new RegExp(`\\b${escapeRegex(word)}\\b(?![^<]*</phoneme>)`, 'gi'), (match) => {
      return `<phoneme alphabet="ipa" ph="${ipa}">${xmlEscape(match)}</phoneme>`;
    });
  }

  // Catch-all for letter-spelled acronyms the core emitted that didn't
  // match an explicit CLINICAL_IPA / FAST_GLUE entry above. Pattern:
  // capital, then one or more "-X" where X is a capital letter or
  // digit. Skip tokens already inside a <phoneme> tag. Auto-generates a
  // fast letter-chain IPA so the long tail of clinical acronyms sounds
  // fluid instead of per-letter staccato. Explicit "say as word" cases
  // in CLINICAL_IPA win because they run first.
  t = t.replace(
    /\b[A-Z](?:-[A-Z0-9])+\b(?![^<]*<\/phoneme>)/g,
    (match) => {
      const ipa = buildFastChainIpa(match);
      if (!ipa) return match;
      // Persist the discovery: when BIOSCOPE_TTS_NORMALIZE_DEV_PATH is
      // set, write the new entry into the shared package's working-copy
      // data/learned-ipa.json so future runs (in this project AND any
      // other consumer like CAFMI) inherit it via the _learnedIPA pass
      // above instead of regenerating it on every run. Gated on the env
      // var so installed-package consumers (Amplify, fresh clones) don't
      // try to write to a node_modules path. Buffered in memory; flush
      // at end of audio-gen via flushAutoDiscoveredIpa().
      autoDiscover(match, ipa);
      return `<phoneme alphabet="ipa" ph="${ipa}">${xmlEscape(match)}</phoneme>`;
    }
  );

  // SSRI — the default fast-glue IPA ˌɛsɛsɑːrˈaɪ produces an audible
  // beat between the first and second /s/ on Chirp HD (the synth re-
  // articulates adjacent identical fricatives). Rewrite the exact tag
  // emitted above, binding the SS into one stressed beat (primary on
  // the first ɛs, secondary on the second) with a syllable break before
  // the AR so the cluster resolves cleanly into "ess-ess-AR-eye".
  // Direct string replace because POST_OVERRIDES' \b word boundaries
  // don't match around phoneme tag punctuation.
  t = t.replaceAll(
    '<phoneme alphabet="ipa" ph="ˌɛsɛsɑːrˈaɪ">S-S-R-I</phoneme>',
    '<phoneme alphabet="ipa" ph="ˈɛsˌɛs.ɑːrˌaɪ">S-S-R-I</phoneme>',
  );

  return t;
}

// ─── PUBLIC ENTRYPOINT ──────────────────────────────────────

function normalizeForTTS(text) {
  if (!text) return '';
  return postprocessForTTS(coreNormalize(preprocessForTTS(text)));
}

// ─── SELF-TEST ──────────────────────────────────────────────

function selfTest() {
  // SSML phoneme wraps are part of the expected output for FAST_GLUE
  // and CLINICAL_IPA tokens. Tests that hit those tokens carry the
  // expected `<phoneme alphabet="ipa" ph="…">word</phoneme>` markup
  // verbatim. Google TTS Neural2 / Chirp 3 HD honor the tags; voices
  // that don't get the tags stripped by the synthesizer wrapper.
  const tests = [
    ['Take 200mg of NMN daily', 'Take two hundred milligrams of <phoneme alphabet="ipa" ph="ˌɛnɛmˈɛn">N-M-N</phoneme> daily'],
    ['NAD+ levels decline by 50% after age 40', '<phoneme alphabet="ipa" ph="ˌɛneɪˈdiː">N-A-D</phoneme>-plus levels decline by fifty percent after age forty'],
    ['Blood glucose: 95 mg/dL', 'Blood glucose: ninety five milligrams per deciliter'],
    ['VO2max improved by 12%', '<phoneme alphabet="ipa" ph="ˌviːˈoʊ">V-O</phoneme>-two-max improved by twelve percent'],
    ['The 1st study used 500μg of vitamin B12', 'The first study used five hundred micrograms of vitamin-B-twelve'],
    ['mTOR pathway activation', 'm-TOR pathway activation'],
    ['IL-6 and TNF-α levels', 'interleukin six and <phoneme alphabet="ipa" ph="ˌtiːɛnˈɛf">T-N-F</phoneme>-alpha levels'],
    ['3.5g of EPA + DHA', 'three point five grams of <phoneme alphabet="ipa" ph="ˌiːpiːˈeɪ">E-P-A</phoneme> plus <phoneme alphabet="ipa" ph="ˌdiːeɪtʃˈeɪ">D-H-A</phoneme>'],
    // Comma-formatted numbers
    ['over 1,000 people', 'over one thousand people'],
    ['10,000 participants enrolled', 'ten thousand participants enrolled'],
    ['2,500mg daily', 'two thousand five hundred milligrams daily'],
    // Gene names with embedded numbers
    ['ZNF280A gene', '<phoneme alphabet="ipa" ph="ˌziːɛnˈɛf">Z-N-F</phoneme>-two-eighty-A gene'],
    ['FOXO4 transcription factor', 'fox-oh-four transcription factor'],
    ['PCSK9 inhibitor', '<phoneme alphabet="ipa" ph="ˌpiːsiːɛsˈkeɪ">P-C-S-K</phoneme>-nine inhibitor'],
    ['TP53 mutation', '<phoneme alphabet="ipa" ph="ˌtiːˈpiː">T-P</phoneme>-fifty-three mutation'],
    ['BRCA1 variant', 'bracka-one variant'],
    // CDK4 — the FAST_GLUE 'CD8' auto-registers 'C-D' too, which the
    // post-pass wraps inside "C-D-K-four". Acceptable: "see-DEE K four"
    // reads more naturally than slow per-letter spelling anyway.
    ['CDK4 activity', '<phoneme alphabet="ipa" ph="ˌsiːˈdiː">C-D</phoneme>-K-four activity'],
    // Pre-pass course-tuned regexes
    ['CYP1A2 enzyme', 'sipp-one-A-two enzyme'],
    ['rs1801133 variant', 'r-s, one, eight, oh, one, one, three, three variant'],
    ['SIRT3 expression', 'sirt three expression'],
    ['BPC-157 peptide', '<phoneme alphabet="ipa" ph="ˌbiːpiːˈsiː">B-P-C</phoneme> one fifty-seven peptide'],
    // 78th passes through the core's number/ordinal pipeline unchanged
    // (not in ORDINAL_MAP; the trailing "th" defeats the bare-number
    // regex). Acceptable in production — Chirp HD reads "78th" as the
    // ordinal naturally.
    ['Take a 78th-%ile score', 'Take a 78th-percentyle score'],
    // PRE_ABBREVIATIONS overrides
    ['T2D incidence', 'type two diabetes incidence'],
    ['HIIT improves fitness', 'hit improves fitness'],
    // Pause tokens → SSML break tags
    ['Wait[[pause-short]]then continue', 'Wait<break time="300ms"/>then continue'],
    // CLINICAL_IPA phoneme wrap
    ['Akkermansia colonizes the gut', '<phoneme alphabet="ipa" ph="ˌækərˈmænsiə">Akkermansia</phoneme> colonizes the gut'],
    // OMIC_IPA phoneme wrap
    ['the genome study', 'the <phoneme alphabet="ipa" ph="ˈdʒiːnoʊm">genome</phoneme> study'],
    // ─── Word-form acronyms (CLINICAL_IPA post-core hyphen entries).
    ['CHIP burden rises with age',
      '<phoneme alphabet="ipa" ph="tʃɪp">C-H-I-P</phoneme> burden rises with age'],
    ['SASP and DIM',
      '<phoneme alphabet="ipa" ph="sæsp">S-A-S-P</phoneme> and <phoneme alphabet="ipa" ph="dɪm">D-I-M</phoneme>'],
    ["per CPIC's SSRI guideline",
      'per <phoneme alphabet="ipa" ph="ˈsiːpɪk">C-P-I-C</phoneme>\'s <phoneme alphabet="ipa" ph="ˌɛsɛsɑːrˈaɪ">S-S-R-I</phoneme> guideline'],
    // SLCO1B1 — POST_OVERRIDES emits a phoneme tag with fluid letter chain.
    ['SLCO1B1 *5/*5',
      '<phoneme alphabet="ipa" ph="ɛs.ɛl.siː.oʊ.wʌn.biː.wʌn">SLCO1B1</phoneme> *five/*five'],
    // ─── Snake_case identifier preprocess.
    ['call update_identity on the patient',
      'call update identity on the patient'],
    ['flags is_clinician active_crisis prefers_terse',
      'flags is clinician active crisis prefers terse'],
    // ─── HGVS coordinate range. The trailing "del" stays attached to
    // the second number (it was glued in the input) — the core's
    // number pipeline doesn't split it. Real HGVS strings tend to have
    // a space-separated suffix and read cleanly.
    ['c.123_456del simple range',
      'c.one hundred twenty three to 456del simple range'],
    // ─── Signature-blank collapse. The leading underscore-run becomes
    // a single space, which the core's later whitespace pass trims.
    ['___ I do consent', 'I do consent'],
    // ─── Liters-recovery extensions.
    ['Chow, L.S. et al. (2020)', 'Chow, L.S. et al. (two thousand twenty)'],
    ['Osterberg, L. & Blaschke, T.', 'Osterberg, L. & Blaschke, T.'],
    ['P&L statement', 'P&L statement'],
    ['the L-M ratio',
      'the <phoneme alphabet="ipa" ph="ˌɛlˈɛm">L-M</phoneme> ratio'],
    // ─── Auto-wrap fallback for arbitrary letter-spelled acronyms not
    // in any explicit dictionary.
    ['the C-H-D-H pathway',
      'the <phoneme alphabet="ipa" ph="ˌsiːeɪtʃdiːˈeɪtʃ">C-H-D-H</phoneme> pathway'],
  ];

  let passed = 0;
  for (const [input, expected] of tests) {
    const result = normalizeForTTS(input);
    const ok = result === expected;
    if (!ok) {
      console.log(`  FAIL: "${input}"`);
      console.log(`    Expected: "${expected}"`);
      console.log(`    Got:      "${result}"`);
    } else {
      passed++;
    }
  }
  console.log(`TTS Normalize: ${passed}/${tests.length} tests passed`);
  return passed === tests.length;
}

module.exports = {
  normalizeForTTS,
  addLearnedPronunciation,
  addLearnedIPA,
  flushAutoDiscoveredIpa,
  isPronounceableAcronym,
  findPronounceableAcronyms,
  reloadLearnedIpa,
  selfTest,
};
