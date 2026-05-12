// export-human.ts — bundle proposal.html + the kit into a single self-contained
// HTML file for human review. Inlines napkin-kit.css/js so the result works
// offline (modulo the rough.js / Google Fonts CDNs). No annotation overlay.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname }                                      from 'path';
import { fileURLToPath }                                      from 'url';

const __dir     = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(__dir);
const ASSETS    = join(SKILL_DIR, 'assets');

const sessionDir = process.argv[2] ?? './.napkin-session';
const outArg     = process.argv[3];
const outPath    = (outArg && outArg.length > 0) ? outArg : './docs/human/napkin.html';

const proposalPath = join(sessionDir, 'proposal.html');
if (!existsSync(proposalPath)) {
  console.error(`No proposal.html in ${sessionDir}`);
  process.exit(1);
}

mkdirSync(dirname(outPath), { recursive: true });

const proposal = readFileSync(proposalPath, 'utf8');
const kitCss   = readFileSync(join(ASSETS, 'napkin-kit.css'), 'utf8');
const kitJs    = readFileSync(join(ASSETS, 'napkin-kit.js'),  'utf8');

const inject = [
  `<link href="https://fonts.googleapis.com/css2?family=Gloria+Hallelujah&display=swap" rel="stylesheet">`,
  `<script src="https://cdn.jsdelivr.net/npm/roughjs@4.6.6/bundled/rough.js"></script>`,
  `<style>\n${kitCss}\n</style>`,
  `<script>\n${kitJs}\n</script>`,
].join('\n');

if (!/<\/head>/i.test(proposal)) {
  console.error('proposal.html has no </head> — refusing to export');
  process.exit(1);
}

const output = proposal.replace(/<\/head>/i, `${inject}\n</head>`);
writeFileSync(outPath, output);
console.log(`Wrote ${outPath}`);
