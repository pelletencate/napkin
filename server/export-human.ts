// export-human.ts — bundle proposal.html + the kit into a self-contained HTML
// file for human review. References napkin-kit.css/js from jsDelivr (pinned to
// the local skill's current git SHA) so the artifact stays small and survives
// kit edits without re-exporting. No annotation overlay.

import { execSync }                       from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname }                  from 'path';
import { fileURLToPath }                  from 'url';

const __dir     = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(__dir);

const KIT_REPO  = 'pelletencate/napkin';
const KIT_REF   = resolveKitRef();

function resolveKitRef(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: SKILL_DIR, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || 'main';
  } catch {
    return 'main';
  }
}

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
const kitBase  = `https://cdn.jsdelivr.net/gh/${KIT_REPO}@${KIT_REF}/assets`;

const inject = [
  `<link href="https://fonts.googleapis.com/css2?family=Gloria+Hallelujah&display=swap" rel="stylesheet">`,
  `<script src="https://cdn.jsdelivr.net/npm/roughjs@4.6.6/bundled/rough.js"></script>`,
  `<link rel="stylesheet" href="${kitBase}/napkin-kit.css">`,
  `<script src="${kitBase}/napkin-kit.js"></script>`,
].join('\n');

if (!/<\/head>/i.test(proposal)) {
  console.error('proposal.html has no </head> — refusing to export');
  process.exit(1);
}

const output = proposal.replace(/<\/head>/i, `${inject}\n</head>`);
writeFileSync(outPath, output);
console.log(`Wrote ${outPath} (kit @ ${KIT_REF.slice(0, 12)})`);
