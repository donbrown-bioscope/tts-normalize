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

// ─── English wordlist (lazy) ──────────────────────────────────────────
// Loaded once on first use; backs the ALL-CAPS catch-all so common English
// words emphasized in narration ("CONVENTIONAL", "INSULIN") don't get
// letter-spelled. ~275k entries from `an-array-of-english-words`. The cost
// is one ~30 MB Set built at first audio-gen call; subsequent normalize
// calls are O(1) lookups. Wrapped in try/catch so consumers without the
// dep installed still get the legacy SKIP_UPPERCASE-only behavior.
let _englishWordSet = null;
function _englishWords() {
  if (_englishWordSet !== null) return _englishWordSet;
  try {
    const list = require('an-array-of-english-words');
    _englishWordSet = new Set(list);
  } catch {
    _englishWordSet = new Set();
  }
  return _englishWordSet;
}

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

// Pronounce a 4-digit calendar year the way a human would:
//   1996 → "nineteen ninety-six"
//   1900 → "nineteen hundred"
//   1905 → "nineteen oh five"
//   2000 → "two thousand"
//   2007 → "two thousand seven"
//   2023 → "twenty twenty-three"
//
// Returns null when the number doesn't fit the year shape (so the caller
// can fall back to the regular number reading).
function yearToWords(n) {
  if (!Number.isInteger(n) || n < 1500 || n > 2099) return null;
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  if (n === 2000) return 'two thousand';
  if (hi === 20 && lo > 0 && lo < 10) return `two thousand ${numberToWords(lo)}`;
  const hiWords = numberToWords(hi);
  if (lo === 0) return `${hiWords} hundred`;
  if (lo < 10) return `${hiWords} oh ${numberToWords(lo)}`;
  return `${hiWords} ${numberToWords(lo)}`;
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
  'mmol/L': 'millimoles per liter', 'mmol/l': 'millimoles per liter',
  'µmol/L': 'micromoles per liter', 'µmol/l': 'micromoles per liter',
  'μmol/L': 'micromoles per liter', 'μmol/l': 'micromoles per liter',
  'nmol/L': 'nanomoles per liter', 'nmol/l': 'nanomoles per liter',
  'nmol/mL': 'nanomoles per milliliter', 'nmol/ml': 'nanomoles per milliliter',
  'pmol/L': 'picomoles per liter', 'pmol/l': 'picomoles per liter',
  'pmol/mL': 'picomoles per milliliter', 'pmol/ml': 'picomoles per milliliter',
  'fmol/L': 'femtomoles per liter', 'fmol/l': 'femtomoles per liter',
  'fmol/mL': 'femtomoles per milliliter', 'fmol/ml': 'femtomoles per milliliter',
  'pmol': 'picomoles', 'fmol': 'femtomoles',
  'ng/mL': 'nanograms per milliliter', 'ng/ml': 'nanograms per milliliter',
  'ng/dL': 'nanograms per deciliter', 'ng/dl': 'nanograms per deciliter',
  'pg/mL': 'picograms per milliliter', 'pg/ml': 'picograms per milliliter',
  'µg/dL': 'micrograms per deciliter', 'µg/dl': 'micrograms per deciliter',
  'μg/dL': 'micrograms per deciliter', 'μg/dl': 'micrograms per deciliter',
  'µg/mL': 'micrograms per milliliter', 'µg/ml': 'micrograms per milliliter',
  'μg/mL': 'micrograms per milliliter', 'μg/ml': 'micrograms per milliliter',
  'g/L': 'grams per liter', 'g/l': 'grams per liter',
  'g/dL': 'grams per deciliter', 'g/dl': 'grams per deciliter',
  'mEq/L': 'milliequivalents per liter', 'mEq/l': 'milliequivalents per liter',
  'IU/L': 'international units per liter', 'IU/l': 'international units per liter',
  'U/L': 'units per liter', 'U/l': 'units per liter',
  'U/mL': 'units per milliliter', 'U/ml': 'units per milliliter',
  // Pressure
  'mmHg': 'millimeters of mercury', 'kPa': 'kilopascals',
  // Time
  'hr': 'hour', 'hrs': 'hours', 'min': 'minutes', 'sec': 'seconds',
  'ms': 'milliseconds',
  // Energy
  'kcal': 'kilocalories', 'kJ': 'kilojoules', 'cal': 'calories',
  // Other medical
  'IU': 'international units', 'mg/kg': 'milligrams per kilogram',
  'g/kg': 'grams per kilogram', 'µg/kg': 'micrograms per kilogram',
  'μg/kg': 'micrograms per kilogram', 'ng/kg': 'nanograms per kilogram',
  'mg/week': 'milligrams per week', 'mg/wk': 'milligrams per week',
  'g/week': 'grams per week', 'g/wk': 'grams per week',
  'mg/day': 'milligrams per day', 'g/day': 'grams per day',
  'IU/day': 'international units per day',
  'steps/day': 'steps per day', 'step/day': 'step per day',
  'm/s': 'meters per second', 'mL/min': 'milliliters per minute',
  'ml/min': 'milliliters per minute',
  'bpm': 'beats per minute', 'rpm': 'respirations per minute',
  'mmol': 'millimoles', 'µmol': 'micromoles', 'nmol': 'nanomoles',
  'mIU/L': 'milli international units per liter',
  'mIU/mL': 'milli international units per milliliter',
  'mIU/ml': 'milli international units per milliliter',
  'IU/mL': 'international units per milliliter',
  'IU/ml': 'international units per milliliter',
  'µIU/mL': 'micro international units per milliliter',
  'µIU/ml': 'micro international units per milliliter',
  'μIU/mL': 'micro international units per milliliter',
  'μIU/ml': 'micro international units per milliliter',
  'µIU': 'micro international units',
  'μIU': 'micro international units',
  'mIU': 'milli international units', 'pg/mg': 'picograms per milligram',
  'CFU': 'colony forming units',
  // Distance/size
  'nm': 'nanometers', 'µm': 'micrometers', 'mm': 'millimeters',
  'cm': 'centimeters', 'km': 'kilometers',
  // Radiation dose
  'mSv': 'millisieverts', 'µSv': 'microsieverts', 'μSv': 'microsieverts',
  'Sv': 'sieverts', 'Gy': 'grays', 'mGy': 'milligrays',
};

// ─── ABBREVIATION EXPANSIONS ────────────────────────────────

const ABBREVIATIONS = {
  // Spell out as individual letters (hyphenated so TTS reads each letter distinctly)
  'DNA': 'D-N-A', 'RNA': 'R-N-A', 'mRNA': 'm-R-N-A', 'tRNA': 't-R-N-A',
  'BMI': 'B-M-I', 'BMR': 'B-M-R', 'SMR': 'S-M-R', 'RDA': 'R-D-A', 'FDA': 'F-D-A',
  'NIH': 'N-I-H', 'WHO': 'W-H-O', 'CDC': 'C-D-C',
  // BEIR VII — the 7th US NAS Biological Effects of Ionizing Radiation
  // report. "BEIR" pronunciation locked via learned-ipa /bɪər/; expand
  // the Roman numeral here so it reads "beer seven" instead of "B-E-I-R
  // V-I-I". UNSCEAR also has a learned-ipa entry (/ʌnˈskɛər/, "un-scare").
  'BEIR VII': 'BEIR seven',
  // ATP — auto-glued form heard as "ADP" (different molecule, high-risk
  // confusion). Same terminal-voicing-consonant failure mode as the
  // terminal-T cohort (HRT/TRT/VTE) — fix per the same pattern: one
  // <phoneme> tag per letter, primary stress on each, no separator.
  'ATP':  '<phoneme alphabet="ipa" ph="ˈeɪ">A</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈpiː">P</phoneme>',
  'ADP': 'A-D-P', 'AMP': 'A-M-P',
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
  // Monoclonal antibody — the bare "mAb" / "mAbs" tokens slip past the
  // letter-spell catch-all (mixed case) and Chirp mumbles them.
  // Expand to the full phrase clinicians actually say.
  'mAb': 'monoclonal antibody', 'mAbs': 'monoclonal antibodies',
  // Heart-failure-by-EF taxonomy. Mixed case ("HFrEF") slips past the
  // letter-spell catch-all and Chirp says "huff-reff" / "huff-puff".
  // Expand to the full phrase so listeners hear the categorical
  // distinction (reduced vs mildly-reduced vs preserved EF) every time
  // — these acronyms get used in close succession in HF discussions
  // and letter-spelled forms blur into each other.
  'HFrEF':  'heart failure with reduced ejection fraction',
  'HFpEF':  'heart failure with preserved ejection fraction',
  'HFmrEF': 'heart failure with mildly reduced ejection fraction',
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
  'MCP-1': 'M-C-P-one', 'MCP1': 'M-C-P-one',
  // Long alpha-digit-alpha gene IDs are split into 2–3 phone chunks,
  // each in its own <phoneme> tag. Single long IPAs (5–6 phones) made
  // Chirp 3 HD slur ("ASXL1" → "ISXL1"); comma-separated text was clear
  // but painfully slow. Concatenated short tags use the same prosody
  // shape that works for two-letter acronyms (TET2, JAK2) — Chirp
  // articulates each chunk crisply, and back-to-back tags read as one
  // fluid utterance instead of a punctuation-paused sequence.
  'DNMT3A': '<phoneme alphabet="ipa" ph="ˌdiːˈɛn">D-N</phoneme><phoneme alphabet="ipa" ph="ˌɛmˈtiː">M-T</phoneme><phoneme alphabet="ipa" ph="ˌθriːˈeɪ">3-A</phoneme>',
  'ASXL1':  '<phoneme alphabet="ipa" ph="ˌeɪˈɛs">A-S</phoneme><phoneme alphabet="ipa" ph="ˌɛksɛlˈwʌn">X-L-1</phoneme>',
  // Same 2-phone-chunk pattern for SRSF2 (4 letters + digit, same shape
  // as ASXL1) and CCP / ANA (3 letters). For the 3-letter forms we split
  // into a single-letter tag + a 2-letter tag so the front letter is
  // explicitly bracketed and can't slur into the next.
  'SRSF2': '<phoneme alphabet="ipa" ph="ˌɛsˈɑːr">S-R</phoneme><phoneme alphabet="ipa" ph="ˌɛsɛfˈtuː">S-F-2</phoneme>',
  // ANA / DNA — single-tag overrides for two 3-letter chains that
  // each break Chirp 3 HD differently in their default forms:
  //   - Auto-glue ˌdiːɛnˈeɪ slurs DNA's diː into the next ɛn so the
  //     synth renders "die-N-A".
  //   - Period-each-foot ˈdiː.ˈɛn.ˈeɪ triggers a leading-vowel
  //     misrender — the ˈ-prefixed leading diphthong comes out as the
  //     wrong vowel (DNA → "die-N-A", ANA → "eye-N-A").
  // Hybrid that survives both: secondary stress on the leading letter
  // (no primary, which kills the diphthong-misrender bug), period
  // immediately after to break the slur into the middle letter, no
  // stress on the middle, primary on the trailing letter.
  // ANA also needs the override to bypass the shared package's
  // learned-ipa word entry (ˈænə) added by auto-llm in 2026-05-03.
  'ANA':   '<phoneme alphabet="ipa" ph="ˌeɪ.ɛn.ˈeɪ">A-N-A</phoneme>',
  'DNA':   '<phoneme alphabet="ipa" ph="ˌdiː.ɛn.ˈeɪ">D-N-A</phoneme>',
  // Terminal-T (and other voicing-prone) clinical acronyms — Chirp HD
  // voices the trailing /t/ to /d/ inside a single <phoneme> tag (HRT
  // → "HRD", TRT → "TRD", VTE → "VDE", etc.) regardless of stress
  // marks or period separators in the IPA. Splitting into one
  // <phoneme> tag per letter, concatenated without separators, blocks
  // the slur at the tag boundary while preserving DNMT3A-style cadence
  // (no audible inter-letter pause). Confirmed by ear on TRT
  // (appendix-g) before being rolled out across the cohort.
  // Each entry is dual-keyed: the plain ALL-CAPS form (matches body
  // prose like "she started HRT") and the hyphenated form (matches
  // figure-narration overrides in car-mode.json, which the author
  // pre-spells as "H-R-T"). Both keys point at the same SSML so the
  // pronunciation is identical regardless of which form the upstream
  // text uses.
  'HRT':     '<phoneme alphabet="ipa" ph="ˈeɪtʃ">H</phoneme><phoneme alphabet="ipa" ph="ˈɑːr">R</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme>',
  'H-R-T':   '<phoneme alphabet="ipa" ph="ˈeɪtʃ">H</phoneme><phoneme alphabet="ipa" ph="ˈɑːr">R</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme>',
  'TRT':     '<phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈɑːr">R</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme>',
  'T-R-T':   '<phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈɑːr">R</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme>',
  'BHRT':    '<phoneme alphabet="ipa" ph="ˈbiː">B</phoneme><phoneme alphabet="ipa" ph="ˈeɪtʃ">H</phoneme><phoneme alphabet="ipa" ph="ˈɑːr">R</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme>',
  'B-H-R-T': '<phoneme alphabet="ipa" ph="ˈbiː">B</phoneme><phoneme alphabet="ipa" ph="ˈeɪtʃ">H</phoneme><phoneme alphabet="ipa" ph="ˈɑːr">R</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme>',
  'MHT':     '<phoneme alphabet="ipa" ph="ˈɛm">M</phoneme><phoneme alphabet="ipa" ph="ˈeɪtʃ">H</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme>',
  'M-H-T':   '<phoneme alphabet="ipa" ph="ˈɛm">M</phoneme><phoneme alphabet="ipa" ph="ˈeɪtʃ">H</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme>',
  'VTE':     '<phoneme alphabet="ipa" ph="ˈviː">V</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈiː">E</phoneme>',
  'V-T-E':   '<phoneme alphabet="ipa" ph="ˈviː">V</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈiː">E</phoneme>',
  'ITT':     '<phoneme alphabet="ipa" ph="ˈaɪ">I</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme>',
  'I-T-T':   '<phoneme alphabet="ipa" ph="ˈaɪ">I</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme>',
  'ATBC':    '<phoneme alphabet="ipa" ph="ˈeɪ">A</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈbiː">B</phoneme><phoneme alphabet="ipa" ph="ˈsiː">C</phoneme>',
  'A-T-B-C': '<phoneme alphabet="ipa" ph="ˈeɪ">A</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈbiː">B</phoneme><phoneme alphabet="ipa" ph="ˈsiː">C</phoneme>',
  'ACTH':    '<phoneme alphabet="ipa" ph="ˈeɪ">A</phoneme><phoneme alphabet="ipa" ph="ˈsiː">C</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈeɪtʃ">H</phoneme>',
  'A-C-T-H': '<phoneme alphabet="ipa" ph="ˈeɪ">A</phoneme><phoneme alphabet="ipa" ph="ˈsiː">C</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈeɪtʃ">H</phoneme>',
  'ATTR':    '<phoneme alphabet="ipa" ph="ˈeɪ">A</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈɑːr">R</phoneme>',
  'A-T-T-R': '<phoneme alphabet="ipa" ph="ˈeɪ">A</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈɑːr">R</phoneme>',
  // AST — aspartate aminotransferase. Terminal-T cohort; auto-glue
  // ˌeɪɛsˈtiː slurs and the T gets voiced into a D.
  'AST':     '<phoneme alphabet="ipa" ph="ˈeɪ">A</phoneme><phoneme alphabet="ipa" ph="ˈɛs">S</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme>',
  'A-S-T':   '<phoneme alphabet="ipa" ph="ˈeɪ">A</phoneme><phoneme alphabet="ipa" ph="ˈɛs">S</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme>',
  // PDFF — proton density fat fraction. Terminal double-F; the
  // post-pass's 2+2 concat (P-D + F-F) renders the second F-F chunk
  // as a single muddy "ef" instead of two letters. Per-letter tags
  // force each F to articulate.
  'PDFF':    '<phoneme alphabet="ipa" ph="ˈpiː">P</phoneme><phoneme alphabet="ipa" ph="ˈdiː">D</phoneme><phoneme alphabet="ipa" ph="ˈɛf">F</phoneme><phoneme alphabet="ipa" ph="ˈɛf">F</phoneme>',
  'P-D-F-F': '<phoneme alphabet="ipa" ph="ˈpiː">P</phoneme><phoneme alphabet="ipa" ph="ˈdiː">D</phoneme><phoneme alphabet="ipa" ph="ˈɛf">F</phoneme><phoneme alphabet="ipa" ph="ˈɛf">F</phoneme>',
  // Terminal-P / terminal-C analogs — same failure mode as terminal-T
  // (Chirp HD voicing the final consonant inside a single auto-glued
  // <phoneme> tag). SNP → "S P" (N dropped), ETC → "EDC", UCP → "USOP".
  'SNP':     '<phoneme alphabet="ipa" ph="ˈɛs">S</phoneme><phoneme alphabet="ipa" ph="ˈɛn">N</phoneme><phoneme alphabet="ipa" ph="ˈpiː">P</phoneme>',
  'S-N-P':   '<phoneme alphabet="ipa" ph="ˈɛs">S</phoneme><phoneme alphabet="ipa" ph="ˈɛn">N</phoneme><phoneme alphabet="ipa" ph="ˈpiː">P</phoneme>',
  'ETC':     '<phoneme alphabet="ipa" ph="ˈiː">E</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈsiː">C</phoneme>',
  'E-T-C':   '<phoneme alphabet="ipa" ph="ˈiː">E</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme><phoneme alphabet="ipa" ph="ˈsiː">C</phoneme>',
  'UCP':     '<phoneme alphabet="ipa" ph="ˈjuː">U</phoneme><phoneme alphabet="ipa" ph="ˈsiː">C</phoneme><phoneme alphabet="ipa" ph="ˈpiː">P</phoneme>',
  'U-C-P':   '<phoneme alphabet="ipa" ph="ˈjuː">U</phoneme><phoneme alphabet="ipa" ph="ˈsiː">C</phoneme><phoneme alphabet="ipa" ph="ˈpiː">P</phoneme>',
  'HSC':     '<phoneme alphabet="ipa" ph="ˈeɪtʃ">H</phoneme><phoneme alphabet="ipa" ph="ˈɛs">S</phoneme><phoneme alphabet="ipa" ph="ˈsiː">C</phoneme>',
  'H-S-C':   '<phoneme alphabet="ipa" ph="ˈeɪtʃ">H</phoneme><phoneme alphabet="ipa" ph="ˈɛs">S</phoneme><phoneme alphabet="ipa" ph="ˈsiː">C</phoneme>',
  // NAD — auto-glue ˌɛnˈeɪdiː heard as "NID" (medial /eɪ/ flattened
  // by Whisper to /i/). Single-letter tags per the cohort pattern.
  'NAD':     '<phoneme alphabet="ipa" ph="ˈɛn">N</phoneme><phoneme alphabet="ipa" ph="ˈeɪ">A</phoneme><phoneme alphabet="ipa" ph="ˈdiː">D</phoneme>',
  'N-A-D':   '<phoneme alphabet="ipa" ph="ˈɛn">N</phoneme><phoneme alphabet="ipa" ph="ˈeɪ">A</phoneme><phoneme alphabet="ipa" ph="ˈdiː">D</phoneme>',
  // CCD — chronic coronary disease. Double-C in a single tag slurs to
  // one "see" instead of two (same failure mode as PDFF's terminal
  // double-F); terminal-D also voicing-prone per the AST/NAD cohort.
  // Per-letter tags force each C to articulate and lock the D.
  'CCD':     '<phoneme alphabet="ipa" ph="ˈsiː">C</phoneme><phoneme alphabet="ipa" ph="ˈsiː">C</phoneme><phoneme alphabet="ipa" ph="ˈdiː">D</phoneme>',
  'C-C-D':   '<phoneme alphabet="ipa" ph="ˈsiː">C</phoneme><phoneme alphabet="ipa" ph="ˈsiː">C</phoneme><phoneme alphabet="ipa" ph="ˈdiː">D</phoneme>',
  // Initial-letter-dropped class — BER → "BR", NER → "NER" intact
  // but parallels its sibling; NHEJ → "an HEJ" (leading N swallowed
  // into preceding article). Same per-letter-tag pattern blocks the
  // elision at the first tag boundary.
  // BER/NER — medial E gets swallowed when all three letters carry
  // primary stress (heard as "BR" / "NR"). Shift primary stress onto
  // the middle letter and demote the outer letters to secondary stress
  // so Chirp gives the E more vowel duration.
  'BER':     '<phoneme alphabet="ipa" ph="ˌbiː">B</phoneme><phoneme alphabet="ipa" ph="ˈiː">E</phoneme><phoneme alphabet="ipa" ph="ˌɑːr">R</phoneme>',
  'B-E-R':   '<phoneme alphabet="ipa" ph="ˌbiː">B</phoneme><phoneme alphabet="ipa" ph="ˈiː">E</phoneme><phoneme alphabet="ipa" ph="ˌɑːr">R</phoneme>',
  'NER':     '<phoneme alphabet="ipa" ph="ˌɛn">N</phoneme><phoneme alphabet="ipa" ph="ˈiː">E</phoneme><phoneme alphabet="ipa" ph="ˌɑːr">R</phoneme>',
  'N-E-R':   '<phoneme alphabet="ipa" ph="ˌɛn">N</phoneme><phoneme alphabet="ipa" ph="ˈiː">E</phoneme><phoneme alphabet="ipa" ph="ˌɑːr">R</phoneme>',
  'NHEJ':    '<phoneme alphabet="ipa" ph="ˈɛn">N</phoneme><phoneme alphabet="ipa" ph="ˈeɪtʃ">H</phoneme><phoneme alphabet="ipa" ph="ˈiː">E</phoneme><phoneme alphabet="ipa" ph="ˈdʒeɪ">J</phoneme>',
  'N-H-E-J': '<phoneme alphabet="ipa" ph="ˈɛn">N</phoneme><phoneme alphabet="ipa" ph="ˈeɪtʃ">H</phoneme><phoneme alphabet="ipa" ph="ˈiː">E</phoneme><phoneme alphabet="ipa" ph="ˈdʒeɪ">J</phoneme>',
  // Author also uses the irregular "N-HE-J" form in figure narration.
  'N-HE-J':  '<phoneme alphabet="ipa" ph="ˈɛn">N</phoneme><phoneme alphabet="ipa" ph="ˈeɪtʃ">H</phoneme><phoneme alphabet="ipa" ph="ˈiː">E</phoneme><phoneme alphabet="ipa" ph="ˈdʒeɪ">J</phoneme>',
  // TET / TET2 — clinical convention reads TET as the word "tett"
  // (ten-eleven translocation), not letter-spelled. GENE_PRONOUNCEABLE_
  // PREFIXES already maps TET→"tet" for digit-suffixed forms like TET2;
  // standalone "TET enzymes" needs an explicit entry here because the
  // letter-spell catch-all otherwise spells it (heard as "TAT" by
  // Whisper). Whisper continues to hear "TET2" as "TETU" — accept that
  // as a known false-positive class; the audio matches clinical usage.
  'TET':     '<phoneme alphabet="ipa" ph="ˈtɛt">tett</phoneme>',
  'FUT2':    '<phoneme alphabet="ipa" ph="ˈɛf">F</phoneme><phoneme alphabet="ipa" ph="ˈjuː">U</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme> two',
  'F-U-T-2': '<phoneme alphabet="ipa" ph="ˈɛf">F</phoneme><phoneme alphabet="ipa" ph="ˈjuː">U</phoneme><phoneme alphabet="ipa" ph="ˈtiː">T</phoneme> two',
  // DHEA-S — 5-letter hyphenated. ABBREVIATIONS['DHEA'] expands the
  // first 4 letters, leaving "-S" which step 11's catch-all letter-
  // spells into auto-glue "D-H-E-A-S" — Whisper hears "DH EACE".
  // Per-letter form keeps the terminal S clean.
  'DHEA-S':   '<phoneme alphabet="ipa" ph="ˈdiː">D</phoneme><phoneme alphabet="ipa" ph="ˈeɪtʃ">H</phoneme><phoneme alphabet="ipa" ph="ˈiː">E</phoneme><phoneme alphabet="ipa" ph="ˈeɪ">A</phoneme><phoneme alphabet="ipa" ph="ˈɛs">S</phoneme>',
  'D-H-E-A-S':'<phoneme alphabet="ipa" ph="ˈdiː">D</phoneme><phoneme alphabet="ipa" ph="ˈeɪtʃ">H</phoneme><phoneme alphabet="ipa" ph="ˈiː">E</phoneme><phoneme alphabet="ipa" ph="ˈeɪ">A</phoneme><phoneme alphabet="ipa" ph="ˈɛs">S</phoneme>',
  'PI3K': 'pie-three-kay',
  'BDNF': 'B-D-N-F', 'NGF': 'N-G-F',
  'ROS': 'R-O-S', 'RNS': 'R-N-S',
  'DHEA': 'D-H-E-A', 'DHA': 'D-H-A', 'EPA': 'E-P-A',
  'NMN': 'N-M-N', 'NR': 'N-R', 'CoQ10': 'co-Q-ten',
  'AMPK': 'A-M-P-K', 'mTOR': 'm-TOR', 'mTORC1': 'm-TORC-one',
  // SIRT1-7 — pronounce "SIRT" as a word (rhymes with "shirt"), not
  // letter-spelled. These entries are effectively dead: preprocessForTTS
  // converts SIRT(\d+) → phoneme-wrapped form before step 6b. Kept as
  // documentation of the intended pronunciation.
  'SIRT1': '<phoneme alphabet="ipa" ph="sɜːrt">sirt</phoneme>-one',
  'SIRT2': '<phoneme alphabet="ipa" ph="sɜːrt">sirt</phoneme>-two',
  'SIRT3': '<phoneme alphabet="ipa" ph="sɜːrt">sirt</phoneme>-three',
  'SIRT4': '<phoneme alphabet="ipa" ph="sɜːrt">sirt</phoneme>-four',
  'SIRT5': '<phoneme alphabet="ipa" ph="sɜːrt">sirt</phoneme>-five',
  'SIRT6': '<phoneme alphabet="ipa" ph="sɜːrt">sirt</phoneme>-six',
  'SIRT7': '<phoneme alphabet="ipa" ph="sɜːrt">sirt</phoneme>-seven',
  'GlycA': '<phoneme alphabet="ipa" ph="ˌɡlaɪkˈeɪ">glyc-A</phoneme>',
  'KEAP1': '<phoneme alphabet="ipa" ph="kiːp.wʌn">keep-one</phoneme>',
  'p53': 'p fifty three', 'p38': 'p thirty eight', 'p21': 'p twenty one',
  'FOXO3': 'foxo three', 'FOXO': 'foxo',
  // SCORE2 — European Society of Cardiology cardiovascular risk
  // calculator (Systematic COronary Risk Evaluation, 2021 revision).
  // "SCORE" is a real English word that Chirp says fine; the digit
  // suffix would otherwise get letter-spelled with the rest as
  // "S-C-O-R-E-2" by the catch-all. Map to word + word.
  'SCORE2': 'score-two',
  'Nrf2': 'N-R-F-two', 'NF-kB': 'N-F-kappa-B',
  'VEGF': 'V-E-G-F',
  'EGCG': 'E-G-C-G', 'NAC': 'N-A-C',
  'VO2': 'V-O-two', 'VO2max': 'V-O-two-max',
  'pH': 'p-H', 'pO2': 'p-O-two', 'pCO2': 'p-C-O-two',
  'T3': 'T-three', 'T4': 'T-four', 'TSH': 'T-S-H',
  'fT3': 'free-T-three', 'fT4': 'free-T-four', 'rT3': 'reverse-T-three',
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
  // UCP1/2/3 use the per-letter <phoneme> form (matches the terminal-T
  // cohort pattern) to avoid the auto-glue "USOP1" slur.
  'UCP1': '<phoneme alphabet="ipa" ph="ˈjuː">U</phoneme><phoneme alphabet="ipa" ph="ˈsiː">C</phoneme><phoneme alphabet="ipa" ph="ˈpiː">P</phoneme> one',
  'UCP2': '<phoneme alphabet="ipa" ph="ˈjuː">U</phoneme><phoneme alphabet="ipa" ph="ˈsiː">C</phoneme><phoneme alphabet="ipa" ph="ˈpiː">P</phoneme> two',
  'UCP3': '<phoneme alphabet="ipa" ph="ˈjuː">U</phoneme><phoneme alphabet="ipa" ph="ˈsiː">C</phoneme><phoneme alphabet="ipa" ph="ˈpiː">P</phoneme> three',
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
  'CD4+': 'C-D-four-plus', 'CD4⁺': 'C-D-four-plus',
  'CD8+': 'C-D-eight-plus', 'CD8⁺': 'C-D-eight-plus',
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
  'HIF-1α': 'hiff-one-alpha', 'HIF-2α': 'hiff-two-alpha',
  'HIF-1alpha': 'hiff-one-alpha', 'HIF-2alpha': 'hiff-two-alpha',
  'HIF1α': 'hiff-one-alpha', 'HIF2α': 'hiff-two-alpha',
  'HIF1': 'hiff-one', 'HIF2': 'hiff-two',
  'NF-κB': 'N-F-kappa-B',
  'TGF-β': 'T-G-F-beta', 'IFN-α': 'interferon alpha', 'IFN-γ': 'interferon gamma',
  'PGC-1α': 'P-G-C-one-alpha',
  // Protein/gene names — hyphenated to prevent unnatural TTS pauses
  'C/EBPβ': 'C-E-B-P-beta', 'C/EBPα': 'C-E-B-P-alpha',
  // DNA motifs — spell out letter by letter
  'CCAAT': 'C-C-A-A-T', 'TATA': 'T-A-T-A', 'CpG': 'C p G',
  // Unit compounds with Greek mu — must be handled before Greek letter replacement
  // and BEFORE the bare 'µg'/'µmol' entries below, since this map runs
  // longest-first per coreNormalize step 2 and the bare-prefix entries
  // would otherwise eat the leading 'µ' and leave an orphan '/X' tail.
  'μg/dL': 'micrograms per deciliter', 'µg/dL': 'micrograms per deciliter',
  'μg/mL': 'micrograms per milliliter', 'µg/mL': 'micrograms per milliliter',
  'μg/kg': 'micrograms per kilogram', 'µg/kg': 'micrograms per kilogram',
  'μg/L': 'micrograms per liter', 'µg/L': 'micrograms per liter',
  'μmol/L': 'micromoles per liter', 'µmol/L': 'micromoles per liter',
  'μmol/g': 'micromoles per gram', 'µmol/g': 'micromoles per gram',
  'μmol/mL': 'micromoles per milliliter', 'µmol/mL': 'micromoles per milliliter',
  'μIU/mL': 'micro international units per milliliter', 'µIU/mL': 'micro international units per milliliter',
  'μIU/L': 'micro international units per liter', 'µIU/L': 'micro international units per liter',
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
  'TET':    'tet',        // ten-eleven translocation (TET2 CHIP gene)
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

  // 1c. Currency. Without this pass, "$50,000" survives as a literal "$"
  // attached to the spelled-out number; Google TTS reads "$N" as
  // "N dollars" (always plural), which mispronounces compound-adjective
  // uses like "$15,000–$50,000 annual membership" as "…dollars annual
  // membership". Spell the amount + "dollar(s)" inline so the synth
  // never sees a bare "$".
  //
  // Pluralization heuristic:
  //   • Range ($X–$Y) followed by a lowercase noun → compound adjective,
  //     singular ("X to Y dollar <noun>").
  //   • Range followed by " per " → rate, plural ("X to Y dollars per…").
  //   • Range at end-of-clause → plural.
  //   • Single $NNN → plural (the dominant case; "for under $500",
  //     "costs $50M"). Compound-adjective singulars with a single
  //     amount ("a $50,000 plan") are rare and stay plural until a
  //     real example shows up.
  const _currExpand = (numStr, mag) => {
    const w = convertNumber(numStr);
    if (mag === 'K') return `${w} thousand`;
    if (mag === 'M') return `${w} million`;
    if (mag === 'B') return `${w} billion`;
    return w;
  };
  t = t.replace(
    /\$(\d+(?:\.\d+)?)([KMB])?\s*[-–—]\s*\$(\d+(?:\.\d+)?)([KMB])?(?=(\s+per\b|\s+[a-z]|\s|$|[^\w]))/g,
    (_match, n1, m1, n2, m2, lookahead) => {
      const w1 = _currExpand(n1, m1);
      const w2 = _currExpand(n2, m2);
      // Compound adjective: range + lowercase noun (not "per") → singular.
      if (/^\s+[a-z]/.test(lookahead) && !/^\s+per\b/.test(lookahead)) {
        return `${w1} to ${w2} dollar`;
      }
      return `${w1} to ${w2} dollars`;
    }
  );
  t = t.replace(/\$(\d+(?:\.\d+)?)([KMB])?/g, (_match, n, m) => {
    return `${_currExpand(n, m)} dollars`;
  });

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

  // 4b. Compound-adjective mass units ("two 30-g meals" → "two thirty-gram
  //     meals", not "thirty-grams meals"). The number+unit pair is joined by
  //     a hyphen and modifies a following noun, so the unit stays singular.
  //     Must run before the standard units pass (step 5) — that pass leaves
  //     hyphen-joined pairs alone, after which number conversion turns "30"
  //     into "thirty" and the standalone-unit pass turns "g" into "grams",
  //     producing the wrong "thirty-grams meals".
  const MASS_UNIT_SINGULAR = {
    'g': 'gram', 'mg': 'milligram', 'kg': 'kilogram',
    'µg': 'microgram', 'μg': 'microgram', 'mcg': 'microgram',
    'ng': 'nanogram', 'pg': 'picogram',
  };
  const sortedMassSing = Object.entries(MASS_UNIT_SINGULAR).sort((a, b) => b[0].length - a[0].length);
  for (const [unit, singular] of sortedMassSing) {
    const pattern = new RegExp(`\\b(\\d+\\.?\\d*)-${escapeRegex(unit)}(?=\\s+[a-z])`, 'g');
    t = t.replace(pattern, (_, num) => `${convertNumber(num)}-${singular}`);
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

  // 8b. Read bare 4-digit numbers in the calendar-year range as years
  //     (1996 → "nineteen ninety-six", 2023 → "twenty twenty-three").
  //     Unit-bound and currency numbers have already been rewritten by
  //     earlier passes, so any standalone 1500–2099 here is almost
  //     always a year in this corpus.
  t = t.replace(/\b(1[5-9]\d{2}|20\d{2})\b/g, (m) => {
    const w = yearToWords(parseInt(m, 10));
    return w == null ? m : w;
  });

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

  // 10a. Multi-word digit-spelling chains. When 3+ number-words (with
  // optional "point"/"oh") are joined by hyphens, the source is spelling
  // a digit / digit-group sequence, not encoding pairwise ranges.
  // Examples: "one-point-one-four" (1.14), "zero-point-eight-seven" (0.87),
  // "rs-seven-six-two-five-five-one" (rsID), "one-fifty-eight" (Val158Met
  // position), "twelve-ninety-five" (CJC-1295), "C-A-one-twenty-five"
  // (CA-125), "valine-one-fifty-eight-methionine" (Val158Met).
  // Optional non-number-word preamble (one token + hyphen) and a trailing
  // non-number-word suffix (one hyphen + token) are folded into the run
  // so "rs-seven..." reads as "rs seven..." and "...eight-methionine"
  // reads as "...eight methionine". Must precede the pairwise range
  // rule below.
  const NUM_OR_PT = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|point|oh)';
  const CHAIN_RE = new RegExp(`(?:\\b\\w+[-–])?(?:${NUM_OR_PT})(?:[-–](?:${NUM_OR_PT})){2,}(?:[-–]\\w+\\b)?`, 'gi');
  t = t.replace(CHAIN_RE, (match) => match.replace(/[-–]/g, ' '));

  // 10a-bis. Decimal-pair digit-spelling after "point": e.g. "zero point
  // two-six" (0.26) and "one point six-five" (1.65) are digit-spelled
  // pairs, not ranges. Without this guard the pair would become
  // "...point two to six...". Looks back for "point " preceding a
  // hyphen-joined ONES-ONES pair.
  t = t.replace(/\b(point)\s+([a-z]+)\s*[-–]\s*([a-z]+)\b/gi, (match, pt, a, b) => {
    const al = a.toLowerCase(), bl = b.toLowerCase();
    const NW = ['zero','one','two','three','four','five','six','seven','eight','nine'];
    if (NW.includes(al) && NW.includes(bl)) return `${pt} ${a} ${b}`;
    return match;
  });

  // 10b. Replace number ranges with "to" (e.g. "five-ten" → "five to ten")
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
    // Spoken compound 3-digit numbers: "one-eighty" (180), "four-thirty"
    // (430), "twelve-ninety" (1290). ONES/TEEN + TENS_PREFIX is always
    // a spoken N-hundred-M form, never a range.
    if ((ONES_WORDS.has(al) || (NUMBER_WORDS.has(al) && !TENS_PREFIXES.has(al) && !MULTIPLIERS.has(al))) && TENS_PREFIXES.has(bl)) return `${a} ${b}`;
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
  // 4+ letter ALL-CAPS tokens that ARE English words but should letter-spell
  // anyway because the field reads them as acronyms (BRCA→B-R-C-A is in the
  // gene-rule above; this list is for surprise word/acronym collisions like
  // EORTC, AICR, etc. — currently empty; add as collisions surface).
  const LETTER_SPELL_OVERRIDE = new Set([]);
  // Skip matches inside SSML elements whose contents are
  // pronunciation-prescribed (sub alias / say-as / existing phoneme).
  // Without this guard the catch-all would letter-spell SSRI to S-S-R-I
  // even when the author already wrapped it as
  // `<sub alias="ess ess R I">SSRI</sub>`, leaving a redundant hyphenated
  // string inside the sub element that subsequent passes can't recover
  // back to the natural form. See WRAP_GUARDS in postprocessForTTS for
  // the matching protection on the phoneme/sub/say-as wraps themselves.
  t = t.replace(/\b([A-Z]{3,})\b(?![^<>]*>)(?![^<]*<\/(?:phoneme|sub|say-as)>)/g, (match) => {
    if (SKIP_UPPERCASE.has(match)) return match;
    // 4+ letter ALL-CAPS tokens: authors emphasize drug/gene/term names by
    // capping them in source text (figure labels: CONVENTIONAL / TREAT
    // EARLY / EZETIMIBE; narration emphasis: INSULIN / RESILIENCE). Without
    // this check, every such token landed on a hand-curated downcase list
    // in each consumer (PL's tts-normalize.mjs had ~80 entries). Auto-
    // downcase when the lowercased form is recognized by any of three
    // sources: (a) the bundled English wordlist (CONVENTIONAL, INSULIN),
    // (b) CAFMI's CLINICAL_IPA dict (EZETIMIBE / EVOLOCUMAB — domain
    // drug names with their own phoneme wraps in postprocess), (c) OMIC_IPA
    // (gene/protein names). 3-letter tokens keep the old behavior — too
    // many short clinical acronyms (LDL, CRP, GFR, etc.) for the check to
    // be safe at that length.
    if (match.length >= 4 && !LETTER_SPELL_OVERRIDE.has(match)) {
      const lower = match.toLowerCase();
      if (_englishWords().has(lower)) return lower;
      if (CLINICAL_IPA[lower] || OMIC_IPA[lower]) return lower;
      // Word-pronounced learned-ipa entries (BEIR → /bɪər/, UNSCEAR →
      // /ʌnˈskɛər/, etc.) mean the token reads as a word, not letter-by-
      // letter. Skip the letter-spell so the postprocess learned-ipa
      // pass can wrap the uppercase form with the correct IPA.
      const learned = _learnedIPA[lower];
      if (learned && learned.source !== 'auto-letter-spell' && learned.source !== 'auto-glue') {
        return match;
      }
    }
    return match.split('').join('-');
  });

  // 12. Replace em-dashes with a comma + short break (150 ms gives a
  // clear rhetorical pause without feeling like a full sentence stop).
  t = t.replace(/\s*—\s*/g, ', <break time="150ms"/> ');

  // 12a. Long comma-separated lists — inject <break> after each comma.
  // Chirp 3 HD sometimes swallows the first 1–2 commas in a long list
  // ("…healthspan — exercise, caloric restriction, sauna, …" reads as
  // "exercise caloric restriction" with no pause), even though it pauses
  // correctly later in the same list. The prosody model appears to treat
  // a tight comma run as one constituent when the list-introduction
  // signal is weak. Force the pacing with an explicit short break at
  // each comma whenever we detect a run of 4+ short items.
  //
  // Heuristic: 4+ consecutive comma-separated segments, each 1–5 words
  // of [\w'-] characters. Runs at this stage of coreNormalize — phoneme
  // tags haven't been inserted yet by postprocessForTTS, so the regex
  // sees plain words and matches cleanly. Threshold of 4 items keeps
  // ordinary prose ("after dinner, we went home") untouched.
  t = t.replace(
    /((?:\b[\w'-]+(?:\s+[\w'-]+){0,4},\s+){3,}\b[\w'-]+(?:\s+[\w'-]+){0,4}\b)/g,
    (match) => match.replace(/,\s+/g, ', <break time="100ms"/> ')
  );

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
    'cystatin C',
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

// Read/write at the package's own data dir. When consumers want to
// contribute back to the shared dictionary, they `npm link` this
// package — node_modules/@bioscope/tts-normalize becomes a symlink to
// their local clone, so __dirname resolves to the shared repo's
// working tree and writes here go straight to source. CI consumers
// (npm install from git+https) get a read-only copy that's wiped on
// next install — fine, since CI isn't the canonical write path.
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
  // Sort keys so the file diffs cleanly between runs.
  const sorted = {};
  for (const k of Object.keys(_learnedIPA).sort()) sorted[k] = _learnedIPA[k];
  fs.writeFileSync(LEARNED_IPA_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf-8');
}

// ─── AUTO-DISCOVERED IPA ─────────────────────────────────────────────
// When the catch-all letter-spell wrap (in postprocessForTTS) builds an
// IPA for an unfamiliar acronym, persist it back to data/learned-ipa.json
// so all consumers (e.g. the Precision Longevity course and CAFMI)
// inherit the entry on next `npm update` (or immediately, if they're
// using `npm link` to a shared clone). findPronounceableAcronyms
// ignores `auto-glue` entries, so they remain eligible for later upgrade
// to a word-pronounced IPA via resolveAndPersistAcronyms.

let _autoDiscoveredCount = 0;

function autoDiscover(word, ipa) {
  const key = word.toLowerCase();
  if (_learnedIPA[key]) return; // already in the dict
  addLearnedIPA(word, ipa, 'auto-glue');
  _autoDiscoveredCount++;
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
  // Keep this filter permissive — its only job is to skip tokens the
  // LLM would obviously letter-spell (no vowels, all-consonant runs)
  // so we don't pay for hopeless calls. Anything plausibly word-shaped
  // gets forwarded; the LLM has the final say. Authoring rule: be
  // surprised if a real English word is excluded here.
  const word = token.replace(/-/g, '').replace(/\d+$/, '');
  if (word.length < 2 || word.length > 9) return false;
  if (!/^[A-Z]+$/.test(word)) return false;
  // Need at least one vowel (Y counts) — without one the token is by
  // construction letter-spelled (W-G-S, M-T-H-F-R, T-N-F).
  if (!/[AEIOUY]/.test(word)) return false;
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
  // Strip phoneme tags so hyphenated tokens *inside* the catch-all's
  // <phoneme ph="…">X-Y-Z</phoneme> wraps are still visible to the
  // regex. The catch-all already chose letter-spell IPA for these; if
  // the token is actually pronounceable, we want to upgrade it to a
  // word-pronunciation IPA via LLM resolution.
  const stripped = text.replace(/<phoneme[^>]*>([^<]*)<\/phoneme>/g, '$1');
  const seen = new Set();
  const re = /\b[A-Z](?:-[A-Z0-9])+\b/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const tok = m[0];
    if (seen.has(tok)) continue;
    if (!isPronounceableAcronym(tok)) continue;
    const bare = tok.replace(/-/g, '').toLowerCase();
    const hyphenated = tok.toLowerCase();
    // Already covered by a built-in dict?
    if (CLINICAL_IPA[tok] || CLINICAL_IPA[bare] || CLINICAL_IPA[hyphenated]) continue;
    if (OMIC_IPA[tok] || OMIC_IPA[bare] || OMIC_IPA[hyphenated]) continue;
    // `auto-glue` entries are letter-spell IPAs cached by the catch-all,
    // not authoritative — they remain eligible for upgrade to a word
    // pronunciation. Other learned entries (manual-override, auto-llm,
    // auto-letter-spell) are authoritative and skip the candidate.
    const learned = _learnedIPA[bare] || _learnedIPA[hyphenated];
    if (learned && learned.source !== 'auto-glue') continue;
    seen.add(tok);
  }
  return [...seen];
}

/**
 * Resolve word-pronounceable acronyms in `text` via Claude and persist
 * accepted IPAs to data/learned-ipa.json. This is a higher-level
 * convenience for audio-gen scripts: one call before per-section
 * normalize and the dictionary is upgraded so word pronunciations
 * (PACE → /peɪs/) win over letter-by-letter (P-A-C-E).
 *
 * Required: ANTHROPIC_API_KEY. Persistence writes to this package's
 * own data/learned-ipa.json — when consumers `npm link` to a local
 * clone of this repo, those writes land in the shared working tree and
 * can be committed back. No-op if no candidates are found.
 *
 * Returns { candidates, accepted, rejected } so the caller can log
 * what happened. After this resolves, call reloadLearnedIpa() before
 * normalizing per-section text.
 */
async function resolveAndPersistAcronyms(text, opts = {}) {
  const log = opts.log || console;
  const candidates = findPronounceableAcronyms(text);
  if (!candidates.length) return { candidates: [], accepted: [], rejected: [] };
  if (!process.env.ANTHROPIC_API_KEY) {
    log.warn && log.warn('  ⚠ ANTHROPIC_API_KEY not set; skipping word-pronunciation resolution.');
    return { candidates, accepted: [], rejected: candidates };
  }
  let Anthropic;
  try { ({ default: Anthropic } = await import('@anthropic-ai/sdk')); }
  catch (e) {
    log.warn && log.warn(`  ⚠ @anthropic-ai/sdk not available (${e.message}); skipping resolution.`);
    return { candidates, accepted: [], rejected: candidates };
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const list = candidates.map(c => `- ${c} (collapsed: ${c.replace(/-/g, '')})`).join('\n');
  const prompt = `You are advising a clinical/biomedical TTS pipeline on how acronyms are conventionally pronounced.

The question for each acronym is: when a clinician, researcher, or educated speaker reads this aloud in the relevant field, do they say it as a single word or letter-by-letter? Use established convention, not theoretical pronounceability.

Pronounced as a WORD (return IPA): PACE → /peɪs/, GRACE → /ɡreɪs/, SOFA → /ˈsoʊfə/, FISH → /fɪʃ/, CHIP → /tʃɪp/, SIBO → /ˈsiːboʊ/, NASH /næʃ/, MASH /mæʃ/, AIDS /eɪdz/, MACE /meɪs/, STING /stɪŋ/, NICE /naɪs/, GERD /ɡɜːrd/, AMP /æmp/, RAS /ræs/.

Pronounced LETTER-BY-LETTER (return null) — including when the collapsed form is a real English word but convention spells it: WHO ("double-you-aitch-oh", not "who"), IT, US, FDA, DNA, RNA, WGS, BRCA, HLA, MRI, CT, EKG, CGM, MTHFR, NIH, CDC, NEJM, JAMA, PCOS.

If you're uncertain, prefer the convention used in the relevant clinical or research literature. The goal is to match what speakers actually say. Some collapsed forms that could be sayable are nonetheless letter-spelled (WHO, IT, ABLE), and some that look unlikely are spoken as words (CHIP, SASP). Use your knowledge of the field.

For word pronunciations, give IPA in narrow transcription with primary stress (ˈ). Use standard English phonetic IPA — peɪs, ˈsoʊfə, ɡreɪs, fɪʃ, tʃɪp. No slashes, brackets, or commentary.

For letter-by-letter, return null.

Acronyms to evaluate:
${list}

Respond with ONLY a raw JSON array (no markdown fences, no prose). Field names: "acronym" (hyphenated as in the input) and "ipa":
[
  {"acronym": "P-A-C-E", "ipa": "peɪs"},
  {"acronym": "W-H-O", "ipa": null},
  {"acronym": "D-N-A", "ipa": null}
]`;
  const resp = await client.messages.create({
    model: opts.model || 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });
  const respText = resp.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
  const jsonMatch = respText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    log.warn && log.warn(`  ⚠ LLM response had no JSON array; rejecting all.`);
    return { candidates, accepted: [], rejected: candidates };
  }
  let parsed;
  try { parsed = JSON.parse(jsonMatch[0]); }
  catch (e) {
    log.warn && log.warn(`  ⚠ LLM JSON parse failed: ${e.message}; rejecting all.`);
    return { candidates, accepted: [], rejected: candidates };
  }
  // Tolerate field renaming (ipa / pronunciation / IPA) and acronym
  // hyphen-stripping that some models do.
  const byKey = new Map();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const acro = typeof item.acronym === 'string' ? item.acronym : null;
    if (!acro) continue;
    const ipa = item.ipa ?? item.pronunciation ?? item.IPA ?? null;
    byKey.set(acro, ipa || null);
    byKey.set(acro.replace(/-/g, ''), ipa || null);
  }
  const accepted = [];
  const rejected = [];
  for (const c of candidates) {
    const ipa = byKey.get(c) ?? byKey.get(c.replace(/-/g, '')) ?? null;
    if (ipa && !isValidIpaString(ipa)) {
      log.warn && log.warn(`  ⚠ ${c}: rejecting invalid IPA "${ipa}"`);
      rejected.push(c);
      // Fall through to letter-spell persistence below.
    } else if (ipa) {
      // LLM returned a valid word IPA — persist as the canonical
      // pronunciation. Both bare and hyphenated forms so future direct-
      // text lookups (authored markup) succeed too.
      addLearnedIPA(c.replace(/-/g, ''), ipa, 'auto-llm');
      addLearnedIPA(c, ipa, 'auto-llm');
      accepted.push({ acronym: c, ipa });
      continue;
    } else {
      rejected.push(c);
    }
    // LLM said null OR returned invalid IPA → letter-spell. Persist
    // the buildFastChainIpa result so future runs hit the dict pass
    // directly instead of falling through to the catch-all every time.
    // Tag it source: 'auto-letter-spell' so it's distinguishable from
    // word pronunciations during review.
    const letterIpa = buildFastChainIpa(c);
    if (letterIpa) {
      addLearnedIPA(c, letterIpa, 'auto-letter-spell');
      addLearnedIPA(c.replace(/-/g, ''), letterIpa, 'auto-letter-spell');
    }
  }
  return { candidates, accepted, rejected };
}

// Validate that an IPA string contains only legal IPA characters (plus
// stress marks and the syllable-break dot). Rejects garbage from the
// LLM that would poison the dictionary.
// Permissive IPA validation: allow any Unicode letter (covers ASCII
// letters, æ ø ç in Latin-1 Supplement, IPA Extensions ɐɛɪɔ…, the
// extended Latin needed for some glyphs), any combining mark (stress,
// tone, nasalization), plus the IPA syllable break dot and whitespace.
// We deliberately don't try to deeply validate IPA correctness — the
// goal is to reject obvious garbage (LLM returning a sentence or
// punctuation-heavy string) before persisting to the shared dict.
const _IPA_CHARSET = /^[\p{Letter}\p{Mark}.\s]+$/u;
function isValidIpaString(ipa) {
  if (!ipa || typeof ipa !== 'string') return false;
  if (ipa.length < 2 || ipa.length > 30) return false;
  if (!_IPA_CHARSET.test(ipa)) return false;
  // Reject if it's just ASCII letters with no IPA-specific marks —
  // that suggests the model returned the spelling, not IPA.
  if (/^[a-zA-Z]+$/.test(ipa)) return false;
  return true;
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
 * Returns a summary of auto-glue discoveries from the current process.
 * Useful for audio-gen scripts that want to commit + push the change
 * back to the shared repo. addLearnedIPA writes synchronously per-call,
 * so there's no buffered state to flush — this just hands back metadata.
 */
function flushAutoDiscoveredIpa() {
  if (_autoDiscoveredCount === 0) return { written: false, count: 0 };
  const out = { written: true, count: _autoDiscoveredCount, path: LEARNED_IPA_PATH };
  _autoDiscoveredCount = 0;
  return out;
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
  // SGLT2i — sodium-glucose cotransporter-2 inhibitor class. The trailing
  // lowercase "i" is the clinician shorthand for "inhibitor(s)"; left bare
  // Chirp slurs the whole token. Rewrite to the expanded form, which then
  // flows through the post-core letter-spell + "L"-recovery for SGLT-2.
  'SGLT2i': 'SGLT-2 inhibitors',
  'SGLT-2i': 'SGLT-2 inhibitors',
  // LC3-II / LC3-I autophagy ratio.
  'LC3-II/LC3-I': 'L-C three, two over L-C three, one',
  'LC3-II / LC3-I': 'L-C three, two over L-C three, one',
  // LC-MS — liquid-chromatography mass spectrometry. Bare "LC-MS"
  // survives the core (only one inter-letter hyphen, so the catch-all
  // \b[A-Z](?:-[A-Z0-9])+\b doesn't match) and Chirp reads it as a
  // single mumbled token. Clinicians say "L-C mass spec" — letter-spell
  // the L-C and pronounce "spec" as the word /spɛk/ ("speck") so Chirp
  // doesn't letter-spell it.
  'LC-MS': 'L-C mass speck',
  'LC/MS': 'L-C mass speck',
  'GC-MS': 'G-C mass speck',
  'GC/MS': 'G-C mass speck',
  // Interventional-cardiology word-pronounced acronyms. NIRS = "neers"
  // /nɪərz/ (near-infrared spectroscopy, rhymes with "ears"); IVUS =
  // "EYE-vus" /ˈaɪvəs/ (intravascular ultrasound). Standard cath-lab
  // usage at TCT/CRT and in Infraredx/Nipro product literature. Has to
  // live in PRE_ABBREVIATIONS — leaving NIRS bare to the post-core
  // letter-spell pass lets the existing "IRS" entry in learned-ipa.json
  // grab the trailing 3 letters and produce "N + I-R-S". Same trap for
  // IVUS (FAST_GLUE_ACRONYMS has "VUS" for variant-of-uncertain-
  // significance, so an unhandled "IVUS" splits to "I + V-U-S").
  // Longest-first sort guarantees "NIRS-IVUS" wins over the singletons.
  'NIRS-IVUS': '<phoneme alphabet="ipa" ph="nɪərz">neers</phoneme> <phoneme alphabet="ipa" ph="ˈaɪvəs">eye-vus</phoneme>',
  'NIRS':      '<phoneme alphabet="ipa" ph="nɪərz">neers</phoneme>',
  'IVUS':      '<phoneme alphabet="ipa" ph="ˈaɪvəs">eye-vus</phoneme>',
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
  // HIPAA moved to data/learned-ipa.json (IPA /ˈhɪpə/) so the
  // postprocess phoneme-tag pass owns the pronunciation. Leaving the
  // literal "hippa" rewrite here masked the IPA wrap.
  'CLIA':  'cleea',
  // Cerbo (EMR) moved to CLINICAL_IPA with /ˈsɜːrboʊ/ — Chirp HD treated
  // the literal "sir-bo" with a clipped short-O; IPA holds the long-O
  // boʊ diphthong cleanly.
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
  // apoC-III — hyphenated form. Catch here, before the Roman-numeral
  // pass letter-spells "III" into "I-I-I" and the POST_OVERRIDES
  // wrapper for "apoCIII" can't find the original token. PascalCase
  // and bare forms are handled in POST_OVERRIDES.
  'apoC-III': 'apoCIII',
  'ApoC-III': 'apoCIII',
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

  // Nrf2 — nuclear factor erythroid 2-related factor 2. Capitalization
  // is inconsistent in source text (Nrf2 / NRF2 / nrf2 / NRF-2 / Nrf-2);
  // Chirp HD reads "nrf2" as gibberish and the optional hyphen confuses
  // the gene-number regex. Normalize every variant to a clearly-enunciated
  // letter-spelled IPA wrap ("en-arr-eff two") so the pronunciation is
  // locked regardless of how the author typed it.
  t = t.replace(/\b[Nn][Rr][Ff]-?2\b/g, '<phoneme alphabet="ipa" ph="ˌɛnˈɑːr">N-R</phoneme><phoneme alphabet="ipa" ph="ˌɛfˈtuː">F-2</phoneme>');

  // ACTN-family genes (ACTN1–ACTN4 — alpha-actinin 1–4; ACTN3 is the
  // R577X-bearing fast-twitch isoform). Five-character mixed letter+digit
  // tokens slur in Chirp HD; the digit-3 case in particular bleeds into
  // the trailing "N" without explicit grouping. Concat two 2-phone tags
  // ("A-C", "T-N") + spoken number, matching the house pattern for
  // ≥3-character acronyms. Covers ACTN3 / Actn3 / actn3 / ACTN-3.
  t = t.replace(/\b[Aa][Cc][Tt][Nn]-?(\d+)\b/g, (_, n) =>
    '<phoneme alphabet="ipa" ph="ˌeɪˈsiː">A-C</phoneme>' +
    '<phoneme alphabet="ipa" ph="ˌtiːˈɛn">T-N</phoneme>' +
    ` ${numWord(parseInt(n, 10))}`);

  // SIRT-family genes — colloquial single-syllable "sirt" + number (not
  // "sirtuin one", not letter-spelled "S-I-R-T one"). Wrap "sirt" in an
  // IPA phoneme tag so Chirp HD locks the /sɜːrt/ pronunciation (the
  // bare word "sirt" is otherwise ambiguous to the synth). The trailing
  // number is left as a plain English word — including its IPA would
  // require θ for "three", which collides with the Greek-letter pass.
  t = t.replace(/\bSIRT(\d+)\b/g, (_, n) => {
    return `<phoneme alphabet="ipa" ph="sɜːrt">sirt</phoneme>-${numWord(parseInt(n, 10))}`;
  });

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

  // R577X — ACTN3 variant; 3-digit position must be spoken digit-by-digit
  // ("are-five-seven-seven-ex"), not as the word "five seventy-seven".
  // Must precede the generic Letter-digit-letter regex below.
  t = t.replace(/\bR577X\b/g,
    '<phoneme alphabet="ipa" ph="ɑːr">R</phoneme>' +
    '<phoneme alphabet="ipa" ph="faɪv">5</phoneme>' +
    '<phoneme alphabet="ipa" ph="ˈsɛvən">7</phoneme>' +
    '<phoneme alphabet="ipa" ph="ˈsɛvən">7</phoneme>' +
    '<phoneme alphabet="ipa" ph="ɛks">X</phoneme>');

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
  // mTOR — letter "M" + word "tore" ("EM-tore"), single fluid token.
  // Primary stress on the leading "m" (the letter), secondary on
  // "tore" — matches how clinicians say it.
  // PRE_ABBREVIATIONS rewrites mTOR → m-TOR / mTORC1 → m-TORC-one
  // before CLINICAL_IPA runs, so all entries are keyed on the
  // post-split hyphenated form.  The bare un-hyphenated forms are
  // kept as belt-and-suspenders in case PRE_ABBREVIATIONS is bypassed.
  'm-TORC-one': 'ˈɛmˌtɔːrsiːwʌn',
  'm-TORC-two': 'ˈɛmˌtɔːrsiːtuː',
  'm-TOR':      'ˈɛmˌtɔːr',
  'mTORC1':     'ˈɛmˌtɔːrsiːwʌn',
  'mTORC2':     'ˈɛmˌtɔːrsiːtuː',
  'mTOR':       'ˈɛmˌtɔːr',
  // ─── Acronyms read as a single word in clinical / scientific use.
  // All keyed on the post-core hyphenated form (the core letter-spells
  // bare acronyms like CPIC into C-P-I-C before postprocess sees them).
  // The auto-wrap fallback later in postprocess would emit a fluid
  // letter spell for these otherwise — these explicit entries override
  // with the actual word pronunciation.
  'C-A-P':     'kæp',          // Controlled Attenuation Parameter (FibroScan CAP score)
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
  // AI's — possessive of "AI". Without this entry, the bare "AI" gets
  // wrapped in <phoneme>…</phoneme> and the trailing 's is read as a
  // separate letter "S" ("AY-eye S"). Wrap the whole token so the
  // apostrophe-s renders as a possessive sibilant ("AY-eyez").
  "AI's":      'ˈeɪˌaɪz',
  "AIs":       'ˈeɪˌaɪz',
  // Firmicutes — Latin binomial, the dominant gut bacterial phylum
  // alongside Bacteroidetes. Clinical pronunciation rhymes with
  // "fer-MICK-you-teez" ("fer" as in Fermi).
  'Firmicutes': 'fɜːrˈmɪkjuːtiːz',
  'firmicutes': 'fɜːrˈmɪkjuːtiːz',
  // Cerbo — concierge-specialty EMR. Brand pronunciation is "SIR-boh"
  // with a long-O diphthong on the second syllable. Earlier attempt
  // /ˈsɜːrboʊ/ landed as "SAR-bo" on Chirp HD (the /ɜːr/ flattened toward
  // /ɑː/ before the stop). Rhotic stressed schwa /ɝ/ holds the "sir"
  // vowel cleanly — same shape as "Firmicutes" doesn't help here because
  // the consonant tail is different.
  'Cerbo': 'ˈsɝboʊ',
  'cerbo': 'ˈsɝboʊ',
  // LifeOmic — Bioscope's prior company. Spoken "life-OH-mick" with a
  // long-O on the middle syllable. Without IPA Chirp slurs the O into
  // a schwa and the boundary between "life" and "Omic" gets lost.
  'LifeOmic': 'ˌlaɪfˈoʊmɪk',
  'Lifeomic': 'ˌlaɪfˈoʊmɪk',
  'lifeomic': 'ˌlaɪfˈoʊmɪk',
  // SAH — S-adenosylhomocysteine. Read as the three letters "S-A-H"
  // ("ess-ay-aitch"), in pair with SAMe in the methylation panel.
  // Without this entry, something else in the pipeline was wrapping
  // S-A-H with a partial "sæ" phoneme that elided the H entirely.
  'S-A-H':     'ɛseɪˈeɪtʃ',
  'SAH':       'ɛseɪˈeɪtʃ',
  // TREM — Triggering Receptor Expressed on Myeloid cells. Clinical
  // pronunciation rhymes with "trim", not "trem". sTREM2 / sTREM-two
  // are pre-rewritten in POST_OVERRIDES to "soluble TREM two", and
  // the core's all-caps letter-spell pass would otherwise turn the
  // bare TREM into "T-R-E-M". Both the hyphenated post-core form and
  // the bare word get the trim-rhyming IPA.
  'T-R-E-M':   'trɪm',
  'TREM':      'trɪm',
  'trem':      'trɪm',
  'M-A-P-K':   'ˈmæpkeɪ',      // MAP kinase — word "map" + letter K
  // SLCO1B1 moved to POST_OVERRIDES with a <sub alias="…"> rewrite —
  // IPA stress markers weren't enough to keep Chirp HD from slurring
  // the leading S, and adding more `ˌ` made no audible difference.
  // The <sub> approach hands Chirp natural English words, which it
  // articulates crisply.
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
  // cystatin — protease inhibitor family; cystatin C is the renal-function
  // marker. Clinical pronunciation rhymes with the drug-class "statin":
  // "sis-TAT-in" /sɪˈstætɪn/. CLINICAL_IPA matches case-insensitively, so
  // one entry covers cystatin / Cystatin / CYSTATIN. The phrase entry
  // "cystatin-C" (HYPHENATE_TERMS converts the space to a hyphen upstream)
  // wraps the whole biomarker — including the letter "C" (/siː/) — in one
  // phoneme tag so the synth doesn't handle the trailing letter on its own.
  'cystatin-C': 'sɪˈstætɪn siː',
  'cystatin':   'sɪˈstætɪn',
  'cystatins':  'sɪˈstætɪnz',
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
  // patent — adjective form (open / unobstructed lumen), long-A
  // ("PAY-tent" /ˈpeɪtənt/). Chirp HD defaults to the noun reading
  // ("PAT-ent"), which is wrong in every clinical context.
  'patent':  'ˈpeɪtənt',
  'Patent':  'ˈpeɪtənt',
  'patency': 'ˈpeɪtənsi',
  'Patency': 'ˈpeɪtənsi',
  // Remi — clinical-AI-team persona name. Short-e /ɛ/ ("REH-mee").
  'Remi': 'ˈrɛmi',
  'remi': 'ˈrɛmi',
  // APOE / APOB — clinicians say "AY-poh-EE" / "AY-poh-BEE" (one fluid
  // utterance with the /p/ flowing between vowels — not letter-spelled
  // A-P-O-B). Course-local ABBREVIATIONS additionally pre-wraps the
  // mixed-case forms (apoB / ApoB / APOB; same for apoE) so the FAST
  // letter-spell pass doesn't fire on them.
  'A-P-O-E': 'ˌeɪpoʊˈiː',
  'A-P-O-B': 'ˌeɪpoʊˈbiː',
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
  'sulforaphane':    'sʌlˈfɔːrəfeɪn',
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
  'ezetimibe':       'ɛˈzɛtɪˌmaɪb',
  // ─── Medication IPA additions — generic drug names that survive past
  // the gene/acronym pre-passes and would otherwise get stress-misplaced
  // by Chirp HD on first encounter. Grouped by class for maintenance.
  // Statins (atorvastatin / simvastatin / rosuvastatin already above).
  'pravastatin':       'ˌprævəˈstætɪn',
  // Lipid-lowering monoclonals + RNAi/ASO/oral apo(a)-disruption agents.
  'alirocumab':        'ˌæləˈroʊkjuːmæb',
  'evolocumab':        'ˌɛvoʊˈloʊkjuːmæb',
  'inclisiran':        'ɪnˈklɪsɪˌræn',
  'pelacarsen':        'ˌpɛləˈkɑːrsɛn',
  'olpasiran':         'ˌoʊlpəˈsaɪˌræn',
  'lepodisiran':       'ˌlɛpoʊˈdaɪsɪˌræn',
  'muvalaplin':        'ˌmuːvəˈlæplɪn',
  'bempedoic':         'ˌbɛmpəˈdoʊɪk',
  // Anti-inflammatory monoclonals (canakinumab IL-1β; ziltivekimab IL-6).
  'canakinumab':       'ˌkænəˈkɪnjuːmæb',
  'ziltivekimab':      'ˌzɪltɪˈvɛkɪmæb',
  // Anti-inflammatory small molecules.
  'colchicine':        'ˈkɒltʃəsiːn',
  'methotrexate':      'ˌmɛθəˈtrɛkˌseɪt',
  // Omega-3 (EPA-only).
  'icosapent':         'ˌaɪkoʊˈsæpɛnt',
  // SGLT2 inhibitors — gliflozins.
  'empagliflozin':     'ɛmˌpæɡlɪˈfloʊzɪn',
  'dapagliflozin':     'ˌdæpəɡlɪˈfloʊzɪn',
  // Anticoagulants — DOACs + warfarin + heparin + aspirin.
  'warfarin':          'ˈwɔːrfərɪn',
  'apixaban':          'əˈpɪksəˌbæn',
  'rivaroxaban':       'ˌrɪvəˈrɒksəˌbæn',
  'dabigatran':        'dæˈbɪɡəˌtræn',
  'edoxaban':          'ɛˈdɒksəˌbæn',
  'heparin':           'ˈhɛpərɪn',
  'aspirin':           'ˈæspərɪn',
  // Antiplatelets.
  'clopidogrel':       'kloʊˈpɪdoʊɡrɛl',
  // ACE inhibitor — lisinopril (most-prescribed antihypertensive in US).
  'lisinopril':        'laɪˈsɪnəˌprɪl',
  // Beta blocker — metoprolol (cardio-selective β1).
  'metoprolol':        'məˈtoʊprəˌlɒl',
  // Non-DHP calcium-channel blockers.
  'verapamil':         'vəˈræpəˌmɪl',
  'diltiazem':         'dɪlˈtaɪəzɛm',
  // Dihydropyridine CCB — amlodipine.
  'amlodipine':        'æmˈloʊdɪˌpiːn',
  // IL-6 receptor monoclonal — tocilizumab (RA, COVID-19, CRS).
  'tocilizumab':       'ˌtoʊsɪlˈɪzuːˌmæb',
  // HIV antiretrovirals (NRTI + PI).
  'abacavir':          'əˈbækəˌvɪr',
  'atazanavir':        'ˌætəˈzænəˌvɪr',
  // Mineralocorticoid-receptor antagonists.
  'finerenone':        'faɪˈnɛrəˌnoʊn',
  // Sex hormones (estradiol / testosterone-cypionate-enanthate-undecanoate above).
  'estriol':           'ˈɛstriˌɒl',
  'estrone':           'ˈɛstroʊn',
  'progesterone':      'proʊˈdʒɛstəˌroʊn',
  'testosterone':      'tɛˈstɒstəˌroʊn',
  'tamoxifen':         'təˈmɒksəˌfɛn',
  // Glucocorticoids / mineralocorticoids.
  'hydrocortisone':    'ˌhaɪdroʊˈkɔːrtɪˌsoʊn',
  'fludrocortisone':   'ˌfluːdroʊˈkɔːrtɪˌsoʊn',
  // Glycemic emergency hormone.
  'glucagon':          'ˈɡluːkəˌɡɒn',
  // B3 vitamin / lipid agent.
  'niacin':            'ˈnaɪəsɪn',
  // Sleep / circadian peptides.
  'melatonin':         'ˌmɛləˈtoʊnɪn',
  'oxytocin':          'ˌɒksɪˈtoʊsɪn',
  // PTH analogue (long-acting).
  'palopegteriparatide': 'ˌpæloʊpɛɡˌtɛrɪˈpærəˌtaɪd',
  // Antidepressants — SSRIs and others.
  'sertraline':        'ˈsɜːrtrəliːn',
  'citalopram':        'saɪˈtæləˌpræm',
  'escitalopram':      'ˌɛsaɪˈtæləˌpræm',
  'fluoxetine':        'fluːˈɒksəˌtiːn',
  'bupropion':         'bjuːˈproʊpiˌɒn',
  'mirtazapine':       'mɪrˈtæzəˌpiːn',
  'trazodone':         'ˈtræzəˌdoʊn',
  // Anti-seizure / mood stabilizer.
  'carbamazepine':     'ˌkɑːrbəˈmæzəˌpiːn',
  'lithium':           'ˈlɪθiəm',
  // Macrolide antibiotics (CYP3A4 / P-gp interactions with colchicine).
  'clarithromycin':    'kləˌrɪθroʊˈmaɪsɪn',
  'erythromycin':      'ɪˌrɪθroʊˈmaɪsɪn',
  // PPI.
  'omeprazole':        'oʊˈmɛprəˌzoʊl',
  // Opioids.
  'codeine':           'ˈkoʊdiːn',
  'tramadol':          'ˈtræməˌdɒl',
  // Difficult biology / measurement terms.
  'autophagy':       'ɔːˈtɒfədʒi',
  'mitophagy':       'maɪˈtɒfədʒi',
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
  // "LYE-poh-PROH-teen" — long-i on the first syllable. Both LIP- and LYE-
  // are listed in major dictionaries; the course faculty prefers the LYE-
  // form, so we render it that way here.
  'lipoprotein':     'ˌlaɪpoʊˈproʊˌtiːn',
  'lipoproteins':    'ˌlaɪpoʊˈproʊˌtiːnz',
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
  // DNMT3A / ASXL1 now expand to comma-separated letter form in
  // ABBREVIATIONS (e.g. "D, N, M, T, three, A") so Chirp's punctuation-
  // driven prosodic pauses guarantee letter-by-letter articulation. The
  // hyphenated CLINICAL_IPA overrides we tried previously are no longer
  // matched and have been removed.
  // (ANA / CCP / SRSF2 use the same concatenated 2-phone <phoneme>
  // chunks as DNMT3A / ASXL1 — see ABBREVIATIONS, where the SSML lives.
  // Single multi-foot IPAs flattened audibly under Chirp 3 HD.)
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
  'LDL', 'HDL', 'VLDL',
  // Endocrine receptor families.
  'GLP', 'SGLT',
  // MHC class-II beta chain.
  'HLA', 'DRB',
  // MR-PDFF fragments.
  'MR', 'PDFF',
  // Standardized mortality ratio — the 'MR' tail above would otherwise
  // wrap only the M-R, leaving a bare leading "S-" that Chirp slurs into
  // the next phoneme ("S-em-ar" → "sim-are").
  'SMR',
  // BCG (Bacillus Calmette-Guérin) — same shape: 'c-g' auto-glue entry
  // in learned-ipa wraps just C-G, leaving bare "B-" that slurs into
  // the IPA. Register the full chain so it beats the partial.
  'BCG',
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
  // Contractions — apostrophe (straight or curly) confuses the letter-spell
  // pass; pin pronunciation with IPA so the synth never stumbles.
  "You'll":  '<phoneme alphabet="ipa" ph="juːl">You\'ll</phoneme>',
  "you'll":  '<phoneme alphabet="ipa" ph="juːl">you\'ll</phoneme>',
  "You’ll": '<phoneme alphabet="ipa" ph="juːl">You’ll</phoneme>',
  "you’ll": '<phoneme alphabet="ipa" ph="juːl">you’ll</phoneme>',
  "You're":  '<phoneme alphabet="ipa" ph="jɔːr">You\'re</phoneme>',
  "you're":  '<phoneme alphabet="ipa" ph="jɔːr">you\'re</phoneme>',
  "You’re": '<phoneme alphabet="ipa" ph="jɔːr">You’re</phoneme>',
  "you’re": '<phoneme alphabet="ipa" ph="jɔːr">you’re</phoneme>',
  "You've":  '<phoneme alphabet="ipa" ph="juːv">You\'ve</phoneme>',
  "you've":  '<phoneme alphabet="ipa" ph="juːv">you\'ve</phoneme>',
  "You’ve": '<phoneme alphabet="ipa" ph="juːv">You’ve</phoneme>',
  "you’ve": '<phoneme alphabet="ipa" ph="juːv">you’ve</phoneme>',
  "You'd":   '<phoneme alphabet="ipa" ph="juːd">You\'d</phoneme>',
  "you'd":   '<phoneme alphabet="ipa" ph="juːd">you\'d</phoneme>',
  "You’d":  '<phoneme alphabet="ipa" ph="juːd">You’d</phoneme>',
  "you’d":  '<phoneme alphabet="ipa" ph="juːd">you’d</phoneme>',
  "We've":   '<phoneme alphabet="ipa" ph="wiːv">We\'ve</phoneme>',
  "we've":   '<phoneme alphabet="ipa" ph="wiːv">we\'ve</phoneme>',
  "We’ve":  '<phoneme alphabet="ipa" ph="wiːv">We’ve</phoneme>',
  "we’ve":  '<phoneme alphabet="ipa" ph="wiːv">we’ve</phoneme>',
  // RESTQ-Sport — recovery-stress questionnaire; spoken "rest-cue sport".
  'RESTQ-Sport': 'rest-cue sport',
  'RESTQ': 'rest-cue',
  // ICD-10 — diagnosis code system, spoken "eye-see-dee-ten" with clean
  // letter articulation and primary stress on "ten". Core letter-spells
  // "ICD" → "I-C-D" and converts "10" → "ten", giving us the post-core
  // form "I-C-D-ten". POST_OVERRIDES runs before the FAST_GLUE-registered
  // "C-D" wrap (auto-derived from CD8) — without this, that partial wrap
  // captures just "C-D" and Chirp slurs the detached leading "I-".
  'I-C-D-ten': '<phoneme alphabet="ipa" ph="ˌaɪˌsiːˌdiːˈtɛn">I-C-D-ten</phoneme>',
  // Catch ICD-9 too while we're here (rarely used now, but it's still a
  // referenced legacy system; spoken "eye-see-dee-nine").
  'I-C-D-nine': '<phoneme alphabet="ipa" ph="ˌaɪˌsiːˌdiːˈnaɪn">I-C-D-nine</phoneme>',
  // Publication brand — hyphenated form stays as one compound noun.
  'Longevity Today': 'longevity-today',
  // DunedinPACE figure — hyphenate to glue the phrase.
  'one point oh three': 'one-point-oh-three',
  // HLA-DRB1 — POST because the letter-spelled form contains a lone
  // "L" surrounded by hyphens, which the units pipeline would expand
  // to "liters".
  'HLA-DRB1': 'H-L-A-D-R-B-one',
  // SLCO1B1 — hepatic statin-uptake transporter gene. Chirp HD slurs
  // an IPA letter-chain ("ɛs.ɛl.siː.oʊ.wʌn.biː.wʌn") with the leading
  // /s/ buried; secondary-stress marks on every letter didn't help.
  // <sub alias="…"> hands the synth seven natural English words, which
  // it articulates crisply with normal clinical cadence.
  'SLCO1B1': '<sub alias="ess L C O one B one">SLCO1B1</sub>',
  // apoCIII — apolipoprotein C-III. The bare/PascalCase form ("apoCIII"
  // / "ApoCIII") passes through every letter-spell pass (mixed case +
  // Roman-numeral tail) and Chirp mumbles it; the hyphenated form
  // ("apoC-III") is handled earlier in PRE_ABBREVIATIONS so the Roman
  // III isn't letter-spelled into I-I-I before this runs. Read as
  // "ape-O-see-three" — same family shape as apoB / apoE.
  'apoCIII':  '<sub alias="ape oh see three">apoCIII</sub>',
  // Clinical-noun "read" — assessment / quick interpretation. Chirp
  // defaults the past-tense /rɛd/ for ambiguous "read" tokens; pre-
  // rewrite the established noun phrases to "reed" so they speak as
  // /riːd/. Add new phrases here as they show up.
  'microbiome read':  'microbiome reed',
  'immune read':      'immune reed',
  'proteomic read':   'proteomic reed',
  'metabolomic read': 'metabolomic reed',
  'genomic read':     'genomic reed',
  'epigenetic read':  'epigenetic reed',
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
  // so the leading L survives intact. Hyphenated-compound form first
  // ("Lp(a)-directed", "Lp(a)-lowering"): the trailing tail of the
  // expansion ("little-a") would otherwise chain through the compound
  // hyphen into one slurred token. Insert a space so the Lp(a) phrase
  // stays glued ("L-P-little-a" reads fluidly) but the next word stands
  // on its own.
  t = t.replace(/\bLp(?:\(a\)|-a\b)-([a-z])/g, 'L-P-little-a $1');
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

  // Phrase substitutions. The negative lookahead skips any match that
  // already sits inside a <phoneme> wrap, so a later key can't re-wrap
  // the content an earlier key emitted. Without it, the case-insensitive
  // flag plus both-case keys (e.g. "You'll" and "you'll") double-wrap
  // contractions into nested <phoneme> tags — invalid SSML that Chirp
  // then renders by letter-spelling the tail ("you'll" → "you L L").
  for (const [key, val] of Object.entries(POST_OVERRIDES)) {
    t = t.replace(new RegExp(`\\b${escapeRegex(key)}\\b(?![^<]*</phoneme>)`, 'gi'), val);
  }

  // Pause tokens → SSML <break/> tags. Authors write [[pause-short]] /
  // [[pause-medium]] / [[pause-long]]. Lowercase alpha-only placeholders
  // because the core's normalizer strips raw XML/SSML AND expands
  // numeric units inside brackets ("600ms" → "six hundred milliseconds").
  t = t.replace(/\[\[pause-short\]\]/g,  '<break time="300ms"/>');
  t = t.replace(/\[\[pause-medium\]\]/g, '<break time="600ms"/>');
  t = t.replace(/\[\[pause-long\]\]/g,   '<break time="1200ms"/>');

  // Guard string for every \b…\b IPA wrap. Four negative lookaheads in
  // sequence reject matches that would corrupt existing SSML structure:
  //   (?![^<>]*>)        — inside an *open tag* (e.g. attribute area of
  //                        `<sub alias="…">`). Without this, a learned
  //                        entry for a common word colliding with an
  //                        SSML element name (sub, voice, p, s, audio)
  //                        wraps the element name itself, producing
  //                        invalid XML and a Google TTS 400.
  //   (?![^<]*</phoneme>)
  //                      — inside an existing <phoneme>…</phoneme> wrap.
  //                        Prevents nested phoneme tags, which Chirp
  //                        truncates on.
  //   (?![^<]*</sub>)    — inside a <sub alias="…">…</sub> rewrite
  //                        (e.g. SSRI → <sub alias="ess ess R I">SSRI
  //                        </sub>). Without this, the CLINICAL_IPA pass
  //                        re-wraps the inner SSRI and produces nested
  //                        <sub><sub>SSRI</sub></sub> on a second run.
  //   (?![^<]*</say-as>) — inside <say-as>…</say-as>, which authors use
  //                        for explicit pronunciation override.
  const WRAP_GUARDS = '(?![^<>]*>)(?![^<]*</phoneme>)(?![^<]*</sub>)(?![^<]*</say-as>)';

  // Wrap every omics word with an SSML phoneme tag carrying the IPA
  // pronunciation. Google Cloud TTS Neural2 and Chirp 3 HD honor these
  // reliably. The literal word stays inside the tag so any voice that
  // ignores SSML still produces audio (graceful fallback).
  for (const [word, ipa] of OMIC_IPA_SORTED) {
    t = t.replace(new RegExp(`\\b${escapeRegex(word)}\\b${WRAP_GUARDS}`, 'gi'), (match) => {
      return `<phoneme alphabet="ipa" ph="${ipa}">${xmlEscape(match)}</phoneme>`;
    });
  }
  // Same machinery for clinical / scientific words.
  for (const [word, ipa] of CLINICAL_IPA_SORTED) {
    t = t.replace(new RegExp(`\\b${escapeRegex(word)}\\b${WRAP_GUARDS}`, 'gi'), (match) => {
      return `<phoneme alphabet="ipa" ph="${ipa}">${xmlEscape(match)}</phoneme>`;
    });
  }

  // Apply Whisper-discovered IPA entries (learned at runtime from mispronunciation QA).
  // Same phoneme machinery as CLINICAL_IPA; longer keys first.
  //
  // Case sensitivity: entries from `auto-letter-spell` and `auto-glue`
  // sources are letter-spelled acronym IPAs ("IT" → ˌaɪˈtiː, "BOOST" →
  // ˌbiːoʊoʊɛsˈtiː) persisted under a lowercased key. Matching them
  // case-insensitively would substitute the IPA for every English-prose
  // occurrence of the homograph ("it", "us", "who", "boost"…). For
  // these entries, match against the uppercase form with case-sensitive
  // `g` flag. Other sources keep `gi`:
  //   • auto-llm word IPAs are by construction homophonic with the
  //     English word the LLM accepted (PACE → /peɪs/), so firing on
  //     prose is a benign redundant wrap.
  //   • tutorial-* / clinical-migration / omic-migration / manual are
  //     word-shaped scientific terms ("fisetin", "genome", "threonine",
  //     "navitoclax") that must match whatever case the author wrote.
  const learnedIpaSorted = Object.entries(_learnedIPA).sort((a, b) => b[0].length - a[0].length);
  for (const [word, entry] of learnedIpaSorted) {
    const ipa = typeof entry === 'string' ? entry : entry.ipa;
    if (!ipa) continue;
    const source = (typeof entry === 'object' && entry && entry.source) || '';
    const isLetterSpelledAcronym =
      source === 'auto-letter-spell' || source === 'auto-glue';
    const pattern = isLetterSpelledAcronym ? word.toUpperCase() : word;
    const flags = isLetterSpelledAcronym ? 'g' : 'gi';
    t = t.replace(new RegExp(`\\b${escapeRegex(pattern)}\\b${WRAP_GUARDS}`, flags), (match) => {
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
    new RegExp(String.raw`\b[A-Z](?:-[A-Z0-9])+\b${WRAP_GUARDS}`, 'g'),
    (match) => {
      const ipa = buildFastChainIpa(match);
      if (!ipa) return match;
      // Cache the catch-all output back into data/learned-ipa.json so
      // future runs find it pre-resolved. When the consumer is using
      // `npm link` to a local clone of this repo, the write lands in
      // the shared working tree and can be committed up. Marked
      // `auto-glue` so resolveAndPersistAcronyms can still upgrade
      // the entry to a word-pronounced IPA.
      autoDiscover(match, ipa);
      return `<phoneme alphabet="ipa" ph="${ipa}">${xmlEscape(match)}</phoneme>`;
    }
  );

  // SSRI — Chirp HD re-articulates adjacent identical fricatives, so
  // any IPA letter-chain through "S-S" lands with an audible beat
  // between the two /s/'s. Stress-mark tweaks (ˈɛsˌɛs, ˈɛsɛs.ˌɑːr.ˌaɪ)
  // didn't change the output. Switching to a <sub alias="…"> rewrite
  // hands the synth four natural English words and bypasses IPA
  // entirely; Chirp speaks them with normal word cadence.
  t = t.replaceAll(
    '<phoneme alphabet="ipa" ph="ˌɛsɛsɑːrˈaɪ">S-S-R-I</phoneme>',
    '<sub alias="ess ess R I">SSRI</sub>',
  );

  // Hyphenated compounds adjacent to an IPA-wrapped acronym ("AI-based",
  // "APOE-guided", "NK-cell", "post-ASCVD"): Chirp HD treats the whole
  // compound as one prosodic unit and slurs the IPA pronunciation — the
  // leading vowel of "AI" /ˈeɪˌaɪ/ gets eaten so "AI-based" lands as
  // "II-based". Swap the joining hyphen for a space so the synth renders
  // the wrapped term and the adjacent word as distinct utterances. The
  // text the user reads doesn't change; only the SSML stream the synth
  // consumes does.
  //
  // Exception: "little-a" is part of the Lp(a) expansion ("L-P-little-a")
  // and is deliberately hyphen-glued to the wrapped "L-P" so Chirp reads
  // the whole abbreviation as one fluid phrase. Leave that glue intact;
  // the Lp(a)-X compound case is already handled upstream by inserting a
  // space between "little-a" and the next word.
  t = t.replace(/(<\/(?:phoneme|sub|say-as)>)-(?!little-a\b)([a-z])/g, '$1 $2');
  t = t.replace(/([a-z])-(<(?:phoneme|sub|say-as)\b)/g, '$1 $2');

  return t;
}

// ─── PUBLIC ENTRYPOINT ──────────────────────────────────────

function _debugCore(text) { return coreNormalize(preprocessForTTS(text)); }
module.exports._debugCore = _debugCore;

// ════════════════════════════════════════════════════════════
// SPANISH (es) NORMALIZATION — v1: numbers, units, symbols.
// Locale-gated; the English pipeline above is untouched. No IPA /
// acronym-pronunciation layer (Spanish TTS reads words phonetically).
// ════════════════════════════════════════════════════════════

const ES_ONES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte',
  'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const ES_TENS = ['', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const ES_HUNDREDS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos',
  'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

// Apocope trailing "uno"/"veintiuno" → "un"/"veintiún" (before a noun, mil, or millón).
function esApocope(words) {
  return words.replace(/veintiuno$/, 'veintiún').replace(/(^|\s)uno$/, '$1un');
}

// Feminine agreement: "doscientos"→"doscientas", "uno"→"una", "veintiuno"→"veintiuna".
function esFeminize(words) {
  return words.replace(/cientos\b/g, 'cientas').replace(/veintiuno\b/g, 'veintiuna').replace(/\buno\b/g, 'una');
}

function esBelow1000(n) {
  if (n === 100) return 'cien';
  let out = '';
  if (n >= 100) { out += ES_HUNDREDS[Math.floor(n / 100)] + ' '; n %= 100; }
  if (n >= 30) {
    out += ES_TENS[Math.floor(n / 10)];
    if (n % 10) out += ' y ' + ES_ONES[n % 10];
  } else if (n > 0) {
    out += ES_ONES[n];
  }
  return out.trim();
}

function esIntWords(n) {
  if (n === 0) return 'cero';
  if (n < 0) return 'menos ' + esIntWords(-n);
  const parts = [];
  const millones = Math.floor(n / 1_000_000);
  const miles = Math.floor((n % 1_000_000) / 1000);
  const resto = n % 1000;
  if (millones) {
    parts.push(millones === 1 ? 'un millón' : esApocope(esIntWords(millones)) + ' millones');
  }
  if (miles) {
    parts.push(miles === 1 ? 'mil' : esApocope(esBelow1000(miles)) + ' mil');
  }
  if (resto) parts.push(esBelow1000(resto));
  return parts.join(' ').trim();
}

// Spanish reads decimals digit-by-digit after "coma". `norm` uses '.' as the
// decimal separator (callers convert a Spanish "," first).
function esDecimalWords(norm) {
  const [intp, decp = ''] = norm.split('.');
  const intWords = esIntWords(parseInt(intp, 10) || 0);
  const decWords = decp.split('').map((d) => ES_ONES[Number(d)]).join(' ');
  return `${intWords} coma ${decWords}`;
}

// Turn a formatted numeric token (with , / . separators) into Spanish words.
// Heuristics for English- vs Spanish-formatted source:
//   "10,000" → thousands;  "99,5" → decimal comma;  "3.5" → decimal point;
//   "1.234,5" → Spanish (',' decimal, '.' thousands).
function esNumberToken(raw) {
  const s = String(raw).trim();
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) return esDecimalWords(s.replace(/\./g, '').replace(',', '.')); // 1.234,5 (es)
  if (/^\d{1,3}(,\d{3})+\.\d+$/.test(s)) return esDecimalWords(s.replace(/,/g, ''));                     // 40,028.5 (en thousands+decimal)
  if (/^\d+,\d{1,2}$/.test(s)) return esDecimalWords(s.replace(',', '.'));        // 99,5  (decimal comma)
  if (/^\d{1,3}(,\d{3})+$/.test(s)) return esIntWords(parseInt(s.replace(/,/g, ''), 10)); // 10,000 (thousands)
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return esIntWords(parseInt(s.replace(/\./g, ''), 10)); // 1.000 (es thousands)
  if (/^\d+\.\d+$/.test(s)) return esDecimalWords(s);                              // 3.5  (decimal point)
  if (/^\d+$/.test(s)) return esIntWords(parseInt(s, 10));
  const cleaned = s.replace(/[.,]/g, '');
  return /^\d+$/.test(cleaned) ? esIntWords(parseInt(cleaned, 10)) : s;
}

// Unit plurals (the stored form); singular derived when the value is 1.
const UNITS_ES = {
  'mg/dL': 'miligramos por decilitro', 'mg/dl': 'miligramos por decilitro',
  'mmol/L': 'milimoles por litro', 'µmol/L': 'micromoles por litro', 'μmol/L': 'micromoles por litro',
  'ng/mL': 'nanogramos por mililitro', 'ng/ml': 'nanogramos por mililitro',
  'pg/mL': 'picogramos por mililitro', 'µg/dL': 'microgramos por decilitro', 'μg/dL': 'microgramos por decilitro',
  'g/dL': 'gramos por decilitro', 'IU/L': 'unidades internacionales por litro', 'U/L': 'unidades por litro',
  'mg/kg': 'miligramos por kilogramo', 'mmHg': 'milímetros de mercurio', 'kPa': 'kilopascales',
  'mcg': 'microgramos', 'µg': 'microgramos', 'μg': 'microgramos', 'ng': 'nanogramos', 'pg': 'picogramos',
  'mg': 'miligramos', 'kg': 'kilogramos', 'g': 'gramos',
  'mL': 'mililitros', 'ml': 'mililitros', 'dL': 'decilitros', 'dl': 'decilitros', 'L': 'litros',
  'kcal': 'kilocalorías', 'cal': 'calorías', 'kJ': 'kilojulios',
  'bpm': 'latidos por minuto', 'mmol': 'milimoles', 'µmol': 'micromoles', 'nmol': 'nanomoles',
  'IU': 'unidades internacionales', 'mIU': 'miliunidades internacionales',
  'km': 'kilómetros', 'cm': 'centímetros', 'mm': 'milímetros', 'nm': 'nanómetros', 'µm': 'micrómetros',
  'lb': 'libras', 'lbs': 'libras', 'oz': 'onzas',
  'hr': 'horas', 'hrs': 'horas', 'min': 'minutos', 'sec': 'segundos', 'ms': 'milisegundos',
  // Tier 2 scientific units
  'GHz': 'gigahercios', 'MHz': 'megahercios', 'kHz': 'kilohercios', 'Hz': 'hercios',
  'dB': 'decibelios', 'kDa': 'kilodaltons', 'Da': 'daltons', 'ppm': 'partes por millón',
  'ppb': 'partes por mil millones', 'kW': 'kilovatios', 'mW': 'milivatios', 'W': 'vatios',
  'mV': 'milivoltios', 'V': 'voltios', 'J': 'julios',
  'mM': 'milimolar', 'µM': 'micromolar', 'μM': 'micromolar', 'nM': 'nanomolar', 'pM': 'picomolar',
};
// Units whose Spanish noun is feminine (drive "una" instead of "un" at value 1).
const ES_FEMININE_UNITS = new Set(['calorías', 'kilocalorías', 'libras', 'onzas', 'horas',
  'unidades internacionales', 'unidades por litro', 'miliunidades internacionales',
  'partes por millón', 'partes por mil millones']);
const SORTED_UNITS_ES = Object.entries(UNITS_ES).sort((a, b) => b[0].length - a[0].length);

const ES_MONTHS = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const ES_ORD_M = ['', 'primero', 'segundo', 'tercero', 'cuarto', 'quinto', 'sexto',
  'séptimo', 'octavo', 'noveno', 'décimo', 'undécimo', 'duodécimo'];
const ES_ORD_F = ['', 'primera', 'segunda', 'tercera', 'cuarta', 'quinta', 'sexta',
  'séptima', 'octava', 'novena', 'décima', 'undécima', 'duodécima'];

// Data-driven learned terms (token → spoken Spanish), grown by the weekly
// gap-scan/learner. Additive + es-only, so it never affects the English path.
// Each entry: { find: literal string, replace: spoken form }. Applied as literal
// (non-regex) replacements early in coreNormalizeEs.
let LEARNED_ES = [];
try { LEARNED_ES = require('./data/learned-es-terms.json'); } catch { /* none yet */ }
function reloadLearnedEsTerms() {
  try { delete require.cache[require.resolve('./data/learned-es-terms.json')]; LEARNED_ES = require('./data/learned-es-terms.json'); }
  catch { LEARNED_ES = []; }
  return LEARNED_ES.length;
}

function esIsOne(raw) {
  return String(raw).replace(/[.,]/g, '') === '1';
}
function esSingularize(plural) {
  // Singularize the leading noun(s); keep a "por …" tail intact.
  const [head, ...tail] = plural.split(' por ');
  const sing = head.replace(/ías\b/, 'ía').replace(/s\b/, '');
  return [sing, ...tail].join(' por ');
}
function esUnitPhrase(numWords, raw, plural) {
  const fem = ES_FEMININE_UNITS.has(plural);
  if (esIsOne(raw)) return `${fem ? 'una' : 'un'} ${esSingularize(plural)}`;
  return `${fem ? esFeminize(numWords) : esApocope(numWords)} ${plural}`;
}

function coreNormalizeEs(text) {
  let t = ' ' + String(text) + ' ';

  // 0a. Strip Markdown / formatting artifacts a TTS voice would mangle.
  //     (">" is left for the comparison pass below, not treated as a blockquote.)
  t = t
    .replace(/\*\*([^*]+)\*\*/g, '$1')      // **bold**
    .replace(/\*([^*\n]+)\*/g, '$1')        // *italic*
    .replace(/(^|\s)[*•#]+\s/g, '$1')       // stray bullets / heading marks
    .replace(/[`_*#]/g, '');                // leftover markdown chars

  // 0a2. Learned terms (data-driven; grown by the weekly gap-scan). Applied with
  //      alphanumeric word boundaries (NOT literal substring) so a short token
  //      like "IV" never corrupts "división". Applied before the rule passes.
  for (let i = 0; i < LEARNED_ES.length; i++) {
    const e = LEARNED_ES[i];
    if (!e || !e.find) continue;
    const re = new RegExp(`(?<![A-Za-zÀ-ÿ0-9])${escapeRegex(e.find)}(?![A-Za-zÀ-ÿ0-9])`, 'g');
    t = t.replace(re, e.replace == null ? '' : e.replace);
  }

  // 0b. Common abbreviations (deterministic backstop; the translation TTS mode
  //     expands these too, but narration text may arrive un-expanded).
  const ABBR_ES = [
    [/\bEE\.?\s?UU\.?/g, 'Estados Unidos'],
    [/\bDra\.\s*/g, 'doctora '], [/\bDr\.\s*/g, 'doctor '],
    [/\bvs\.?(?=\W|$)/gi, 'versus'], [/\betc\.?(?=\s|$)/gi, 'etcétera'],
    [/\bp\.\s?ej\.\b/gi, 'por ejemplo'], [/\baprox\.\b/gi, 'aproximadamente'],
    [/\bnúm\.\b/gi, 'número'],
  ];
  for (const [re, w] of ABBR_ES) t = t.replace(re, w);

  // 0c. Comparison / math operators → words (also when glued to a number).
  t = t
    .replace(/\s*≤\s*/g, ' menor o igual que ').replace(/\s*≥\s*/g, ' mayor o igual que ')
    .replace(/\s*[≈~]\s*/g, ' aproximadamente ').replace(/\s*±\s*/g, ' más o menos ')
    .replace(/\s*÷\s*/g, ' entre ').replace(/\s*&\s*/g, ' y ')
    .replace(/(^|[\s\d])<(?=\s*[\d.])/g, '$1 menor que ')
    .replace(/(^|[\s\d])>(?=\s*[\d.])/g, '$1 mayor que ');

  // 1. Percentages: "50%" / "99,5 %" → "… por ciento"
  t = t.replace(/(\d[\d.,]*)\s*%/g, (_, n) => `${esNumberToken(n)} por ciento`);

  // 2. Temperatures
  t = t.replace(/(\d[\d.,]*)\s*°\s*C\b/gi, (_, n) => `${esNumberToken(n)} grados Celsius`);
  t = t.replace(/(\d[\d.,]*)\s*°\s*F\b/gi, (_, n) => `${esNumberToken(n)} grados Fahrenheit`);
  t = t.replace(/(\d[\d.,]*)\s*°/g, (_, n) => `${esNumberToken(n)} grados`);

  // 3. Currency before the number
  t = t.replace(/\$\s*(\d[\d.,]*)/g, (_, n) => esUnitPhrase(esNumberToken(n), n, 'dólares'));
  t = t.replace(/€\s*(\d[\d.,]*)/g, (_, n) => esUnitPhrase(esNumberToken(n), n, 'euros'));

  // 3b. ISO dates "2026-06-20" → "veinte de junio de dos mil veintiséis"
  //     (before ranges so the hyphens aren't read as a numeric range).
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => {
    const mm = parseInt(mo, 10), dd = parseInt(d, 10);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return m;
    const day = dd === 1 ? 'primero' : esIntWords(dd);
    return `${day} de ${ES_MONTHS[mm]} de ${esIntWords(parseInt(y, 10))}`;
  });

  // 4. Ranges, with an optional trailing unit applied to the upper bound
  //    ("5–10 mg" → "cinco a diez miligramos"). Runs before the plain unit pass
  //    so the unit pass doesn't consume the upper bound out of the range.
  const unitAlt = SORTED_UNITS_ES.map(([u]) => escapeRegex(u)).join('|');
  t = t.replace(
    new RegExp(`(\\d[\\d.,]*)\\s*[–—-]\\s*(\\d[\\d.,]*)\\s*(${unitAlt})?(?![A-Za-z])`, 'g'),
    (_, a, b, u) => (u
      ? `${esNumberToken(a)} a ${esUnitPhrase(esNumberToken(b), b, UNITS_ES[u])}`
      : `${esNumberToken(a)} a ${esNumberToken(b)}`),
  );

  // 4b. Ratios / blood pressure: "120/80" → "ciento veinte sobre ochenta"
  //     (before units so a trailing unit like "120/80 mmHg" attaches correctly;
  //     both sides must be 1–3 digit integers, so unit tokens like "mg/dL" and
  //     4-digit years are unaffected).
  t = t.replace(
    new RegExp(`(\\d{1,3})\\s*/\\s*(\\d{1,3})\\s*(${unitAlt})?(?![A-Za-z0-9])`, 'g'),
    (_, a, b, u) => (u
      ? `${esNumberToken(a)} sobre ${esUnitPhrase(esNumberToken(b), b, UNITS_ES[u])}`
      : `${esNumberToken(a)} sobre ${esNumberToken(b)}`),
  );

  // 5. Number + unit (longest unit keys first so "mg/dL" beats "mg")
  for (const [u, plural] of SORTED_UNITS_ES) {
    const re = new RegExp(`(\\d[\\d.,]*)\\s*${escapeRegex(u)}(?![A-Za-z])`, 'g');
    t = t.replace(re, (_, n) => esUnitPhrase(esNumberToken(n), n, plural));
  }

  // 5b. Scientific letter+number tokens where the number IS spoken: vitamins
  //     (B/D/K + number), thyroid (T3/T4), coenzyme Q10, omega-N. Multi-letter
  //     gene symbols (PCSK9, TP53, FOXO3) are untouched — the leading \b plus
  //     single-letter class means "B" in "SLCO1B1" (preceded by a digit) won't match.
  t = t.replace(/\bomega[-\s]?(\d+)\b/gi, (_, n) => `omega ${esIntWords(parseInt(n, 10))}`);
  t = t.replace(/\bCoQ[-\s]?(\d+)\b/g, (_, n) => `CoQ ${esIntWords(parseInt(n, 10))}`);
  t = t.replace(/\b([BDKT])-?(\d{1,2})\b/g, (_, L, n) => `${L} ${esIntWords(parseInt(n, 10))}`);

  // 5c. Ordinals: Spanish "1.º/2.ª" + English "1st/2nd" (1–12) → ordinal words.
  t = t.replace(/\b(\d+)\.?(º|ª)/g, (m, n, ind) => {
    const i = parseInt(n, 10); if (i < 1 || i > 12) return m;
    return ind === 'ª' ? ES_ORD_F[i] : ES_ORD_M[i];
  });
  t = t.replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, (m, n) => {
    const i = parseInt(n, 10); return (i >= 1 && i <= 12) ? ES_ORD_M[i] : m;
  });

  // 6. Arithmetic / connector symbols (spaced, to avoid hyphenated words)
  t = t.replace(/\s\+\s/g, ' más ').replace(/\s×\s/g, ' por ').replace(/\s=\s/g, ' igual a ');

  // 7. Remaining bare numbers
  t = t.replace(/(?<![\w.,])(\d[\d.,]*\d|\d)(?![\w])/g, (_, n) => esNumberToken(n));

  // 8. Apocope of a trailing "uno"/"veintiuno" before a noun (heuristic: any word
  //    that isn't a common function word). Numbers in this domain almost always
  //    quantify a following noun, so "treinta y uno días" → "treinta y un días".
  const ES_FUNC = 'de|del|por|al|a|en|y|o|u|que|con|sin|para|como|más|menos|según|sobre|entre';
  // Guard with a following space (not \b — JS \b is ASCII-only and mis-fires on
  // "años"/accented words that start with a function-word letter).
  t = t.replace(
    new RegExp(`\\b(veintiuno|uno)(\\s+)(?!(?:${ES_FUNC})\\s)([a-záéíóúñ])`, 'gi'),
    (_, num, sp, c) => (num.toLowerCase() === 'veintiuno' ? 'veintiún' : 'un') + sp + c,
  );

  return t.replace(/\s{2,}/g, ' ').trim();
}

// ════════════════════════════════════════════════════════════
// FRENCH (fr) NORMALIZATION — modeled on the Spanish path above:
// numbers, units, symbols, dates, ordinals. Locale-gated; the
// English + Spanish pipelines are untouched. No IPA / acronym-
// pronunciation layer (French TTS reads words phonetically; the
// learned-fr-terms data file letter-spells the acronyms that need it).
// ════════════════════════════════════════════════════════════

// 0–19 carry their own names; the teens (dix-sept…) are reused inside
// soixante-/quatre-vingt- compounds, so the table runs to 19.
const FR_ONES = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix',
  'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
// 70/80/90 are built from soixante/quatre-vingt, so only 20–60 live here.
const FR_TENS = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', '', '', ''];

// Feminine agreement in French only touches the trailing "un" → "une"
// (cardinals 2+ and the hundreds/tens words are gender-invariable, unlike
// Spanish). So "vingt et un calories" → "vingt et une calories".
function frFeminize(words) {
  return words.replace(/\bun$/, 'une');
}

// `mult` = this chunk multiplies "mille", which suppresses the plural -s on a
// trailing "quatre-vingts"/"cents" ("quatre-vingt mille", "deux cent mille").
// Before a noun multiplier (million/milliard) the -s stays, so callers pass
// mult=false there.
function frBelow100(n, mult) {
  if (n < 20) return FR_ONES[n];
  const tens = Math.floor(n / 10), u = n % 10;
  if (n < 70) {
    const base = FR_TENS[tens];
    if (u === 0) return base;
    if (u === 1) return base + ' et un';      // vingt et un, trente et un, …
    return base + '-' + FR_ONES[u];           // vingt-deux, …
  }
  if (n < 80) {                                // 70–79 = soixante + 10–19
    const rem = n - 60;
    if (rem === 11) return 'soixante et onze'; // 71 keeps the "et"
    return 'soixante-' + FR_ONES[rem];         // soixante-dix, soixante-douze, soixante-dix-neuf
  }
  const rem = n - 80;                          // 80–99 = quatre-vingt + 0–19
  if (rem === 0) return mult ? 'quatre-vingt' : 'quatre-vingts';
  return 'quatre-vingt-' + FR_ONES[rem];       // no "et" at 81/91; quatre-vingt-un, quatre-vingt-onze
}

function frBelow1000(n, mult) {
  if (n < 100) return frBelow100(n, mult);
  const h = Math.floor(n / 100), rem = n % 100;
  let centWord;
  if (h === 1) centWord = 'cent';
  else centWord = FR_ONES[h] + ' ' + ((rem === 0 && !mult) ? 'cents' : 'cent'); // deux cents / deux cent un
  if (rem === 0) return centWord;
  return centWord + ' ' + frBelow100(rem, mult);
}

function frIntWords(n) {
  if (n === 0) return 'zéro';
  if (n < 0) return 'moins ' + frIntWords(-n);
  const parts = [];
  const milliards = Math.floor(n / 1_000_000_000);
  const millions = Math.floor((n % 1_000_000_000) / 1_000_000);
  const milliers = Math.floor((n % 1_000_000) / 1000);
  const reste = n % 1000;
  if (milliards) parts.push(milliards === 1 ? 'un milliard' : frBelow1000(milliards, false) + ' milliards');
  if (millions) parts.push(millions === 1 ? 'un million' : frBelow1000(millions, false) + ' millions');
  if (milliers) parts.push(milliers === 1 ? 'mille' : frBelow1000(milliers, true) + ' mille'); // "mille" invariable, never "un mille"
  if (reste) parts.push(frBelow1000(reste, false));
  return parts.join(' ').trim();
}

// French reads decimals digit-by-digit after "virgule". `norm` uses '.' as the
// decimal separator (callers convert a French "," first).
function frDecimalWords(norm) {
  const [intp, decp = ''] = norm.split('.');
  const intWords = frIntWords(parseInt(intp, 10) || 0);
  const decWords = decp.split('').map((d) => FR_ONES[Number(d)]).join(' ');
  return `${intWords} virgule ${decWords}`;
}

// Turn a formatted numeric token (with , / . separators) into French words.
// Same English-vs-continental heuristics as the Spanish token reader: French
// shares the comma-decimal / period-or-space-thousands conventions, and the
// spaced-thousands case is pre-collapsed in coreNormalizeFr before this runs.
function frNumberToken(raw) {
  const s = String(raw).trim();
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) return frDecimalWords(s.replace(/\./g, '').replace(',', '.')); // 1.234,5 (fr/es)
  if (/^\d{1,3}(,\d{3})+\.\d+$/.test(s)) return frDecimalWords(s.replace(/,/g, ''));                     // 40,028.5 (en thousands+decimal)
  if (/^\d+,\d{1,2}$/.test(s)) return frDecimalWords(s.replace(',', '.'));        // 99,5  (decimal comma)
  if (/^\d{1,3}(,\d{3})+$/.test(s)) return frIntWords(parseInt(s.replace(/,/g, ''), 10)); // 10,000 (thousands)
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return frIntWords(parseInt(s.replace(/\./g, ''), 10)); // 1.000 (continental thousands)
  if (/^\d+\.\d+$/.test(s)) return frDecimalWords(s);                              // 3.5  (decimal point)
  if (/^\d+$/.test(s)) return frIntWords(parseInt(s, 10));
  const cleaned = s.replace(/[.,]/g, '');
  return /^\d+$/.test(cleaned) ? frIntWords(parseInt(cleaned, 10)) : s;
}

// Unit plurals (the stored form); singular derived when the value is 1.
const UNITS_FR = {
  'mg/dL': 'milligrammes par décilitre', 'mg/dl': 'milligrammes par décilitre',
  'mmol/L': 'millimoles par litre', 'µmol/L': 'micromoles par litre', 'μmol/L': 'micromoles par litre',
  'ng/mL': 'nanogrammes par millilitre', 'ng/ml': 'nanogrammes par millilitre',
  'pg/mL': 'picogrammes par millilitre', 'µg/dL': 'microgrammes par décilitre', 'μg/dL': 'microgrammes par décilitre',
  'g/dL': 'grammes par décilitre', 'IU/L': 'unités internationales par litre', 'U/L': 'unités par litre',
  'mg/kg': 'milligrammes par kilogramme', 'mmHg': 'millimètres de mercure', 'kPa': 'kilopascals',
  'mcg': 'microgrammes', 'µg': 'microgrammes', 'μg': 'microgrammes', 'ng': 'nanogrammes', 'pg': 'picogrammes',
  'mg': 'milligrammes', 'kg': 'kilogrammes', 'g': 'grammes',
  'mL': 'millilitres', 'ml': 'millilitres', 'dL': 'décilitres', 'dl': 'décilitres', 'L': 'litres',
  'kcal': 'kilocalories', 'cal': 'calories', 'kJ': 'kilojoules',
  'bpm': 'battements par minute', 'mmol': 'millimoles', 'µmol': 'micromoles', 'nmol': 'nanomoles',
  'IU': 'unités internationales', 'mIU': 'milliunités internationales',
  'km': 'kilomètres', 'cm': 'centimètres', 'mm': 'millimètres', 'nm': 'nanomètres', 'µm': 'micromètres',
  'lb': 'livres', 'lbs': 'livres', 'oz': 'onces',
  'hr': 'heures', 'hrs': 'heures', 'min': 'minutes', 'sec': 'secondes', 'ms': 'millisecondes',
  // Tier 2 scientific units
  'GHz': 'gigahertz', 'MHz': 'mégahertz', 'kHz': 'kilohertz', 'Hz': 'hertz',
  'dB': 'décibels', 'kDa': 'kilodaltons', 'Da': 'daltons', 'ppm': 'parties par million',
  'ppb': 'parties par milliard', 'kW': 'kilowatts', 'mW': 'milliwatts', 'W': 'watts',
  'mV': 'millivolts', 'V': 'volts', 'J': 'joules',
  'mM': 'millimolaire', 'µM': 'micromolaire', 'μM': 'micromolaire', 'nM': 'nanomolaire', 'pM': 'picomolaire',
};
// Units whose French noun is feminine — only matters at value 1 to drive
// "une" instead of "un" (French cardinals 2+ are gender-invariable).
const FR_FEMININE_UNITS = new Set(['calories', 'kilocalories', 'livres', 'onces', 'heures', 'minutes',
  'secondes', 'millisecondes', 'millimoles', 'micromoles', 'nanomoles',
  'unités internationales', 'milliunités internationales', 'unités par litre',
  'parties par million', 'parties par milliard',
  'millimoles par litre', 'micromoles par litre', 'unités internationales par litre']);
const SORTED_UNITS_FR = Object.entries(UNITS_FR).sort((a, b) => b[0].length - a[0].length);

const FR_MONTHS = ['', 'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
// Ordinals 1–12. Only "premier/première" inflects for gender; 2+ share one form.
const FR_ORD_M = ['', 'premier', 'deuxième', 'troisième', 'quatrième', 'cinquième', 'sixième',
  'septième', 'huitième', 'neuvième', 'dixième', 'onzième', 'douzième'];
const FR_ORD_F = ['', 'première', 'deuxième', 'troisième', 'quatrième', 'cinquième', 'sixième',
  'septième', 'huitième', 'neuvième', 'dixième', 'onzième', 'douzième'];

// Data-driven learned terms (token → spoken French), grown by the weekly
// gap-scan/learner. Additive + fr-only, so it never affects en/es.
let LEARNED_FR = [];
try { LEARNED_FR = require('./data/learned-fr-terms.json'); } catch { /* none yet */ }
function reloadLearnedFrTerms() {
  try { delete require.cache[require.resolve('./data/learned-fr-terms.json')]; LEARNED_FR = require('./data/learned-fr-terms.json'); }
  catch { LEARNED_FR = []; }
  return LEARNED_FR.length;
}

function frIsOne(raw) {
  return String(raw).replace(/[.,\s]/g, '') === '1';
}
// Singularize each word of the leading noun(s); keep a "par …" tail intact.
function frSingularize(plural) {
  const [head, ...tail] = plural.split(' par ');
  const sing = head.split(' ')
    .map((w) => (w.length > 2 && w.endsWith('s') ? w.slice(0, -1) : w)) // "hertz" (z) stays; "grammes"→"gramme"
    .join(' ');
  return [sing, ...tail].join(' par ');
}
function frUnitPhrase(numWords, raw, plural) {
  const fem = FR_FEMININE_UNITS.has(plural);
  if (frIsOne(raw)) return `${fem ? 'une' : 'un'} ${frSingularize(plural)}`;
  return `${fem ? frFeminize(numWords) : numWords} ${plural}`;
}

function coreNormalizeFr(text) {
  let t = ' ' + String(text) + ' ';

  // 0a. Strip Markdown / formatting artifacts a TTS voice would mangle.
  t = t
    .replace(/\*\*([^*]+)\*\*/g, '$1')      // **bold**
    .replace(/\*([^*\n]+)\*/g, '$1')        // *italic*
    .replace(/(^|\s)[*•#]+\s/g, '$1')       // stray bullets / heading marks
    .replace(/[`_*#]/g, '');                // leftover markdown chars

  // 0a2. Collapse French spaced thousands ("10 000" / "1 234 567" — incl. the
  //      narrow/non-breaking spaces French typography uses) so the bare-number
  //      pass doesn't split them. Requires 3-digit groups, so "20 ans" is safe.
  t = t.replace(/(\d{1,3}(?:[   ]\d{3})+)(?!\d)/g, (m) => m.replace(/[   ]/g, ''));

  // 0a3. Learned terms (data-driven; grown by the weekly gap-scan). Applied with
  //      alphanumeric word boundaries (NOT literal substring) so a short token
  //      never corrupts a longer word. Applied before the rule passes.
  for (let i = 0; i < LEARNED_FR.length; i++) {
    const e = LEARNED_FR[i];
    if (!e || !e.find) continue;
    const re = new RegExp(`(?<![A-Za-zÀ-ÿ0-9])${escapeRegex(e.find)}(?![A-Za-zÀ-ÿ0-9])`, 'g');
    t = t.replace(re, e.replace == null ? '' : e.replace);
  }

  // 0b. Common abbreviations (deterministic backstop). Longest/most-specific first.
  const ABBR_FR = [
    [/É\.?-?\s?U\.?/g, 'États-Unis'], [/\bUSA\b/g, 'États-Unis'],
    [/\bDre\.?\s*/g, 'docteure '], [/\bDr\.?\s*/g, 'docteur '],
    [/\bMme\.?\s*/g, 'Madame '], [/\bMlle\.?\s*/g, 'Mademoiselle '], [/\bM\.\s+/g, 'Monsieur '],
    [/\bvs\.?(?=\W|$)/gi, 'contre'], [/\betc\.?(?=\s|$)/gi, 'et cetera'],
    [/\bp\.\s?ex\.?/gi, 'par exemple'], [/\benv\.\b/gi, 'environ'],
    [/\bc\.-à-d\.?/gi, "c'est-à-dire"], [/\bn[°º]\.?\s?/gi, 'numéro '],
  ];
  for (const [re, w] of ABBR_FR) t = t.replace(re, w);

  // 0c. Comparison / math operators → words (also when glued to a number).
  t = t
    .replace(/\s*≤\s*/g, ' inférieur ou égal à ').replace(/\s*≥\s*/g, ' supérieur ou égal à ')
    .replace(/\s*[≈~]\s*/g, ' environ ').replace(/\s*±\s*/g, ' plus ou moins ')
    .replace(/\s*÷\s*/g, ' divisé par ').replace(/\s*&\s*/g, ' et ')
    .replace(/(^|[\s\d])<(?=\s*[\d.])/g, '$1 inférieur à ')
    .replace(/(^|[\s\d])>(?=\s*[\d.])/g, '$1 supérieur à ');

  // 1. Percentages: "50%" / "99,5 %" → "… pour cent"
  t = t.replace(/(\d[\d.,]*)\s*%/g, (_, n) => `${frNumberToken(n)} pour cent`);

  // 2. Temperatures (singular "degré" only at value 1)
  t = t.replace(/(\d[\d.,]*)\s*°\s*C\b/gi, (_, n) => `${frNumberToken(n)} ${frIsOne(n) ? 'degré' : 'degrés'} Celsius`);
  t = t.replace(/(\d[\d.,]*)\s*°\s*F\b/gi, (_, n) => `${frNumberToken(n)} ${frIsOne(n) ? 'degré' : 'degrés'} Fahrenheit`);
  t = t.replace(/(\d[\d.,]*)\s*°/g, (_, n) => `${frNumberToken(n)} ${frIsOne(n) ? 'degré' : 'degrés'}`);

  // 3. Currency, symbol before OR after the number (French usually writes "50 $").
  t = t.replace(/\$\s*(\d[\d.,]*)/g, (_, n) => frUnitPhrase(frNumberToken(n), n, 'dollars'));
  t = t.replace(/(\d[\d.,]*)\s*\$/g, (_, n) => frUnitPhrase(frNumberToken(n), n, 'dollars'));
  t = t.replace(/€\s*(\d[\d.,]*)/g, (_, n) => frUnitPhrase(frNumberToken(n), n, 'euros'));
  t = t.replace(/(\d[\d.,]*)\s*€/g, (_, n) => frUnitPhrase(frNumberToken(n), n, 'euros'));

  // 3b. ISO dates "2026-06-20" → "vingt juin deux mille vingt-six" (day 1 → "premier").
  //     Before ranges so the hyphens aren't read as a numeric range.
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => {
    const mm = parseInt(mo, 10), dd = parseInt(d, 10);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return m;
    const day = dd === 1 ? 'premier' : frIntWords(dd);
    return `${day} ${FR_MONTHS[mm]} ${frIntWords(parseInt(y, 10))}`;
  });

  // 4. Ranges, with an optional trailing unit applied to the upper bound
  //    ("5–10 mg" → "cinq à dix milligrammes").
  const unitAlt = SORTED_UNITS_FR.map(([u]) => escapeRegex(u)).join('|');
  t = t.replace(
    new RegExp(`(\\d[\\d.,]*)\\s*[–—-]\\s*(\\d[\\d.,]*)\\s*(${unitAlt})?(?![A-Za-z])`, 'g'),
    (_, a, b, u) => (u
      ? `${frNumberToken(a)} à ${frUnitPhrase(frNumberToken(b), b, UNITS_FR[u])}`
      : `${frNumberToken(a)} à ${frNumberToken(b)}`),
  );

  // 4b. Ratios / blood pressure: "120/80" → "cent vingt sur quatre-vingts".
  t = t.replace(
    new RegExp(`(\\d{1,3})\\s*/\\s*(\\d{1,3})\\s*(${unitAlt})?(?![A-Za-z0-9])`, 'g'),
    (_, a, b, u) => (u
      ? `${frNumberToken(a)} sur ${frUnitPhrase(frNumberToken(b), b, UNITS_FR[u])}`
      : `${frNumberToken(a)} sur ${frNumberToken(b)}`),
  );

  // 5. Number + unit (longest unit keys first so "mg/dL" beats "mg")
  for (const [u, plural] of SORTED_UNITS_FR) {
    const re = new RegExp(`(\\d[\\d.,]*)\\s*${escapeRegex(u)}(?![A-Za-z])`, 'g');
    t = t.replace(re, (_, n) => frUnitPhrase(frNumberToken(n), n, plural));
  }

  // 5b. Scientific letter+number tokens where the number IS spoken: vitamins
  //     (B/D/K + number), thyroid (T3/T4), coenzyme Q10, oméga-N. Multi-letter
  //     gene symbols (PCSK9, TP53, FOXO3) are untouched.
  t = t.replace(/\bom[ée]ga[-\s]?(\d+)\b/gi, (_, n) => `oméga ${frIntWords(parseInt(n, 10))}`);
  t = t.replace(/\bCoQ[-\s]?(\d+)\b/g, (_, n) => `CoQ ${frIntWords(parseInt(n, 10))}`);
  t = t.replace(/\b([BDKT])-?(\d{1,2})\b/g, (_, L, n) => `${L} ${frIntWords(parseInt(n, 10))}`);

  // 5c. Ordinals (1–12): "1er/1re/2e/2ème" → ordinal words.
  t = t.replace(/\b(\d+)(ère|ème|er|re|nd|e)\b/gi, (m, n, suf) => {
    const i = parseInt(n, 10); if (i < 1 || i > 12) return m;
    return /^(re|ère)$/i.test(suf) ? FR_ORD_F[i] : FR_ORD_M[i];
  });

  // 6. Arithmetic / connector symbols (spaced, to avoid hyphenated words)
  t = t.replace(/\s\+\s/g, ' plus ').replace(/\s×\s/g, ' fois ').replace(/\s=\s/g, ' égale ');

  // 7. Remaining bare numbers
  t = t.replace(/(?<![\w.,])(\d[\d.,]*\d|\d)(?![\w])/g, (_, n) => frNumberToken(n));

  return t.replace(/\s{2,}/g, ' ').trim();
}

function normalizeForTTS(text, opts = {}) {
  if (!text) return '';
  const locale = (opts && opts.locale ? String(opts.locale) : 'en').toLowerCase().split(/[-_]/)[0];
  if (locale === 'es') return coreNormalizeEs(text);
  if (locale === 'fr') return coreNormalizeFr(text);
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
    ['SIRT3 expression', '<phoneme alphabet="ipa" ph="sɜːrt">sirt</phoneme> three expression'],
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
      'per <phoneme alphabet="ipa" ph="ˈsiːpɪk">C-P-I-C</phoneme>\'s <sub alias="ess ess R I">SSRI</sub> guideline'],
    // SLCO1B1 — POST_OVERRIDES emits a <sub alias> rewrite (IPA stress
    // tweaks didn't keep Chirp HD from slurring the leading S).
    ['SLCO1B1 *5/*5',
      '<sub alias="ess L C O one B one">SLCO1B1</sub> *five/*five'],
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
    // ─── Hyphenated number-word handling (v0.9.0).
    // 2-word ONES + TENS_PREFIX: spoken compound 3-digit number, not range.
    ['above one-eighty milligrams', 'above one eighty milligrams'],
    ['or four-thirty nanomoles per liter', 'or four thirty nanomoles per liter'],
    // 3+ chain: digit-spelling sequence.
    ['PACE is one-point-one-four',     'pace is one point one four'],
    ['final PACE is zero-point-eight-seven', 'final pace is zero point eight seven'],
    ['Day fifty-seven of one-eighty-one', 'Day fifty-seven of one eighty one'],
    ['twenty-four-seven secure messaging', 'twenty four seven secure messaging'],
    // Decimal-pair after "point": digit-spelling, not range.
    ['range is zero point two-six to one point six-five',
      'range is zero point two six to one point six five'],
    // Non-regressions: real ranges and compound adjectives stay intact.
    ['Tabas-Williams response-to-retention model',
      'Tabas-Williams response-to-retention model'],
    ['iron-rich diet', 'iron-rich diet'],
    ['twenty to twenty-five percent', 'twenty to twenty-five percent'],
    ['three-hundred patients', 'three hundred patients'],
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
  resolveAndPersistAcronyms,
  reloadLearnedIpa,
  reloadLearnedEsTerms,
  reloadLearnedFrTerms,
  selfTest,
};
