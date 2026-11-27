/**
 * Spelling rules per language. Datasets of kind tone-speech name their
 * language in meta.language.
 * @typedef {{ name: string, lang: string, tones: string[], vowels: string[] }} Language
 * @typedef {{ label: string, index: number, word: string, correct: string, distractor: string, pair: string }} Candidate
 * @typedef {{ filename: string, transcript: string, nativeScript?: string }} RawClip
 * @typedef {RawClip & { candidates: Candidate[] }} Clip
 */

/** @type {Record<string, Language>} */
export const languages = {
  vie: {
    name: 'Vietnamese',
    lang: 'vi',
    tones: ['ngang', 'huyen', 'sac', 'hoi', 'nga', 'nang'],
    vowels: ['aàáảãạ', 'ăằắẳẵặ', 'âầấẩẫậ', 'eèéẻẽẹ', 'êềếểễệ', 'iìíỉĩị',
      'oòóỏõọ', 'ôồốổỗộ', 'ơờớởỡợ', 'uùúủũụ', 'ưừứửữự', 'yỳýỷỹỵ'],
  },
  cmn: {
    name: 'Mandarin',
    lang: 'zh-Latn',
    tones: ['tone1', 'tone2', 'tone3', 'tone4'],
    vowels: ['āáǎà', 'ēéěè', 'īíǐì', 'ōóǒò', 'ūúǔù', 'ǖǘǚǜ'],
  },
};

/** @param {string} first @param {string} second */
export const pairKey = (first, second) => [first, second].sort().join('-');

/** @param {RawClip[]} clips @param {string} code @returns {Clip[]} */
export function buildCatalog(clips, code) {
  const { vowels, tones } = languages[code];
  const variants = new Map(vowels.flatMap(family => Array.from(family, letter => [letter, family])));
  const marked = new Set(vowels.flatMap(family => [...(code === 'vie' ? family.slice(1) : family)]));
  const alphabet = code === 'vie'
    ? /^[aăâbcdđeêghiklmnoôơpqrstuưvxyàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]+$/u
    : /^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+$/u;

  return clips.flatMap(clip => {
    const transcript = clip.transcript.normalize().replace(/(^|\s)-N(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
    /** @type {Candidate[]} */
    const candidates = [];
    for (const match of transcript.matchAll(/\p{L}+/gu)) {
      const word = match[0].toLowerCase();
      if (!alphabet.test(word) || (code === 'vie' && ![...word].some(letter => marked.has(letter) || 'ăâêôơưđ'.includes(letter)))) continue;
      const markCount = [...word].filter(letter => marked.has(letter)).length;
      for (const [offset, letter] of [...word].entries()) {
        const family = variants.get(letter);
        if (!family) continue;
        const correct = family.indexOf(letter);
        for (const [wrong, alternate] of [...family].entries()) {
          if (correct === wrong || markCount - Number(marked.has(letter)) + Number(marked.has(alternate)) > 1) continue;
          const index = match.index + offset;
          const replacement = transcript[index] === letter ? alternate : alternate.toUpperCase();
          candidates.push({
            label: transcript.slice(0, index) + replacement + transcript.slice(index + 1),
            index: [...transcript.slice(0, index)].length,
            word, correct: tones[correct], distractor: tones[wrong],
            pair: pairKey(tones[correct], tones[wrong]),
          });
        }
      }
    }
    return candidates.length ? [{ ...clip, transcript, candidates }] : [];
  });
}
