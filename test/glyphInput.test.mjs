import { firstGrapheme } from '../src/lib/glyphInput.js';
import { codepoint } from '../src/lib/charTabs.js';

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  if (got === want) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  }
}

eq('plain-glyph', firstGrapheme('\u754cabc'), '\u754c');
eq('combining-sequence-is-one-glyph', firstGrapheme('e\u0301x'), 'e\u0301');
eq('emoji-sequence-is-one-glyph', firstGrapheme('\u{1F469}\u200D\u{1F680}next'), '\u{1F469}\u200D\u{1F680}');
eq('paste-line-breaks-are-ignored', firstGrapheme('\n\u25c6\r'), '\u25c6');
eq('empty-input', firstGrapheme(''), '');
eq('combining-codepoints-are-complete', codepoint('é'), 'U+0065 U+0301');
eq('emoji-sequence-codepoints-are-complete', codepoint('👩‍🚀'), 'U+1F469 U+200D U+1F680');
eq('empty-codepoint-label', codepoint(''), '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
