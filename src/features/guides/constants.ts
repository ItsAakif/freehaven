/** Full Guide constants. Product defaults are stored on `guides` too. */

export const GUIDE_WORDS_PER_CHAPTER = 250;
export const GUIDE_CHAPTER_MIN_WORDS = 212;
export const GUIDE_CHAPTER_MAX_WORDS = 287;

/** Pre-flight only. A 250-word chapter, not the 15-minute lesson priors. */
export const GUIDE_SCRIPT_CALL_MS = 10_000;

export const GUIDE_CHAPTER_INSTRUCTION =
  'Write this chapter as continuous prose for a listener. Do not mention the book, ' +
  'the chapter number, this summary, the model, or the word count. Do not add ' +
  'headings, bullet lists, or notes about what was omitted.';
