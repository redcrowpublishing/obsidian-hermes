'use strict';

/**
 * Lightweight large-file search helper for the Hermes Obsidian plugin.
 * It prefers ripgrep when available and falls back to pure JavaScript search.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');

const MAX_OUTPUT_CHARS = 20000;
const DEFAULT_CONTEXT_LINES = 15;
const MAX_PARAGRAPH_CHARS = 3000;
const MAX_RESULTS = 15;
const MAX_COLUMNS = 500;
const RG_TIMEOUT = 15000;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'of', 'in', 'to',
  'for', 'with', 'on', 'at', 'from', 'by', 'and', 'or', 'but', 'not', 'no', 'if',
  'then', 'than', 'that', 'this'
]);

let _rgPath = null;
let _rgChecked = false;

function getRgPath() {
  if (_rgChecked) return _rgPath;
  _rgChecked = true;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['rg'], {
      encoding: 'utf-8', timeout: 5000, windowsHide: true
    }).trim().split('\n')[0].trim();
    if (result && fs.existsSync(result)) _rgPath = result;
  } catch (_) {}
  return _rgPath;
}

function extractKeywords(query) {
  const keywords = new Set();
  const words = query.trim().match(/[\p{L}\p{N}_-]{2,}/gu) || [];
  for (const w of words) {
    const lower = w.toLowerCase();
    if (!STOP_WORDS.has(lower)) keywords.add(w);
  }
  return [...keywords].sort((a, b) => b.length - a.length).slice(0, 8);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rgSearch(filePath, searchTerms) {
  const rg = getRgPath();
  if (!rg) return null;
  const hitLines = new Map();
  for (const term of searchTerms) {
    try {
      const result = execFileSync(rg, [
        '--line-number', '--no-heading', '--color', 'never', '-i', '-F',
        '--max-columns', String(MAX_COLUMNS), '--', term, filePath
      ], { encoding: 'utf-8', timeout: RG_TIMEOUT, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
      for (const line of result.split('\n')) {
        const colon = line.indexOf(':');
        if (colon > 0) {
          const idx = parseInt(line.slice(0, colon), 10) - 1;
          if (!Number.isNaN(idx) && idx >= 0) {
            if (!hitLines.has(idx)) hitLines.set(idx, new Set());
            hitLines.get(idx).add(term);
          }
        }
      }
    } catch (_) {}
  }
  return hitLines;
}

function jsSearch(lines, searchTerms) {
  const hitLines = new Map();
  const patterns = searchTerms.map(term => ({ term, re: new RegExp(escapeRegExp(term), 'i') }));
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > MAX_COLUMNS) continue;
    for (const { term, re } of patterns) {
      if (re.test(lines[i])) {
        if (!hitLines.has(i)) hitLines.set(i, new Set());
        hitLines.get(i).add(term);
      }
    }
  }
  return hitLines;
}

function buildRegions(hitLines, totalLines, contextLines) {
  if (hitLines.size === 0) return [];
  const sortedHits = [...hitLines.keys()].sort((a, b) => a - b);
  const rawRegions = [];
  let start = sortedHits[0], end = sortedHits[0], kws = new Set(hitLines.get(sortedHits[0])), count = 1;
  for (let i = 1; i < sortedHits.length; i++) {
    const idx = sortedHits[i];
    if (idx - end <= contextLines) {
      end = idx;
      for (const kw of hitLines.get(idx)) kws.add(kw);
      count++;
    } else {
      rawRegions.push({ start, end, keywords: kws, hitCount: count });
      start = end = idx;
      kws = new Set(hitLines.get(idx));
      count = 1;
    }
  }
  rawRegions.push({ start, end, keywords: kws, hitCount: count });
  return rawRegions.map(r => {
    const ctxStart = Math.max(0, r.start - contextLines);
    const ctxEnd = Math.min(totalLines - 1, r.end + contextLines);
    const span = ctxEnd - ctxStart + 1;
    const sizePenalty = span > 200 ? 0.3 : span > 100 ? 0.6 : 1.0;
    const score = (r.keywords.size * r.keywords.size * 5 + (r.hitCount / span) * 10) * sizePenalty;
    return { start: ctxStart, end: ctxEnd, keywords: r.keywords, hitCount: r.hitCount, score };
  }).sort((a, b) => b.score - a.score);
}

function findHeadings(lines, lineIdx) {
  let h1 = null, h2 = null;
  for (let i = lineIdx; i >= 0; i--) {
    const line = lines[i].trim();
    if (!h2 && /^## /.test(line)) h2 = line.replace(/^## +/, '');
    if (!h1 && /^# /.test(line) && !/^## /.test(line)) h1 = line.replace(/^# +/, '');
    if (h1 && h2) break;
    if (lineIdx - i > 500) break;
  }
  if (h1 && h2) return `${h1} > ${h2}`;
  return h1 || h2 || null;
}

function formatOutput(query, keywords, regions, lines, maxChars) {
  const parts = [`Search: ${query}`, `Keywords: ${keywords.join(', ')}`, `Found ${regions.length} relevant passages`, ''];
  let totalChars = parts.join('\n').length;
  let shown = 0;
  for (const region of regions) {
    if (shown >= MAX_RESULTS) break;
    let text = lines.slice(region.start, region.end + 1).join('\n');
    if (text.length > MAX_PARAGRAPH_CHARS) text = text.slice(0, MAX_PARAGRAPH_CHARS) + '\n...(passage truncated)';
    const heading = findHeadings(lines, region.start);
    const block = [
      '='.repeat(60),
      `[Passage ${shown + 1}] ${heading ? heading + ' | ' : ''}lines ${region.start + 1}-${region.end + 1} | matches: ${[...region.keywords].join(', ')} | hits: ${region.hitCount}`,
      '='.repeat(60),
      '',
      text,
      ''
    ].join('\n');
    if (totalChars + block.length > maxChars && shown > 0) {
      parts.push(`\n...(reached ${maxChars} character limit; omitted ${regions.length - shown} remaining passages)`);
      break;
    }
    parts.push(block);
    totalChars += block.length;
    shown++;
  }
  return parts.join('\n');
}

function vaultSearch(query, filePath, options = {}) {
  const contextLines = options.contextLines || DEFAULT_CONTEXT_LINES;
  const maxChars = options.maxChars || MAX_OUTPUT_CHARS;
  if (!query || !query.trim()) return '';
  if (!fs.existsSync(filePath)) return `File does not exist: ${filePath}`;
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return 'No useful search terms could be extracted from the query.';
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  let hitLines = rgSearch(filePath, keywords);
  if (!hitLines || hitLines.size === 0) hitLines = jsSearch(lines, keywords);
  if (hitLines.size === 0) return `Search: ${query}\nKeywords: ${keywords.join(', ')}\nNo relevant content found.`;
  return formatOutput(query, keywords, buildRegions(hitLines, lines.length, contextLines), lines, maxChars);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--query' && args[i + 1]) opts.query = args[++i];
    else if (args[i] === '--path' && args[i + 1]) opts.path = args[++i];
    else if (args[i] === '--context' && args[i + 1]) opts.contextLines = parseInt(args[++i], 10);
    else if (args[i] === '--max-chars' && args[i + 1]) opts.maxChars = parseInt(args[++i], 10);
  }
  if (!opts.query || !opts.path) {
    console.error('Usage: node vault_search.js --query "search terms" --path "file path" [--context 15] [--max-chars 20000]');
    process.exit(1);
  }
  process.stdout.write(vaultSearch(opts.query, opts.path, opts));
}

module.exports = { vaultSearch, extractKeywords, getRgPath };
