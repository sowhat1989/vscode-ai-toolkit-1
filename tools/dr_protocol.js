#!/usr/bin/env node
/**
 * tools/dr_protocol.js
 * D&R Protocol: Deconstruction -> Focal Point -> Re-architecture
 *
 * Usage:
 *  node tools/dr_protocol.js --file path/to/input.txt
 *  echo "some text" | node tools/dr_protocol.js
 *  node tools/dr_protocol.js --issue 123 --repo owner/repo   (optional, requires gh + jq)
 *
 * Output: JSON printed to stdout. Optionally writes to ./dr_results/<timestamp>.json
 */

const fs = require('fs');
const path = require('path');

const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','else','for','to','of','in','on','with','by','is','are','was','were','be','been','it','that','this','these','those','as','at','from','we','you','they','he','she','i','my','our','your'
]);

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    if (process.stdin.isTTY) return resolve(null);
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function tokenizeWords(text) {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^a-z0-9'\s\-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function extractFactsAndClaims(sentences) {
  // naive heuristic: sentences containing numbers, dates, or "should/must" are claims/facts
  const facts = [], claims = [], questions = [];
  for (const s of sentences) {
    const low = s.toLowerCase();
    if (/[0-9]{2,}|202[0-9]|[0-9]+%/.test(s) || /\b(version|error|commit|bug|issue|cron|workflow)\b/i.test(s)) {
      facts.push(s.trim());
    } else if (/\b(should|must|need to|we should|recommend|suggest|propose)\b/i.test(low)) {
      claims.push(s.trim());
    } else if (/\?$/.test(s.trim()) || /^\s*who\s|what\s|why\s|how\s/i.test(s)) {
      questions.push(s.trim());
    } else {
      // default: neutral facts
      facts.push(s.trim());
    }
  }
  return { facts, claims, questions };
}

function scoreKeywords(words) {
  const freq = Object.create(null);
  words.forEach(w => {
    if (STOPWORDS.has(w) || w.length <= 2) return;
    freq[w] = (freq[w] || 0) + 1;
  });
  const arr = Object.entries(freq).sort((a,b) => b[1]-a[1]);
  return arr.slice(0, 12).map(([k,v]) => ({ keyword: k, count: v }));
}

function identifyFocalPoints(sentences, keywords) {
  // Heuristic: focal points are top keywords + longest sentences containing top keywords
  const topK = keywords.slice(0,Math.min(6, keywords.length)).map(k => k.keyword);
  const matched = [];
  for (const s of sentences) {
    const lw = s.toLowerCase();
    const matches = topK.filter(k => lw.includes(k));
    if (matches.length) {
      matched.push({ sentence: s.trim(), matches, length: s.length });
    }
  }
  matched.sort((a,b) => (b.matches.length - a.matches.length) || (b.length - a.length));
  const focal = matched.slice(0,5).map((m, i) => ({
    id: `F${i+1}`,
    summary: m.sentence,
    triggers: m.matches
  }));
  // Also include top keywords as micro-focal points
  const micro = topK.map((k, i) => ({ id: `K${i+1}`, keyword: k }));
  return { focal, micro };
}

function reArchitect(focalPoints) {
  // For each focal point, propose 1-3 pragmatic actions following 4 principles
  const proposals = focalPoints.focal.map(fp => {
    const actions = [];
    // simple heuristic: if mentions "issue" or "bug" -> triage; if "workflow" -> audit; if "email" -> notify
    const s = fp.summary.toLowerCase();
    if (s.includes('issue') || s.includes('bug') || s.includes('label')) {
      actions.push('Triage: reproduce, add labels, assign owner, prioritize.');
      actions.push('Automate: create a minimal workflow to notify assignees only when label + unassigned.');
    }
    if (s.includes('workflow') || s.includes('cron') || s.includes('gh token') || s.includes('secret')) {
      actions.push('Security audit: list workflows that use tokens; restrict job permissions; rotate tokens.');
      actions.push('Instrument: add verbose logging and dry-run option before any push actions.');
    }
    if (s.includes('email') || s.includes('notify')) {
      actions.push('Validate: ensure email sending does not perform git operations; use read-only tokens for notifications.');
      actions.push('Fallback: add a non-invasive channel (issue comment) as backup notification.');
    }
    if (actions.length === 0) {
      actions.push('Ask clarifying question about intent and constraints; propose a minimal PoC (one-file) to test.');
    }
    return {
      id: fp.id,
      problem: fp.summary,
      proposals: actions.slice(0,3),
      principles: ['Simple','Efficient','Pragmatic','Safe']
    };
  });
  return proposals;
}

function summarizeJSON(origText, decon, keywords, focal, proposals) {
  return {
    meta: {
      timestamp: new Date().toISOString(),
      sourceSize: origText.length
    },
    deconstruction: decon,
    keywords,
    focalPoints: focal,
    rearchitecture: proposals
  };
}

async function main() {
  const argv = require('minimist')(process.argv.slice(2));
  let input = null;
  if (argv.file) {
    input = fs.readFileSync(path.resolve(argv.file), 'utf8');
  } else if (argv._.length) {
    input = argv._.join(' ');
  } else {
    input = await readStdin();
  }
  if (!input) {
    console.error('No input provided. Use --file or pipe text into the script.');
    process.exit(2);
  }
  // limit input size to avoid heavy compute
  if (input.length > 200_000) {
    console.error('Input too large (>200k chars). Aborting.');
    process.exit(3);
  }

  // Split into sentences (naive)
  const sentences = input
    .replace(/\r\n/g,'\n')
    .split(/(?<=[.?!]\s+|\n{2,})/)
    .map(s => s.trim())
    .filter(Boolean);

  const decon = extractFactsAndClaims(sentences);
  const words = tokenizeWords(input);
  const keywords = scoreKeywords(words);
  const focal = identifyFocalPoints(sentences, keywords);
  const proposals = reArchitect(focal);

  const result = summarizeJSON(input, decon, keywords, focal, proposals);

  // write result file
  const outDir = path.resolve('./dr_results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `dr_result_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

  console.log(JSON.stringify(result, null, 2));
  console.error(`Wrote ${outPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
