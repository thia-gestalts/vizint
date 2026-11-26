export const languages = {
  vie: {
    name: 'Vietnamese',
    lang: 'vi',
    tones: ['ngang', 'huyen', 'sac', 'hoi', 'nga', 'nang'],
    vowels: ['aàáảãạ', 'ăằắẳẵặ', 'âầấẩẫậ', 'eèéẻẽẹ', 'êềếểễệ', 'iìíỉĩị',
      'oòóỏõọ', 'ôồốổỗộ', 'ơờớởỡợ', 'uùúủũụ', 'ưừứửữự', 'yỳýỷỹỵ'],
    dataset: 'FPT Open Speech Dataset',
    datasetUrl: 'https://data.mendeley.com/datasets/k9sxg2twv4/4',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    notice: 'Copyright 2018 FPT Corporation. Compiled by Duc Chung Tran. This activity uses a subset with normalized transcripts. The dataset page includes the FPT permission notice.',
  },
  cmn: {
    name: 'Mandarin',
    lang: 'zh-Latn',
    tones: ['tone1', 'tone2', 'tone3', 'tone4'],
    vowels: ['āáǎà', 'ēéěè', 'īíǐì', 'ōóǒò', 'ūúǔù', 'ǖǘǚǜ'],
    dataset: 'AISHELL-1',
    datasetUrl: 'https://huggingface.co/datasets/AISHELL/AISHELL-1',
    license: 'Apache License 2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    notice: 'Recordings by Beijing Shell Shell Technology Co., Ltd. This activity uses curated MP3 clips with pinyin transcriptions. The dataset is tagged Apache 2.0 and its description specifies academic use.',
  },
};

export const pairKey = (first, second) => [first, second].sort().join('-');

export function buildCatalog(clips, code) {
  const { vowels, tones } = languages[code];
  const variants = new Map(vowels.flatMap(family => Array.from(family, letter => [letter, family])));
  const marked = new Set(vowels.flatMap(family => [...(code === 'vie' ? family.slice(1) : family)]));
  const alphabet = code === 'vie'
    ? /^[aăâbcdđeêghiklmnoôơpqrstuưvxyàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]+$/u
    : /^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+$/u;

  return clips.flatMap(clip => {
    const transcript = clip.transcript.normalize().replace(/(^|\s)-N(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
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
