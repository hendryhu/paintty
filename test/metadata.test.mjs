import assert from 'node:assert/strict';
import fs from 'node:fs';

const sourceIndex = new URL('../index.html', import.meta.url);
assert.equal(
  fs.existsSync(sourceIndex),
  true,
  'metadata validation requires index.html',
);
const html = fs.readFileSync(sourceIndex, 'utf8');
const description = 'Paintty is a browser-based editor for terminal art and animations.';
const title = 'Paintty — animated terminal art editor';

assert.match(html, new RegExp(`<title>${title}</title>`));
assert.match(html, new RegExp(`<meta name="description" content="${description}"`));
assert.match(html, /<link rel="canonical" href="https:\/\/paintty\.hendryhu\.com\/"/);
assert.match(html, /<meta property="og:type" content="website"/);
assert.match(html, /<meta property="og:site_name" content="Paintty"/);
assert.match(html, new RegExp(`<meta property="og:title" content="${title}"`));
assert.match(html, /<meta property="og:url" content="https:\/\/paintty\.hendryhu\.com\/"/);
assert.match(html, new RegExp(`<meta property="og:description" content="${description}"`));
assert.match(html, /<meta property="og:image" content="https:\/\/paintty\.hendryhu\.com\/og-image\.png"/);
assert.match(html, /<meta property="og:image:width" content="1200"/);
assert.match(html, /<meta property="og:image:height" content="630"/);
assert.match(html, /<meta property="og:image:alt" content="Paintty terminal art editor"/);
assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
assert.match(html, new RegExp(`<meta name="twitter:title" content="${title}"`));
assert.match(html, new RegExp(`<meta name="twitter:description" content="${description}"`));
assert.match(html, /<meta name="twitter:image" content="https:\/\/paintty\.hendryhu\.com\/og-image\.png"/);
assert.match(html, /<meta name="twitter:image:alt" content="Paintty terminal art editor"/);
assert.match(html, /<link rel="icon" href="\.\/icon\.svg" type="image\/svg\+xml"/);
assert.match(html, /<script type="module" src="\/src\/main\.js"/);

console.log('metadata tests passed');
