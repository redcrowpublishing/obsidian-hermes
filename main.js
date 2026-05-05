var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

var main_exports = {};
__export(main_exports, { default: () => HermesPlugin });
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

// CodeMirror 6 modules
var cm_state = require("@codemirror/state");
var cm_view = require("@codemirror/view");

// ============================================
// Built-in Vault Search (embedded from vault_search.js)
// Zero dependencies — works without vault_search.py
// ============================================

const _VS_STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','have','has','had',
  'do','does','did','will','would','could','should','may','might','can',
  'i','you','he','she','it','we','they','me','him','her','them','my','your',
  'of','in','to','for','with','on','at','from','by','and','or','but','not','if',
  'this','that','these','those','what','when','where','why','how','about','into',
  'note','file','please','using','use','make','give','show','tell','ask'
]);

const _VS_SYNONYMS = {
  'wife': ['spouse', 'partner'],
  'husband': ['spouse', 'partner'],
  'child': ['children', 'son', 'daughter'],
  'teacher': ['mentor', 'instructor'],
  'student': ['learner', 'pupil'],
  'work': ['job', 'career', 'project'],
  'study': ['research', 'learning'],
  'problem': ['issue', 'question'],
  'method': ['approach', 'procedure', 'workflow'],
  'note': ['document', 'file'],
  'summary': ['summarize', 'abstract'],
  'review': ['audit', 'critique']
};

function _vsSplitByCnBreaks(text) {
  return [{ text, breakAfter: null }];
}

function _vsEscapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _vsExtractKeywords(query) {
  const keywords = new Set();
  const chineseSegs = query.trim().match(/[\u4e00-\u9fff]+/g) || [];
  const englishWords = query.trim().match(/[a-zA-Z]{2,}/g) || [];

  for (const seg of chineseSegs) {
    if (seg.length >= 2 && seg.length <= 8) keywords.add(seg);
    for (const { text, breakAfter } of _vsSplitByCnBreaks(seg)) {
      if (text.length >= 2 && !_VS_STOP_WORDS.has(text)) {
        keywords.add(text);
        if (text.length >= 4) {
          const h = text.slice(0, 2), t = text.slice(-2);
          if (!_VS_STOP_WORDS.has(h)) keywords.add(h);
          if (!_VS_STOP_WORDS.has(t)) keywords.add(t);
        }
        if (breakAfter && text.length + breakAfter.length <= 6) keywords.add(text + breakAfter);
      }
    }
  }
  for (const w of englishWords) {
    if (!_VS_STOP_WORDS.has(w.toLowerCase())) keywords.add(w);
  }

  const primary = [...keywords].sort((a, b) => b.length - a.length).slice(0, 8);
  const expanded = [...primary];
  const seen = new Set(primary.map(w => w.toLowerCase()));
  for (const kw of primary) {
    for (const syn of (_VS_SYNONYMS[kw] || [])) {
      if (!seen.has(syn.toLowerCase())) { expanded.push(syn); seen.add(syn.toLowerCase()); }
    }
  }
  return expanded;
}

function _vsJsSearch(lines, searchTerms) {
  const hitLines = new Map();
  const patterns = searchTerms.map(t => ({ term: t, re: new RegExp(_vsEscapeRe(t), 'i') }));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 2000) continue;
    for (const { term, re } of patterns) {
      if (re.test(line)) {
        if (!hitLines.has(i)) hitLines.set(i, new Set());
        hitLines.get(i).add(term);
      }
    }
  }
  return hitLines;
}

function _vsBuildRegions(hitLines, totalLines, contextLines) {
  if (hitLines.size === 0) return [];
  const sortedHits = [...hitLines.keys()].sort((a, b) => a - b);
  const raw = [];
  let rStart = sortedHits[0], rEnd = sortedHits[0];
  let rKws = new Set(hitLines.get(sortedHits[0])), rHits = 1;
  for (let i = 1; i < sortedHits.length; i++) {
    const idx = sortedHits[i];
    if (idx - rEnd <= contextLines) {
      rEnd = idx; for (const kw of hitLines.get(idx)) rKws.add(kw); rHits++;
    } else {
      raw.push({ start: rStart, end: rEnd, keywords: rKws, hitCount: rHits });
      rStart = idx; rEnd = idx; rKws = new Set(hitLines.get(idx)); rHits = 1;
    }
  }
  raw.push({ start: rStart, end: rEnd, keywords: rKws, hitCount: rHits });
  return raw.map(r => {
    const ctxStart = Math.max(0, r.start - contextLines);
    const ctxEnd = Math.min(totalLines - 1, r.end + contextLines);
    const span = ctxEnd - ctxStart + 1;
    const sizePenalty = span > 200 ? 0.3 : span > 100 ? 0.6 : 1.0;
    const score = (r.keywords.size * r.keywords.size * 5 + (r.hitCount / span) * 10) * sizePenalty;
    return { start: ctxStart, end: ctxEnd, keywords: r.keywords, hitCount: r.hitCount, score };
  }).sort((a, b) => b.score - a.score);
}

function _vsFindHeadings(lines, lineIdx) {
  let h1 = null, h2 = null;
  for (let i = lineIdx; i >= 0; i--) {
    const line = lines[i].trim();
    if (!h2 && /^## /.test(line)) h2 = line.replace(/^## +/, '');
    if (!h1 && /^# /.test(line) && !/^## /.test(line)) h1 = line.replace(/^# +/, '');
    if (h1 && h2) break;
    if (lineIdx - i > 500) break;
  }
  if (h1 && h2) return `📖 ${h1} > 📑 ${h2}`;
  if (h1) return `📖 ${h1}`;
  if (h2) return `📑 ${h2}`;
  return null;
}

/**
 * Built-in large-file search. Searches content already loaded from Obsidian; no external helper required.
 * @param {string} content complete file text
 * @param {string} query user query
 * @returns {string|null} formatted search results, or null when no matches are found
 */
function builtinVaultSearch(content, query) {
  const CONTEXT_LINES = 15;
  const MAX_CHARS = 15000;
  const MAX_PARA_CHARS = 3000;
  const MAX_RESULTS = 8;

  const lines = content.split('\n');
  const searchTerms = _vsExtractKeywords(query);
  if (searchTerms.length === 0) return null;

  const hitLines = _vsJsSearch(lines, searchTerms);
  if (hitLines.size === 0) return null;

  const regions = _vsBuildRegions(hitLines, lines.length, CONTEXT_LINES);
  if (regions.length === 0) return null;

  const header = `Search for "${query}". Keywords: ${searchTerms.slice(0, 6).join(', ')} | Found ${regions.length} relevant passages\n`;
  const parts = [header];
  let totalChars = header.length;
  let shown = 0;

  for (const region of regions) {
    if (shown >= MAX_RESULTS) break;
    let text = lines.slice(region.start, region.end + 1).join('\n');
    if (text.length > MAX_PARA_CHARS) text = text.slice(0, MAX_PARA_CHARS) + '\n…(truncated)';
    const heading = _vsFindHeadings(lines, region.start);
    const block = [
      '─'.repeat(50),
      `[Passage ${shown + 1}] ${heading ? heading + ' | ' : ''}lines ${region.start + 1}-${region.end + 1} | matches: ${[...region.keywords].join(', ')}`,
      '─'.repeat(50),
      text, ''
    ].join('\n');
    if (totalChars + block.length > MAX_CHARS && shown > 0) break;
    parts.push(block);
    totalChars += block.length;
    shown++;
  }

  return parts.join('\n');
}

// ============================================
// SecureStorage (preserved from v0.4.1)
// ============================================
var safeStorage = null;
var safeStorageAvailable = null;

function getSafeStorage() {
  var _a;
  if (safeStorageAvailable === false) return null;
  if (safeStorage) return safeStorage;
  try {
    const electron = require("electron");
    if ((_a = electron == null ? void 0 : electron.remote) == null ? void 0 : _a.safeStorage) {
      safeStorage = electron.remote.safeStorage;
    } else if (electron == null ? void 0 : electron.safeStorage) {
      safeStorage = electron.safeStorage;
    }
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      safeStorageAvailable = true;
      return safeStorage;
    }
  } catch (e) {}
  safeStorageAvailable = false;
  return null;
}

function getEnvToken() {
  try { return process.env.HERMES_API_TOKEN || process.env.OPENCLAW_TOKEN || null; } catch (e) { return null; }
}

var SecureTokenStorage = class {
  constructor() { this.encryptedToken = null; this.plaintextToken = ""; }
  getActiveMethod() {
    if (getEnvToken()) return "envVar";
    if (getSafeStorage()) return "safeStorage";
    return "plaintext";
  }
  getStatusInfo() {
    if (getEnvToken()) return { method: "envVar", description: "Using HERMES_API_TOKEN (or legacy OPENCLAW_TOKEN) environment variable", secure: true };
    if (getSafeStorage()) return { method: "safeStorage", description: "Encrypted with OS keychain", secure: true };
    return { method: "plaintext", description: "\u26A0\uFE0F Stored in plaintext", secure: false };
  }
  setToken(token) {
    if (getEnvToken()) return { encrypted: null, plaintext: "" };
    const storage = getSafeStorage();
    if (storage && token) {
      try {
        const encrypted = storage.encryptString(token);
        this.encryptedToken = encrypted.toString("base64");
        this.plaintextToken = "";
        return { encrypted: this.encryptedToken, plaintext: "" };
      } catch (e) {}
    }
    this.encryptedToken = null;
    this.plaintextToken = token;
    return { encrypted: null, plaintext: token };
  }
  getToken(encrypted, plaintext) {
    const envToken = getEnvToken();
    if (envToken) return envToken;
    if (encrypted) {
      const storage = getSafeStorage();
      if (storage) {
        try { return storage.decryptString(Buffer.from(encrypted, "base64")); } catch (e) {}
      }
    }
    return plaintext || "";
  }
};

var secureTokenStorage = new SecureTokenStorage();

// ============================================
// Vault Helper Functions (Phase 1)
// ============================================
function listSiblingFiles(app, file) {
  if (!file || !file.parent) return [];
  return file.parent.children.map(c => c.name).sort();
}

function buildSystemPrompt(app, settings) {
  const activeFile = app.workspace.getActiveFile();
  let prompt = `You are an AI assistant inside an Obsidian vault, helping the user manage notes.\n`;
  prompt += `Treat vault paths as vault-relative unless the user explicitly provides an absolute path. Do not assume any particular folder layout.\n`;
  if (activeFile) {
    prompt += `Current file: ${activeFile.path}\n`;
    const siblings = listSiblingFiles(app, activeFile);
    if (siblings.length > 0) {
      prompt += `Files in current directory:\n${siblings.map(s => `  - ${s}`).join('\n')}\n`;
    }
  }
  const workflowFolder = normalizeVaultFolder(settings.workflowFolder || "");
  if (workflowFolder) {
    prompt += `Workflow folder configured for this vault: ${workflowFolder}/\n`;
  }
  prompt += `\n## Response Format\n`;
  prompt += `- Conclusion first, then reasoning — lead with the answer\n`;
  prompt += `- Use Markdown tables for comparisons, option lists, and config summaries\n`;
  prompt += `- Use headers (##/###) to structure longer responses — avoid walls of text\n`;
  prompt += `- All code and commands go in fenced code blocks with a language tag\n`;
  prompt += `- Be concise — don't pad; if one sentence suffices, don't write three\n`;
  prompt += `- If uncertain, say so — don't guess or fabricate\n`;
  prompt += `\n## Obsidian Native\n`;
  prompt += `- Preserve YAML frontmatter (\`---\` blocks), \`[[wikilinks]]\`, \`#tags\`, and dataview blocks — never corrupt them\n`;
  prompt += `- To modify an existing file: use the edit tool (provide oldText + newText). Use write only for new files\n`;
  prompt += `- Always read a file before modifying it\n`;
  prompt += `- Use vault-relative paths for vault files unless the user explicitly asks otherwise\n`;
  prompt += `\n## File Tools\n`;
  prompt += `If file tools are available, use them with vault-relative paths. Create files with write, read files with read, and edit existing files with edit. Obsidian auto-detects file changes.\n`;
  prompt += `\n## Large file search\n`;
  prompt += `When a large file is attached (marked [Large file]), search for focused keywords, then request or inspect surrounding context before answering.\n`;
  prompt += `Strategy:\n`;
  prompt += `1. Extract the core keyword from the user's question (not the whole sentence)\n`;
  prompt += `2. Search for exact terms first; if there are no results, try synonyms or related terms\n`;
  prompt += `3. Once you find matches, inspect enough surrounding context to avoid misquoting or overgeneralizing\n`;
  prompt += `4. For non-English text, try exact terms and obvious variants when useful.\n`;
  prompt += `\n## Selection Context\n`;
  prompt += `User messages may include an \`<editor_selection>\` tag showing text the user selected:\n`;
  prompt += `\`\`\`\n<editor_selection path="path/to/file.md" lines="10-15">\nselected text here\n</editor_selection>\n\`\`\`\n`;
  prompt += `**When present:** The user selected this text before sending their message. Use this context to understand what they're referring to. Address the selected content directly in your response.\n`;
  return prompt;
}

// ============================================
// Word-level Diff (Phase 2 - Inline Edit)
// ============================================
function computeWordDiff(oldText, newText) {
  const oldWords = oldText.split(/(\s+)/);
  const newWords = newText.split(/(\s+)/);
  // Simple LCS-based diff
  const m = oldWords.length, n = newWords.length;
  // For performance, use a simplified approach
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldWords[i - 1] === newWords[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // Backtrack
  const result = [];
  let i = m, j = n;
  const ops = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      ops.push({ type: 'same', text: oldWords[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'ins', text: newWords[j - 1] });
      j--;
    } else {
      ops.push({ type: 'del', text: oldWords[i - 1] });
      i--;
    }
  }
  ops.reverse();
  return ops;
}

// ============================================
// Slash Commands Definition
// ============================================
var SLASH_COMMANDS = [
  { command: '/rewrite', label: '/rewrite', description: 'Rewrite the current note' },
  { command: '/translate', label: '/translate', description: 'Translate the selected text' },
  { command: '/summarize', label: '/summarize', description: 'Summarize the current note' },
  { command: '/expand', label: '/expand', description: 'Expand the selected content' },
  { command: '/fix', label: '/fix', description: 'Fix grammar, spelling, and clarity' },
  { command: '/compact', label: '/compact', description: 'Compress this plugin conversation locally' },
  { command: '/setup', label: '/setup', description: 'Hermes Agent setup guidance' },
  { command: '/help', label: '/help', description: 'Hermes Agent help' },
  { command: '/commands', label: '/commands', description: 'List Hermes Agent commands' },
  { command: '/status', label: '/status', description: 'Show Hermes Agent session status' },
  { command: '/model', label: '/model', description: 'Show or change the Hermes model' },
  { command: '/tools', label: '/tools', description: 'Manage Hermes tools' },
  { command: '/skills', label: '/skills', description: 'Search or install Hermes skills' },
  { command: '/skill', label: '/skill', description: 'Load a named Hermes skill' },
  { command: '/new', label: '/new', description: 'Start a fresh Hermes session' },
  { command: '/clear', label: '/clear', description: 'Clear context / start over' },
  { command: '/resume', label: '/resume', description: 'Resume a Hermes session' },
  { command: '/save', label: '/save', description: 'Save conversation from Hermes' },
  { command: '/workflow-review-note', label: '/workflow-review-note', description: 'Review the active note', prompt: 'Review the active note for structure, clarity, links, tags, stale claims, and actionable next edits. Distinguish fact, inference, interpretation, and suggestion. If this vault has a configured workflow folder, use the relevant workflow there when available.' },
  { command: '/workflow-create-note', label: '/workflow-create-note', description: 'Draft a new note', prompt: 'Ask only for missing essentials. Draft a vault-native Markdown note with frontmatter, wikilinks where useful, and clear status. If this vault has a configured workflow folder, use the relevant workflow there when available.' },
  { command: '/workflow-research-pack', label: '/workflow-research-pack', description: 'Build a research context pack from selected/current material', prompt: 'Build a concise context pack: question, sources/material, claims, uncertainties, connections, and next actions. If this vault has a configured workflow folder, use the relevant workflow there when available.' },
];

// ============================================
// Settings & Defaults
// ============================================
var DEFAULT_SETTINGS = {
  gatewayUrl: "http://127.0.0.1:18789",
  gatewayTokenEncrypted: null,
  gatewayTokenPlaintext: "",
  defaultModel: "hermes/obsidian",
  scopes: "",
  vaultSearchPath: "",
  workflowFolder: "",
  customModels: [],
  streamMarkdown: false,
  showActionsInChat: true,
  customCommands: [],
  commandUsage: {},
  auditLogEnabled: false,
  auditLogPath: "Hermes/audit-log.md",
  includeCurrentNote: true,
  conversationsPath: "Hermes/conversations",
  syncEnabled: false,
  syncServerUrl: "http://127.0.0.1:18790",
  syncPaths: [{ remotePath: "notes", localPath: "Hermes/Notes", enabled: true }],
  syncInterval: 0,
  syncConflictBehavior: "ask",
  selectedModel: ""
};

// ============================================
// Hermes Agent Gateway API (streaming via Node http)
// ============================================
var HermesAPI = class {
  constructor(settings) { this.settings = settings; }
  getToken() {
    return secureTokenStorage.getToken(this.settings.gatewayTokenEncrypted, this.settings.gatewayTokenPlaintext);
  }

  validateGatewayUrl() {
    const parsedUrl = new URL(`${this.settings.gatewayUrl}/v1/chat/completions`);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("Gateway URL must use http or https");
    if (!parsedUrl.hostname) throw new Error("Gateway URL is missing a host");
    return parsedUrl;
  }

  /**
   * Streaming chat with thinking support.
   * Returns { text, thinking } — thinking is array of { content } blocks.
   */
  async chat(messages, onChunk, onThinking, abortSignal) {
    const parsedUrl = this.validateGatewayUrl();
    const token = this.getToken();
    const body = JSON.stringify({
      model: this.settings.defaultModel || "hermes/obsidian",
      messages: messages,
      stream: true
    });

    const http = require(parsedUrl.protocol === "https:" ? "https" : "http");

    return new Promise((resolve, reject) => {
      if (abortSignal?.aborted) { reject(new Error("AbortError")); return; }

      const req = http.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: parsedUrl.pathname,
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          ...(this.settings.scopes ? { "x-hermes-scopes": this.settings.scopes } : {})
        }
      }, (res) => {
        if (res.statusCode >= 400) {
          let errBody = "";
          res.on("data", (chunk) => errBody += chunk);
          res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${errBody}`)));
          return;
        }

        let fullText = "";
        let thinkingText = "";
        let inThinking = false;
        let buffer = "";

        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              if (!delta) continue;

              // Check for thinking/reasoning content
              if (delta.reasoning_content || delta.reasoning) {
                const rc = delta.reasoning_content || delta.reasoning;
                thinkingText += rc;
                inThinking = true;
                if (onThinking) onThinking(thinkingText);
              }
              if (delta.content) {
                if (inThinking) inThinking = false;
                fullText += delta.content;
                if (onChunk) onChunk(fullText, delta.content);
              }
            } catch (e) {}
          }
        });

        res.on("end", () => resolve({ text: fullText, thinking: thinkingText }));
        res.on("error", (err) => reject(err));
      });

      req.setTimeout(120000, () => { req.destroy(new Error("Gateway request timed out")); });
      req.on("error", (err) => reject(new Error(`Connection failed: ${err.message}`)));

      if (abortSignal) {
        const onAbort = () => { req.destroy(); reject(Object.assign(new Error("Cancelled"), { name: "AbortError" })); };
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      req.write(body);
      req.end();
    });
  }

  async chatSync(message, systemPrompt) {
    const url = this.validateGatewayUrl().toString();
    const token = this.getToken();
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: message });
    const response = await (0, import_obsidian.requestUrl)({
      url, method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", ...(this.settings.scopes ? { "x-hermes-scopes": this.settings.scopes } : {}) },
      body: JSON.stringify({ model: this.settings.defaultModel || "hermes/obsidian", messages, stream: false })
    });
    if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${response.text}`);
    return response.json?.choices?.[0]?.message?.content || "";
  }

};

// ============================================
// ConversationStore — Persistence
// ============================================
var ConversationStore = class {
  constructor(app, getSettings) {
    this.app = app;
    this.getSettings = getSettings;
    this.conversations = new Map();
  }

  generateId() { return "conv-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8); }

  createConversation(title) {
    const id = this.generateId();
    const conv = { id, title: title || "New Chat", messages: [], model: "", createdAt: Date.now(), updatedAt: Date.now() };
    this.conversations.set(id, conv);
    return conv;
  }

  getConversation(id) { return this.conversations.get(id) || null; }

  deleteConversation(id) { this.conversations.delete(id); this.deleteFile(id); }

  updateTitle(id, title) {
    const conv = this.conversations.get(id);
    if (conv) { conv.title = title; conv.updatedAt = Date.now(); }
  }

  addMessage(convId, role, content, extra) {
    const conv = this.conversations.get(convId);
    if (!conv) return;
    const msg = { role, content, timestamp: Date.now() };
    if (extra?.thinking) msg.thinking = extra.thinking;
    if (extra?.images) msg.images = extra.images;
    conv.messages.push(msg);
    conv.updatedAt = Date.now();
    if (conv.title === "New Chat" && role === "user") {
      conv.title = content.slice(0, 40) + (content.length > 40 ? "..." : "");
      conv._autoTitled = true;
    }
  }

  removeMessage(convId, index) {
    const conv = this.conversations.get(convId);
    if (!conv || index < 0 || index >= conv.messages.length) return;
    conv.messages.splice(index, 1);
    conv.updatedAt = Date.now();
  }

  // Truncate messages from index onwards (for edit-resend)
  truncateFrom(convId, index) {
    const conv = this.conversations.get(convId);
    if (!conv) return;
    conv.messages = conv.messages.slice(0, index);
    conv.updatedAt = Date.now();
  }

  getMessages(convId) {
    const conv = this.conversations.get(convId);
    if (!conv) return [];
    return conv.messages.map(m => ({ role: m.role, content: m.content }));
  }

  getAllConversations() {
    return Array.from(this.conversations.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveConversation(id) {
    const conv = this.conversations.get(id);
    if (!conv) return;
    const settings = this.getSettings();
    const folder = settings.conversationsPath;
    await this.ensureFolder(folder);
    const filePath = `${folder}/${id}.json`;
    const data = JSON.stringify(conv, null, 2);
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof import_obsidian.TFile) {
      await this.app.vault.modify(existing, data);
    } else {
      await this.app.vault.create(filePath, data);
    }
    // Dual-write: export readable Markdown copy
    try { await this.exportMarkdown(id); } catch (e) { console.error("Hermes: MD export error", e); }
  }

  async loadAll() {
    const settings = this.getSettings();
    const folder = settings.conversationsPath;
    const folderObj = this.app.vault.getAbstractFileByPath(folder);
    if (!folderObj || !(folderObj instanceof import_obsidian.TFolder)) return;
    for (const child of folderObj.children) {
      if (child instanceof import_obsidian.TFile && child.extension === "json") {
        try {
          const raw = await this.app.vault.read(child);
          const conv = JSON.parse(raw);
          if (conv.id && conv.messages) this.conversations.set(conv.id, conv);
        } catch (e) { console.error("Hermes: Failed to load conversation", child.path, e); }
      }
    }
  }

  async exportMarkdown(id) {
    const conv = this.conversations.get(id);
    if (!conv || !conv.messages.length) return;
    const settings = this.getSettings();
    const mdFolder = settings.conversationsPath + "/md";
    await this.ensureFolder(mdFolder);

    const created = new Date(conv.createdAt);
    const updated = new Date(conv.updatedAt);
    const pad = (n) => String(n).padStart(2, "0");
    const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

    // Build safe filename from title
    const safeTitle = (conv.title || "Untitled").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
    const datePrefix = `${created.getFullYear()}${pad(created.getMonth()+1)}${pad(created.getDate())}`;
    const fileName = `${datePrefix}-${safeTitle}.md`;

    let md = `---\ntitle: "${conv.title.replace(/"/g, '\\"')}"\ncreated: ${fmtDate(created)}\nupdated: ${fmtDate(updated)}\nid: ${conv.id}\n---\n\n`;

    for (const msg of conv.messages) {
      const time = new Date(msg.timestamp);
      const timeStr = `${pad(time.getHours())}:${pad(time.getMinutes())}`;
      if (msg.role === "user") {
        md += `## 👤 User (${timeStr})\n\n${msg.content}\n\n`;
      } else if (msg.role === "assistant") {
        if (msg.thinking) {
          md += `## 🤖 Assistant (${timeStr})\n\n<details><summary>💭 Thinking</summary>\n\n${msg.thinking}\n\n</details>\n\n${msg.content}\n\n`;
        } else {
          md += `## 🤖 Assistant (${timeStr})\n\n${msg.content}\n\n`;
        }
      }
    }

    const mdPath = `${mdFolder}/${fileName}`;
    const existing = this.app.vault.getAbstractFileByPath(mdPath);
    try {
      if (existing instanceof import_obsidian.TFile) {
        await this.app.vault.modify(existing, md);
      } else {
        // Remove old exports for same conv id (title may have changed)
        const folder = this.app.vault.getAbstractFileByPath(mdFolder);
        if (folder instanceof import_obsidian.TFolder) {
          for (const child of folder.children) {
            if (child instanceof import_obsidian.TFile && child.extension === "md") {
              try {
                const raw = await this.app.vault.read(child);
                if (raw.includes("id: " + conv.id)) {
                  await this.app.vault.delete(child);
                }
              } catch (e) {}
            }
          }
        }
        await this.app.vault.create(mdPath, md);
      }
    } catch (e) { console.error("Hermes: MD export failed", e); }
  }

  async deleteFile(id) {
    const settings = this.getSettings();
    const file = this.app.vault.getAbstractFileByPath(`${settings.conversationsPath}/${id}.json`);
    if (file) { try { await this.app.vault.delete(file); } catch (e) {} }
  }

  async ensureFolder(path) {
    const parts = path.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }
};

// ============================================
// File Action Executor (preserved from v0.4.1)
// ============================================
var DESTRUCTIVE_ACTIONS = ["createFile", "updateFile", "appendToFile", "deleteFile", "renameFile"];

var ConfirmActionModal = class extends import_obsidian.Modal {
  constructor(app, action, description) {
    super(app); this.action = action; this.description = description; this.result = false;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Confirm Action" });
    contentEl.createEl("p", { text: "Hermes wants to perform the following action:" });
    const detailsEl = contentEl.createDiv({ cls: "oc-confirm-details" });
    detailsEl.createEl("strong", { text: this.getActionLabel() });
    detailsEl.createEl("p", { text: this.description });
    if (this.action.action === "deleteFile") contentEl.createDiv({ cls: "oc-confirm-warning" }).setText("\u26A0\uFE0F This action cannot be undone.");
    const buttons = contentEl.createDiv({ cls: "oc-confirm-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => { this.result = false; this.close(); });
    const confirmBtn = buttons.createEl("button", { text: "Confirm", cls: "mod-cta" });
    confirmBtn.addEventListener("click", () => { this.result = true; this.close(); });
    confirmBtn.focus();
  }
  onClose() { this.contentEl.empty(); if (this.resolvePromise) this.resolvePromise(this.result); }
  getActionLabel() {
    return ({ deleteFile: "\uD83D\uDDD1\uFE0F Delete", updateFile: "\u270F\uFE0F Update", renameFile: "\uD83D\uDCDD Rename" })[this.action.action] || this.action.action;
  }
  async waitForResult() { return new Promise(resolve => { this.resolvePromise = resolve; this.open(); }); }
};

var ActionExecutor = class {
  constructor(app, getSettings) { this.app = app; this.getSettings = getSettings; }
  async execute(actions) {
    let success = 0, failed = 0, skipped = 0;
    for (const action of actions) {
      try {
        if (DESTRUCTIVE_ACTIONS.includes(action.action)) {
          const modal = new ConfirmActionModal(this.app, action, this.getDesc(action));
          if (!await modal.waitForResult()) { skipped++; await this.log(action, "skipped"); continue; }
        }
        await this.executeOne(action);
        await this.log(action, "success");
        success++;
      } catch (err) {
        await this.log(action, "failed", err instanceof Error ? err.message : String(err));
        failed++;
      }
    }
    if (success > 0) new import_obsidian.Notice(`Hermes: ${success} action(s) completed`);
    if (failed > 0) new import_obsidian.Notice(`Hermes: ${failed} action(s) failed`);
    return { success, failed, skipped };
  }
  getDesc(action) {
    if (action.action === "deleteFile") return `Delete: ${action.path}`;
    if (action.action === "updateFile") return `Replace: ${action.path}`;
    if (action.action === "renameFile") return `Rename: ${action.path} \u2192 ${action.newPath}`;
    return JSON.stringify(action);
  }
  async log(action, status, error) {
    const settings = this.getSettings();
    if (!settings.auditLogEnabled) return;
    const { vault } = this.app;
    const logPath = settings.auditLogPath;
    const ts = new Date().toISOString();
    const emoji = status === "success" ? "\u2705" : status === "failed" ? "\u274C" : "\u23ED\uFE0F";
    let entry = `\n| ${ts} | ${emoji} ${status} | \`${action.action}\` | `;
    if (action.action === "renameFile") entry += `\`${action.path}\` \u2192 \`${action.newPath}\` |`;
    else if (action.path) entry += `\`${action.path}\` |`;
    else entry += `${JSON.stringify(action)} |`;
    if (error) entry += ` ${error}`;
    let logFile = vault.getAbstractFileByPath(logPath);
    if (!logFile) {
      const folder = logPath.substring(0, logPath.lastIndexOf("/"));
      if (folder && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
      await vault.create(logPath, `# Hermes Audit Log\n\n| Timestamp | Status | Action | Details |\n|-----------|--------|--------|---------|` + entry);
    } else if (logFile instanceof import_obsidian.TFile) {
      const content = await vault.read(logFile);
      await vault.modify(logFile, content + entry);
    }
  }
  validateVaultPath(path) {
    if (!path || typeof path !== "string") throw new Error("Missing path");
    if (path.length > 240) throw new Error("Path is too long");
    if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\")) throw new Error("Absolute paths are not allowed");
    const normalized = path.replace(/\\/g, "/");
    if (normalized.split("/").some(part => part === ".." || part === "")) throw new Error("Invalid relative path");
    if (normalized.startsWith(".obsidian/") || normalized === ".obsidian") throw new Error("Refusing to modify Obsidian configuration files");
    return normalized;
  }
  validateAction(action) {
    const allowed = new Set(["createFile", "updateFile", "appendToFile", "deleteFile", "renameFile", "openFile"]);
    if (!action || !allowed.has(action.action)) throw new Error(`Unsupported action: ${action?.action}`);
    if (action.path) action.path = this.validateVaultPath(action.path);
    if (action.newPath) action.newPath = this.validateVaultPath(action.newPath);
    if (typeof action.content === "string" && action.content.length > 500000) throw new Error("Action content exceeds 500 KB safety limit");
  }
  async executeOne(action) {
    this.validateAction(action);
    const { vault } = this.app;
    switch (action.action) {
      case "createFile": {
        if (vault.getAbstractFileByPath(action.path)) throw new Error(`Exists: ${action.path}`);
        const folder = action.path.substring(0, action.path.lastIndexOf("/"));
        if (folder && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
        await vault.create(action.path, action.content);
        break;
      }
      case "updateFile": { const f = vault.getAbstractFileByPath(action.path); if (!(f instanceof import_obsidian.TFile)) throw new Error(`Not found: ${action.path}`); await vault.modify(f, action.content); break; }
      case "appendToFile": { const f = vault.getAbstractFileByPath(action.path); if (!(f instanceof import_obsidian.TFile)) throw new Error(`Not found: ${action.path}`); await vault.modify(f, (await vault.read(f)) + "\n" + action.content); break; }
      case "deleteFile": { const f = vault.getAbstractFileByPath(action.path); if (!f) throw new Error(`Not found: ${action.path}`); await vault.delete(f); break; }
      case "renameFile": { const f = vault.getAbstractFileByPath(action.path); if (!f) throw new Error(`Not found: ${action.path}`); await vault.rename(f, action.newPath); break; }
      case "openFile": { const f = vault.getAbstractFileByPath(action.path); if (!(f instanceof import_obsidian.TFile)) throw new Error(`Not found: ${action.path}`); await this.app.workspace.getLeaf().openFile(f); break; }
      default: throw new Error(`Unknown: ${action.action}`);
    }
  }
  parseActions(text) {
    const match = text.match(/```json:(?:hermes|openclaw)-actions\n([\s\S]*?)```/);
    if (!match) return [];
    try { return JSON.parse(match[1]); } catch (e) { return []; }
  }
  stripActionBlocks(text) { return text.replace(/```json:(?:hermes|openclaw)-actions\n[\s\S]*?```\n?/g, "").trim(); }
};

// ============================================
// Icons
// ============================================
// Bundled static Hermes terminal-style SVG icon.
// Static, local SVG only: do not replace with user/API-provided markup.
var HERMES_ICON = `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1020 871" aria-hidden="true"><path d="M0 0 C9.66327597 3.13521865 19.17040889 6.52331157 28.625 10.25 C31.34646276 11.31426951 34.06952513 12.37440464 36.79296875 13.43359375 C37.51635941 13.7150676 38.23975006 13.99654144 38.98506165 14.2865448 C48.61193157 18.02473789 58.27513004 21.66729179 67.9375 25.3125 C68.90109436 25.67611633 69.86468872 26.03973267 70.85748291 26.41436768 C84.68752352 31.63179168 98.52556189 36.82779712 112.36813354 42.01187134 C130.09176385 48.64960942 147.79938233 55.32972908 165.50631714 62.01184082 C184.37209544 69.13271451 184.37209544 69.13271451 203.25390625 76.2109375 C204.51264557 76.68112556 204.51264557 76.68112556 205.79681396 77.16081238 C206.6139386 77.4660231 207.43106323 77.77123383 208.27294922 78.08569336 C225.37236877 84.47283584 242.41610552 90.99448435 259.43505859 97.59301758 C271.13034405 102.12638163 282.84131002 106.61586358 294.56781006 111.06784058 C315.19561511 118.89992802 335.75834085 126.89163652 356.30151367 134.94274902 C360.98687664 136.77844651 365.67314677 138.61182524 370.359375 140.4453125 C376.17911471 142.72233007 381.99882128 144.99943132 387.81811523 147.27758789 C397.1645066 150.93628346 406.51209036 154.59186805 415.86328125 158.23828125 C417.19140335 158.75622757 417.19140335 158.75622757 418.5463562 159.28463745 C422.6510232 160.88525203 426.75593601 162.48523058 430.86132812 164.08398438 C446.9249716 170.34584967 462.95840819 176.68058504 479 183 C479 229.2 479 275.4 479 323 C489.89 322.505 489.89 322.505 501 322 C507.55456755 321.98552824 514.09647198 322.01228767 520.6484375 322.12109375 C522.41060625 322.14550998 524.17278312 322.16934682 525.93496704 322.19264221 C530.48860191 322.25434329 535.04208597 322.32370814 539.59558105 322.39489746 C544.27589267 322.46663661 548.95630805 322.53081305 553.63671875 322.59570312 C562.75792657 322.72323725 571.87899262 322.85890085 581 323 C580.97787697 322.28622885 580.95575394 321.5724577 580.93296051 320.83705711 C580.40143324 303.41713184 580.0051021 285.99927983 579.75650787 268.57301903 C579.63306505 260.1449901 579.46504905 251.72239152 579.18945312 243.29785156 C578.94915697 235.94882577 578.79517401 228.60373041 578.74187613 221.25088561 C578.71073122 217.3599166 578.63846846 213.48018135 578.46247864 209.59284592 C577.43650818 186.0340543 577.43650818 186.0340543 583.34971237 179.34000587 C589.09349117 174.77725397 595.38334228 171.79613332 602.18296528 169.13266563 C605.83966568 167.66238952 609.08941598 165.81613485 612.4765625 163.80859375 C614.5249759 162.6829542 616.57442823 161.55920284 618.625 160.4375 C627.74544578 155.40805909 636.77000774 150.25025824 645.71655273 144.91821289 C652.838258 140.67501208 660.00309148 136.51109802 667.1875 132.375 C668.27836914 131.7469043 669.36923828 131.11880859 670.49316406 130.47167969 C672.6369233 129.23774553 674.78080099 128.00401715 676.92480469 126.77050781 C681.55763122 124.103212 686.1857444 121.42780935 690.8125 118.75 C691.57651123 118.30833496 692.34052246 117.86666992 693.12768555 117.41162109 C693.83449463 117.00250488 694.54130371 116.59338867 695.26953125 116.171875 C695.91873535 115.79740234 696.56793945 115.42292969 697.23681641 115.03710938 C698.78607654 114.12583036 700.30773766 113.16796774 701.82421875 112.203125 C704 111 704 111 707 111 C706.99078207 112.21276139 706.98156414 113.42552279 706.97206688 114.67503452 C706.75512148 143.51428516 706.59041232 172.35352161 706.48934671 201.19340039 C706.47684081 204.74913359 706.46389748 208.30486507 706.45068359 211.8605957 C706.44806049 212.56842736 706.44543739 213.27625902 706.44273479 214.00554013 C706.39931403 225.44142731 706.32052069 236.87680779 706.22847204 248.31239516 C706.13469667 260.06117489 706.0793578 271.80969068 706.05911505 283.55882925 C706.04610954 290.15219753 706.0156755 296.74441962 705.94269943 303.33741951 C705.87447394 309.55198399 705.85395389 315.7649378 705.86892319 321.97984123 C705.86618752 324.25217336 705.8465015 326.52456318 705.80794525 328.79656982 C705.56839427 343.64978191 707.37963142 352.55386063 717 364 C718.04786128 365.54668177 719.0779954 367.10607293 720.06640625 368.69140625 C720.4847876 369.33706543 720.90316895 369.98272461 721.33422852 370.64794922 C722.20405684 372.0037818 723.06716984 373.36393342 723.92553711 374.72705078 C726.02206849 378.03883965 728.11760395 381.22204241 730.625 384.23828125 C736.50134287 391.80030581 737.669426 397.71539985 738.14453125 407.109375 C738.21751434 408.28726593 738.29049744 409.46515686 738.36569214 410.67874146 C738.59454764 414.451705 738.79834549 418.22549386 739 422 C739.14268823 424.4637595 739.28631792 426.92746467 739.4309082 429.39111328 C739.78950821 435.62317981 740.1177476 441.8564025 740.43261719 448.09082031 C740.62597755 451.89422839 740.82842793 455.6970861 741.03125 459.5 C741.76676396 473.68117702 742.19228568 487.79999372 742 502 C739.80553585 502.98905426 737.61105421 503.97806924 735.41644287 504.96679688 C733.72098819 505.73127113 732.0264922 506.49787239 730.33251953 507.265625 C729.60661621 507.59046875 728.88071289 507.9153125 728.1328125 508.25 C727.38918457 508.58515625 726.64555664 508.9203125 725.87939453 509.265625 C724 510 724 510 722 510 C722.09837158 510.8751123 722.19674316 511.75022461 722.2980957 512.65185547 C722.63795101 515.99504747 722.90974672 519.33129832 723.14135742 522.68310547 C723.25311044 524.11437306 723.38943957 525.54399231 723.5534668 526.97021484 C724.5331193 535.66117589 724.00548139 541.44855243 718.52616882 548.49707031 C717.63729729 549.58906738 717.63729729 549.58906738 716.73046875 550.703125 C708.76766389 560.52315376 707.32487957 569.54606549 706 581.875 C705.74443629 583.88451469 705.48377958 585.89338765 705.21826172 587.90161133 C704.68891447 591.95947367 704.18705591 596.0191646 703.70996094 600.08349609 C702.75270251 608.18478771 701.60074633 616.25745416 700.45507812 624.33380127 C700.13093979 626.64514492 699.81735144 628.95765582 699.5078125 631.27099609 C699.41225067 631.97995529 699.31668884 632.68891449 699.2182312 633.4193573 C698.9643541 635.30759488 698.71279584 637.19614383 698.46142578 639.0847168 C698 642 698 642 697 645 C693.44997371 643.5409782 691.73986477 641.72582586 689.4375 638.6875 C686.28250358 634.61521759 683.03969478 630.65872535 679.6875 626.75 C675.43928375 621.77102605 671.35952376 616.68462855 667.34106445 611.51928711 C661.88687716 604.53150049 656.21808345 597.72130609 650.56591797 590.89355469 C647.02471817 586.61143033 643.51195229 582.30611236 640 578 C639.51708496 577.40896484 639.03416992 576.81792969 638.53662109 576.20898438 C635.22903266 572.15970662 631.93274175 568.10157803 628.64746094 564.03417969 C627.55527611 562.68561952 626.45960502 561.33987487 625.36035156 559.99707031 C623.8150242 558.10896466 622.28141685 556.2118943 620.75 554.3125 C620.28416504 553.74877686 619.81833008 553.18505371 619.33837891 552.60424805 C616.8302846 549.46604839 615.141383 547.06797463 615 543 C615.7421875 540.1328125 615.7421875 540.1328125 616.875 537.125 C623.17081817 520.26277371 620.61082462 501.89150367 613.41723633 485.79492188 C606.45922966 471.27205522 595.80925141 460.82211099 580.71875 454.66015625 C572.96618671 451.96402966 565.79357814 450.83139549 557.625 450.875 C556.54992187 450.86919922 556.54992187 450.86919922 555.453125 450.86328125 C551.74015965 450.86998335 548.42713717 451.11142378 544.79296875 451.88671875 C541 452 541 452 538.19921875 449.52734375 C537.33375925 448.35097797 536.49785557 447.15248166 535.6875 445.9375 C534.75884377 444.64899569 533.82912274 443.36125827 532.8984375 442.07421875 C532.42760742 441.40438965 531.95677734 440.73456055 531.47167969 440.04443359 C528.59714624 436.05117827 525.44606558 432.26921926 522.35229492 428.44506836 C519 424.22077146 519 424.22077146 519 422 C534.04654935 421.62509305 549.09273536 421.34354584 564.14297104 421.17100525 C571.13255298 421.08873262 578.11922253 420.97673969 585.10693359 420.79296875 C591.85695939 420.61553442 598.60396646 420.52333474 605.35617828 420.48196411 C607.92570739 420.45250407 610.4950796 420.39496632 613.06331635 420.30831909 C632.66302534 419.67364608 632.66302534 419.67364608 638.23534012 423.55835533 C641.97622981 427.25499092 644.57505344 431.42739237 646.96862221 436.08175182 C648.42033374 438.78177408 650.25988566 441.10704553 652.1796875 443.48828125 C652.79183105 444.28790283 653.40397461 445.08752441 654.03466797 445.91137695 C654.64197754 446.70374756 655.24928711 447.49611816 655.875 448.3125 C659.99370456 453.68944728 664.08042787 459.08329222 668.0625 464.5625 C668.70461426 465.44510498 669.34672852 466.32770996 670.00830078 467.23706055 C671.23129179 468.92439146 672.44863938 470.61583055 673.65966797 472.31176758 C674.20252441 473.06095459 674.74538086 473.8101416 675.3046875 474.58203125 C676.0160083 475.57553589 676.0160083 475.57553589 676.74169922 476.58911133 C677.15693848 477.05470459 677.57217773 477.52029785 678 478 C678.66 478 679.32 478 680 478 C683.04428318 474.75081314 685.78648557 471.24590858 688.56835938 467.77148438 C690.00816714 465.98989414 691.47808193 464.23684339 692.953125 462.484375 C693.88656948 461.34469322 694.81889513 460.204094 695.75 459.0625 C696.20439453 458.53180908 696.65878906 458.00111816 697.12695312 457.4543457 C698.54498823 455.7618123 698.54498823 455.7618123 700 453 C699.17886829 448.3987034 695.84489916 444.59628839 693.1875 440.8125 C692.46324829 439.77017212 692.46324829 439.77017212 691.72436523 438.70678711 C686.99784437 431.93359139 682.14803685 425.2494683 677.30078125 418.5625 C673.93078761 413.90979939 670.57995293 409.24394221 667.25 404.5625 C666.73638916 403.84650635 666.22277832 403.1305127 665.69360352 402.39282227 C664.98675415 401.39593384 664.98675415 401.39593384 664.265625 400.37890625 C663.85086914 399.7969751 663.43611328 399.21504395 663.00878906 398.61547852 C662 397 662 397 661 394 C659.76809024 394.01474869 658.53618048 394.02949738 657.26694012 394.04469299 C627.99691677 394.39152566 598.7273616 394.6551975 569.45579148 394.81704527 C565.84983721 394.8370556 562.24388727 394.85776485 558.63793945 394.87890625 C557.56116034 394.8852017 557.56116034 394.8852017 556.4626281 394.89162433 C544.85226892 394.96117023 533.24318253 395.08727703 521.63357743 395.23444474 C509.71310299 395.3842882 497.79329315 395.47298492 485.87191564 395.50541592 C479.17837337 395.52536655 472.487891 395.57516349 465.79524803 395.69168091 C459.49140645 395.80053712 453.19162458 395.83374128 446.88693237 395.8097229 C444.57730828 395.81411424 442.26754443 395.84581027 439.95873451 395.9072876 C422.95559367 396.33771373 422.95559367 396.33771373 418.0028975 392.42040062 C414.5577644 388.64124968 412.14864215 384.4474 409.93451178 379.86161613 C408.71585706 377.43396639 407.18885876 375.31982373 405.5390625 373.16796875 C404.8121521 372.17289307 404.8121521 372.17289307 404.07055664 371.15771484 C403.59352295 370.50754395 403.11648926 369.85737305 402.625 369.1875 C397.43811268 362.06682543 392.41763351 354.84524044 387.48876953 347.54370117 C386.98845215 346.80482666 386.48813477 346.06595215 385.97265625 345.3046875 C385.32695679 344.3453833 385.32695679 344.3453833 384.66821289 343.36669922 C383.11474453 341.06379 383.11474453 341.06379 381.55176258 339.3896656 C376.80327171 333.84168071 376.13517425 329.61824525 376.22705078 322.453125 C376.21642105 321.42783188 376.20579132 320.40253876 376.19483948 319.34617615 C376.16688783 315.98027832 376.18082249 312.6159598 376.1953125 309.25 C376.18405747 306.90729407 376.1701747 304.56459941 376.15377808 302.22192383 C376.11777536 296.07336786 376.11736228 289.92530952 376.12445068 283.77667236 C376.12536427 277.49555589 376.09249527 271.21462521 376.0625 264.93359375 C376.00867063 252.6223437 375.99245206 240.31135475 376 228 C344.5562933 214.7852178 344.5562933 214.7852178 313.01391602 201.80859375 C308.50845284 199.97787074 304.00613174 198.13944938 299.50390625 196.30078125 C298.16230942 195.75292465 298.16230942 195.75292465 296.79360962 195.19400024 C288.17807708 191.67147526 279.58697574 188.09145581 271 184.5 C253.1032476 177.01675357 235.14829163 169.67812257 217.18904114 162.34638977 C208.61577813 158.84543775 200.04973827 155.32700272 191.48413086 151.80737305 C173.6313839 144.47297 155.75255627 137.20434319 137.86035156 129.96679688 C132.70541237 127.88129298 127.55192766 125.79220639 122.3984375 123.703125 C105.14270963 116.70968825 87.88401436 109.72495497 70.58422852 102.84106445 C68.41754637 101.97773107 66.25537816 101.10295362 64.09863281 100.21508789 C61.00522818 98.95794976 61.00522818 98.95794976 57.76855469 98.00170898 C51.65280884 95.95917874 48.4455266 94.04712899 45.1875 88.37890625 C44.08770235 86.12458801 43.02672294 83.85102477 42 81.5625 C41.415773 80.33972601 40.8271538 79.11904181 40.234375 77.90039062 C39.0383707 75.43740579 37.85800825 72.96786787 36.6875 70.49267578 C34.3036891 65.5588218 31.67182201 60.78211914 29 56 C23.83515169 46.64223472 18.91876588 37.16515061 14.03076172 27.66040039 C10.3404998 20.50954584 6.54731444 13.43911738 2.48754883 6.49072266 C0 2.19803395 0 2.19803395 0 0 Z " fill="#F2AD09" transform="translate(267,106)"/><path d="M0 0 C3.88483815 0.00766901 7.76964077 -0.00219277 11.65447376 -0.00973 C18.45100454 -0.02052642 25.24746373 -0.02026025 32.04399774 -0.01258852 C42.15090735 -0.00121129 52.25775689 -0.00705772 62.36466613 -0.01621344 C80.41866797 -0.03199024 98.47263791 -0.03064963 116.52664276 -0.0219767 C132.32618766 -0.01442423 148.12572087 -0.01246264 163.9252672 -0.01604463 C164.97408257 -0.01627379 166.02289795 -0.01650294 167.10349561 -0.01673904 C171.36118774 -0.01767309 175.61887986 -0.01862829 179.87657198 -0.01961833 C219.80108822 -0.02879132 259.72558418 -0.02048132 299.6500973 -0.00432764 C335.10547384 0.00990872 370.56081806 0.00863482 406.01619432 -0.00571062 C445.86860158 -0.0217813 485.72099091 -0.02814072 525.57340095 -0.01887383 C529.82324788 -0.0179117 534.07309482 -0.01697318 538.32294176 -0.01604463 C539.3693302 -0.0158074 540.41571864 -0.01557017 541.49381582 -0.01532575 C557.28180291 -0.01191613 573.06977702 -0.01589893 588.85776231 -0.02348329 C606.81291039 -0.03206583 624.76802164 -0.0299064 642.72316513 -0.01364106 C652.76682167 -0.00484229 662.81039842 -0.00424259 672.85405286 -0.01557958 C679.56873327 -0.02232181 686.2833499 -0.01809287 692.99802089 -0.00506528 C696.81977567 0.00204864 700.6413723 0.00455825 704.46312193 -0.00628323 C737.46085633 -0.09288645 764.1230143 5.58875101 789.62410448 27.38540266 C790.63537401 28.24198469 790.63537401 28.24198469 791.66707323 29.11587141 C818.07725152 53.51862523 824.3900858 89.93116785 825.80926035 124.09023474 C825.93714625 127.54137067 826.05522563 130.99255943 826.15697668 134.44456957 C826.29177863 138.8893296 826.47912119 143.31818299 826.79134081 147.75429915 C828.70907499 175.72430035 828.70907499 175.72430035 823.39161394 183.09343336 C817.05632517 189.82870665 808.39312326 193.59091554 799.96257494 197.0064659 C795.63414855 198.79429848 791.65590423 201.02191931 787.62410448 203.38540266 C787.61823824 202.22267836 787.61237199 201.05995405 787.60632799 199.86199568 C787.54877164 188.83036323 787.47584259 177.79892171 787.38838957 166.76748465 C787.34392373 161.09798388 787.30461713 155.42855106 787.27766893 149.75893782 C787.25139622 144.27337014 787.21083016 138.78806738 787.16091821 133.30266569 C787.1444098 131.22426177 787.13279695 129.1458122 787.12649057 127.06735228 C787.04268005 101.95202221 784.27165754 77.99265768 766.29207323 58.83852766 C751.37190327 45.11983552 732.57169397 40.05867064 712.67843912 40.12813376 C711.40034883 40.12462768 710.12225855 40.12112161 708.80543826 40.11750929 C705.26740643 40.10809323 701.72947813 40.11103825 698.19144136 40.11606483 C694.33856031 40.11934087 690.48570096 40.11104111 686.6328269 40.10424648 C679.88310958 40.09395158 673.13342093 40.0911018 666.38369653 40.09315871 C656.34628595 40.09621001 646.30890708 40.08788182 636.27150267 40.07740945 C617.3005657 40.05806938 598.32963953 40.05244122 579.35869386 40.05129534 C564.70755979 40.05037616 550.05642995 40.04625901 535.40529726 40.03989409 C531.18757473 40.03809899 526.96985219 40.03631936 522.75212965 40.03454433 C521.70358127 40.03410224 520.65503289 40.03366014 519.57471032 40.03320465 C490.08139392 40.02089646 460.588079 40.01300349 431.09475992 40.0138912 C429.9828298 40.01392236 428.87089968 40.01395352 427.72527471 40.01398562 C422.08958876 40.01415183 416.45390282 40.01434992 410.81821688 40.01455504 C409.69895587 40.01459493 408.57969486 40.01463482 407.42651684 40.01467592 C405.16309807 40.01475679 402.89967929 40.01484039 400.63626051 40.0149267 C365.42353313 40.01615212 330.21084427 40.00114046 294.99812791 39.97378157 C255.43362516 39.94305415 215.86914772 39.92584948 176.30463228 39.92770801 C172.08502362 39.92785727 167.86541496 39.92795469 163.64580629 39.92801665 C162.60683775 39.92803995 161.56786921 39.92806326 160.49741677 39.92808728 C143.78457177 39.9281488 127.07176023 39.9153822 110.35892517 39.89815212 C93.55898233 39.88119058 76.75908841 39.87922589 59.95914175 39.89237076 C49.98214197 39.89975644 40.00529086 39.89611334 30.02830686 39.87648608 C23.35785055 39.86447382 16.68750177 39.867091 10.01705037 39.88142708 C6.22040789 39.88917956 2.42405282 39.89077259 -1.37256924 39.87451237 C-26.59292401 39.77363347 -48.02198437 42.00217254 -68.37589552 58.38540266 C-68.99722365 58.84301985 -69.61855177 59.30063704 -70.25870802 59.77212141 C-85.43642458 71.52602749 -93.89704797 91.14722981 -96.89676996 109.5873643 C-97.37674372 113.39212638 -97.50663 117.03130825 -97.51456072 120.86495398 C-97.51740294 121.58892073 -97.52024516 122.31288749 -97.5231735 123.05879263 C-97.53148407 125.4810593 -97.53278611 127.90327789 -97.53411391 130.32555769 C-97.53868297 132.08381451 -97.5436835 133.84207025 -97.54907747 135.60032473 C-97.56265116 140.43454761 -97.5700763 145.26876345 -97.57650413 150.10300039 C-97.58452147 155.32634405 -97.5982238 160.5496732 -97.61121657 165.77300642 C-97.63588376 176.05238435 -97.65527845 186.33176594 -97.67296931 196.61115798 C-97.69406546 208.74502989 -97.72050696 220.87888851 -97.74714078 233.01274931 C-97.79495546 254.87507843 -97.83809766 276.73741431 -97.87858107 298.59975813 C-97.91713446 319.41682267 -97.95854591 340.23387846 -98.00358107 361.05093001 C-98.00907572 363.59555012 -98.01457004 366.14017024 -98.02006402 368.68479036 C-98.02828584 372.49113802 -98.03650857 376.29748569 -98.04473543 380.10383335 C-98.14933492 428.55348567 -98.23991555 477.00314611 -98.3120928 525.45285795 C-98.31472721 527.22084255 -98.31472721 527.22084255 -98.31741484 529.024544 C-98.32443769 533.74244131 -98.33146017 538.46033862 -98.33842696 543.17823602 C-98.36353228 560.13226986 -98.39344787 577.08628957 -98.4263716 594.04030989 C-98.46199483 612.40780239 -98.49056706 630.77528925 -98.50888082 649.14280759 C-98.51821422 658.34853546 -98.53055347 667.5542325 -98.55192282 676.75994108 C-98.56954515 684.35154215 -98.58050272 691.94311337 -98.58227331 699.53473545 C-98.58335085 703.3322571 -98.58751715 707.12970198 -98.6006582 710.92720268 C-98.6146882 715.00446895 -98.61303385 719.08158153 -98.60988905 723.15887068 C-98.6196458 724.90129209 -98.6196458 724.90129209 -98.62959965 726.67891393 C-98.56057755 749.05266276 -91.94328836 769.16194634 -76.35636427 785.50259016 C-58.7405746 802.30132095 -34.89545656 807.87345563 -11.25879958 807.77740095 C-9.68987245 807.78213673 -8.12094883 807.78818169 -6.55203118 807.79540478 C-2.28313819 807.81135532 1.98557094 807.80902804 6.25448272 807.80348347 C10.87682328 807.80078404 15.49911424 807.81542848 20.12143419 807.8279228 C28.12598059 807.84725847 36.13048001 807.85588195 44.13504884 807.85722349 C55.75706298 807.85927404 67.37899843 807.87881915 79.000986 807.90262142 C97.92515519 807.94099525 116.84931903 807.9668137 135.77351854 807.98403548 C154.03687282 808.00069547 172.30021495 808.02084665 190.5635576 808.04751204 C191.6841669 808.04914546 192.80477621 808.05077888 193.95934337 808.0524618 C206.25006207 808.07050937 218.54077813 808.08991822 230.8314924 808.11076544 C232.4627884 808.11352757 232.4627884 808.11352757 234.12703988 808.1163455 C238.48124069 808.12373257 242.83544147 808.13112874 247.18964197 808.13868931 C259.82719191 808.16059169 272.46473118 808.17826801 285.10229594 808.18871755 C358.78414529 808.25012189 358.78414529 808.25012189 385.25447557 808.83608626 C386.15867715 808.85537538 387.06287872 808.8746645 387.99448035 808.89453815 C402.45025793 809.21779711 402.45025793 809.21779711 408.62410448 810.38540266 C408.62410448 811.04540266 408.62410448 811.70540266 408.62410448 812.38540266 C409.28410448 812.71540266 409.94410448 813.04540266 410.62410448 813.38540266 C410.99811234 815.71256267 411.32262031 818.04774083 411.62410448 820.38540266 C411.93722587 821.70353211 412.27364066 823.0163238 412.63191698 824.32290266 C412.9045537 825.32450423 412.9045537 825.32450423 413.18269823 826.34634016 C413.5608674 827.70774917 413.94631678 829.06715645 414.33894823 830.42446516 C415.581436 835.05474334 415.68439292 838.60801104 414.62410448 843.38540266 C412.41051414 845.598993 407.20276904 844.81666589 404.12845323 844.93783186 C402.54579793 845.00094215 402.54579793 845.00094215 400.93116979 845.06532739 C384.46976467 845.64309661 367.99365571 845.54283613 351.52445278 845.54544543 C346.41402995 845.5473211 341.30361463 845.55487981 336.19319627 845.56158064 C325.0635325 845.57505607 313.93387238 845.5811699 302.80420182 845.5855913 C295.84221968 845.58836863 288.8802389 845.59260823 281.91825769 845.59709547 C262.59971642 845.60926739 243.28117622 845.61957506 223.9626312 845.62297056 C222.73088945 845.62319013 221.49914769 845.6234097 220.23008042 845.62363592 C218.99563545 845.62385419 217.76119047 845.62407247 216.48933808 845.62429736 C213.98844315 845.62474081 211.48754823 845.62518737 208.98665331 845.62563704 C207.74616042 845.62585847 206.50566754 845.6260799 205.22758396 845.62630804 C185.10193217 845.630261 164.97631646 845.64773952 144.85067862 845.67099656 C124.1333083 845.69474251 103.4159561 845.70717366 82.69857196 845.70833848 C71.08799213 845.7092527 59.47745954 845.71494238 47.86689279 845.73315809 C37.98952176 845.74860202 28.11221263 845.75365377 18.23483181 845.74541999 C13.20352749 845.74153049 8.17234767 845.74235991 3.1410589 845.75647734 C-1.47708876 845.76931661 -6.09501962 845.76793205 -10.71316741 845.75588663 C-12.37092189 845.75394701 -14.02869227 845.75692622 -15.68642449 845.76573099 C-47.74713239 845.92504406 -78.00691517 836.48359638 -101.71573927 814.13930891 C-122.6945492 792.42115766 -134.56122731 762.66644593 -134.50732329 732.58391474 C-134.51040224 730.97802886 -134.51040224 730.97802886 -134.51354339 729.33970083 C-134.51920595 725.74580759 -134.51775705 722.15195277 -134.51633742 718.55805586 C-134.51892149 715.9578183 -134.52193476 713.35758114 -134.52534082 710.75734453 C-134.5329078 704.35621763 -134.53511322 697.95509908 -134.53566987 691.55396817 C-134.53658482 683.88522509 -134.54325628 676.21648969 -134.5500167 668.54774992 C-134.56606658 650.01267099 -134.57197906 631.4775929 -134.57676545 612.94250828 C-134.57910265 604.17035903 -134.58270546 595.39821043 -134.58646082 586.62606169 C-134.59929613 556.58573531 -134.61001478 526.54540928 -134.61346342 496.50508021 C-134.61368506 494.61975731 -134.61390684 492.73443442 -134.61412878 490.84911153 C-134.61434941 488.95928466 -134.6145699 487.06945779 -134.61479022 485.17963092 C-134.61523277 481.3884396 -134.61567989 477.59724828 -134.6161299 473.80605696 C-134.61623929 472.86606389 -134.61634868 471.92607082 -134.61646139 470.95759311 C-134.62009055 440.49070878 -134.63600541 410.02384827 -134.65932026 379.55697305 C-134.68393672 347.33016374 -134.69763713 315.10336803 -134.69883134 282.87654905 C-134.69900279 279.3362295 -134.69921822 275.79590996 -134.69946577 272.25559042 C-134.69952154 271.38389236 -134.69957731 270.51219429 -134.69963477 269.61408114 C-134.70078371 255.60753665 -134.71179241 241.60101667 -134.72635283 227.59448045 C-134.74074559 213.50515005 -134.74393917 199.41585094 -134.73591285 185.3265152 C-134.7314695 176.96541075 -134.7352651 168.60440756 -134.75115136 160.24331648 C-134.76210505 153.98585358 -134.75721968 147.72849405 -134.74637949 141.47103306 C-134.74442663 138.95008807 -134.74748173 136.42913282 -134.75622385 133.90820224 C-134.8826127 94.97811416 -125.55209046 62.72613867 -98.25089552 33.88540266 C-70.53776537 7.08011643 -37.33345373 -0.10590687 0 0 Z " fill="#DDA312" transform="translate(149.37589552253485,11.614597337320447)"/><path d="M0 0 C4.90911477 0.5982672 9.11415915 2.11733637 13.61328125 4.078125 C14.358022 4.39635223 15.10276276 4.71457947 15.87007141 5.04244995 C18.35358618 6.1054443 20.83296321 7.1777631 23.3125 8.25 C25.09462355 9.01477977 26.87701968 9.77892464 28.65966797 10.54248047 C32.4704813 12.17606389 36.27958939 13.81353671 40.08740234 15.45410156 C45.93672458 17.97393961 51.79006434 20.48432925 57.64453125 22.9921875 C59.62451383 23.84040849 61.60449428 24.68863444 63.58447266 25.53686523 C64.57650696 25.96184296 65.56854126 26.38682068 66.59063721 26.82467651 C69.6575872 28.13896468 72.72411282 29.45423843 75.79052734 30.76977539 C92.46997248 37.92439747 109.16591524 45.03991156 125.86590576 52.14642334 C142.89028487 59.39137826 159.90645879 66.65504631 176.90258789 73.96606445 C184.32697969 77.15749455 191.75690941 80.32984265 199.2265625 83.4140625 C200.46389544 83.92734074 201.7012012 84.44068453 202.93847656 84.95410156 C205.13734314 85.86326634 207.33954133 86.76444062 209.54589844 87.65527344 C210.95790527 88.23970215 210.95790527 88.23970215 212.3984375 88.8359375 C213.19942871 89.16126465 214.00041992 89.4865918 214.82568359 89.82177734 C218.82469441 91.98876883 221.34260768 95.26706265 223.84765625 98.984375 C224.36424805 99.74572754 224.88083984 100.50708008 225.41308594 101.29150391 C226.2295459 102.50845947 226.2295459 102.50845947 227.0625 103.75 C228.23546707 105.48191309 229.4086471 107.21368196 230.58203125 108.9453125 C231.16291504 109.80543945 231.74379883 110.66556641 232.34228516 111.55175781 C234.62511438 114.92321752 236.93657214 118.27450297 239.25 121.625 C244.90001853 129.82463886 250.48887434 138.06597325 256.07519531 146.30908203 C256.76967773 147.33243652 257.46416016 148.35579102 258.1796875 149.41015625 C258.79569824 150.31902588 259.41170898 151.22789551 260.04638672 152.16430664 C260.6910791 153.10008545 261.33577148 154.03586426 262 155 C262.24651306 155.62022034 262.49302612 156.24044067 262.74700928 156.87945557 C263.90776602 159.30891595 264.76872665 160.45312681 267 162 C271.89371449 162.87906061 276.67530052 162.86292279 281.63591003 162.77248001 C284.18410302 162.72605505 286.72938044 162.72170675 289.2779541 162.72787476 C293.76783499 162.73179985 298.25653033 162.69838083 302.74615479 162.652771 C309.93162476 162.58030953 317.11645595 162.53917039 324.30229187 162.54600143 C326.80953958 162.5391559 329.31499716 162.50089978 331.82189941 162.46060181 C333.3623829 162.45628333 334.90287064 162.45323507 336.44335938 162.45166016 C337.48462227 162.42222572 337.48462227 162.42222572 338.54692078 162.39219666 C342.40804662 162.42303234 343.87987396 162.89898448 346.87887573 165.42088318 C347.57884674 166.27199173 348.27881775 167.12310028 349 168 C349.49322754 168.59868896 349.98645508 169.19737793 350.49462891 169.81420898 C350.90116699 170.36923096 351.30770508 170.92425293 351.7265625 171.49609375 C352.42930298 172.44645508 352.42930298 172.44645508 353.14624023 173.41601562 C353.63423096 174.08310547 354.12222168 174.75019531 354.625 175.4375 C355.69017709 176.87460978 356.7566077 178.3107912 357.82421875 179.74609375 C358.35708496 180.46265137 358.88995117 181.17920898 359.43896484 181.91748047 C366.67815156 191.57501295 374.33545998 200.91305868 381.9609375 210.265625 C385.67181716 214.818937 389.34271053 219.40352744 393 224 C396.65856366 222.83136528 400.09048608 221.50533697 403.5625 219.875 C412.00804386 216.46625639 422.46388264 216.83337582 431 220 C441.83251498 225.00876476 448.45913037 232.64127915 453.08984375 243.51953125 C456.68624981 253.32089541 456.26260604 265.01843232 452.21484375 274.59765625 C450.69453736 277.60404992 449.03936007 280.45788626 447.1484375 283.24609375 C445.93385482 285.10101764 444.95727832 287.00201084 444 289 C449.49334441 296.28076666 455.11049384 303.40561366 461.03686523 310.33935547 C464.37044682 314.24234311 467.60350064 318.20953033 470.79296875 322.23046875 C473.56873411 325.71368581 476.37700787 329.16978197 479.1875 332.625 C479.74147461 333.30651123 480.29544922 333.98802246 480.86621094 334.69018555 C483.68780462 338.16045405 486.51219949 341.62841002 489.33984375 345.09375 C494.95307468 351.97912481 500.50708872 358.90086057 505.96606445 365.90917969 C509.15479329 369.98039374 512.45321977 373.94374503 515.8125 377.875 C527 390.98176032 527 390.98176032 527 394 C485.09341889 399.74326159 485.09341889 399.74326159 471.42382812 390.77587891 C461.64359806 383.28482151 453.69069551 373.65402824 446.23583984 363.91577148 C443.43022096 360.34501124 440.29125535 357.45876599 436.82421875 354.5388031 C434.65832322 352.71178167 432.66072458 350.75929169 430.67578125 348.73828125 C429.95712891 348.01189453 429.23847656 347.28550781 428.49804688 346.53710938 C427.77681641 345.80298828 427.05558594 345.06886719 426.3125 344.3125 C417.22589295 334.60001067 417.22589295 334.60001067 404.9375 330.5625 C389.42470282 328.16699544 373.93924081 320.55118083 364 308 C352.02582129 291.49899763 346.0971206 274.01287224 348.39453125 253.47265625 C350.62894175 239.73463559 356.74529858 227.4115391 366 217 C363.76767813 218.16093088 361.53868009 219.32737415 359.3125 220.5 C358.63856201 220.85441162 357.96462402 221.20882324 357.27026367 221.57397461 C351.53922602 224.62725865 346.11103786 228.03303267 340.70703125 231.62890625 C338 233 338 233 335.96801758 232.86262512 C333.22893003 231.66202318 332.93157628 230.30255445 331.8046875 227.5690918 C328.595886 221.12118491 325.21424622 215.87105187 319 212 C306.89129196 208.19323822 292.38478749 210.12869373 279.90240479 210.68774414 C272.27480846 211.01560583 264.64432754 211.19432599 257.01116943 211.32730675 C254.35796848 211.39339862 251.7133622 211.5223402 249.06298828 211.65913391 C237.51808079 212.08566119 237.51808079 212.08566119 233.45115662 209.17718506 C231.61625541 206.86914578 230.29616538 204.64210971 229 202 C228.29496338 200.96311035 227.58992676 199.9262207 226.86352539 198.85791016 C226.28078857 197.92769043 225.69805176 196.9974707 225.09765625 196.0390625 C224.43443359 194.98976563 223.77121094 193.94046875 223.08789062 192.859375 C222.41951172 191.79203125 221.75113281 190.7246875 221.0625 189.625 C216.5773534 182.47312705 211.98546742 175.49344184 206.97045898 168.70117188 C203.68617747 164.19896761 200.5923484 159.57270462 197.5 154.9375 C196.86835937 154.00228516 196.23671875 153.06707031 195.5859375 152.10351562 C194.69261719 150.76643555 194.69261719 150.76643555 193.78125 149.40234375 C193.24564453 148.60304443 192.71003906 147.80374512 192.15820312 146.98022461 C191 145 191 145 191 143 C190.46632813 142.83636963 189.93265625 142.67273926 189.3828125 142.50415039 C183.35103343 140.58334704 177.7190016 138.13652506 172 135.4375 C160.79191459 130.2296121 149.50564317 125.21313525 138.1875 120.25 C137.3069696 119.86386536 136.42643921 119.47773071 135.51922607 119.07989502 C119.89348609 112.23307621 104.22669034 105.48445163 88.53523254 98.78982544 C80.71229744 95.45210692 72.89546783 92.10016874 65.07855225 88.74838257 C61.4223531 87.18076239 57.76585787 85.61383325 54.109375 84.046875 C50.5546875 82.5234375 50.5546875 82.5234375 47 81 C46.37531326 80.77413208 45.75062653 80.54826416 45.10700989 80.31555176 C40.78988231 78.69351879 38.97616877 77.29869949 37.04296875 73.125 C36.57608643 72.15046875 36.1092041 71.1759375 35.62817383 70.171875 C35.15275146 69.12515625 34.6773291 68.0784375 34.1875 67 C33.13446908 64.79087626 32.07976427 62.58254968 31.0234375 60.375 C30.5087793 59.28316406 29.99412109 58.19132812 29.46386719 57.06640625 C27.51643806 52.98706838 25.43912527 48.98810342 23.3125 45 C22.93254883 44.28199219 22.55259766 43.56398438 22.16113281 42.82421875 C19.71594968 38.2092022 17.25477893 33.60269108 14.79652405 28.99462891 C13.23426813 26.06517116 11.67358026 23.13487902 10.11288452 20.20458984 C8.95202302 18.02723986 7.78824743 15.85146541 6.62426758 13.67578125 C5.90434781 12.32558045 5.18453509 10.97532257 4.46484375 9.625 C4.12989899 9.00085205 3.79495422 8.3767041 3.44985962 7.73364258 C2.08816269 5.17327348 0.91943938 2.75831814 0 0 Z " fill="#AF7604" transform="translate(407,365)"/><path d="M0 0 C14.00898973 5.26266536 27.91121564 10.74336562 41.75 16.4375 C43.65480731 17.21897576 45.55967518 18.00030392 47.46459961 18.78149414 C62.24169354 24.84620234 76.99646168 30.9646344 91.74804688 37.09106445 C105.47348926 42.79015605 119.22575208 48.41975886 133 54 C135.19341177 54.88915504 137.38676707 55.77844932 139.5801239 56.66773987 C145.16548068 58.93228616 150.75098132 61.19647738 156.33666992 63.46020508 C177.09411227 71.87306305 197.83140153 80.33496467 218.5625 88.8125 C219.50198486 89.19668091 220.44146973 89.58086182 221.40942383 89.97668457 C231.37140424 94.0511834 241.33079536 98.13179881 251.28125 102.234375 C252.07844955 102.56302048 252.87564911 102.89166595 253.69700623 103.23027039 C257.42639807 104.76809732 261.15516966 106.30740568 264.88305664 107.84887695 C266.19416792 108.39014945 267.50528415 108.93140997 268.81640625 109.47265625 C270.50938843 110.17273804 270.50938843 110.17273804 272.23657227 110.88696289 C274.13459053 111.65143548 276.05881415 112.35293805 278 113 C278 136.76 278 160.52 278 185 C273.89235652 183.63078551 270.09353264 182.24464036 266.15234375 180.5234375 C265.00894531 180.02585937 263.86554688 179.52828125 262.6875 179.015625 C261.4375 178.46875 260.1875 177.921875 258.9375 177.375 C257.61601581 176.79917983 256.29439782 176.22366663 254.97265625 175.6484375 C252.86739683 174.73217916 250.76222372 173.81572754 248.65744019 172.89837646 C241.06262751 169.58856906 233.4577878 166.30205659 225.85250854 163.01638794 C221.91441396 161.31495657 217.9766889 159.61267083 214.0390625 157.91015625 C213.26999069 157.57763351 212.50091888 157.24511078 211.70854187 156.9025116 C206.87458394 154.81197844 202.04209224 152.71809629 197.2109375 150.62109375 C180.80325206 143.49965471 164.37300299 136.43258391 147.92887878 129.39572144 C142.00844786 126.86153758 136.09015799 124.32239113 130.17259216 121.78152466 C125.39754898 119.73132887 120.62202888 117.68224498 115.8465271 115.63311768 C113.41256617 114.58835306 110.9788289 113.54306725 108.5453186 112.49725342 C96.43426273 107.29266218 84.31903036 102.10466933 72.1328125 97.078125 C71.23635513 96.70695053 70.33989777 96.33577606 69.41627502 95.95335388 C65.31816158 94.25664355 61.21636717 92.57092969 57.10424805 90.90844727 C55.67995073 90.32102063 54.25586414 89.7330827 52.83203125 89.14453125 C51.62264893 88.65315674 50.4132666 88.16178223 49.16723633 87.65551758 C42.5622284 84.20307337 39.73057681 79.18521583 36.55859375 72.75390625 C36.15405975 71.95449112 35.74952576 71.15507599 35.33273315 70.33143616 C34.4711218 68.62672443 33.61378636 66.91984581 32.76040649 65.21099854 C30.53958732 60.76485184 28.28746565 56.33458644 26.0390625 51.90234375 C25.59961807 51.03399902 25.16017365 50.1656543 24.70741272 49.27099609 C21.3545417 42.65816022 17.89671567 36.11593817 14.3125 29.625 C13.84996826 28.78549805 13.38743652 27.94599609 12.91088867 27.08105469 C12.03540015 25.49446027 11.15906001 23.90833537 10.28173828 22.32275391 C8.07983123 18.33247892 5.90633163 14.32756128 3.75 10.3125 C3.36626221 9.61012207 2.98252441 8.90774414 2.5871582 8.18408203 C0 3.34492435 0 3.34492435 0 0 Z " fill="#CB8902" transform="translate(340,239)"/><path d="M0 0 C5.77639116 1.70120006 11.03854914 4.31558483 16.4375 6.9375 C22.24667164 9.74601577 28.04316642 12.5173032 34 15 C30.36579105 27.16503628 23.41766754 38.59106273 15 48 C13.93652344 49.25876953 13.93652344 49.25876953 12.8515625 50.54296875 C-3.51203721 69.5190028 -27.23250374 80.97891774 -52 84 C-54.54444865 84.08757602 -57.09085509 84.12625291 -59.6368103 84.12698364 C-60.74259963 84.12932363 -60.74259963 84.12932363 -61.87072814 84.13171089 C-64.32448403 84.135678 -66.77817731 84.13254781 -69.23193359 84.12939453 C-70.99846431 84.13075059 -72.76499475 84.13253168 -74.53152466 84.13470459 C-79.32136209 84.13925787 -84.11117795 84.13749712 -88.90101576 84.1343255 C-93.92991155 84.13178708 -98.95880555 84.13414394 -103.98770142 84.13571167 C-112.44281341 84.13753071 -120.89791667 84.13513576 -129.35302734 84.13037109 C-139.09070458 84.12494659 -148.82836082 84.12667898 -158.56603754 84.1321975 C-166.9510902 84.13675728 -175.33613659 84.1373647 -183.72119009 84.13475883 C-188.71775952 84.13320948 -193.71431914 84.13296477 -198.71088791 84.13629532 C-203.42065521 84.13921519 -208.1303959 84.13712389 -212.84016037 84.13140106 C-214.55523637 84.13009453 -216.27031466 84.13043102 -217.98538971 84.13266373 C-226.50998646 84.14272507 -235.01751762 84.03939221 -243.53286743 83.61691284 C-244.25574617 83.58655603 -244.9786249 83.55619921 -245.72340906 83.52492249 C-250.76394163 83.23605837 -250.76394163 83.23605837 -253 81 C-253.43761069 71.33088757 -248.81731807 61.33181531 -245.76953125 52.37109375 C-244.94855062 50.25694698 -244.94855062 50.25694698 -245 49 C-239.99980435 48.01553076 -235.16740491 47.79236641 -230.0925293 47.69677734 C-229.20052385 47.67700459 -228.30851841 47.65723183 -227.3894825 47.63685989 C-224.38864545 47.57276619 -221.38772815 47.51634321 -218.38671875 47.4609375 C-217.33022314 47.44015514 -216.27372753 47.41937279 -215.1852169 47.39796066 C-196.45272671 47.03374804 -177.72064744 46.88771313 -158.98530054 46.79932117 C-156.8293796 46.78904987 -154.67346158 46.7782986 -152.51754379 46.76738739 C-139.2653956 46.70039505 -126.01325765 46.63525283 -112.76098633 46.59863281 C-106.11949502 46.58020852 -99.47813622 46.55125205 -92.83674258 46.5106281 C-89.36725727 46.48983997 -85.89793562 46.47414028 -82.42838478 46.47182083 C-58.36296331 46.81262344 -58.36296331 46.81262344 -35.8125 39.3125 C-35.14597412 38.96292236 -34.47944824 38.61334473 -33.79272461 38.25317383 C-16.85141309 29.1510191 -7.88644366 17.12669101 0 0 Z " fill="#987124" transform="translate(933,773)"/><path d="M0 0 C5.76859956 3.53028418 10.93857722 7.83121395 16.11328125 12.16796875 C19.7793343 15.21741471 23.56936984 18.10058347 27.36328125 20.98828125 C28.08725098 21.5395166 28.8112207 22.09075195 29.55712891 22.65869141 C31.04325375 23.78921831 32.52974773 24.91926014 34.01660156 26.04882812 C37.59634111 28.77100369 41.16696831 31.50506615 44.73828125 34.23828125 C46.14968866 35.31777491 47.56114711 36.39720185 48.97265625 37.4765625 C50.02356445 38.2802124 50.02356445 38.2802124 51.09570312 39.10009766 C53.27319025 40.76497216 55.45101119 42.42940917 57.62890625 44.09375 C65.04348638 49.76060767 72.45746251 55.4279252 79.83984375 61.13671875 C82.39817862 63.10668281 84.98204528 65.03964906 87.57421875 66.96484375 C88.32638672 67.52816406 89.07855469 68.09148437 89.85351562 68.671875 C91.31043108 69.76235796 92.77233444 70.84622381 94.24023438 71.921875 C99.80728264 76.10643079 105.9796531 80.9623968 108.23828125 87.73828125 C108.97869585 93.87314507 108.03764547 97.39416894 104.38671875 102.390625 C100.42016038 106.72499151 95.69746642 110.06573646 90.95410156 113.48974609 C88.278824 115.43644066 85.66779659 117.46423521 83.05078125 119.48828125 C81.97007738 120.31904333 80.88934729 121.14977129 79.80859375 121.98046875 C77.19206064 123.99741061 74.58460458 126.02567273 71.98046875 128.05859375 C64.7781278 133.68061826 57.56424422 139.27789072 50.23828125 144.73828125 C40.63854364 151.89603266 31.21411935 159.27651395 21.78613281 166.65820312 C20.14566058 167.94238833 18.50455571 169.22576583 16.86279297 170.50830078 C15.32387739 171.71050936 13.7863526 172.91450124 12.25048828 174.12060547 C-0.67259511 184.21221006 -0.67259511 184.21221006 -10.125 184.07421875 C-14.52160713 183.51405843 -17.57447107 181.77865116 -20.76171875 178.73828125 C-24.22468424 174.06229959 -25.59422905 169.56585337 -24.76171875 163.73828125 C-22.54729756 156.47908596 -17.5265472 152.34356503 -11.76171875 147.73828125 C-11.24786621 147.32707031 -10.73401367 146.91585937 -10.20458984 146.4921875 C-6.68890544 143.68713122 -3.14526895 140.91920286 0.40771484 138.16162109 C3.36054256 135.86567743 6.29891093 133.55141099 9.23828125 131.23828125 C12.71130273 128.5071641 16.18577092 125.77800552 19.66796875 123.05859375 C26.61558214 117.62660799 33.48836488 112.11289454 40.31420898 106.52856445 C45.73354777 102.10963733 51.26481564 97.8582659 56.859375 93.6640625 C59.29981289 91.96005377 59.29981289 91.96005377 60.23828125 89.73828125 C59.70589844 89.50753906 59.17351562 89.27679687 58.625 89.0390625 C55.49497288 87.3331721 52.81741556 85.15280431 50.05078125 82.92578125 C48.79247467 81.92476473 47.53332354 80.92480913 46.2734375 79.92578125 C45.61359863 79.40242187 44.95375977 78.8790625 44.27392578 78.33984375 C40.87371864 75.66469877 37.4307261 73.04620329 33.98828125 70.42578125 C27.19255508 65.24623953 20.4365705 60.01783023 13.69726562 54.76513672 C9.30665969 51.34394748 4.90499347 47.93817783 0.48828125 44.55078125 C-1.0514623 43.36515915 -2.59120399 42.1795344 -4.13037109 40.99316406 C-5.28810018 40.10260322 -6.44744823 39.21414526 -7.60791016 38.32714844 C-9.51782033 36.86574471 -11.42143746 35.39644992 -13.32421875 33.92578125 C-13.90848633 33.48145752 -14.49275391 33.03713379 -15.09472656 32.5793457 C-20.00446853 28.76504149 -24.02363394 24.82157809 -25.76171875 18.73828125 C-26.43020063 12.83335796 -25.25753433 8.47199186 -21.76171875 3.73828125 C-15.71124585 -2.15559118 -7.69527302 -3.51566222 0 0 Z " fill="#F5AF09" transform="translate(157.76171875,564.26171875)"/><path d="M0 0 C4.90911477 0.5982672 9.11415915 2.11733637 13.61328125 4.078125 C14.358022 4.39635223 15.10276276 4.71457947 15.87007141 5.04244995 C18.35358618 6.1054443 20.83296321 7.1777631 23.3125 8.25 C25.09462355 9.01477977 26.87701968 9.77892464 28.65966797 10.54248047 C32.4704813 12.17606389 36.27958939 13.81353671 40.08740234 15.45410156 C45.93672458 17.97393961 51.79006434 20.48432925 57.64453125 22.9921875 C59.62451383 23.84040849 61.60449428 24.68863444 63.58447266 25.53686523 C64.57650696 25.96184296 65.56854126 26.38682068 66.59063721 26.82467651 C69.6575872 28.13896468 72.72411282 29.45423843 75.79052734 30.76977539 C92.46997248 37.92439747 109.16591524 45.03991156 125.86590576 52.14642334 C142.89028487 59.39137826 159.90645879 66.65504631 176.90258789 73.96606445 C184.32697969 77.15749455 191.75690941 80.32984265 199.2265625 83.4140625 C200.46389544 83.92734074 201.7012012 84.44068453 202.93847656 84.95410156 C205.13734314 85.86326634 207.33954133 86.76444062 209.54589844 87.65527344 C210.95790527 88.23970215 210.95790527 88.23970215 212.3984375 88.8359375 C213.19942871 89.16126465 214.00041992 89.4865918 214.82568359 89.82177734 C218.82469441 91.98876883 221.34260768 95.26706265 223.84765625 98.984375 C224.36424805 99.74572754 224.88083984 100.50708008 225.41308594 101.29150391 C226.2295459 102.50845947 226.2295459 102.50845947 227.0625 103.75 C228.23546707 105.48191309 229.4086471 107.21368196 230.58203125 108.9453125 C231.16291504 109.80543945 231.74379883 110.66556641 232.34228516 111.55175781 C234.62511438 114.92321752 236.93657214 118.27450297 239.25 121.625 C244.90001853 129.82463886 250.48887434 138.06597325 256.07519531 146.30908203 C256.76967773 147.33243652 257.46416016 148.35579102 258.1796875 149.41015625 C258.79569824 150.31902588 259.41170898 151.22789551 260.04638672 152.16430664 C260.6910791 153.10008545 261.33577148 154.03586426 262 155 C262.24651306 155.62022034 262.49302612 156.24044067 262.74700928 156.87945557 C263.90776602 159.30891595 264.76872665 160.45312681 267 162 C271.89371449 162.87906061 276.67530052 162.86292279 281.63591003 162.77248001 C284.18410302 162.72605505 286.72938044 162.72170675 289.2779541 162.72787476 C293.76783499 162.73179985 298.25653033 162.69838083 302.74615479 162.652771 C309.93162476 162.58030953 317.11645595 162.53917039 324.30229187 162.54600143 C326.80953958 162.5391559 329.31499716 162.50089978 331.82189941 162.46060181 C333.3623829 162.45628333 334.90287064 162.45323507 336.44335938 162.45166016 C337.48462227 162.42222572 337.48462227 162.42222572 338.54692078 162.39219666 C342.40804662 162.42303234 343.87987396 162.89898448 346.87887573 165.42088318 C347.57884674 166.27199173 348.27881775 167.12310028 349 168 C349.49322754 168.59868896 349.98645508 169.19737793 350.49462891 169.81420898 C350.90116699 170.36923096 351.30770508 170.92425293 351.7265625 171.49609375 C352.42930298 172.44645508 352.42930298 172.44645508 353.14624023 173.41601562 C353.63423096 174.08310547 354.12222168 174.75019531 354.625 175.4375 C355.69017709 176.87460978 356.7566077 178.3107912 357.82421875 179.74609375 C358.35708496 180.46265137 358.88995117 181.17920898 359.43896484 181.91748047 C366.67815156 191.57501295 374.33545998 200.91305868 381.9609375 210.265625 C385.67181716 214.818937 389.34271053 219.40352744 393 224 C396.65856366 222.83136528 400.09048608 221.50533697 403.5625 219.875 C412.00804386 216.46625639 422.46388264 216.83337582 431 220 C441.83251498 225.00876476 448.45913037 232.64127915 453.08984375 243.51953125 C456.68624981 253.32089541 456.26260604 265.01843232 452.21484375 274.59765625 C450.69453736 277.60404992 449.03936007 280.45788626 447.1484375 283.24609375 C445.93385482 285.10101764 444.95727832 287.00201084 444 289 C449.49334441 296.28076666 455.11049384 303.40561366 461.03686523 310.33935547 C464.37044682 314.24234311 467.60350064 318.20953033 470.79296875 322.23046875 C473.56873411 325.71368581 476.37700787 329.16978197 479.1875 332.625 C479.74147461 333.30651123 480.29544922 333.98802246 480.86621094 334.69018555 C483.68780462 338.16045405 486.51219949 341.62841002 489.33984375 345.09375 C494.95307468 351.97912481 500.50708872 358.90086057 505.96606445 365.90917969 C509.15479329 369.98039374 512.45321977 373.94374503 515.8125 377.875 C527 390.98176032 527 390.98176032 527 394 C510.5 394 494 394 477 394 C477 393.67 477 393.34 477 393 C496.305 392.505 496.305 392.505 516 392 C509.66404743 383.93606036 503.39287129 376.0564289 496.75 368.28125 C493.90910446 364.923828 491.19827304 361.47242671 488.5 358 C484.42543054 352.75721767 480.21884023 347.65377639 475.9074707 342.60449219 C472.61634075 338.74556158 469.43027074 334.8187434 466.28125 330.84375 C463.28882494 327.1134667 460.2361179 323.43439315 457.1875 319.75 C449.94128986 310.98159941 442.78732493 302.13083125 436 293 C435.49855469 293.2165625 434.99710938 293.433125 434.48046875 293.65625 C424.87028031 297.1925374 413.24012718 297.84168078 403.38671875 294.93359375 C391.96821771 289.60882897 385.71665122 281.48132205 381 270 C377.46570983 260.1447678 378.91575117 250.77874242 382 241 C383.27672004 238.51147788 384.62705433 236.2081364 386.20703125 233.90234375 C386.46871094 233.27457031 386.73039062 232.64679688 387 232 C385.84581285 229.19707637 384.31822892 226.98674476 382.3828125 224.671875 C381.60526611 223.73190674 381.60526611 223.73190674 380.81201172 222.77294922 C380.25529785 222.10537598 379.69858398 221.43780273 379.125 220.75 C374.57039493 215.22131064 370.14384203 209.62731038 365.875 203.875 C362.06219589 198.74069127 358.20704724 193.64923212 354.25 188.625 C353.80019775 188.05346191 353.35039551 187.48192383 352.88696289 186.89306641 C350.78957091 184.23711516 348.67367427 181.5997209 346.53515625 178.9765625 C345.80167969 178.07679688 345.06820313 177.17703125 344.3125 176.25 C343.34763672 175.08210938 343.34763672 175.08210938 342.36328125 173.890625 C341 172 341 172 341 170 C340.04057495 170.02442673 339.0811499 170.04885345 338.09265137 170.07402039 C329.03052034 170.29745604 319.96895099 170.46210877 310.90468597 170.56993389 C306.24485594 170.62723626 301.5872568 170.70488155 296.92871094 170.82983398 C292.42865785 170.94977343 287.93074299 171.01520703 283.42921448 171.04364967 C281.71617463 171.06390369 280.00324606 171.10346185 278.29112244 171.16303062 C264.89853551 171.61025848 264.89853551 171.61025848 260.24241638 167.66113281 C258.17862028 164.85822591 256.57890488 162.09654264 255 159 C253.84448465 157.24947366 252.6714778 155.51022056 251.47265625 153.7890625 C250.33390537 152.069052 249.19721362 150.34767661 248.0625 148.625 C243.51441351 141.76207347 238.92665392 134.93803054 234.21875 128.18359375 C230.18940755 122.40205485 226.19993337 116.5930993 222.21875 110.77832031 C221.13829897 109.20179681 220.05381836 107.62803661 218.96875 106.0546875 C218.14890625 104.85199219 218.14890625 104.85199219 217.3125 103.625 C216.85488281 102.95726562 216.39726563 102.28953125 215.92578125 101.6015625 C215 100 215 100 215 98 C213.27716797 97.47212891 213.27716797 97.47212891 211.51953125 96.93359375 C204.05998631 94.44320192 196.89699713 91.18750714 189.6875 88.0625 C188.11905677 87.3858588 186.55045098 86.7095943 184.98168945 86.03369141 C181.81523984 84.66904512 178.64953297 83.30269787 175.484375 81.93505859 C170.35171909 79.71852316 165.21179956 77.51922123 160.07104492 75.3215332 C148.44495444 70.35114673 136.83902637 65.33540933 125.24243164 60.29663086 C117.52123816 56.94477199 109.78793362 53.6221364 102.046875 50.31640625 C101.10276764 49.91296997 100.15866028 49.50953369 99.1859436 49.09387207 C94.49617658 47.0899876 89.80537161 45.08860006 85.11279297 43.09130859 C83.37983819 42.35134148 81.64692608 41.61127441 79.9140625 40.87109375 C79.13190369 40.53928604 78.34974487 40.20747833 77.54388428 39.86561584 C73.19663369 38.005419 68.95785143 36.02041248 64.76620483 33.83045959 C62.78510507 32.83865103 62.78510507 32.83865103 59.625 32.0625 C56.65690417 31.19254088 54.45425629 30.28327188 51.75 28.875 C42.59062695 24.14125674 32.91663614 20.43061809 23.38671875 16.515625 C5.67031757 9.22196047 5.67031757 9.22196047 0 1 C0 0.67 0 0.34 0 0 Z " fill="#E89C02" transform="translate(407,365)"/><path d="M0 0 C3.85440959 0.18683853 4.92219102 0.91635826 7.60546875 3.80078125 C8.47997625 4.96105821 9.34033646 6.13211026 10.1875 7.3125 C10.84395508 8.18551758 10.84395508 8.18551758 11.51367188 9.07617188 C12.71179214 10.69134774 13.8580297 12.34464836 15 14 C15.72896484 15.04027344 15.72896484 15.04027344 16.47265625 16.1015625 C17 18 17 18 15.953125 20.41015625 C15.39109375 21.28542969 14.8290625 22.16070313 14.25 23.0625 C9.27254227 31.58554406 7.5129402 41.36737532 9.6875 51.06640625 C13.14192164 63.48793072 19.43849606 72.98320411 30.8125 79.4375 C35.57506669 81.36243985 40.36801895 81.38681011 45.4375 81.4375 C46.22423096 81.44773193 47.01096191 81.45796387 47.8215332 81.46850586 C53.92682497 81.37826744 59.24733947 79.9913931 65 78 C71.6504661 86.01447684 78.29521229 94.02714544 84.6875 102.25 C88.6264432 107.31445828 92.70279058 112.23369335 96.87573242 117.10644531 C100.67346672 121.56198579 104.28333893 126.14730834 107.875 130.76953125 C110.99147918 134.7625202 114.20533621 138.65310563 117.5 142.5 C121.76091547 147.47510301 125.83876214 152.56583439 129.85083008 157.74316406 C133.63257384 162.59850097 137.58824032 167.28934593 141.6484375 171.9140625 C145 175.78654234 145 175.78654234 145 178 C145.66 178.33 146.32 178.66 147 179 C112.35835462 184.44488381 112.35835462 184.44488381 99.90087891 175.87402344 C90.50839333 168.44289257 82.7088901 159.15578373 75.27099609 149.82397461 C72.42097738 146.33597046 69.25582135 143.45095186 65.82202148 140.54649353 C63.66153695 138.71271968 61.66094853 136.75951971 59.67578125 134.73828125 C58.95712891 134.01189453 58.23847656 133.28550781 57.49804688 132.53710938 C56.77681641 131.80298828 56.05558594 131.06886719 55.3125 130.3125 C46.22589295 120.60001067 46.22589295 120.60001067 33.9375 116.5625 C18.42470282 114.16699544 2.93924081 106.55118083 -7 94 C-18.97417871 77.49899763 -24.9028794 60.01287224 -22.60546875 39.47265625 C-21.41661484 32.16312222 -19.37692517 25.93465732 -16.125 19.3125 C-15.79757812 18.6412207 -15.47015625 17.96994141 -15.1328125 17.27832031 C-13.01270527 13.21823215 -10.84435192 10.50580694 -7 8 C-6.34 8 -5.68 8 -5 8 C-4.731875 7.4225 -4.46375 6.845 -4.1875 6.25 C-2.98280141 3.9674132 -1.59201885 2.0262058 0 0 Z " fill="#8C5B02" transform="translate(778,579)"/><path d="M0 0 C3.88483815 0.00766901 7.76964077 -0.00219277 11.65447376 -0.00973 C18.45100454 -0.02052642 25.24746373 -0.02026025 32.04399774 -0.01258852 C42.15090735 -0.00121129 52.25775689 -0.00705772 62.36466613 -0.01621344 C80.41866797 -0.03199024 98.47263791 -0.03064963 116.52664276 -0.0219767 C132.32618766 -0.01442423 148.12572087 -0.01246264 163.9252672 -0.01604463 C164.97408257 -0.01627379 166.02289795 -0.01650294 167.10349561 -0.01673904 C171.36118774 -0.01767309 175.61887986 -0.01862829 179.87657198 -0.01961833 C219.80108822 -0.02879132 259.72558418 -0.02048132 299.6500973 -0.00432764 C335.10547384 0.00990872 370.56081806 0.00863482 406.01619432 -0.00571062 C445.86860158 -0.0217813 485.72099091 -0.02814072 525.57340095 -0.01887383 C529.82324788 -0.0179117 534.07309482 -0.01697318 538.32294176 -0.01604463 C539.3693302 -0.0158074 540.41571864 -0.01557017 541.49381582 -0.01532575 C557.28180291 -0.01191613 573.06977702 -0.01589893 588.85776231 -0.02348329 C606.81291039 -0.03206583 624.76802164 -0.0299064 642.72316513 -0.01364106 C652.76682167 -0.00484229 662.81039842 -0.00424259 672.85405286 -0.01557958 C679.56873327 -0.02232181 686.2833499 -0.01809287 692.99802089 -0.00506528 C696.81977567 0.00204864 700.6413723 0.00455825 704.46312193 -0.00628323 C737.46085633 -0.09288645 764.1230143 5.58875101 789.62410448 27.38540266 C790.63537401 28.24198469 790.63537401 28.24198469 791.66707323 29.11587141 C803.74669913 40.27733098 813.51512517 56.52188057 817.62410448 72.38540266 C816.13910448 73.37540266 816.13910448 73.37540266 814.62410448 74.38540266 C814.37354295 73.88315169 814.12298143 73.38090071 813.86482713 72.86343001 C808.7795076 62.74583508 803.4838788 53.2166081 796.65535448 44.17055891 C795.02486418 41.93490587 793.73984672 39.90188654 792.62410448 37.38540266 C791.96410448 37.38540266 791.30410448 37.38540266 790.62410448 37.38540266 C789.47200796 36.26821816 788.32629101 35.14398597 787.20613573 33.99477766 C779.5701228 26.22678426 771.15546056 20.55991452 761.62410448 15.38540266 C760.41690218 14.7079001 760.41690218 14.7079001 759.18531195 14.01671062 C740.95733451 5.66688969 720.81958457 5.50484659 701.17261866 5.62700006 C697.2895745 5.64430363 693.40664896 5.6261469 689.52361087 5.61287175 C682.74403824 5.59442684 675.96476352 5.59787036 669.18519495 5.61633681 C659.10349845 5.64372135 649.02202742 5.63634532 638.94031394 5.6224196 C620.92835561 5.59865071 602.91653796 5.60867353 584.9045875 5.63297615 C569.14464729 5.65409419 553.3847549 5.66312131 537.62480066 5.66038512 C536.57718444 5.66021705 535.52956822 5.66004899 534.45020605 5.65987584 C530.19706072 5.65917129 525.94391541 5.65840325 521.6907701 5.65754469 C481.84320492 5.64962534 441.9957242 5.67500095 402.14818318 5.71659781 C366.77856339 5.75334663 331.40902451 5.7649579 296.03938768 5.75405501 C293.76741446 5.75336214 291.49544123 5.75266994 289.22346801 5.75197843 C287.53860084 5.75146544 287.53860084 5.75146544 285.81969595 5.75094209 C280.16491796 5.74923489 274.51013995 5.74758733 268.85536192 5.74600409 C267.18179935 5.74553285 267.18179935 5.74553285 265.47442744 5.74505209 C235.87799046 5.7370659 206.28156123 5.74803103 176.68512896 5.76502667 C173.49934155 5.76684066 170.31355414 5.76865196 167.12776673 5.77045713 C165.01460051 5.77165935 162.90143431 5.77287659 160.78826812 5.77410895 C146.08039281 5.78253861 131.3725328 5.78371371 116.66465585 5.77989796 C97.71087933 5.7750049 78.75718474 5.78321367 59.80343056 5.81431797 C49.78943674 5.83037451 39.77557928 5.83565414 29.76157742 5.82503325 C23.06186804 5.81905323 16.36227857 5.82776553 9.66259783 5.84813041 C5.85281042 5.85931807 2.04329979 5.86449655 -1.76648927 5.85179725 C-37.71845993 5.74233257 -66.43274303 12.80115819 -93.37589552 37.38540266 C-94.10163771 38.02864485 -94.8273799 38.67188704 -95.57511427 39.33462141 C-104.35490669 47.54452872 -111.30690356 57.92164812 -117.00089552 68.44790266 C-117.33154005 69.05448714 -117.66218459 69.66107161 -118.00284865 70.28603743 C-119.91828191 73.98103944 -120.87071821 77.26849791 -121.37589552 81.38540266 C-122.16331702 84.53508865 -122.98247641 87.54392289 -124.36027052 90.49087141 C-129.7211807 102.0867532 -128.52582293 116.06328192 -128.45106032 128.63984106 C-128.43799819 130.85513251 -128.43170997 133.07036249 -128.42692091 135.28568648 C-128.41566921 139.96478709 -128.39633811 144.64383442 -128.37589552 149.32290266 C-128.35224221 154.80365279 -128.33195523 160.28437633 -128.3199568 165.76516531 C-128.31347515 167.9484257 -128.30098623 170.1315992 -128.28824904 172.31483076 C-128.2832942 174.27936957 -128.2832942 174.27936957 -128.27823927 176.28359602 C-128.27300246 177.44112883 -128.26776564 178.59866163 -128.26237013 179.79127119 C-128.37589552 182.38540266 -128.37589552 182.38540266 -129.37589552 183.38540266 C-129.47502392 184.87625631 -129.50669299 186.37172718 -129.50870802 187.86587141 C-129.50999709 188.78303938 -129.51128615 189.70020735 -129.51261427 190.64516829 C-129.50874709 191.61132063 -129.5048799 192.57747298 -129.50089552 193.57290266 C-129.50476271 194.51971907 -129.5086299 195.46653548 -129.51261427 196.44204329 C-129.50728188 200.26270259 -129.46948473 203.85399546 -128.80558302 207.62368391 C-128.37589552 210.38540266 -128.37589552 210.38540266 -128.84237864 213.37368105 C-129.6066464 218.3501286 -129.50364435 223.31047741 -129.48247816 228.33466719 C-129.48193294 229.42967266 -129.48138772 230.52467812 -129.48082598 231.65286557 C-129.47790874 235.32113825 -129.46793843 238.98935913 -129.45817091 242.65761946 C-129.45500256 245.29137955 -129.45227527 247.92513623 -129.45018103 250.558897 C-129.44498547 256.25000719 -129.43660027 261.94110494 -129.42618658 267.63220785 C-129.39971215 282.32319688 -129.39324692 297.01420738 -129.38552431 311.70521608 C-129.38418839 314.13956156 -129.3826781 316.57390689 -129.38112869 319.00825225 C-129.35882223 354.97406981 -129.44234772 390.9393291 -129.55948927 426.90493391 C-129.56316058 428.03581797 -129.56316058 428.03581797 -129.56690606 429.18954818 C-129.62636546 447.48151511 -129.69033848 465.77346446 -129.75647817 484.06540832 C-129.80154022 496.55519602 -129.84196149 509.04499442 -129.88054813 521.53480365 C-129.92126809 534.69828501 -129.96532502 547.86175168 -130.01277407 561.02521054 C-130.03887699 568.28402619 -130.06375623 575.54284023 -130.08496954 582.80167197 C-130.17020146 611.67456757 -130.26750837 640.53031785 -131.37589552 669.38540266 C-131.70589552 669.38540266 -132.03589552 669.38540266 -132.37589552 669.38540266 C-132.39906678 678.31279823 -132.41683504 687.24018344 -132.42770769 696.16760252 C-132.43292604 700.31296728 -132.44000469 704.45831146 -132.45133498 708.60366438 C-132.46220106 712.60422339 -132.46818027 716.6047626 -132.47077277 720.60533522 C-132.47262029 722.1315479 -132.47622802 723.6577595 -132.48162558 725.18396376 C-132.48888537 727.32177189 -132.48988437 729.45949825 -132.48942091 731.59731673 C-132.49164152 732.81421187 -132.49386214 734.03110701 -132.49615004 735.28487776 C-132.39532906 737.88434729 -132.06581451 739.90841989 -131.37589552 742.38540266 C-131.30757565 744.80119326 -131.29101911 747.21874979 -131.31339552 749.63540266 C-131.32241896 750.89868391 -131.3314424 752.16196516 -131.34073927 753.46352766 C-131.35814162 754.90985579 -131.35814162 754.90985579 -131.37589552 756.38540266 C-131.70589552 756.38540266 -132.03589552 756.38540266 -132.37589552 756.38540266 C-135.16014644 743.71152713 -134.65778071 730.85676477 -134.63659193 717.95678328 C-134.63961451 715.35222978 -134.64350452 712.74767716 -134.6481845 710.14312611 C-134.65691774 704.49213298 -134.65826889 698.8411761 -134.65468123 693.1901779 C-134.6493601 684.78644323 -134.65548373 676.38274347 -134.66376416 667.9790126 C-134.67898657 652.09382381 -134.68071099 636.20865099 -134.67824113 620.32345643 C-134.6764067 608.05323637 -134.67817124 595.78302152 -134.68246558 583.51280211 C-134.68306798 581.74837665 -134.68366918 579.9839512 -134.68426918 578.21952575 C-134.68517646 575.56050763 -134.68608513 572.90148952 -134.68700153 570.24247141 C-134.69542863 545.52645512 -134.69976849 520.8104408 -134.69559481 496.09442328 C-134.69543843 495.16309295 -134.69528206 494.23176263 -134.69512094 493.27221017 C-134.69431519 488.55214305 -134.69346942 483.83207594 -134.69260764 479.11200884 C-134.69243655 478.17463414 -134.69226547 477.23725943 -134.69208919 476.27147944 C-134.69174254 474.37588029 -134.69139401 472.48028115 -134.69104361 470.584682 C-134.68568798 441.09783357 -134.69361331 411.61101505 -134.71207716 382.12417219 C-134.73281082 348.97384336 -134.74351718 315.82353305 -134.73950168 282.67319737 C-134.73910635 279.13576419 -134.7387448 275.598331 -134.7384043 272.06089781 C-134.73831356 271.18993225 -134.73822283 270.31896669 -134.73812935 269.42160823 C-134.73696518 256.2946472 -134.74359803 243.16770493 -134.75421622 230.04074858 C-134.76628663 215.1034686 -134.76780608 200.16622983 -134.75542605 185.22894922 C-134.74881457 176.87893075 -134.75038881 168.52901095 -134.76401456 160.17900045 C-134.77327329 153.92999401 -134.76670007 147.68109529 -134.75416677 141.43209666 C-134.75152316 138.91466728 -134.75387568 136.3972263 -134.76190263 133.87980833 C-134.87732161 94.96176876 -125.5433718 62.71692835 -98.25089552 33.88540266 C-70.53776537 7.08011643 -37.33345373 -0.10590687 0 0 Z " fill="#FCEC50" transform="translate(149.37589552253485,11.614597337320447)"/><path d="M0 0 C1.51308998 -0.05798515 1.51308998 -0.05798515 3.05674744 -0.11714172 C7.70895522 -0.25441008 12.36107061 -0.35334766 17.01464844 -0.43066406 C19.46219993 -0.48225786 21.90937968 -0.55716169 24.35546875 -0.65625 C45.8022138 -1.50958419 45.8022138 -1.50958419 51.1628418 2.96264648 C54.10220864 6.09288092 57.27172852 9.85471211 57.27172852 14.30395508 C56.65453949 14.23209991 56.03735046 14.16024475 55.40145874 14.08621216 C22.10483157 9.89163984 22.10483157 9.89163984 -8.02200317 21.29385376 C-19.69459885 31.37591073 -30.16893553 43.46495114 -38.72827148 56.30395508 C-40.97339058 56.67309856 -40.97339058 56.67309856 -43.82815552 56.66471863 C-44.90791656 56.66884262 -45.98767761 56.67296661 -47.10015869 56.67721558 C-48.28986267 56.66642975 -49.47956665 56.65564392 -50.70532227 56.64453125 C-52.57844589 56.64518837 -52.57844589 56.64518837 -54.4894104 56.64585876 C-57.91914574 56.64412355 -61.34834312 56.62905126 -64.77798319 56.60813689 C-68.36010061 56.58941649 -71.94222476 56.58762333 -75.52438354 56.58406067 C-82.3100857 56.57472652 -89.09564331 56.55009433 -95.88128173 56.5200122 C-103.60546547 56.48651069 -111.32965601 56.4699929 -119.05389428 56.45492589 C-134.94543714 56.42354586 -150.83683569 56.37075891 -166.72827148 56.30395508 C-167.02918701 57.24867676 -167.33010254 58.19339844 -167.64013672 59.16674805 C-169.77263302 65.31495928 -174.18940086 69.87314446 -179.97827148 72.80395508 C-187.13914727 75.54875414 -194.93970402 75.37549924 -201.95483398 72.26879883 C-208.83882949 68.52354136 -213.08999322 62.75797006 -215.34545898 55.24926758 C-216.83819999 47.66370614 -215.19109913 41.11790624 -211.72827148 34.30395508 C-207.34929978 28.46179186 -201.89752463 24.84117017 -194.72827148 23.30395508 C-187.06163488 22.3624383 -181.01264322 23.73254755 -174.72827148 28.30395508 C-171.2353581 31.93023425 -168.32915646 35.50130015 -166.72827148 40.30395508 C-152.00274523 40.45816542 -137.27716753 40.60618878 -122.55150604 40.74691868 C-115.71358511 40.81241023 -108.87569494 40.87989907 -102.0378418 40.95214844 C-95.43728391 41.02188484 -88.83668666 41.08597773 -82.23603821 41.14665031 C-79.71948902 41.17070056 -77.20295708 41.19663257 -74.68644714 41.22448921 C-71.15809829 41.26322305 -67.62974705 41.29522785 -64.10131836 41.32568359 C-63.06409637 41.33862961 -62.02687439 41.35157562 -60.95822144 41.36491394 C-51.36226059 41.8024145 -51.36226059 41.8024145 -42.5091095 38.92657471 C-41.93794907 38.33987 -41.36678864 37.75316528 -40.77832031 37.14868164 C-40.11435745 36.48419006 -39.45039459 35.81969849 -38.76631165 35.1350708 C-37.73621223 34.05077789 -37.73621223 34.05077789 -36.68530273 32.94458008 C-35.58807137 31.83249176 -35.58807137 31.83249176 -34.46867371 30.69793701 C-32.1423606 28.33259081 -29.84156665 25.94410385 -27.54077148 23.55395508 C-25.98316285 21.96120754 -24.42393324 20.3700435 -22.86303711 18.78051758 C-19.99519446 15.85563368 -17.13698548 12.92203087 -14.29003906 9.97680664 C-11.46494955 7.05568259 -8.61237177 4.16677672 -5.72827148 1.30395508 C-4.10195226 -0.32236414 -2.24874337 0.08570694 0 0 Z M-202.10327148 43.11645508 C-203.46364369 47.87775781 -203.29705336 51.22733225 -200.97827148 55.61645508 C-198.36799765 58.81696586 -198.36799765 58.81696586 -194.72827148 60.30395508 C-190.5139023 60.63842882 -187.82514191 60.74270325 -183.91577148 59.17895508 C-180.32789954 56.10363627 -178.96677064 52.93937789 -178.29077148 48.30395508 C-178.94296697 43.83175748 -180.92073949 40.72415879 -184.47827148 37.92895508 C-191.6354468 35.94085082 -197.44171885 36.97168115 -202.10327148 43.11645508 Z " fill="#E8AE18" transform="translate(673.728271484375,598.696044921875)"/><path d="M0 0 C1.00817403 -0.00445668 1.00817403 -0.00445668 2.03671521 -0.0090034 C4.29362896 -0.01768961 6.55048967 -0.01919858 8.80741882 -0.02069092 C10.42372247 -0.02531915 12.04002502 -0.03034382 13.65632629 -0.03573608 C18.05103904 -0.04886164 22.4457365 -0.05530535 26.84046578 -0.05974674 C29.58584757 -0.06267723 32.33122517 -0.06678199 35.07660484 -0.07125092 C43.66550086 -0.08492628 52.25438733 -0.09459273 60.84329349 -0.09845281 C70.75934232 -0.10293375 80.67525333 -0.12048317 90.59126025 -0.1494534 C98.25504823 -0.17106675 105.91879742 -0.1811569 113.58261555 -0.18249393 C118.16031801 -0.18354221 122.73789091 -0.1894549 127.31556129 -0.20731354 C131.62229945 -0.22378821 135.92881057 -0.22595269 140.235569 -0.21717453 C141.8149762 -0.21640383 143.39439557 -0.22075125 144.97377205 -0.23063278 C147.13284979 -0.24334746 149.29112285 -0.23747883 151.45019531 -0.22705078 C152.65753484 -0.22851734 153.86487436 -0.2299839 155.10879993 -0.2314949 C159.92913411 0.31068309 163.20244709 2.05501334 166.79057312 5.26544189 C169.06313164 9.28612235 169.21095882 12.62265112 168.41557312 17.14044189 C166.34719632 21.20332489 164.68007067 23.54222199 160.41557312 25.14044189 C157.31642342 25.3977108 157.31642342 25.3977108 153.59700012 25.40786743 C152.91177902 25.41239854 152.22655792 25.41692966 151.52057254 25.42159808 C149.22525021 25.43425508 146.93016476 25.4326209 144.6348114 25.43096924 C142.98880203 25.43695368 141.34279547 25.44375903 139.6967926 25.45132446 C135.22567982 25.46900012 130.75464358 25.4736805 126.28349924 25.47495604 C122.55089282 25.4768551 118.81830424 25.4842127 115.08570468 25.49130023 C106.27914774 25.50758767 97.47263168 25.51246885 88.6660614 25.51104736 C79.5819467 25.50984576 70.49806952 25.53095055 61.41401494 25.56253469 C53.61431832 25.5886868 45.81469934 25.59941511 38.01495922 25.59813654 C33.35675705 25.5976266 28.69876595 25.60332744 24.04060745 25.62449265 C19.65910162 25.64385718 15.27800859 25.64401185 10.89648819 25.62945938 C9.28966672 25.62736797 7.68281953 25.63209202 6.07604218 25.6441803 C3.87958133 25.65963287 1.68454391 25.65032655 -0.5118866 25.63491821 C-1.74005033 25.63600775 -2.96821407 25.63709728 -4.23359489 25.63821983 C-8.27491134 25.03786799 -10.4205234 23.68361932 -13.58442688 21.14044189 C-16.42278825 16.88289984 -16.46868073 13.13609827 -15.58442688 8.14044189 C-11.71410111 1.33990103 -7.61863083 0.01878851 0 0 Z " fill="#E4A713" transform="translate(329.5844268798828,504.85955810546875)"/><path d="M0 0 C0.67031719 1.9570868 1.33614683 3.91571113 2 5.875 C2.37125 6.96554687 2.7425 8.05609375 3.125 9.1796875 C4 12 4 12 4 14 C1.85516052 14.179003 -0.29102472 14.34181554 -2.4375 14.5 C-3.11958527 14.56437256 -3.80167053 14.62874512 -4.50442505 14.69506836 C-8.99329708 15.04686409 -12.96226834 14.91775262 -17.39624023 14.09960938 C-25.50574525 12.87741588 -33.47643645 12.3857062 -40.52645874 17.1965332 C-49.16567955 23.79574407 -56.48739442 32.039313 -63.80450439 40.02960205 C-66.83967361 43.31469166 -69.95057567 46.52632408 -73.0546875 49.74609375 C-81.41956348 58.4601526 -89.72388436 67.23865948 -97.59188843 76.4074707 C-98.05656525 76.93300537 -98.52124207 77.45854004 -99 78 C-99.4159845 78.55855179 -99.83196899 79.11710358 -100.26055908 79.69258118 C-102.99055617 81.74453335 -105.41136682 81.34080836 -108.77880859 81.30541992 C-109.46371872 81.30276123 -110.14862885 81.30010254 -110.85429382 81.29736328 C-112.34066273 81.29041088 -113.82701223 81.27698684 -115.31327438 81.257864 C-117.66751294 81.23024496 -120.02076372 81.22532804 -122.37515259 81.22737122 C-129.06815895 81.23090459 -135.76050154 81.2078495 -142.453125 81.1340332 C-146.54835723 81.09048036 -150.64211332 81.08578323 -154.73750687 81.10561562 C-156.29645493 81.10551812 -157.85547557 81.09065794 -159.41413498 81.06065941 C-167.74615981 80.52589635 -167.74615981 80.52589635 -174.9788208 83.72451782 C-176.33429505 85.78604883 -176.33429505 85.78604883 -177.14834595 87.95796204 C-178.96986206 92.32546906 -183.00507948 95.04747038 -187.16796875 97.03515625 C-194.02692709 99.573325 -199.79914215 100.12046159 -206.625 97.3125 C-213.50432926 93.89647568 -217.8670258 89.88103462 -221.078125 82.875 C-223.39330113 75.65478969 -223.06231127 68.46615281 -219.9375 61.5625 C-215.91061858 54.61415558 -210.9167791 50.6504673 -203.18359375 48.47265625 C-196.00503493 46.91880005 -190.36987541 48.6633986 -184 52 C-181.125 54.4375 -181.125 54.4375 -179 57 C-178.278125 57.845625 -177.55625 58.69125 -176.8125 59.5625 C-175.24109505 61.67576873 -174.13210733 63.64102745 -173 66 C-164.59422444 66.11587396 -156.18878276 66.20470398 -147.78240585 66.25906086 C-143.87890149 66.28515031 -139.97594369 66.3205346 -136.07275391 66.37719727 C-132.30556116 66.43154313 -128.53889392 66.46142545 -124.77133942 66.47438622 C-123.33436052 66.48362174 -121.89741025 66.50165727 -120.46065521 66.52865028 C-118.44768854 66.56496318 -116.43419253 66.56704255 -114.42089844 66.56762695 C-113.27506287 66.57873001 -112.12922729 66.58983307 -110.94866943 66.60127258 C-107.0926478 65.81497892 -106.19942629 64.14472165 -104 61 C-103.34 61 -102.68 61 -102 61 C-101.60230659 60.11384003 -101.60230659 60.11384003 -101.19657898 59.20977783 C-99.96231302 56.9304017 -98.69377154 55.45812977 -96.85473633 53.64355469 C-96.21679642 53.00899353 -95.57885651 52.37443237 -94.92158508 51.72064209 C-93.88725594 50.70650238 -93.88725594 50.70650238 -92.83203125 49.671875 C-92.11899338 48.9640387 -91.40595551 48.25620239 -90.67131042 47.5269165 C-88.38973806 45.26314228 -86.10161658 43.00614329 -83.8125 40.75 C-81.54206125 38.50733494 -79.27315071 36.26317841 -77.00724792 34.01593018 C-75.59870969 32.61947599 -74.18750874 31.22570033 -72.77314758 29.83514404 C-67.10024236 24.218915 -61.45825174 18.61357404 -57.36328125 11.71875 C-44.81145969 -6.75889751 -19.63470735 -1.31708563 0 0 Z M-205 64 C-208.79020852 67.68777045 -209.90560911 70.71411032 -210 76 C-208.27219865 80.12752544 -205.75534424 82.61023548 -202 85 C-197.63444229 86.26998043 -195.81997399 86.42575573 -191.75 84.3125 C-187.47682701 80.90618271 -187.47682701 80.90618271 -185.6484375 75.95703125 C-185.37206997 71.61515193 -185.76990885 69.39546916 -188 65.5625 C-193.60489592 60.77498474 -198.68982073 59.55419188 -205 64 Z " fill="#D89C14" transform="translate(741,640)"/><path d="M0 0 C6.50004796 -0.00560564 12.99989896 -0.02997979 19.49988365 -0.05797195 C24.56642267 -0.07653166 29.63291181 -0.08179914 34.69948196 -0.08333588 C37.10045135 -0.08635003 39.50142012 -0.09433641 41.90235519 -0.10752106 C45.22054952 -0.1245293 48.53822542 -0.12272052 51.85644531 -0.11621094 C52.83173187 -0.12542572 53.80701843 -0.1346405 54.81185913 -0.14413452 C60.06122226 -0.11179098 63.78788537 0.25476485 68.30419922 3.24023438 C71.13077154 6.51310759 72.21299547 8.49757527 72.74169922 12.80273438 C72.11739089 17.70801413 70.62681355 19.98131136 67.08203125 23.35539246 C61.77925948 26.75155935 55.03973306 25.76849991 48.98388672 25.71020508 C47.51804957 25.71071427 46.05221214 25.71297252 44.58638 25.71684265 C40.6125977 25.72225501 36.63928301 25.70286214 32.66558456 25.67874169 C28.49346143 25.65738751 24.32133902 25.65803753 20.14916992 25.65605164 C13.1348471 25.64960518 6.12069868 25.62837441 -0.89355469 25.59692383 C-9.86003773 25.55676934 -18.8264067 25.53925159 -27.79296875 25.52961445 C-35.53658247 25.52126506 -43.28017267 25.50403967 -51.02376556 25.48457694 C-52.67670372 25.4805444 -54.32964261 25.47680241 -55.98258209 25.47335458 C-60.70690226 25.46347145 -65.43115681 25.44879205 -70.15543556 25.42651558 C-71.57827987 25.42047276 -73.00113187 25.41597937 -74.42398643 25.41327286 C-78.84968599 25.40407673 -83.27137265 25.34622799 -87.69580078 25.24023438 C-89.00189301 25.20936422 -90.30798523 25.17849407 -91.65365601 25.14668846 C-92.91239532 25.09140795 -94.17113464 25.03612743 -95.46801758 24.97917175 C-97.15703438 24.91195813 -97.15703438 24.91195813 -98.88017273 24.84338665 C-101.69580078 24.24023438 -101.69580078 24.24023438 -103.55085754 22.32832813 C-105.99174016 17.87676094 -105.78392421 12.82645603 -105.50830078 7.86523438 C-104.51370286 4.65191802 -103.64810532 3.79839511 -100.69580078 2.24023438 C-96.38916702 1.12282356 -92.09306038 1.02679162 -87.66992188 0.93261719 C-86.8631966 0.912463 -86.05647133 0.89230881 -85.22529984 0.87154388 C-82.5150435 0.8064199 -79.80470065 0.74922025 -77.09423828 0.69335938 C-76.14248089 0.6726664 -75.1907235 0.65197342 -74.21012497 0.63065338 C-49.47592739 0.10156569 -24.73906561 0.01819915 0 0 Z " fill="#E3B643" transform="translate(337.69580078125,446.759765625)"/><path d="M0 0 C0.97905231 -0.00891337 0.97905231 -0.00891337 1.97788346 -0.0180068 C4.15719337 -0.03530074 6.33628253 -0.03839031 8.51565552 -0.04138184 C10.08137477 -0.05064373 11.64708953 -0.0606938 13.21279907 -0.07147217 C17.46076974 -0.09766708 21.70867728 -0.11059907 25.95671606 -0.11949348 C28.6120027 -0.12536224 31.26727221 -0.13357312 33.9225502 -0.14250183 C42.23432803 -0.16983487 50.54606655 -0.18917763 58.8578862 -0.19690561 C68.44581981 -0.20586982 78.03318356 -0.24098547 87.6209439 -0.2989068 C95.03766509 -0.34215456 102.454226 -0.36231481 109.87107193 -0.36498785 C114.29859798 -0.36708255 118.72558773 -0.37886666 123.1529808 -0.41462708 C127.31797028 -0.44761552 131.48202106 -0.45188843 135.64709473 -0.43434906 C137.17288861 -0.43280977 138.69873326 -0.44147541 140.22439957 -0.46126556 C153.17357892 -0.61934529 153.17357892 -0.61934529 157.77178955 3.13793945 C160.55652342 6.01494818 161.27252511 8.54480566 161.80911255 12.53088379 C161.22763525 17.51497491 158.99879657 19.95439896 155.37161255 23.28088379 C152.62133767 24.65602123 150.42469838 24.40683275 147.3452301 24.40786743 C146.05970749 24.41068726 144.77418488 24.41350708 143.44970703 24.41641235 C142.01669298 24.41446779 140.58367906 24.4124196 139.15066528 24.41027832 C137.64775042 24.41163278 136.14483589 24.41341297 134.641922 24.41558838 C130.55064929 24.42016008 126.45940171 24.4183735 122.36812854 24.41520929 C118.08552148 24.41268108 113.80291659 24.41502483 109.52030945 24.41659546 C102.31994236 24.41841718 95.11958551 24.41601222 87.91921997 24.41125488 C79.60782815 24.4058267 71.29646091 24.40756437 62.98506969 24.41308129 C55.84609214 24.41762962 48.70712196 24.41825411 41.56814343 24.41564262 C37.30616641 24.41408745 33.04420092 24.41386493 28.78222466 24.41717911 C24.76774392 24.4200823 20.75329458 24.41803736 16.73881721 24.41228485 C15.27033159 24.41096971 13.8018433 24.41133004 12.33335876 24.41354752 C-7.83180975 24.44117355 -7.83180975 24.44117355 -12.62838745 21.34338379 C-16.16335802 17.69794539 -15.966208 14.66177615 -15.90963745 9.76135254 C-15.50741826 6.21400271 -14.30258353 4.59370202 -11.62838745 2.28088379 C-7.66621716 0.31344924 -4.39774251 0.02243503 0 0 Z " fill="#DBA526" transform="translate(396.6283874511719,563.7191162109375)"/><path d="M0 0 C0.89874816 0.00092179 1.79749632 0.00184359 2.72347927 0.00279331 C3.75138073 0.00141865 4.77928219 0.00004398 5.83833218 -0.00137234 C6.975527 0.00222294 8.11272182 0.00581821 9.2843771 0.00952244 C10.47445873 0.00937641 11.66454037 0.00923038 12.89068508 0.00907993 C16.16326569 0.00965889 19.43580402 0.01468801 22.70837617 0.02165389 C26.1250196 0.02788815 29.54166379 0.02849128 32.95831203 0.0296793 C39.43232563 0.0327924 45.90632242 0.0410055 52.3803286 0.05102879 C59.74901216 0.06219058 67.11769651 0.06770054 74.48638642 0.07272422 C89.64814464 0.08318813 104.80988712 0.10078717 119.97163296 0.12304783 C119.99628688 4.66202488 120.01447084 9.20096326 120.0265646 13.73999119 C120.03160435 15.28524549 120.03843615 16.83049499 120.04707241 18.37573338 C120.05915372 20.59229812 120.06486468 22.80880001 120.06928921 25.02539158 C120.07445049 25.72019123 120.07961178 26.41499088 120.08492947 27.13084507 C120.08512572 28.79534113 120.03352425 30.45970282 119.97163296 32.12304783 C118.3407081 33.75397269 116.51577661 33.24907785 114.26447964 33.25003147 C112.73741642 33.25426121 112.73741642 33.25426121 111.17950344 33.25857639 C109.49009388 33.25554005 109.49009388 33.25554005 107.76655483 33.25244236 C106.58783306 33.25419468 105.40911129 33.255947 104.19467068 33.25775242 C100.95301688 33.2614105 97.71140362 33.26053756 94.4697504 33.25737333 C91.08426863 33.25484927 87.69878964 33.2571874 84.31330776 33.2587595 C78.6269828 33.26058106 72.9406708 33.25817524 67.2543478 33.25341892 C60.67135278 33.24797632 54.08838873 33.24973899 47.50539446 33.25524533 C41.86293983 33.25977684 36.22049455 33.26042682 30.57803869 33.25780666 C27.20385543 33.2562441 23.82968675 33.25604955 20.45550442 33.25934315 C16.695885 33.26186795 12.93632598 33.2580315 9.17671108 33.25244236 C8.05043804 33.25446659 6.924165 33.25649082 5.76376247 33.25857639 C4.74572033 33.25575657 3.72767818 33.25293674 2.67878628 33.25003147 C1.78871128 33.24965445 0.89863628 33.24927742 -0.01841068 33.24888897 C-2.02836704 33.12304783 -2.02836704 33.12304783 -3.02836704 32.12304783 C-3.12857634 29.84356991 -3.15918007 27.56097648 -3.16117954 25.27929783 C-3.16213627 24.59500706 -3.16309299 23.91071629 -3.16407871 23.20568943 C-3.16476034 21.75642906 -3.16290727 20.30716565 -3.15873814 18.85791111 C-3.15338956 16.63241855 -3.15868364 14.40712782 -3.16508579 12.18164158 C-3.16442501 10.77669321 -3.16314384 9.37174498 -3.16117954 7.96679783 C-3.16005161 6.67966892 -3.15892368 5.39254002 -3.15776157 4.0664072 C-2.98696197 0.18119954 -2.98696197 0.18119954 0 0 Z " fill="#EFA202" transform="translate(273.0283670425415,728.8769521713257)"/><path d="M0 0 C9.66327597 3.13521865 19.17040889 6.52331157 28.625 10.25 C31.34646276 11.31426951 34.06952513 12.37440464 36.79296875 13.43359375 C37.51635941 13.7150676 38.23975006 13.99654144 38.98506165 14.2865448 C48.61193157 18.02473789 58.27513004 21.66729179 67.9375 25.3125 C68.90109436 25.67611633 69.86468872 26.03973267 70.85748291 26.41436768 C84.68752352 31.63179168 98.52556189 36.82779712 112.36813354 42.01187134 C130.09176385 48.64960942 147.79938233 55.32972908 165.50631714 62.01184082 C184.37209544 69.13271451 184.37209544 69.13271451 203.25390625 76.2109375 C204.51264557 76.68112556 204.51264557 76.68112556 205.79681396 77.16081238 C206.6139386 77.4660231 207.43106323 77.77123383 208.27294922 78.08569336 C225.37236877 84.47283584 242.41610552 90.99448435 259.43505859 97.59301758 C271.13034405 102.12638163 282.84131002 106.61586358 294.56781006 111.06784058 C315.19561511 118.89992802 335.75834085 126.89163652 356.30151367 134.94274902 C360.98687664 136.77844651 365.67314677 138.61182524 370.359375 140.4453125 C376.17911471 142.72233007 381.99882128 144.99943132 387.81811523 147.27758789 C397.1645066 150.93628346 406.51209036 154.59186805 415.86328125 158.23828125 C417.19140335 158.75622757 417.19140335 158.75622757 418.5463562 159.28463745 C422.6510232 160.88525203 426.75593601 162.48523058 430.86132812 164.08398438 C446.9249716 170.34584967 462.95840819 176.68058504 479 183 C479 229.2 479 275.4 479 323 C489.89 322.505 489.89 322.505 501 322 C507.55456755 321.98552824 514.09647198 322.01228767 520.6484375 322.12109375 C522.41060625 322.14550998 524.17278312 322.16934682 525.93496704 322.19264221 C530.48860191 322.25434329 535.04208597 322.32370814 539.59558105 322.39489746 C544.27589267 322.46663661 548.95630805 322.53081305 553.63671875 322.59570312 C562.75793049 322.72323731 571.87897718 322.8596031 581 323 C581 317.39 581 311.78 581 306 C581.33 306 581.66 306 582 306 C582.04898438 307.15757812 582.09796875 308.31515625 582.1484375 309.5078125 C582.22351478 311.0468967 582.29906043 312.5859581 582.375 314.125 C582.4059375 314.88554687 582.436875 315.64609375 582.46875 316.4296875 C582.52675781 317.55117188 582.52675781 317.55117188 582.5859375 318.6953125 C582.6173584 319.37609863 582.6487793 320.05688477 582.68115234 320.75830078 C583.02909765 323.68557797 583.02909765 323.68557797 585 329 C549.03 329 513.06 329 476 329 C476.33 327.35 476.66 325.7 477 324 C477.08639782 322.05474299 477.12202629 320.10688766 477.12025452 318.15971375 C477.12162918 316.99168716 477.12300385 315.82366058 477.12442017 314.62023926 C477.12082489 313.34781372 477.11722961 312.07538818 477.11352539 310.7644043 C477.11324316 309.40407819 477.11340195 308.04375192 477.1139679 306.6834259 C477.11425448 302.99787572 477.10838016 299.31235817 477.10139394 295.62681556 C477.09513732 291.77243704 477.09455477 287.91805774 477.09336853 284.06367493 C477.09026202 276.76814497 477.0820578 269.47263003 477.07201904 262.17710668 C477.06083678 253.87001663 477.05534213 245.56292587 477.05032361 237.25583017 C477.03987463 220.17054477 477.02228835 203.08527397 477 186 C476.38792285 186.34085443 475.7758457 186.68170887 475.14522076 187.03289223 C473 188 473 188 470.6764679 187.47372437 C469.82070663 187.11033966 468.96494537 186.74695496 468.08325195 186.37255859 C467.10688278 185.96856842 466.13051361 185.56457825 465.1245575 185.14834595 C463.54116325 184.46776627 463.54116325 184.46776627 461.92578125 183.7734375 C459.6473131 182.82749586 457.36815599 181.88321233 455.08837891 180.94042969 C453.91293518 180.44990112 452.73749146 179.95937256 451.52642822 179.45397949 C446.02422735 177.18537037 440.47372766 175.04738553 434.91796875 172.9140625 C433.26424004 172.27633156 433.26424004 172.27633156 431.57710266 171.62571716 C428.11452229 170.29052821 424.65102672 168.95773191 421.1875 167.625 C418.70022851 166.66654728 416.21300444 165.70797223 413.72583008 164.74926758 C406.15156679 161.83021048 398.5759536 158.91466694 391 156 C389.83259277 155.55086243 388.66518555 155.10172485 387.46240234 154.63897705 C377.54986981 150.82558689 367.63700094 147.0130722 357.72314453 143.203125 C347.56935056 139.30038241 337.4178428 135.39193403 327.2734375 131.46484375 C326.33335846 131.10093033 325.39327942 130.73701691 324.42471313 130.36207581 C323.49484589 130.00210007 322.56497864 129.64212433 321.60693359 129.27124023 C301.85553348 121.62498579 282.07035596 114.07427713 262.25195312 106.60351562 C256.05954988 104.26886113 249.86967433 101.92754372 243.68112183 99.58270264 C241.88936042 98.90410932 240.09715581 98.22668658 238.30493164 97.54931641 C237.22074951 97.13858887 236.13656738 96.72786133 235.01953125 96.3046875 C234.09245361 95.95390137 233.16537598 95.60311523 232.21020508 95.24169922 C229.67223593 94.26001916 227.15036992 93.25127854 224.62866211 92.22924805 C218.18629162 89.64652379 211.67399946 87.25454953 205.1623764 84.85368156 C202.87421449 84.00976568 200.58681698 83.16380762 198.29962158 82.317276 C191.80437463 79.9135025 185.30824344 77.51213471 178.81054688 75.11499023 C174.81681909 73.64145238 170.82433781 72.16457992 166.83261871 70.68560982 C165.31969902 70.12580246 163.80631265 69.56725459 162.29244232 69.01002312 C160.17653448 68.23108995 158.06223899 67.44792056 155.94824219 66.66381836 C154.74818542 66.22065781 153.54812866 65.77749725 152.31170654 65.32090759 C149.10473649 64.04177521 146.0833934 62.5480419 143 61 C140.66989091 60.32215008 138.33640176 59.65583207 136 59 C134.35848664 58.2918962 132.71744741 57.58241988 131.0859375 56.8515625 C127.45528372 55.36938549 123.70295506 54.24140501 119.96484375 53.0625 C117 52 117 52 114.3984375 50.640625 C109.32967644 48.1936369 104.01819621 46.53811347 98.6875 44.75 C90.31665459 41.90248561 82.07196946 38.92614806 73.93823242 35.46069336 C68.31330622 33.07864184 62.59538443 31.05057893 56.82128906 29.06225586 C52.4822182 27.55741401 48.32086124 25.87166684 44.1640625 23.9296875 C40.52053513 22.36441762 36.73798522 21.21919154 32.96875 19.99609375 C29.46612329 18.82087031 26.06185551 17.47876315 22.65234375 16.05859375 C20.6659166 15.2657782 18.65272826 14.53946099 16.62890625 13.84765625 C5.99760923 10.13796175 5.99760923 10.13796175 3 4 C2.34 4 1.68 4 1 4 C0.67 2.68 0.34 1.36 0 0 Z " fill="#FDED72" transform="translate(267,106)"/><path d="M0 0 C4.90911477 0.5982672 9.11415915 2.11733637 13.61328125 4.078125 C14.358022 4.39635223 15.10276276 4.71457947 15.87007141 5.04244995 C18.35358618 6.1054443 20.83296321 7.1777631 23.3125 8.25 C25.09462355 9.01477977 26.87701968 9.77892464 28.65966797 10.54248047 C32.4704813 12.17606389 36.27958939 13.81353671 40.08740234 15.45410156 C45.93672458 17.97393961 51.79006434 20.48432925 57.64453125 22.9921875 C59.62451383 23.84040849 61.60449428 24.68863444 63.58447266 25.53686523 C64.57650696 25.96184296 65.56854126 26.38682068 66.59063721 26.82467651 C69.6575872 28.13896468 72.72411282 29.45423843 75.79052734 30.76977539 C92.46997248 37.92439747 109.16591524 45.03991156 125.86590576 52.14642334 C142.89028487 59.39137826 159.90645879 66.65504631 176.90258789 73.96606445 C184.32697969 77.15749455 191.75690941 80.32984265 199.2265625 83.4140625 C200.46389544 83.92734074 201.7012012 84.44068453 202.93847656 84.95410156 C205.13734314 85.86326634 207.33954133 86.76444062 209.54589844 87.65527344 C210.95790527 88.23970215 210.95790527 88.23970215 212.3984375 88.8359375 C213.19942871 89.16126465 214.00041992 89.4865918 214.82568359 89.82177734 C218.82469441 91.98876883 221.34260768 95.26706265 223.84765625 98.984375 C224.36424805 99.74572754 224.88083984 100.50708008 225.41308594 101.29150391 C226.2295459 102.50845947 226.2295459 102.50845947 227.0625 103.75 C228.23546707 105.48191309 229.4086471 107.21368196 230.58203125 108.9453125 C231.16291504 109.80543945 231.74379883 110.66556641 232.34228516 111.55175781 C234.62511438 114.92321752 236.93657214 118.27450297 239.25 121.625 C244.90001853 129.82463886 250.48887434 138.06597325 256.07519531 146.30908203 C256.76967773 147.33243652 257.46416016 148.35579102 258.1796875 149.41015625 C258.79569824 150.31902588 259.41170898 151.22789551 260.04638672 152.16430664 C260.6910791 153.10008545 261.33577148 154.03586426 262 155 C262.24651306 155.62022034 262.49302612 156.24044067 262.74700928 156.87945557 C263.90776602 159.30891595 264.76872665 160.45312681 267 162 C271.89371449 162.87906061 276.67530052 162.86292279 281.63591003 162.77248001 C284.18410302 162.72605505 286.72938044 162.72170675 289.2779541 162.72787476 C293.76783499 162.73179985 298.25653033 162.69838083 302.74615479 162.652771 C309.93162476 162.58030953 317.11645595 162.53917039 324.30229187 162.54600143 C326.80953958 162.5391559 329.31499716 162.50089978 331.82189941 162.46060181 C333.3623829 162.45628333 334.90287064 162.45323507 336.44335938 162.45166016 C337.48462227 162.42222572 337.48462227 162.42222572 338.54692078 162.39219666 C342.40804662 162.42303234 343.87987396 162.89898448 346.87887573 165.42088318 C347.57884674 166.27199173 348.27881775 167.12310028 349 168 C349.49322754 168.59868896 349.98645508 169.19737793 350.49462891 169.81420898 C350.90116699 170.36923096 351.30770508 170.92425293 351.7265625 171.49609375 C352.42930298 172.44645508 352.42930298 172.44645508 353.14624023 173.41601562 C353.63423096 174.08310547 354.12222168 174.75019531 354.625 175.4375 C355.69017709 176.87460978 356.7566077 178.3107912 357.82421875 179.74609375 C358.35708496 180.46265137 358.88995117 181.17920898 359.43896484 181.91748047 C366.67815156 191.57501295 374.33545998 200.91305868 381.9609375 210.265625 C385.67181716 214.818937 389.34271053 219.40352744 393 224 C396.65856366 222.83136528 400.09048608 221.50533697 403.5625 219.875 C412.00804386 216.46625639 422.46388264 216.83337582 431 220 C441.94572514 225.06111115 448.48245142 232.80518517 453.28515625 243.71484375 C454 246 454 246 453 248 C452.67 247.67 452.34 247.34 452 247 C451.34 247.66 450.68 248.32 450 249 C449.59910156 248.29875 449.19820312 247.5975 448.78515625 246.875 C443.52745657 238.10024497 437.27383226 229.91018424 427 227 C423.53156004 226.54246716 420.12009772 226.49001401 416.625 226.5 C415.73039062 226.47164062 414.83578125 226.44328125 413.9140625 226.4140625 C405.771896 226.39039341 400.22238984 229.13565348 394.1875 234.5 C390.40422406 238.82374394 387.43704983 242.76034287 385 248 C384.67 248 384.34 248 384 248 C382.98716159 243.1449811 382.25976802 239.49939536 385.0625 235.1875 C385.701875 234.135625 386.34125 233.08375 387 232 C385.97452741 229.1454763 384.31481605 226.98266278 382.3828125 224.671875 C381.60526611 223.73190674 381.60526611 223.73190674 380.81201172 222.77294922 C380.25529785 222.10537598 379.69858398 221.43780273 379.125 220.75 C374.57039493 215.22131064 370.14384203 209.62731038 365.875 203.875 C362.06219589 198.74069127 358.20704724 193.64923212 354.25 188.625 C353.80019775 188.05346191 353.35039551 187.48192383 352.88696289 186.89306641 C350.78957091 184.23711516 348.67367427 181.5997209 346.53515625 178.9765625 C345.80167969 178.07679688 345.06820313 177.17703125 344.3125 176.25 C343.34763672 175.08210938 343.34763672 175.08210938 342.36328125 173.890625 C341 172 341 172 341 170 C340.04057495 170.02442673 339.0811499 170.04885345 338.09265137 170.07402039 C329.03052034 170.29745604 319.96895099 170.46210877 310.90468597 170.56993389 C306.24485594 170.62723626 301.5872568 170.70488155 296.92871094 170.82983398 C292.42865785 170.94977343 287.93074299 171.01520703 283.42921448 171.04364967 C281.71617463 171.06390369 280.00324606 171.10346185 278.29112244 171.16303062 C264.89853551 171.61025848 264.89853551 171.61025848 260.24241638 167.66113281 C258.17862028 164.85822591 256.57890488 162.09654264 255 159 C253.84448465 157.24947366 252.6714778 155.51022056 251.47265625 153.7890625 C250.33390537 152.069052 249.19721362 150.34767661 248.0625 148.625 C243.51441351 141.76207347 238.92665392 134.93803054 234.21875 128.18359375 C230.18940755 122.40205485 226.19993337 116.5930993 222.21875 110.77832031 C221.13829897 109.20179681 220.05381836 107.62803661 218.96875 106.0546875 C218.14890625 104.85199219 218.14890625 104.85199219 217.3125 103.625 C216.85488281 102.95726562 216.39726563 102.28953125 215.92578125 101.6015625 C215 100 215 100 215 98 C213.27716797 97.47212891 213.27716797 97.47212891 211.51953125 96.93359375 C204.05998631 94.44320192 196.89699713 91.18750714 189.6875 88.0625 C188.11905677 87.3858588 186.55045098 86.7095943 184.98168945 86.03369141 C181.81523984 84.66904512 178.64953297 83.30269787 175.484375 81.93505859 C170.35171909 79.71852316 165.21179956 77.51922123 160.07104492 75.3215332 C148.44495444 70.35114673 136.83902637 65.33540933 125.24243164 60.29663086 C117.52123816 56.94477199 109.78793362 53.6221364 102.046875 50.31640625 C101.10276764 49.91296997 100.15866028 49.50953369 99.1859436 49.09387207 C94.49617658 47.0899876 89.80537161 45.08860006 85.11279297 43.09130859 C83.37983819 42.35134148 81.64692608 41.61127441 79.9140625 40.87109375 C79.13190369 40.53928604 78.34974487 40.20747833 77.54388428 39.86561584 C73.19663369 38.005419 68.95785143 36.02041248 64.76620483 33.83045959 C62.78510507 32.83865103 62.78510507 32.83865103 59.625 32.0625 C56.65690417 31.19254088 54.45425629 30.28327188 51.75 28.875 C42.59062695 24.14125674 32.91663614 20.43061809 23.38671875 16.515625 C5.67031757 9.22196047 5.67031757 9.22196047 0 1 C0 0.67 0 0.34 0 0 Z " fill="#E8AB1C" transform="translate(407,365)"/><path d="M0 0 C20.55634396 -1.91472991 20.55634396 -1.91472991 26.11816406 1.17773438 C29.60566303 4.23905017 31.89959968 7.89689241 34 12 C33.67 12.66 33.34 13.32 33 14 C32.24380371 14.00410889 31.48760742 14.00821777 30.70849609 14.01245117 C27.26321716 14.04546205 23.81968877 14.11611697 20.375 14.1875 C19.18519531 14.19330078 17.99539063 14.19910156 16.76953125 14.20507812 C9.64732081 14.18101594 9.64732081 14.18101594 3.4765625 17.23828125 C2.65929687 18.14964844 1.84203125 19.06101562 1 20 C0.21898926 20.77657959 -0.56202148 21.55315918 -1.36669922 22.35327148 C-3.87160684 24.87095213 -6.24155499 27.46310168 -8.609375 30.109375 C-16.81235592 39.15346534 -25.58450423 47.65367011 -34.25 56.25 C-37.63318086 59.60640106 -41.0128972 62.96623728 -44.390625 66.328125 C-45.15119202 67.08039368 -45.91175903 67.83266235 -46.69537354 68.60772705 C-50.79622853 72.68989155 -54.71076871 76.85513543 -58.44831848 81.27372742 C-59.97090123 82.96762711 -61.56034353 84.42249722 -63.30859375 85.87890625 C-69.73664718 91.19851157 -69.73664718 91.19851157 -72.62890625 98.75390625 C-72.54343682 101.32057915 -72.39556302 103.88597981 -72.18359375 106.4453125 C-71.82515804 113.38523799 -74.57188139 118.77292383 -79.125 123.875 C-84.33337934 128.58257363 -90.60798977 131.14714096 -97.625 131.4375 C-106.27656053 130.95094475 -112.08294205 127.16633533 -118 121 C-122.83293869 115.12247802 -123.426575 109.6093079 -123.3359375 102.16796875 C-122.59320537 95.163832 -119.28101955 89.87215469 -114.25 85.0625 C-108.60555201 80.56391739 -102.27111139 78.43523999 -95.046875 78.6953125 C-91.90524519 79.16295969 -89.03122788 80.1965014 -86.078125 81.34375 C-83.7274918 82.20075425 -83.7274918 82.20075425 -80 82 C-77.68240232 80.04485057 -75.61565306 78.10368491 -73.51171875 75.9375 C-72.89029495 75.31278809 -72.26887115 74.68807617 -71.62861633 74.04443359 C-69.6387333 72.03878396 -67.66338555 70.01943057 -65.6875 68 C-64.36870575 66.66971264 -63.04905326 65.34027552 -61.72851562 64.01171875 C-60.4471484 62.71690567 -59.1665263 61.4213547 -57.88671875 60.125 C-57.30105637 59.53195068 -56.71539398 58.93890137 -56.11198425 58.32788086 C-53.18079654 55.33035855 -50.35202691 52.28208955 -47.6159668 49.10498047 C-43.70244089 44.58982556 -39.50400867 40.39575093 -35.2578125 36.1953125 C-34.44883514 35.39012177 -33.63985779 34.58493103 -32.80636597 33.75534058 C-30.24834123 31.20943464 -27.68708093 28.66682351 -25.125 26.125 C-21.72892738 22.75544933 -18.33613271 19.3826477 -14.9453125 16.0078125 C-14.16310333 15.23390167 -13.38089417 14.45999084 -12.57498169 13.66262817 C-11.49783401 12.59043533 -11.49783401 12.59043533 -10.39892578 11.49658203 C-9.7649588 10.86785187 -9.13099182 10.2391217 -8.47781372 9.59133911 C-6.90826697 8.05065447 -6.90826697 8.05065447 -6 6 C-5.34 6 -4.68 6 -4 6 C-3.34 4.68 -2.68 3.36 -2 2 C-1.34 2 -0.68 2 0 2 C0 1.34 0 0.68 0 0 Z M-108 98 C-110.51638311 102.15750253 -110.08028379 105.34646981 -109 110 C-107.44712656 113.79591286 -106.29955049 114.83044312 -102.6875 116.875 C-98.71033436 118.08837257 -96.92527306 118.25274672 -93 117 C-87.72648257 114.08686652 -87.72648257 114.08686652 -85 109 C-84.51709004 103.78457241 -85.10415121 100.39370161 -88 96 C-91.60323567 92.82067441 -95.12677562 92.41912465 -99.78125 92.58203125 C-103.69034768 93.31842817 -105.33178385 95.07147008 -108 98 Z " fill="#C58A0E" transform="translate(727,676)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.03132374 17.60415768 1.05132095 35.20831817 1.0625 52.8125 C1.0629343 53.47637978 1.06336861 54.14025955 1.06381607 54.8242569 C1.09142014 98.21867627 0.90801144 141.60743245 0.5 185 C0.48804218 186.2724268 0.47608437 187.54485359 0.46376419 188.85583878 C0.31838866 204.23732255 0.16410233 219.61870487 0 235 C-5.03427433 233.48712271 -7.41550458 231.86807892 -11 228 C-12.81170789 226.43297679 -14.64538172 224.89099415 -16.5 223.375 C-17.4178125 222.61960937 -18.335625 221.86421875 -19.28125 221.0859375 C-21.84342927 218.92552475 -21.84342927 218.92552475 -24.62353516 217.94998169 C-27 216 -27 216 -27.48199463 214.17550278 C-27.69809871 211.67778873 -27.74412159 209.22157111 -27.7421875 206.71435547 C-27.76978653 205.28697807 -27.76978653 205.28697807 -27.79794312 203.83076477 C-27.85065289 200.67593737 -27.86518266 197.52242241 -27.875 194.3671875 C-27.89360476 192.17342622 -27.91281893 189.97967003 -27.93261719 187.78591919 C-27.96710893 183.1807333 -27.98032901 178.57601153 -27.98144531 173.97070312 C-27.98651542 168.08157544 -28.06501186 162.19596193 -28.1625061 156.30773735 C-28.22576945 151.77271094 -28.23892502 147.23852471 -28.23834229 142.7030983 C-28.24606949 140.53334914 -28.27170053 138.36358465 -28.31585693 136.19427109 C-28.64787323 118.32155479 -28.64787323 118.32155479 -24.58421326 113.7102356 C-21.82012366 111.42613145 -19.14890297 109.6959907 -16 108 C-14.86175251 107.11722141 -13.74249139 106.20831555 -12.66015625 105.2578125 C-11.80292969 104.55398438 -10.94570313 103.85015625 -10.0625 103.125 C-8.74958984 102.04605469 -8.74958984 102.04605469 -7.41015625 100.9453125 C-5 99 -5 99 -2.88348389 97.95048523 C0.20406248 94.7531053 -0.42984098 91.12421689 -0.45410156 86.84692383 C-0.44376389 85.91014297 -0.43342621 84.97336212 -0.42277527 84.00819397 C-0.39324566 80.90763304 -0.39184594 77.80772201 -0.390625 74.70703125 C-0.37565023 72.55896247 -0.35892458 70.41090524 -0.34051514 68.26286316 C-0.29675058 62.60592127 -0.2768223 56.9491347 -0.26177979 51.29205322 C-0.24224154 45.52078023 -0.20026788 39.74967581 -0.16015625 33.97851562 C-0.08475546 22.65239563 -0.03452374 11.32631317 0 0 Z " fill="#AC6F01" transform="translate(972,220)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C2.83819158 1.62249941 3.6704116 3.24808497 4.5 4.875 C4.9640625 5.77992188 5.428125 6.68484375 5.90625 7.6171875 C7 10 7 10 7 12 C7.99 12.33 8.98 12.66 10 13 C10.73578693 14.97561688 11.39031621 16.98189938 12 19 C13.0059248 21.14215073 14.04794389 23.2677163 15.125 25.375 C15.93324219 26.96441406 15.93324219 26.96441406 16.7578125 28.5859375 C17.16773438 29.38257813 17.57765625 30.17921875 18 31 C18.66 31 19.32 31 20 31 C20.09152344 31.67417969 20.18304688 32.34835938 20.27734375 33.04296875 C21.18352775 36.75097572 22.81283099 39.94828493 24.5625 43.3125 C24.89185547 43.95767578 25.22121094 44.60285156 25.56054688 45.26757812 C26.36824255 46.84785228 27.18337613 48.42432105 28 50 C28.66 50 29.32 50 30 50 C30.3403125 51.6396875 30.3403125 51.6396875 30.6875 53.3125 C32.22793028 57.64037555 33.0274121 58.01370605 37 60 C38.91988481 60.69645477 40.85923972 61.34102602 42.8125 61.9375 C46.37240993 63.07788527 49.70311885 64.23751637 53 66 C56.24159369 67.72884997 59.50089131 68.88028522 63 70 C67.24865276 71.36297632 71.09717607 72.93010516 75.03515625 75.0078125 C78.89878112 76.95882784 82.97147361 78.42762766 87 80 C89.50076206 80.99814667 92.00076862 81.99804029 94.5 83 C95.6859375 83.474375 96.871875 83.94875 98.09375 84.4375 C98.71934814 84.68798096 99.34494629 84.93846191 99.98950195 85.1965332 C101.37799619 85.75142507 102.76720281 86.30453653 104.15698242 86.85620117 C111.18430499 89.65182965 118.17402987 92.53686614 125.16369629 95.42489624 C137.25674945 100.42015914 149.36534084 105.37477659 161.49645996 110.27685547 C176.21240197 116.22349581 190.89651909 122.24368582 205.5625 128.3125 C220.98834236 134.69534551 236.42272689 141.05637785 251.875 147.375 C253.25150726 147.93790237 253.25150726 147.93790237 254.65582275 148.51217651 C267.05720452 153.58222187 279.46781018 158.62923095 291.88348389 163.66415405 C305.95214981 169.37116169 319.98064313 175.1729512 334 181 C335.17353027 181.48726562 336.34706055 181.97453125 337.55615234 182.4765625 C340.933709 183.87915091 344.31074452 185.28298396 347.6875 186.6875 C348.70392578 187.10990967 349.72035156 187.53231934 350.76757812 187.9675293 C351.69376953 188.35336182 352.61996094 188.73919434 353.57421875 189.13671875 C354.38463623 189.47405029 355.19505371 189.81138184 356.0300293 190.15893555 C357.37157375 190.73169805 358.69530129 191.34765064 360 192 C360 226.98 360 261.96 360 298 C360.66 298 361.32 298 362 298 C363.54560026 300.11519398 364.96953106 302.23109431 366.375 304.4375 C367.27920972 305.82554998 368.18554324 307.21221826 369.09375 308.59765625 C369.56941406 309.32355957 370.04507812 310.04946289 370.53515625 310.79736328 C372.912622 314.37227929 375.38932779 317.8748092 377.875 321.375 C378.37330322 322.07753906 378.87160645 322.78007812 379.38500977 323.50390625 C380.40471372 324.94033891 381.42498076 326.37637199 382.44580078 327.81201172 C385.07604643 331.5148489 387.69379729 335.2264953 390.3125 338.9375 C390.77962402 339.59862793 391.24674805 340.25975586 391.72802734 340.94091797 C392.18516113 341.58818848 392.64229492 342.23545898 393.11328125 342.90234375 C393.57145107 343.5117792 394.0296209 344.12121466 394.50167465 344.74911785 C396 347 396 347 397.016819 349.55289173 C398.62277472 352.95220361 399.97915392 354.71654231 403 357 C410.25025081 358.96703496 418.22126263 358.16091434 425.65136719 357.98901367 C427.99902464 357.97149417 430.34672049 357.9585997 432.69442749 357.94998169 C437.74731089 357.92264887 442.79860625 357.86482865 447.850914 357.78401756 C455.16734169 357.66922873 462.48317135 357.61977282 469.80034366 357.59226433 C481.68817667 357.54708336 493.57549062 357.46829583 505.46289062 357.35766602 C506.17379424 357.35106696 506.88469786 357.3444679 507.61714402 357.33766887 C515.54413772 357.26334122 523.47101348 357.18087521 531.39782715 357.08935547 C534.27042537 357.05630297 537.14302442 357.02332548 540.015625 356.99047852 C540.72444544 356.98235723 541.43326588 356.97423594 542.16356573 356.96586856 C554.00288224 356.83183998 565.84177864 356.75636023 577.68180966 356.72634298 C585.62449847 356.70348466 593.56298429 356.6086274 601.50437117 356.4629606 C606.45234646 356.38768745 611.39903844 356.37518837 616.34752274 356.37991714 C618.63623883 356.3694684 620.92500913 356.33331875 623.21284866 356.26912498 C640.02252918 355.81714628 640.02252918 355.81714628 644.96585941 359.44121766 C648.35403251 362.90022529 650.72772866 366.78688979 652.94510698 371.06540835 C654.64814808 374.18865311 656.75867685 376.9565067 658.875 379.8125 C659.69052126 380.95803651 660.50573043 382.10379545 661.3203125 383.25 C663.30188894 386.0305264 665.29980457 388.79873261 667.3046875 391.5625 C667.87590332 392.35035889 668.44711914 393.13821777 669.03564453 393.94995117 C670.14197419 395.4745812 671.2496257 396.99825333 672.35888672 398.52075195 C675.0885226 402.28434082 677.77172223 406.07634847 680.390625 409.91796875 C681.14134277 411.01854614 681.14134277 411.01854614 681.90722656 412.14135742 C683 414 683 414 683 416 C683.66 416 684.32 416 685 416 C686.33203125 418.515625 686.33203125 418.515625 687 422 C685.6941963 424.93864512 683.72048149 427.27740698 681.6875 429.75 C681.13513672 430.45302246 680.58277344 431.15604492 680.01367188 431.88037109 C676.14922629 436.74666862 672.08141068 441.39679906 667.83984375 445.9375 C666.20951314 447.76513177 664.86768542 449.55965165 663.5625 451.625 C662.7890625 452.800625 662.7890625 452.800625 662 454 C661.34 454 660.68 454 660 454 C658.12516257 451.70378217 656.36487545 449.3959076 654.625 447 C653.53393495 445.52207578 652.44278684 444.04421286 651.3515625 442.56640625 C650.5147998 441.42582764 650.5147998 441.42582764 649.66113281 440.26220703 C647.12456712 436.80779526 644.56644687 433.36975151 642 429.9375 C641.50870605 429.27983643 641.01741211 428.62217285 640.51123047 427.94458008 C636.57276608 422.70036624 632.5097928 417.56407935 628.359375 412.48608398 C627.905625 411.92735596 627.451875 411.36862793 626.984375 410.79296875 C626.5187616 410.24915054 626.05314819 409.70533234 625.57342529 409.14503479 C624 407 624 407 622.80889893 404.2611084 C620.92918362 400.54776401 619.34503848 398.52373941 616 396 C608.24895425 393.88669889 599.75873491 394.7256165 591.8125 394.92578125 C589.42500395 394.94631112 587.0374614 394.96196283 584.64990234 394.97294617 C578.381804 395.01484112 572.11653337 395.12279835 565.84954834 395.24468994 C559.44826511 395.35744899 553.04652248 395.40750512 546.64453125 395.46289062 C534.09515138 395.58067599 521.54772643 395.76615271 509 396 C509.75925781 396.96421875 510.51851562 397.9284375 511.30078125 398.921875 C512.30471115 400.19789806 513.30861609 401.47394076 514.3125 402.75 C515.06176758 403.70132813 515.06176758 403.70132813 515.82617188 404.671875 C516.31279297 405.290625 516.79941406 405.909375 517.30078125 406.546875 C517.77278678 407.14487947 518.24479231 407.74288393 518.73110104 408.35900974 C519.75773414 409.68669222 520.73541512 411.05213383 521.69691467 412.42771912 C522.93718396 414.27584319 522.93718396 414.27584319 525.53686523 414.40649414 C527.03262085 414.34643188 527.03262085 414.34643188 528.55859375 414.28515625 C530.22245117 414.24551758 530.22245117 414.24551758 531.91992188 414.20507812 C533.08072266 414.15802734 534.24152344 414.11097656 535.4375 414.0625 C551.94518026 413.42940637 567.81407036 416.95930317 580.62890625 427.95703125 C591.91086147 438.40721123 600.42857406 451.64562014 603 467 C603.03824623 469.33301986 603.04574284 471.66711508 603 474 C602.67 474 602.34 474 602 474 C601.8040625 473.030625 601.608125 472.06125 601.40625 471.0625 C597.30389879 452.13590581 589.14237849 436.28882045 572.5625 425.5 C562.07973889 419.49737132 551.61967124 416.81097151 539.625 416.875 C538.54992187 416.86919922 538.54992187 416.86919922 537.453125 416.86328125 C533.74015965 416.86998335 530.42713717 417.11142378 526.79296875 417.88671875 C523 418 523 418 520.19921875 415.52734375 C519.33375925 414.35097797 518.49785557 413.15248166 517.6875 411.9375 C516.75884377 410.64899569 515.82912274 409.36125827 514.8984375 408.07421875 C514.42760742 407.40438965 513.95677734 406.73456055 513.47167969 406.04443359 C510.59714624 402.05117827 507.44606558 398.26921926 504.35229492 394.44506836 C501 390.22077146 501 390.22077146 501 388 C516.04654935 387.62509305 531.09273536 387.34354584 546.14297104 387.17100525 C553.13255298 387.08873262 560.11922253 386.97673969 567.10693359 386.79296875 C573.85695939 386.61553442 580.60396646 386.52333474 587.35617828 386.48196411 C589.92570739 386.45250407 592.4950796 386.39496632 595.06331635 386.30831909 C614.66302534 385.67364608 614.66302534 385.67364608 620.23534012 389.55835533 C623.97622981 393.25499092 626.57505344 397.42739237 628.96862221 402.08175182 C630.42033374 404.78177408 632.25988566 407.10704553 634.1796875 409.48828125 C634.79183105 410.28790283 635.40397461 411.08752441 636.03466797 411.91137695 C636.64197754 412.70374756 637.24928711 413.49611816 637.875 414.3125 C641.99370456 419.68944728 646.08042787 425.08329222 650.0625 430.5625 C650.70461426 431.44510498 651.34672852 432.32770996 652.00830078 433.23706055 C653.23129179 434.92439146 654.44863938 436.61583055 655.65966797 438.31176758 C656.20252441 439.06095459 656.74538086 439.8101416 657.3046875 440.58203125 C658.0160083 441.57553589 658.0160083 441.57553589 658.74169922 442.58911133 C659.15693848 443.05470459 659.57217773 443.52029785 660 444 C660.66 444 661.32 444 662 444 C665.04428318 440.75081314 667.78648557 437.24590858 670.56835938 433.77148438 C672.00816714 431.98989414 673.47808193 430.23684339 674.953125 428.484375 C675.88656948 427.34469322 676.81889513 426.204094 677.75 425.0625 C678.20439453 424.53180908 678.65878906 424.00111816 679.12695312 423.4543457 C680.54498823 421.7618123 680.54498823 421.7618123 682 419 C681.17886829 414.3987034 677.84489916 410.59628839 675.1875 406.8125 C674.46324829 405.77017212 674.46324829 405.77017212 673.72436523 404.70678711 C668.99784437 397.93359139 664.14803685 391.2494683 659.30078125 384.5625 C655.93078761 379.90979939 652.57995293 375.24394221 649.25 370.5625 C648.73638916 369.84650635 648.22277832 369.1305127 647.69360352 368.39282227 C646.98675415 367.39593384 646.98675415 367.39593384 646.265625 366.37890625 C645.85086914 365.7969751 645.43611328 365.21504395 645.00878906 364.61547852 C644 363 644 363 643 360 C641.76809024 360.01474869 640.53618048 360.02949738 639.26694012 360.04469299 C609.99691677 360.39152566 580.7273616 360.6551975 551.45579148 360.81704527 C547.84983721 360.8370556 544.24388727 360.85776485 540.63793945 360.87890625 C539.56116034 360.8852017 539.56116034 360.8852017 538.4626281 360.89162433 C526.85226892 360.96117023 515.24318253 361.08727703 503.63357743 361.23444474 C491.71310299 361.3842882 479.79329315 361.47298492 467.87191564 361.50541592 C461.17837337 361.52536655 454.487891 361.57516349 447.79524803 361.69168091 C441.49140645 361.80053712 435.19162458 361.83374128 428.88693237 361.8097229 C426.57730828 361.81411424 424.26754443 361.84581027 421.95873451 361.9072876 C404.95559367 362.33771373 404.95559367 362.33771373 400.0028975 358.42040062 C396.5577644 354.64124968 394.14864215 350.4474 391.93451178 345.86161613 C390.71585706 343.43396639 389.18885876 341.31982373 387.5390625 339.16796875 C386.8121521 338.17289307 386.8121521 338.17289307 386.07055664 337.15771484 C385.59352295 336.50754395 385.11648926 335.85737305 384.625 335.1875 C379.43811268 328.06682543 374.41763351 320.84524044 369.48876953 313.54370117 C368.98845215 312.80482666 368.48813477 312.06595215 367.97265625 311.3046875 C367.32695679 310.3453833 367.32695679 310.3453833 366.66821289 309.36669922 C365.11474453 307.06379 365.11474453 307.06379 363.55176258 305.3896656 C358.80327171 299.84168071 358.13517425 295.61824525 358.22705078 288.453125 C358.21642105 287.42783188 358.20579132 286.40253876 358.19483948 285.34617615 C358.16688783 281.98027832 358.18082249 278.6159598 358.1953125 275.25 C358.18405747 272.90729407 358.1701747 270.56459941 358.15377808 268.22192383 C358.11777536 262.07336786 358.11736228 255.92530952 358.12445068 249.77667236 C358.12536427 243.49555589 358.09249527 237.21462521 358.0625 230.93359375 C358.00867063 218.6223437 357.99245206 206.31135475 358 194 C326.5562933 180.7852178 326.5562933 180.7852178 295.01391602 167.80859375 C290.50845284 165.97787074 286.00613174 164.13944938 281.50390625 162.30078125 C280.16230942 161.75292465 280.16230942 161.75292465 278.79360962 161.19400024 C270.17807708 157.67147526 261.58697574 154.09145581 253 150.5 C235.1032476 143.01675357 217.14829163 135.67812257 199.18904114 128.34638977 C190.61577813 124.84543775 182.04973827 121.32700272 173.48413086 117.80737305 C155.6313839 110.47297 137.75255627 103.20434319 119.86035156 95.96679688 C114.70541237 93.88129298 109.55192766 91.79220639 104.3984375 89.703125 C87.14270963 82.70968825 69.88401436 75.72495497 52.58422852 68.84106445 C50.41754637 67.97773107 48.25537816 67.10295362 46.09863281 66.21508789 C43.00522818 64.95794976 43.00522818 64.95794976 39.76855469 64.00170898 C33.65280884 61.95917874 30.4455266 60.04712899 27.1875 54.37890625 C26.08754161 52.12466643 25.02648177 49.85113295 24 47.5625 C23.42230434 46.35147705 22.84028436 45.14250828 22.25415039 43.93554688 C21.3610644 42.0939328 20.47143511 40.25132396 19.59645081 38.40103149 C16.78693685 32.46129385 13.64552445 26.73127455 10.4375 21 C6.59923143 14.13954939 3.16246999 7.19917432 0 0 Z " fill="#FAC02D" transform="translate(285,140)"/><path d="M0 0 C14.00898973 5.26266536 27.91121564 10.74336562 41.75 16.4375 C43.65480731 17.21897576 45.55967518 18.00030392 47.46459961 18.78149414 C62.24169354 24.84620234 76.99646168 30.9646344 91.74804688 37.09106445 C105.47348926 42.79015605 119.22575208 48.41975886 133 54 C135.19341177 54.88915504 137.38676707 55.77844932 139.5801239 56.66773987 C145.16548068 58.93228616 150.75098132 61.19647738 156.33666992 63.46020508 C181.82150219 73.7890438 207.27782078 84.18761475 232.72399902 94.61128235 C238.08076999 96.80544507 243.43876231 98.99658043 248.79798889 101.18473816 C251.97733021 102.4835867 255.1555549 103.78514942 258.33346558 105.0874939 C259.80819309 105.69120725 261.28338611 106.29378485 262.75906372 106.89517212 C264.77943614 107.71874697 266.79810961 108.54635382 268.81640625 109.375 C270.50938843 110.06722656 270.50938843 110.06722656 272.23657227 110.7734375 C275 112 275 112 278 114 C276.4375 116.0625 276.4375 116.0625 274 118 C268.11145149 117.71675336 263.28342638 115.67138452 257.9375 113.3125 C257.18017578 112.98572266 256.42285156 112.65894531 255.64257812 112.32226562 C254.0172333 111.62032067 252.39328123 110.91514471 250.77050781 110.20727539 C240.69226766 105.81558544 230.56628048 101.55970873 220.375 97.4375 C219.03617958 96.8947794 217.69739528 96.35196966 216.35864258 95.80908203 C201.65772372 89.85078478 186.94568917 83.91989154 172.23657227 77.98187256 C149.62523257 68.85340321 127.03829017 59.67032856 104.49627686 50.37191772 C92.68046111 45.49932744 80.84570852 40.67443937 69 35.875 C68.21554504 35.55712524 67.43109009 35.23925049 66.62286377 34.91174316 C56.69769485 30.88973561 56.69769485 30.88973561 46.75390625 26.9140625 C40.77901625 24.52890967 34.86016328 22.01140084 28.9375 19.5 C27.81794922 19.02691406 26.69839844 18.55382812 25.54492188 18.06640625 C19.33591229 15.4371365 13.14836494 12.76830107 7 10 C7.33 11.98 7.66 13.96 8 16 C5.86555934 13.25214237 4.02037559 10.46859452 2.3125 7.4375 C1.65701172 6.29087891 1.65701172 6.29087891 0.98828125 5.12109375 C0 3 0 3 0 0 Z " fill="#FBDF65" transform="translate(340,239)"/><path d="M0 0 C0 3.99897642 -1.35316035 5.06701552 -4 8 C-5.1446875 8.8971875 -5.1446875 8.8971875 -6.3125 9.8125 C-8.51158363 11.60245179 -10.07217783 13.17308955 -11.875 15.3125 C-16.13005694 20.30960881 -20.81124395 24.86446041 -25.49365234 29.45629883 C-29.07414163 32.98902971 -32.46389461 36.59312329 -35.68041992 40.46166992 C-37.65800188 42.76708045 -39.85322209 44.85322209 -42 47 C-42.66 47.99 -43.32 48.98 -44 50 C-44.66 50 -45.32 50 -46 50 C-46 50.66 -46 51.32 -46 52 C-46.66 52 -47.32 52 -48 52 C-48.28875 52.639375 -48.5775 53.27875 -48.875 53.9375 C-50 56 -50 56 -52 57 C-51.38531118 60.99547736 -49.34540624 63.77506642 -47 67 C-46.67 67 -46.34 67 -46 67 C-43.65400658 75.79747532 -44.51411738 84.07982148 -49 92 C-53.33579112 98.01490386 -58.87626861 101.16443731 -66 103 C-73.07838099 104.0312873 -79.33430748 102.65377374 -85.13671875 98.453125 C-91.25426487 93.34197741 -95.43924339 88.46337151 -96.2734375 80.3359375 C-96.56996078 71.69114353 -94.9311779 65.52940062 -89.203125 58.9296875 C-83.70077462 53.66944053 -77.61228137 51.00259332 -70 50.625 C-66.0941319 50.76561125 -62.70015306 51.93663119 -59.078125 53.34375 C-56.7274918 54.20075425 -56.7274918 54.20075425 -53 54 C-50.68240232 52.04485057 -48.61565306 50.10368491 -46.51171875 47.9375 C-45.89029495 47.31278809 -45.26887115 46.68807617 -44.62861633 46.04443359 C-42.6387333 44.03878396 -40.66338555 42.01943057 -38.6875 40 C-37.36870575 38.66971264 -36.04905326 37.34027552 -34.72851562 36.01171875 C-29.18777588 30.41788012 -23.71029848 24.81807586 -18.60424805 18.8203125 C-15.27292115 15.04031351 -11.6435809 11.54118882 -8.0625 8 C-6.89364258 6.83791016 -6.89364258 6.83791016 -5.70117188 5.65234375 C-3.8030758 3.76589243 -1.90266851 1.88183755 0 0 Z M-81 70 C-83.51638311 74.15750253 -83.08028379 77.34646981 -82 82 C-80.44712656 85.79591286 -79.29955049 86.83044312 -75.6875 88.875 C-71.71033436 90.08837257 -69.92527306 90.25274672 -66 89 C-60.72648257 86.08686652 -60.72648257 86.08686652 -58 81 C-57.51709004 75.78457241 -58.10415121 72.39370161 -61 68 C-64.60323567 64.82067441 -68.12677562 64.41912465 -72.78125 64.58203125 C-76.69034768 65.31842817 -78.33178385 67.07147008 -81 70 Z " fill="#EDB221" transform="translate(700,704)"/><path d="M0 0 C10.0838365 0.01487408 20.16717591 0.05646384 30.25075054 0.13209057 C34.93310123 0.1663702 39.61512531 0.19147204 44.29760742 0.19555664 C48.81719964 0.19983754 53.33605498 0.22828248 57.85541725 0.27343178 C59.57892374 0.28641353 61.30251838 0.29071204 63.02606773 0.28615379 C65.44225837 0.28125231 67.85629153 0.30731608 70.2722168 0.34057617 C70.98359802 0.33195053 71.69497925 0.32332489 72.42791748 0.31443787 C76.31511097 0.40404493 77.87075478 0.89140783 80.88957214 3.42782593 C81.58601334 4.27664337 82.28245453 5.12546082 83 6 C83.49322754 6.59868896 83.98645508 7.19737793 84.49462891 7.81420898 C84.90116699 8.36923096 85.30770508 8.92425293 85.7265625 9.49609375 C86.42930298 10.44645508 86.42930298 10.44645508 87.14624023 11.41601562 C87.87822632 12.41665039 87.87822632 12.41665039 88.625 13.4375 C89.69017709 14.87460978 90.7566077 16.3107912 91.82421875 17.74609375 C92.35708496 18.46265137 92.88995117 19.17920898 93.43896484 19.91748047 C100.67815156 29.57501295 108.33545998 38.91305868 115.9609375 48.265625 C119.67181716 52.818937 123.34271053 57.40352744 127 62 C130.65856366 60.83136528 134.09048608 59.50533697 137.5625 57.875 C146.00804386 54.46625639 156.46388264 54.83337582 165 58 C175.94572514 63.06111115 182.48245142 70.80518517 187.28515625 81.71484375 C188 84 188 84 187 86 C186.67 85.67 186.34 85.34 186 85 C185.34 85.66 184.68 86.32 184 87 C183.59910156 86.29875 183.19820312 85.5975 182.78515625 84.875 C177.52745657 76.10024497 171.27383226 67.91018424 161 65 C157.53156004 64.54246716 154.12009772 64.49001401 150.625 64.5 C149.73039063 64.47164062 148.83578125 64.44328125 147.9140625 64.4140625 C139.771896 64.39039341 134.22238984 67.13565348 128.1875 72.5 C124.40422406 76.82374394 121.43704983 80.76034287 119 86 C118.67 86 118.34 86 118 86 C116.98716159 81.1449811 116.25976802 77.49939536 119.0625 73.1875 C119.701875 72.135625 120.34125 71.08375 121 70 C119.97452741 67.1454763 118.31481605 64.98266278 116.3828125 62.671875 C115.86444824 62.04522949 115.34608398 61.41858398 114.81201172 60.77294922 C113.97694092 59.77158936 113.97694092 59.77158936 113.125 58.75 C108.57039493 53.22131064 104.14384203 47.62731038 99.875 41.875 C96.06219589 36.74069127 92.20704724 31.64923212 88.25 26.625 C87.57529663 25.76769287 87.57529663 25.76769287 86.88696289 24.89306641 C84.78957091 22.23711516 82.67367427 19.5997209 80.53515625 16.9765625 C79.43494141 15.62691406 79.43494141 15.62691406 78.3125 14.25 C77.66925781 13.47140625 77.02601563 12.6928125 76.36328125 11.890625 C75 10 75 10 75 8 C49.26 8 23.52 8 -3 8 C-2.34 6.35 -1.68 4.7 -1 3 C-0.67 2.01 -0.34 1.02 0 0 Z " fill="#FADC5E" transform="translate(673,527)"/><path d="M0 0 C5.4930136 2.32396729 9.41485047 6.21838184 13.125 10.75 C26.16696047 25.8707009 45.67713245 33.2083865 65 36 C67.20704058 36.09036032 69.41638983 36.13178223 71.62527561 36.13587189 C72.59047325 36.13968582 72.59047325 36.13968582 73.57516983 36.1435768 C75.72839698 36.15088791 77.88156661 36.15117179 80.0348053 36.15148926 C81.5959617 36.15534104 83.15711708 36.15962884 84.7182712 36.16431475 C89.0074427 36.17594304 93.29660357 36.18143641 97.58578765 36.18594956 C102.21440593 36.19190489 106.84301014 36.20357304 111.47161865 36.21458435 C119.5008666 36.23294136 127.53011487 36.24778645 135.55937386 36.26036072 C147.2173287 36.27870403 158.87526377 36.30337425 170.53320294 36.32973462 C189.51228178 36.37256177 208.49136622 36.41164697 227.47045898 36.44775391 C228.60664869 36.44991671 229.7428384 36.45207951 230.9134581 36.45430785 C236.66411725 36.46523984 242.41477649 36.47612287 248.16543579 36.48697662 C259.59198035 36.50854305 271.01852459 36.53026626 282.44506836 36.55224609 C283.56804217 36.55440496 284.69101599 36.55656383 285.84801931 36.55878812 C304.7094708 36.59516328 323.57091311 36.6351538 342.43235201 36.67754889 C352.99660079 36.7011343 363.56084688 36.72278392 374.12510872 36.73963928 C459.93445731 36.87741425 459.93445731 36.87741425 495 38 C495 38.33 495 38.66 495 39 C487.87899082 39.78749984 480.75502633 40.29431629 473.60546875 40.74609375 C470.66032565 40.95349819 467.74481496 41.22724338 464.8125 41.5625 C456.85673407 42.39785542 448.88044337 42.43280789 441 41 C441 40.34 441 39.68 441 39 C405.69 39 370.38 39 334 39 C339.61 39.33 345.22 39.66 351 40 C351 40.33 351 40.66 351 41 C314.25175824 41.09172266 277.50353384 41.16212334 240.75520061 41.20426132 C236.40849618 41.20926364 232.06179198 41.21444098 227.71508789 41.21972656 C226.41716039 41.22130043 226.41716039 41.22130043 225.09301213 41.22290608 C211.11548268 41.24027173 197.13801959 41.27178805 183.1605294 41.30861118 C168.79911419 41.34612786 154.43773355 41.36825843 140.07627136 41.37635398 C131.22731228 41.38181961 122.37854084 41.3990293 113.52963958 41.43166587 C107.44677824 41.45294648 101.36401272 41.45916971 95.28111693 41.45400551 C91.7809992 41.45146457 88.28120741 41.45512578 84.78114891 41.4768219 C46.50549541 41.67894791 46.50549541 41.67894791 31.375 32.1875 C30.63121094 31.74591553 29.88742188 31.30433105 29.12109375 30.84936523 C17.38224005 23.76401802 5.94393744 14.6984118 0 2 C0 1.34 0 0.68 0 0 Z " fill="#E8B306" transform="translate(57,783)"/><path d="M0 0 C1.90998714 -0.00352835 1.90998714 -0.00352835 3.85855988 -0.00712797 C7.38319278 -0.01348949 10.90780276 -0.0136927 14.4324403 -0.01285056 C18.27080536 -0.01302082 22.1091624 -0.01893544 25.94752342 -0.02409142 C33.55596838 -0.03339687 41.16440753 -0.03733598 48.77285747 -0.03961039 C57.88803631 -0.04257773 67.00320748 -0.05127812 76.11838229 -0.06002467 C98.14552696 -0.08084592 120.17267295 -0.09133434 142.19982517 -0.10015428 C152.62147432 -0.1043632 163.0431229 -0.10958479 173.46477157 -0.11483881 C209.14521168 -0.132725 244.82565196 -0.14772158 280.50609589 -0.155159 C282.74506942 -0.15563375 284.98404296 -0.15610964 287.22301649 -0.15658666 C288.88848499 -0.15694122 288.88848499 -0.15694122 290.58759932 -0.15730295 C296.21286077 -0.15850413 301.83812222 -0.15971959 307.46338367 -0.16094494 C308.57972545 -0.16118509 309.69606722 -0.16142524 310.84623753 -0.16167267 C347.0509331 -0.16956781 383.25559593 -0.19300614 419.4602772 -0.22550088 C457.74653698 -0.25980114 496.0327776 -0.27951019 534.31905299 -0.28280324 C538.52207363 -0.28322077 542.72509426 -0.28370033 546.92811489 -0.28422642 C547.9630014 -0.28434961 548.99788791 -0.2844728 550.06413462 -0.28459973 C566.71395121 -0.28693119 583.36372973 -0.30258779 600.01353275 -0.32306826 C616.74848313 -0.34332696 633.4833878 -0.34880329 650.21834817 -0.33929763 C660.1577911 -0.33408331 670.09708183 -0.33995702 680.03650284 -0.3618323 C686.68064333 -0.37534906 693.32467916 -0.37425566 699.96882071 -0.36143034 C703.75125771 -0.35453969 707.5334039 -0.35384329 711.31581482 -0.37099043 C740.00427893 -0.49313861 740.00427893 -0.49313861 752.09839344 4.13422108 C752.95933808 4.442776 753.82028271 4.75133091 754.70731658 5.06923598 C756.77042499 5.83278925 758.73756754 6.68899823 760.72339344 7.63422108 C761.77696033 8.13526356 761.77696033 8.13526356 762.85181141 8.64642811 C778.33161722 16.47937135 789.31736545 30.97698901 795.09839344 47.13422108 C795.25854969 50.02093983 795.25854969 50.02093983 795.09839344 52.13422108 C793.20228702 49.29006145 792.13409083 46.80701978 790.91089344 43.63422108 C784.14869515 27.23440293 772.87424486 15.37069615 756.43042469 8.52093983 C745.25631122 4.39005164 735.03269462 2.83546979 723.15272808 2.87695217 C721.8746378 2.8734461 720.59654751 2.86994002 719.27972722 2.8663277 C715.74169539 2.85691165 712.20376709 2.85985666 708.66573032 2.86488325 C704.81284927 2.86815929 700.95998992 2.85985952 697.10711586 2.85306489 C690.35739854 2.84277 683.6077099 2.83992022 676.8579855 2.84197712 C666.82057492 2.84502843 656.78319605 2.83670023 646.74579163 2.82622787 C627.77485466 2.8068878 608.80392849 2.80125964 589.83298282 2.80011375 C575.18184875 2.79919458 560.53071892 2.79507743 545.87958622 2.7887125 C541.66186369 2.7869174 537.44414115 2.78513778 533.22641861 2.78336275 C532.17787023 2.78292065 531.12932185 2.78247855 530.04899928 2.78202306 C500.55568288 2.76971488 471.06236796 2.76182191 441.56904888 2.76270962 C440.45711876 2.76274078 439.34518864 2.76277193 438.19956367 2.76280403 C432.56387773 2.76297025 426.92819179 2.76316833 421.29250585 2.76337345 C420.17324483 2.76341334 419.05398382 2.76345323 417.90080581 2.76349433 C415.63738703 2.7635752 413.37396825 2.7636588 411.11054947 2.76374511 C375.89782209 2.76497054 340.68513324 2.74995888 305.47241688 2.72259998 C265.90791413 2.69187257 226.34343668 2.67466789 186.77892125 2.67652643 C182.55931258 2.67667569 178.33970392 2.6767731 174.12009525 2.67683506 C173.08112671 2.67685837 172.04215817 2.67688168 170.97170574 2.67690569 C154.25886073 2.67696721 137.54604919 2.66420061 120.83321413 2.64697053 C104.0332713 2.63000899 87.23337738 2.6280443 70.43343072 2.64118917 C60.45643093 2.64857486 50.47957983 2.64493175 40.50259582 2.62530449 C33.83213952 2.61329223 27.16179073 2.61590941 20.49133933 2.63024549 C16.69469685 2.63799798 12.89834178 2.63959101 9.10171972 2.62333079 C-14.7643638 2.52789 -36.07511902 4.34303196 -55.90160656 19.13422108 C-56.56160656 18.80422108 -57.22160656 18.47422108 -57.90160656 18.13422108 C-40.24561293 4.46640483 -21.9856129 -0.02781474 0 0 Z " fill="#7B643D" transform="translate(138.90160655975342,48.86577892303467)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.33 15.51 1.66 31.02 2 47 C2.33 31.49 2.66 15.98 3 0 C5.08386084 4.16772168 5.24849914 5.95291382 5.24291992 10.49682617 C5.24599655 11.81466599 5.24907318 13.1325058 5.25224304 14.49028015 C5.24534683 15.92451147 5.23807997 17.35874105 5.23046875 18.79296875 C5.22927638 20.26459208 5.22882391 21.73621618 5.2290802 23.20783997 C5.22751798 26.28696478 5.21924601 29.36597289 5.20581055 32.44506836 C5.18877623 36.399785 5.18499762 40.354374 5.18575573 44.30912304 C5.18548445 47.34504931 5.18001086 50.38094745 5.17275429 53.4168644 C5.16956428 54.87577413 5.16759944 56.33468705 5.16686058 57.79360008 C5.16470309 59.82619747 5.15517478 61.85878306 5.14526367 63.89135742 C5.14145187 65.0495549 5.13764008 66.20775238 5.13371277 67.40104675 C5 70 5 70 4 71 C3.90087161 72.49085365 3.86920253 73.98632452 3.8671875 75.48046875 C3.86525391 76.8562207 3.86525391 76.8562207 3.86328125 78.25976562 C3.86714844 79.22591797 3.87101562 80.19207031 3.875 81.1875 C3.87113281 82.13431641 3.86726563 83.08113281 3.86328125 84.05664062 C3.86861364 87.87729993 3.9064108 91.4685928 4.5703125 95.23828125 C5 98 5 98 4.53351688 100.98827839 C3.76924912 105.96472594 3.87225117 110.92507475 3.89341736 115.94926453 C3.89396258 117.04426999 3.8945078 118.13927546 3.89506954 119.26746291 C3.89798678 122.93573558 3.90795709 126.60395647 3.91772461 130.2722168 C3.92089297 132.90597688 3.92362025 135.53973357 3.92571449 138.17349434 C3.93091005 143.86460453 3.93929525 149.55570228 3.94970894 155.24680519 C3.97618337 169.93779422 3.9826486 184.62880472 3.99037121 199.31981342 C3.99170713 201.7541589 3.99321742 204.18850423 3.99476683 206.62284958 C4.0170733 242.58866715 3.9335478 278.55392644 3.81640625 314.51953125 C3.81273494 315.65041531 3.81273494 315.65041531 3.80898947 316.80414551 C3.74953007 335.09611245 3.68555705 353.38806179 3.61941735 371.68000565 C3.57435531 384.16979335 3.53393404 396.65959176 3.49534739 409.14940099 C3.45462743 422.31288235 3.41057051 435.47634901 3.36312145 448.63980788 C3.33701853 455.89862353 3.31213929 463.15743757 3.29092598 470.4162693 C3.20569407 499.28916491 3.10838715 528.14491519 2 557 C1.67 557 1.34 557 1 557 C0.14300668 542.72333742 -0.14137289 528.50853137 -0.12025452 514.20831299 C-0.12069164 511.97603396 -0.12156913 509.74375498 -0.12284368 507.51147628 C-0.12506098 501.43401149 -0.1211056 495.3565646 -0.11606562 489.27910209 C-0.11216857 483.38107865 -0.11302827 477.48305707 -0.11374746 471.58503267 C-0.11505527 459.53508217 -0.11174327 447.48513719 -0.10573006 435.43518829 C-0.09979795 423.51703107 -0.09596108 411.59887616 -0.09487724 399.68071747 C-0.0948085 398.93762404 -0.09473976 398.19453061 -0.09466894 397.4289192 C-0.09433057 393.65459426 -0.0940292 389.88026931 -0.09374207 386.10594437 C-0.0916458 359.42398088 -0.08492005 332.74202039 -0.07543945 306.06005859 C-0.06624412 280.15087907 -0.05916586 254.24170036 -0.05493164 228.33251953 C-0.05480011 227.53284203 -0.05466859 226.73316453 -0.05453308 225.90925438 C-0.05321447 217.87802102 -0.05193867 209.84678765 -0.05069422 201.81555428 C-0.04815851 185.45733807 -0.04533726 169.0991219 -0.04234314 152.74090576 C-0.04220585 151.98890401 -0.04206856 151.23690226 -0.04192711 150.46211257 C-0.03273798 100.30807378 -0.01687324 50.15403673 0 0 Z " fill="#FACB19" transform="translate(16,124)"/><path d="M0 0 C6.4712859 0.00262045 12.94257075 0.00016036 19.41385674 -0.00138617 C30.94084443 -0.00348912 42.4678249 -0.00028275 53.99481133 0.00487317 C64.29645884 0.00933948 74.59809506 0.00855608 84.89974236 0.00395441 C97.07545071 -0.00148241 109.25115195 -0.00334521 121.42686135 -0.00043333 C127.79437255 0.0010885 134.16187612 0.00144132 140.52938676 -0.00196981 C164.59308869 -0.01315016 188.64423037 0.06853149 212.70318747 0.57027304 C251.04283163 1.36541683 289.38124218 1.23075942 327.72716481 1.17434004 C338.41680937 1.15904738 349.10645576 1.15166546 359.79610869 1.1450463 C378.86125534 1.13322118 397.92639781 1.11831366 416.99153924 1.09990168 C418.68797691 1.09826649 418.68797691 1.09826649 420.41868605 1.09659828 C433.09045354 1.0842749 445.76221897 1.07069388 458.43398309 1.05528498 C459.58102881 1.05389053 460.72807453 1.05249608 461.90987922 1.05105937 C464.22527148 1.04824026 466.54066374 1.04542061 468.856056 1.0426004 C470.00065805 1.04120709 471.14526009 1.03981377 472.32454705 1.03837824 C474.03929935 1.03628794 474.03929935 1.03628794 475.78869311 1.03415542 C494.85612189 1.01111579 513.92354765 0.99581004 532.99098819 0.98681885 C544.69736767 0.98098741 556.40370433 0.96867732 568.11006691 0.94784606 C576.10042831 0.93413054 584.09077477 0.92764467 592.08114783 0.92683595 C596.68243783 0.92613347 601.28366393 0.92217194 605.88493752 0.90937281 C610.10043386 0.8977073 614.31583108 0.89539484 618.53133973 0.90031499 C620.05003156 0.90046543 621.56872852 0.8972636 623.08740411 0.89023792 C631.81537585 0.85196428 640.15420421 1.35457857 648.72469354 3.1343255 C648.72469354 3.4643255 648.72469354 3.7943255 648.72469354 4.1343255 C648.06970689 4.13401354 647.41472025 4.13370158 646.73988553 4.13338017 C575.42904784 4.09948681 504.11820922 4.06807606 432.80736566 4.04963923 C431.20950788 4.04922505 431.20950788 4.04922505 429.57937014 4.04880252 C406.42879004 4.04281668 383.27820986 4.03727632 360.12762954 4.03219485 C348.77456752 4.02970018 337.42150552 4.02710707 326.06844354 4.02446222 C324.3737956 4.02406995 324.3737956 4.02406995 322.64491235 4.02366974 C286.02689622 4.01514727 249.40888627 4.0001248 212.79087388 3.98173106 C175.1606748 3.96286322 137.53047913 3.950554 99.9002754 3.94649552 C94.58510163 3.94591922 89.26992787 3.94526794 83.95475411 3.94457102 C82.90865312 3.94443617 81.86255213 3.94430133 80.78475111 3.94416239 C63.94637339 3.94179909 47.10800624 3.93252331 30.26963283 3.92066144 C13.34081334 3.9088834 -3.58799569 3.90439044 -20.51681913 3.90732275 C-30.57413277 3.90884372 -40.63140808 3.90478998 -50.68871479 3.89273042 C-57.41050454 3.88522125 -64.13226924 3.88500482 -70.85406073 3.89066188 C-74.68178038 3.89367618 -78.50942762 3.89357323 -82.33713944 3.88455914 C-86.46824198 3.87490485 -90.59918008 3.88086397 -94.73028731 3.88822985 C-95.90799862 3.88297582 -97.08570993 3.87772179 -98.29910946 3.87230855 C-108.81078452 3.91462216 -119.61736638 4.46978937 -129.33780646 8.7593255 C-133.22352389 10.45473311 -136.01701546 11.43123387 -140.27530646 11.1343255 C-137.44531948 9.70321591 -134.59736692 8.327145 -131.71280646 7.0093255 C-130.9483924 6.65612238 -130.18397834 6.30291925 -129.39640021 5.939013 C-127.27530646 5.1343255 -127.27530646 5.1343255 -124.27530646 5.1343255 C-124.27530646 4.4743255 -124.27530646 3.8143255 -124.27530646 3.1343255 C-120.97530646 3.1343255 -117.67530646 3.1343255 -114.27530646 3.1343255 C-113.94530646 2.4743255 -113.61530646 1.8143255 -113.27530646 1.1343255 C-75.5135655 0.39531232 -37.76999677 -0.0202663 0 0 Z " fill="#F4C214" transform="translate(234.27530646324158,45.86567449569702)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C2.83819158 1.62249941 3.6704116 3.24808497 4.5 4.875 C4.9640625 5.77992188 5.428125 6.68484375 5.90625 7.6171875 C7 10 7 10 7 12 C7.99 12.33 8.98 12.66 10 13 C10.73578693 14.97561688 11.39031621 16.98189938 12 19 C13.0059248 21.14215073 14.04794389 23.2677163 15.125 25.375 C15.93324219 26.96441406 15.93324219 26.96441406 16.7578125 28.5859375 C17.16773438 29.38257813 17.57765625 30.17921875 18 31 C18.66 31 19.32 31 20 31 C20.09152344 31.67417969 20.18304688 32.34835938 20.27734375 33.04296875 C21.18352775 36.75097572 22.81283099 39.94828493 24.5625 43.3125 C24.89185547 43.95767578 25.22121094 44.60285156 25.56054688 45.26757812 C26.36824255 46.84785228 27.18337613 48.42432105 28 50 C28.66 50 29.32 50 30 50 C30.3403125 51.6396875 30.3403125 51.6396875 30.6875 53.3125 C32.22793028 57.64037555 33.0274121 58.01370605 37 60 C38.91988481 60.69645477 40.85923972 61.34102602 42.8125 61.9375 C46.37240993 63.07788527 49.70311885 64.23751637 53 66 C56.24159369 67.72884997 59.50089131 68.88028522 63 70 C67.24865276 71.36297632 71.09717607 72.93010516 75.03515625 75.0078125 C78.89878112 76.95882784 82.97147361 78.42762766 87 80 C89.50076206 80.99814667 92.00076862 81.99804029 94.5 83 C95.6859375 83.474375 96.871875 83.94875 98.09375 84.4375 C98.71934814 84.68798096 99.34494629 84.93846191 99.98950195 85.1965332 C101.37799619 85.75142507 102.76720281 86.30453653 104.15698242 86.85620117 C111.18430499 89.65182965 118.17402987 92.53686614 125.16369629 95.42489624 C137.25674945 100.42015914 149.36534084 105.37477659 161.49645996 110.27685547 C176.21240197 116.22349581 190.89651909 122.24368582 205.5625 128.3125 C220.98834236 134.69534551 236.42272689 141.05637785 251.875 147.375 C253.25150726 147.93790237 253.25150726 147.93790237 254.65582275 148.51217651 C267.05720452 153.58222187 279.46781018 158.62923095 291.88348389 163.66415405 C305.95214981 169.37116169 319.98064313 175.1729512 334 181 C335.17353027 181.48726562 336.34706055 181.97453125 337.55615234 182.4765625 C340.933709 183.87915091 344.31074452 185.28298396 347.6875 186.6875 C348.70392578 187.10990967 349.72035156 187.53231934 350.76757812 187.9675293 C351.69376953 188.35336182 352.61996094 188.73919434 353.57421875 189.13671875 C354.38463623 189.47405029 355.19505371 189.81138184 356.0300293 190.15893555 C357.37157375 190.73169805 358.69530129 191.34765064 360 192 C360 226.98 360 261.96 360 298 C360.66 298 361.32 298 362 298 C363.54560026 300.11519398 364.96953106 302.23109431 366.375 304.4375 C367.27920972 305.82554998 368.18554324 307.21221826 369.09375 308.59765625 C369.56941406 309.32355957 370.04507812 310.04946289 370.53515625 310.79736328 C372.912622 314.37227929 375.38932779 317.8748092 377.875 321.375 C378.37330322 322.07753906 378.87160645 322.78007812 379.38500977 323.50390625 C380.40471372 324.94033891 381.42498076 326.37637199 382.44580078 327.81201172 C385.07604643 331.5148489 387.69379729 335.2264953 390.3125 338.9375 C390.77962402 339.59862793 391.24674805 340.25975586 391.72802734 340.94091797 C392.18516113 341.58818848 392.64229492 342.23545898 393.11328125 342.90234375 C393.57145107 343.5117792 394.0296209 344.12121466 394.50167465 344.74911785 C396 347 396 347 397.016819 349.55289173 C398.62277472 352.95220361 399.97915392 354.71654231 403 357 C410.25025081 358.96703496 418.22126263 358.16091434 425.65136719 357.98901367 C427.99902464 357.97149417 430.34672049 357.9585997 432.69442749 357.94998169 C437.74731089 357.92264887 442.79860625 357.86482865 447.850914 357.78401756 C455.16734169 357.66922873 462.48317135 357.61977282 469.80034366 357.59226433 C481.68817667 357.54708336 493.57549062 357.46829583 505.46289062 357.35766602 C506.17379424 357.35106696 506.88469786 357.3444679 507.61714402 357.33766887 C515.54413772 357.26334122 523.47101348 357.18087521 531.39782715 357.08935547 C534.27042537 357.05630297 537.14302442 357.02332548 540.015625 356.99047852 C540.72444544 356.98235723 541.43326588 356.97423594 542.16356573 356.96586856 C554.00288224 356.83183998 565.84177864 356.75636023 577.68180966 356.72634298 C585.62449847 356.70348466 593.56298429 356.6086274 601.50437117 356.4629606 C606.45234646 356.38768745 611.39903844 356.37518837 616.34752274 356.37991714 C618.63623883 356.3694684 620.92500913 356.33331875 623.21284866 356.26912498 C640.02252918 355.81714628 640.02252918 355.81714628 644.96585941 359.44121766 C648.35403251 362.90022529 650.72772866 366.78688979 652.94510698 371.06540835 C654.64814808 374.18865311 656.75867685 376.9565067 658.875 379.8125 C659.69052126 380.95803651 660.50573043 382.10379545 661.3203125 383.25 C663.30188894 386.0305264 665.29980457 388.79873261 667.3046875 391.5625 C667.87590332 392.35035889 668.44711914 393.13821777 669.03564453 393.94995117 C670.14197419 395.4745812 671.2496257 396.99825333 672.35888672 398.52075195 C675.0885226 402.28434082 677.77172223 406.07634847 680.390625 409.91796875 C681.14134277 411.01854614 681.14134277 411.01854614 681.90722656 412.14135742 C683 414 683 414 683 416 C683.66 416 684.32 416 685 416 C684.67 416.66 684.34 417.32 684 418 C680.36801306 414.66159168 677.78274172 410.9471616 675.0625 406.875 C670.99118569 400.86529425 666.82929776 394.93502001 662.5625 389.0625 C658.10268551 382.9116084 653.65382584 376.75365543 649.25 370.5625 C648.73638916 369.84650635 648.22277832 369.1305127 647.69360352 368.39282227 C646.98675415 367.39593384 646.98675415 367.39593384 646.265625 366.37890625 C645.85086914 365.7969751 645.43611328 365.21504395 645.00878906 364.61547852 C644 363 644 363 643 360 C641.76809024 360.01474869 640.53618048 360.02949738 639.26694012 360.04469299 C609.99691677 360.39152566 580.7273616 360.6551975 551.45579148 360.81704527 C547.84983721 360.8370556 544.24388727 360.85776485 540.63793945 360.87890625 C539.56116034 360.8852017 539.56116034 360.8852017 538.4626281 360.89162433 C526.85226892 360.96117023 515.24318253 361.08727703 503.63357743 361.23444474 C491.71310299 361.3842882 479.79329315 361.47298492 467.87191564 361.50541592 C461.17837337 361.52536655 454.487891 361.57516349 447.79524803 361.69168091 C441.49140645 361.80053712 435.19162458 361.83374128 428.88693237 361.8097229 C426.57730828 361.81411424 424.26754443 361.84581027 421.95873451 361.9072876 C404.95559367 362.33771373 404.95559367 362.33771373 400.0028975 358.42040062 C396.5577644 354.64124968 394.14864215 350.4474 391.93451178 345.86161613 C390.71585706 343.43396639 389.18885876 341.31982373 387.5390625 339.16796875 C386.8121521 338.17289307 386.8121521 338.17289307 386.07055664 337.15771484 C385.59352295 336.50754395 385.11648926 335.85737305 384.625 335.1875 C379.43811268 328.06682543 374.41763351 320.84524044 369.48876953 313.54370117 C368.98845215 312.80482666 368.48813477 312.06595215 367.97265625 311.3046875 C367.32695679 310.3453833 367.32695679 310.3453833 366.66821289 309.36669922 C365.11474453 307.06379 365.11474453 307.06379 363.55176258 305.3896656 C358.80327171 299.84168071 358.13517425 295.61824525 358.22705078 288.453125 C358.21642105 287.42783188 358.20579132 286.40253876 358.19483948 285.34617615 C358.16688783 281.98027832 358.18082249 278.6159598 358.1953125 275.25 C358.18405747 272.90729407 358.1701747 270.56459941 358.15377808 268.22192383 C358.11777536 262.07336786 358.11736228 255.92530952 358.12445068 249.77667236 C358.12536427 243.49555589 358.09249527 237.21462521 358.0625 230.93359375 C358.00867063 218.6223437 357.99245206 206.31135475 358 194 C326.5562933 180.7852178 326.5562933 180.7852178 295.01391602 167.80859375 C290.50845284 165.97787074 286.00613174 164.13944938 281.50390625 162.30078125 C280.16230942 161.75292465 280.16230942 161.75292465 278.79360962 161.19400024 C270.17807708 157.67147526 261.58697574 154.09145581 253 150.5 C235.1032476 143.01675357 217.14829163 135.67812257 199.18904114 128.34638977 C190.61577813 124.84543775 182.04973827 121.32700272 173.48413086 117.80737305 C155.6313839 110.47297 137.75255627 103.20434319 119.86035156 95.96679688 C114.70541237 93.88129298 109.55192766 91.79220639 104.3984375 89.703125 C87.14270963 82.70968825 69.88401436 75.72495497 52.58422852 68.84106445 C50.41754637 67.97773107 48.25537816 67.10295362 46.09863281 66.21508789 C43.00522818 64.95794976 43.00522818 64.95794976 39.76855469 64.00170898 C33.65280884 61.95917874 30.4455266 60.04712899 27.1875 54.37890625 C26.08754161 52.12466643 25.02648177 49.85113295 24 47.5625 C23.42230434 46.35147705 22.84028436 45.14250828 22.25415039 43.93554688 C21.3610644 42.0939328 20.47143511 40.25132396 19.59645081 38.40103149 C16.78693685 32.46129385 13.64552445 26.73127455 10.4375 21 C6.59923143 14.13954939 3.16246999 7.19917432 0 0 Z " fill="#8D784E" transform="translate(285,140)"/><path d="M0 0 C2.85359322 1.42679661 2.87581233 3.00216622 4 6 C5.05225932 8.34330056 6.12086292 10.67851619 7.1953125 13.01171875 C8 15 8 15 8 17 C9.32 17.66 10.64 18.32 12 19 C11.67 19.66 11.34 20.32 11 21 C12.32295768 22.32295768 13.65621227 23.63570564 15 24.9375 C17 27 17 27 19 30 C19.66 30 20.32 30 21 30 C21.33 31.65 21.66 33.3 22 35 C22.53625 35.061875 23.0725 35.12375 23.625 35.1875 C28.0098678 36.68758635 31.16322913 40.09349823 34.25 43.4375 C38.91267518 47.7822655 44.65044949 51.76821653 51 53 C51 53.66 51 54.32 51 55 C51.66515625 55.11214844 52.3303125 55.22429688 53.015625 55.33984375 C55.97899554 55.99535373 58.79862065 56.8968401 61.67236328 57.86621094 C68.38586544 60.11614139 73.85650164 61.46087086 81 61 C86.71428571 61.71428571 86.71428571 61.71428571 88 63 C89.84511853 63.09665925 91.69399332 63.12187099 93.54164124 63.12025452 C94.75233685 63.12162887 95.96303247 63.12300322 97.21041584 63.12441921 C98.57134842 63.12087446 99.93228077 63.11723992 101.29321289 63.11352539 C102.72564028 63.11324569 104.15806781 63.11340774 105.59049511 63.11397648 C109.54597835 63.11427353 113.50143191 63.10831549 117.45690823 63.10140657 C121.71628594 63.09505695 125.97566467 63.09446528 130.23504639 63.0932312 C137.62493366 63.09033776 145.01481101 63.08388674 152.4046936 63.07516479 C163.10785447 63.06262626 173.81101164 63.05653718 184.51417863 63.05223143 C201.90203346 63.04515427 219.28988367 63.03434779 236.67773438 63.02050781 C238.24026996 63.01926609 238.24026996 63.01926609 239.83437192 63.01799929 C248.27790613 63.01126093 256.72144018 63.00434218 265.16497421 62.99739647 C272.52209212 62.99134838 279.87921008 62.98536611 287.23632812 62.97949219 C288.271902 62.97866406 289.30747587 62.97783593 290.37443078 62.97698271 C307.67616303 62.9632695 324.97789535 62.95352352 342.27963161 62.94658184 C352.94582053 62.94211168 363.61199546 62.9340944 374.27817786 62.92143703 C381.60192369 62.9129741 388.92566631 62.908112 396.24941671 62.90601182 C400.46814283 62.90467422 404.68685088 62.90171465 408.90557098 62.89425278 C447.64805861 62.82822203 447.64805861 62.82822203 462 65 C462 65.33 462 65.66 462 66 C413.7522421 66.09163429 365.50449345 66.1620787 317.25666562 66.20426132 C311.555469 66.20926391 305.85427254 66.21444122 300.15307617 66.21972656 C299.01811122 66.2207758 297.88314627 66.22182505 296.71378844 66.22290608 C278.35707795 66.2402926 260.00041777 66.27182062 241.64373709 66.30861118 C222.79618131 66.34606941 203.9486518 66.36824617 185.10106033 66.37635398 C173.47905054 66.38183163 161.85718297 66.39910766 150.23521697 66.43166587 C142.25640663 66.45287405 134.27766941 66.45918582 126.29883296 66.45400551 C121.70129953 66.45145352 117.10401395 66.4552561 112.50652504 66.4768219 C108.28592391 66.49647378 104.06573423 66.49715106 99.84511303 66.48359558 C98.32933443 66.48192348 96.81352876 66.48683882 95.2978024 66.49953273 C81.1014163 66.61137744 67.49482219 64.1394215 54.4375 58.375 C53.65431396 58.03509033 52.87112793 57.69518066 52.06420898 57.3449707 C33.22879923 48.89901688 18.82590051 36.84613181 7 20 C6.36707031 19.11054687 5.73414063 18.22109375 5.08203125 17.3046875 C1.32531691 11.61161447 0.02900587 6.81637899 0 0 Z " fill="#714709" transform="translate(28,790)"/><path d="M0 0 C2 2 2 2 2.21816254 3.96895885 C2.20333076 4.78093385 2.18849899 5.59290884 2.17321777 6.42948914 C2.1615155 7.36136047 2.14981323 8.29323181 2.13775635 9.25334167 C2.11485535 10.2792189 2.09195435 11.30509613 2.06835938 12.36206055 C2.04470306 13.97958725 2.04470306 13.97958725 2.02056885 15.62979126 C1.98609108 17.97995943 1.94766029 20.33007207 1.9058075 22.68012047 C1.82193632 27.68961642 1.7747698 32.69923396 1.72574615 37.70917225 C1.63429202 47.04000016 1.52934895 56.36979231 1.35546875 65.69946289 C1.23600389 72.18572799 1.16655231 78.67091581 1.12910461 85.15815163 C1.10574511 87.62169106 1.06431761 90.08513287 1.00382996 92.54804039 C0.63091892 108.14219238 1.61665528 118.06764304 12 130 C13.0509834 131.54456196 14.08192466 133.10362989 15.06640625 134.69140625 C15.69421997 135.66049927 15.69421997 135.66049927 16.3347168 136.64916992 C17.20236699 138.00128258 18.06393055 139.35731023 18.92114258 140.71606445 C21.05098894 144.07563683 23.19685672 147.31612355 25.6953125 150.4140625 C33.64737347 160.63531824 32.99200843 170.5159554 32 183 C27.45643665 178.83454251 24.22078545 174.1630182 20.84375 169.02734375 C20.26016724 168.14961807 19.67658447 167.2718924 19.07531738 166.36756897 C17.21143254 163.56111408 15.35571682 160.74936066 13.5 157.9375 C12.28436476 156.10578083 11.06822311 154.27439764 9.8515625 152.44335938 C3.30595297 142.57975691 -3.18372165 132.68064234 -9.61547852 122.74241638 C-13.32577927 117.01342029 -17.09324995 111.32528341 -20.92431641 105.67628479 C-22.81962924 102.86186092 -24.58459851 100.08814872 -26 97 C-21.21950653 98.53626444 -17.88666952 101.24650825 -14.0625 104.375 C-12.86764032 105.34331532 -11.67104229 106.30948982 -10.47265625 107.2734375 C-9.94937744 107.70060059 -9.42609863 108.12776367 -8.88696289 108.56787109 C-6.34416719 110.49775072 -3.65608457 112.22927695 -1 114 C-0.67 76.38 -0.34 38.76 0 0 Z " fill="#C9931E" transform="translate(972,340)"/><path d="M0 0 C20.33378837 -0.04696205 40.66756556 -0.08210638 61.00139713 -0.10362434 C70.44520455 -0.11388621 79.88897805 -0.12784771 89.33276367 -0.15087891 C97.57508429 -0.17097022 105.81738032 -0.18375329 114.05972475 -0.18817699 C118.41386651 -0.19075806 122.76793799 -0.19671499 127.12205696 -0.21146011 C180.3273749 -0.38421759 180.3273749 -0.38421759 196 7 C196.59683594 7.27585937 197.19367188 7.55171875 197.80859375 7.8359375 C207.92644805 12.58985657 216.52245304 18.75395143 225 26 C225.67417969 26.57105469 226.34835937 27.14210938 227.04296875 27.73046875 C239.12259466 38.89192832 248.89102069 55.13647791 253 71 C252.01 71.66 251.02 72.32 250 73 C249.74943848 72.49774902 249.49887695 71.99549805 249.24072266 71.47802734 C244.15540312 61.36043242 238.85977432 51.83120544 232.03125 42.78515625 C230.40075971 40.54950321 229.11574225 38.51648387 228 36 C227.34 36 226.68 36 226 36 C224.84790349 34.8828155 223.70218653 33.7585833 222.58203125 32.609375 C214.94601832 24.8413816 206.53135608 19.17451186 197 14 C196.19539337 13.54825912 195.39078674 13.09651825 194.5617981 12.63108826 C176.36762626 4.29925719 156.22335318 4.10369631 136.60858226 4.18970728 C132.94774816 4.19927924 129.28712361 4.17446424 125.62635803 4.15377808 C118.73869601 4.11983679 111.85136771 4.1154398 104.96363884 4.12250316 C97.10337638 4.12906187 89.24334033 4.10139688 81.38314617 4.07130075 C65.25538884 4.01029239 49.12787376 3.99082034 33 4 C32.505 3.01 32.505 3.01 32 2 C21.44 1.67 10.88 1.34 0 1 C0 0.67 0 0.34 0 0 Z " fill="#FCD710" transform="translate(714,13)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.57394909 12.70659517 0.48891427 22.4223971 -6.8515625 33.24609375 C-8.06614518 35.10101764 -9.04272168 37.00201084 -10 39 C-4.50665559 46.28076666 1.11049384 53.40561366 7.03686523 60.33935547 C10.37044682 64.24234311 13.60350064 68.20953033 16.79296875 72.23046875 C19.56873411 75.71368581 22.37700787 79.16978197 25.1875 82.625 C25.74147461 83.30651123 26.29544922 83.98802246 26.86621094 84.69018555 C29.68780462 88.16045405 32.51219949 91.62841002 35.33984375 95.09375 C40.95307468 101.97912481 46.50708872 108.90086057 51.96606445 115.90917969 C55.15479329 119.98039374 58.45321977 123.94374503 61.8125 127.875 C73 140.98176032 73 140.98176032 73 144 C56.5 144 40 144 23 144 C23 143.67 23 143.34 23 143 C35.87 142.67 48.74 142.34 62 142 C55.66404743 133.93606036 49.39287129 126.0564289 42.75 118.28125 C39.90910446 114.923828 37.19827304 111.47242671 34.5 108 C30.42543054 102.75721767 26.21884023 97.65377639 21.9074707 92.60449219 C18.61634075 88.74556158 15.43027074 84.8187434 12.28125 80.84375 C9.28882424 77.11346583 6.23607654 73.43442834 3.1875 69.75 C-1.35240979 64.25525097 -5.84599514 58.72942137 -10.25 53.125 C-10.7035083 52.5484668 -11.1570166 51.97193359 -11.62426758 51.37792969 C-17 44.50047444 -17 44.50047444 -17 41 C-15.86777097 39.86777097 -14.72968211 38.74093151 -13.56640625 37.640625 C-5.40800396 29.095665 -1.83852376 20.05924011 -0.8125 8.5 C-0.73064453 7.67757812 -0.64878906 6.85515625 -0.56445312 6.0078125 C-0.36661362 4.00614225 -0.18191276 2.00318047 0 0 Z " fill="#F4C02D" transform="translate(861,615)"/><path d="M0 0 C4.90911477 0.5982672 9.11415915 2.11733637 13.61328125 4.078125 C14.358022 4.39635223 15.10276276 4.71457947 15.87007141 5.04244995 C18.35358618 6.1054443 20.83296321 7.1777631 23.3125 8.25 C25.09462355 9.01477977 26.87701968 9.77892464 28.65966797 10.54248047 C32.4704813 12.17606389 36.27958939 13.81353671 40.08740234 15.45410156 C45.93672459 17.97393961 51.790066 20.48432537 57.64453125 22.9921875 C59.62752433 23.8417119 61.61051585 24.69123993 63.59350586 25.54077148 C64.58591278 25.96591034 65.5783197 26.39104919 66.60079956 26.82907104 C69.63723375 28.1302424 72.67328466 29.43230416 75.70922852 30.73461914 C90.83518038 37.22226656 105.97067776 43.6873491 121.11248779 50.13787842 C123.52406658 51.16523841 125.93556651 52.19278352 128.34698486 53.22052002 C131.70501314 54.65155084 135.06337912 56.08178574 138.421875 57.51171875 C139.42163361 57.93779922 140.42139221 58.3638797 141.45144653 58.8028717 C142.83818069 59.39291237 142.83818069 59.39291237 144.25292969 59.99487305 C145.45354034 60.50608955 145.45354034 60.50608955 146.67840576 61.02763367 C149.1085802 62.04547725 151.55122019 63.02787193 154 64 C152.02 64.99 152.02 64.99 150 66 C150 65.34 150 64.68 150 64 C146.535 64.495 146.535 64.495 143 65 C143.66 65.66 144.32 66.32 145 67 C138.57508985 66.49901521 133.50442772 64.23783257 127.6875 61.5625 C125.48550684 60.57040069 123.28228043 59.58103606 121.078125 58.59375 C120.16769691 58.18498375 120.16769691 58.18498375 119.23887634 57.76795959 C113.61733255 55.25346833 107.96053401 52.82414269 102.296875 50.40625 C101.36394119 50.00792465 100.43100739 49.6095993 99.46980286 49.19920349 C95.69049161 47.58688637 91.91048884 45.97621137 88.12924194 44.36843872 C85.44854449 43.2281892 82.76912913 42.084969 80.08984375 40.94140625 C79.2916925 40.60318848 78.49354126 40.2649707 77.67120361 39.91650391 C73.2785849 38.03952128 68.9939904 36.04137387 64.76002502 33.82798767 C62.78408824 32.83824803 62.78408824 32.83824803 59.625 32.0625 C56.65690417 31.19254088 54.45425629 30.28327188 51.75 28.875 C42.59062695 24.14125674 32.91663614 20.43061809 23.38671875 16.515625 C5.67031757 9.22196047 5.67031757 9.22196047 0 1 C0 0.67 0 0.34 0 0 Z " fill="#FDE96F" transform="translate(407,365)"/><path d="M0 0 C0.99 1.485 0.99 1.485 2 3 C1.67 3.66 1.34 4.32 1 5 C0.8453125 5.8353125 0.8453125 5.8353125 0.6875 6.6875 C-1.08532609 12.65064231 -4.47962155 16.87269793 -9 21 C-9.67675781 21.66902344 -10.35351562 22.33804688 -11.05078125 23.02734375 C-17.74786459 29.43944482 -24.8321484 33.72252321 -33 38 C-33.94359375 38.54914062 -34.8871875 39.09828125 -35.859375 39.6640625 C-42.80605492 42.61899351 -50.79169206 42.15814643 -58.23754883 42.20532227 C-59.22157181 42.21522186 -60.20559479 42.22512146 -61.21943665 42.23532104 C-64.46527766 42.26680909 -67.71113199 42.29171168 -70.95703125 42.31640625 C-73.2601502 42.33705347 -75.56326603 42.35805146 -77.86637878 42.37937927 C-82.71241329 42.42330325 -87.55846046 42.46418297 -92.40454102 42.50268555 C-98.47405392 42.5509695 -104.54350011 42.60477807 -110.61294746 42.66063881 C-132.95579338 42.86549547 -155.29937146 43.04152359 -177.6431942 43.08384514 C-179.47239292 43.08775553 -181.30158914 43.09325891 -183.13077736 43.10058784 C-191.88210238 43.13322206 -200.60379146 43.05640893 -209.34301758 42.56079102 C-210.02803439 42.52243354 -210.7130512 42.48407606 -211.4188261 42.44455624 C-216.72532419 42.10518085 -221.8481279 41.30379073 -227 40 C-227.33 40.66 -227.66 41.32 -228 42 C-230.31 41.34 -232.62 40.68 -235 40 C-235 39.67 -235 39.34 -235 39 C-208.32850812 38.32972491 -181.66184426 37.91796743 -154.98262262 37.79887486 C-152.10673737 37.78575325 -149.23085975 37.77125694 -146.3549813 37.75672984 C-133.82368376 37.69353783 -121.29239908 37.63326088 -108.76098633 37.59863281 C-102.11949502 37.58020852 -95.47813622 37.55125205 -88.83674258 37.5106281 C-85.36725727 37.48983997 -81.89793562 37.47414028 -78.42838478 37.47182083 C-54.36296331 37.81262344 -54.36296331 37.81262344 -31.8125 30.3125 C-31.14597412 29.96292236 -30.47944824 29.61334473 -29.79272461 29.25317383 C-16.77698436 22.26013309 -6.79523335 13.29502177 0 0 Z " fill="#BA8408" transform="translate(929,782)"/><path d="M0 0 C0 40.59 0 81.18 0 123 C-0.33 123 -0.66 123 -1 123 C-1.33 84.06 -1.66 45.12 -2 5 C-2.33 5.99 -2.66 6.98 -3 8 C-5.16699219 9.52709961 -5.16699219 9.52709961 -8.046875 11.15234375 C-9.10841797 11.75755859 -10.16996094 12.36277344 -11.26367188 12.98632812 C-12.41416016 13.63021484 -13.56464844 14.27410156 -14.75 14.9375 C-15.94385947 15.61435304 -17.13721432 16.29209688 -18.33007812 16.97070312 C-20.74541812 18.34308875 -23.16340065 19.71061528 -25.58398438 21.07373047 C-30.23410933 23.69590642 -34.86696082 26.34780241 -39.5 29 C-41.20702688 29.97396599 -42.91405821 30.94792419 -44.62109375 31.921875 C-50.61255066 35.34556466 -56.58738258 38.79789871 -62.5625 42.25 C-75.23431132 49.56991253 -87.92200215 56.86331081 -100.65429688 64.07763672 C-103.05400075 65.45645081 -105.43030768 66.8554826 -107.79882812 68.28564453 C-108.74547333 68.84881126 -108.74547333 68.84881126 -109.71124268 69.4233551 C-110.92850534 70.14828244 -112.14009336 70.88285076 -113.34490967 71.62828064 C-117.44794738 74.05215111 -117.44794738 74.05215111 -120.33886719 73.77905273 C-122 73 -122 73 -123 72 C-123.33 73.65 -123.66 75.3 -124 77 C-126 74 -126 74 -125.87915039 71.97021484 C-124.70533363 69.33963965 -123.48088542 68.78635252 -120.93359375 67.4765625 C-119.6350647 66.79207031 -119.6350647 66.79207031 -118.31030273 66.09375 C-117.36227783 65.6090625 -116.41425293 65.124375 -115.4375 64.625 C-113.41496531 63.55790599 -111.39419042 62.48747122 -109.375 61.4140625 C-108.323125 60.8562207 -107.27125 60.29837891 -106.1875 59.72363281 C-101.03324656 56.9364829 -95.98590478 53.97341963 -90.9375 51 C-88.91555036 49.81218371 -86.89341591 48.62468194 -84.87109375 47.4375 C-83.88737793 46.86 -82.90366211 46.2825 -81.89013672 45.6875 C-77.44534616 43.09226497 -72.97385174 40.5447051 -68.5 38 C-57.99613269 32.01857575 -47.55688316 25.92872955 -37.12304688 19.82617188 C-31.72977503 16.6725076 -26.33364147 13.5237507 -20.9375 10.375 C-19.94451904 9.79508301 -18.95153809 9.21516602 -17.9284668 8.61767578 C-16.0966703 7.54856328 -14.26366663 6.48151521 -12.42919922 5.41699219 C-10.90377086 4.52718453 -9.38365942 3.62813128 -7.87158203 2.71582031 C-3.31942923 0 -3.31942923 0 0 0 Z " fill="#FCEF74" transform="translate(974,217)"/><path d="M0 0 C-0.2990625 0.56976563 -0.598125 1.13953125 -0.90625 1.7265625 C-1.9614719 3.91991658 -2.75296275 6.06080852 -3.5 8.375 C-3.7371875 9.10460937 -3.974375 9.83421875 -4.21875 10.5859375 C-4.4765625 11.38257812 -4.734375 12.17921875 -5 13 C-5.32372589 13.91143768 -5.64745178 14.82287537 -5.98098755 15.76193237 C-9.58247303 27.20620228 -9.39096746 39.54549948 -9.6328125 51.4296875 C-9.67407123 53.15847485 -9.71606673 54.88724476 -9.75875854 56.61599731 C-9.86796754 61.11689928 -9.96731698 65.6179641 -10.06445312 70.11914062 C-10.16579684 74.73191431 -10.27668676 79.34445808 -10.38671875 83.95703125 C-10.60036875 92.97115672 -10.8035796 101.98548376 -11 111 C-11.33 111 -11.66 111 -12 111 C-12.01711257 163.18817064 -12.03303393 215.37634149 -12.04234314 267.56451416 C-12.0424812 268.33649811 -12.04261925 269.10848205 -12.04276149 269.90385945 C-12.04575417 286.67978053 -12.04852438 303.45570164 -12.05106533 320.2316228 C-12.0523127 328.45812614 -12.05360925 336.68462948 -12.05493164 344.91113281 C-12.0550624 345.72978357 -12.05519316 346.54843433 -12.05532788 347.39189269 C-12.05959181 373.94292628 -12.06710504 400.49395774 -12.07629722 427.04499004 C-12.08572359 454.32190091 -12.091884 481.59881059 -12.09391499 508.87572305 C-12.09420316 512.72539913 -12.0945288 516.57507521 -12.09487724 520.42475128 C-12.09497838 521.56129644 -12.09497838 521.56129644 -12.09508156 522.7208021 C-12.09626483 534.93430184 -12.10090709 547.14779795 -12.10683203 559.36129621 C-12.11271027 571.62987825 -12.11497024 583.89845668 -12.11350138 596.16704008 C-12.11280616 602.81851407 -12.11387133 609.46997961 -12.11920547 616.12145233 C-12.1240475 622.2033906 -12.1243333 628.28531093 -12.12089889 634.36725 C-12.120474 636.57457476 -12.12176297 638.78190061 -12.12488318 640.98922321 C-12.12886177 643.97600099 -12.12675412 646.96271295 -12.12304783 649.94948959 C-12.12567484 650.81816284 -12.12830186 651.68683609 -12.13100848 652.58183277 C-12.12876118 653.37633457 -12.12651389 654.17083637 -12.1241985 654.98941398 C-12.12435448 655.67260911 -12.12451046 656.35580425 -12.12467116 657.05970226 C-11.99089518 659.14170124 -11.51191197 660.98132596 -11 663 C-10.93168013 665.4157906 -10.91512358 667.83334713 -10.9375 670.25 C-10.94652344 671.51328125 -10.95554687 672.7765625 -10.96484375 674.078125 C-10.98224609 675.52445313 -10.98224609 675.52445313 -11 677 C-11.33 677 -11.66 677 -12 677 C-14.78425091 664.32612447 -14.28188519 651.47136211 -14.26069641 638.57138062 C-14.26371898 635.96682711 -14.267609 633.3622745 -14.27228898 630.75772345 C-14.28102222 625.10673032 -14.28237337 619.45577344 -14.27878571 613.80477524 C-14.27346458 605.40104057 -14.27958821 596.99734081 -14.28786864 588.59360993 C-14.30309105 572.70842115 -14.30481547 556.82324833 -14.30234561 540.93805377 C-14.30051118 528.66783371 -14.30227571 516.39761886 -14.30657005 504.12739944 C-14.30717246 502.36297399 -14.30777366 500.59854854 -14.30837366 498.83412308 C-14.30928094 496.17510497 -14.31018961 493.51608686 -14.31110601 490.85706875 C-14.31953311 466.14105246 -14.32387297 441.42503814 -14.31969929 416.70902061 C-14.31954291 415.77769029 -14.31938654 414.84635996 -14.31922542 413.88680751 C-14.31841967 409.16674039 -14.3175739 404.44667328 -14.31671212 399.72660618 C-14.31654103 398.78923147 -14.31636994 397.85185677 -14.31619367 396.88607678 C-14.31584701 394.99047763 -14.31549848 393.09487849 -14.31514808 391.19927934 C-14.30979246 361.71243091 -14.31771778 332.22561239 -14.33618164 302.73876953 C-14.3569153 269.5884407 -14.36762166 236.43813039 -14.36360615 203.28779471 C-14.36321083 199.75036152 -14.36284928 196.21292834 -14.36250877 192.67549515 C-14.36241804 191.80452959 -14.36232731 190.93356402 -14.36223383 190.03620557 C-14.36106966 176.90924454 -14.36770251 163.78230226 -14.37832069 150.65534592 C-14.39039111 135.71806593 -14.39191055 120.78082717 -14.37953053 105.84354655 C-14.37291904 97.49352809 -14.37449329 89.14360829 -14.38811904 80.79359779 C-14.39737777 74.54459135 -14.39080454 68.29569263 -14.37827124 62.046694 C-14.37562764 59.52926462 -14.37798016 57.01182364 -14.38600711 54.49440567 C-14.42795709 40.3493231 -13.76762315 26.88805617 -11 13 C-10.76643699 11.80882958 -10.53287397 10.61765916 -10.29223329 9.39039266 C-9.31308854 4.71045712 -8.88009456 2.64660008 -4.9375 -0.25 C-2 -1 -2 -1 0 0 Z " fill="#F3DF59" transform="translate(29,91)"/><path d="M0 0 C5.97377764 0.65236261 10.68693487 3.00435668 15.99023438 5.6484375 C16.66248047 5.96296875 17.33472656 6.2775 18.02734375 6.6015625 C18.62281006 6.89369629 19.21827637 7.18583008 19.83178711 7.48681641 C22.17673199 8.19192122 22.17673199 8.19192122 25.29638672 7.42797852 C29.59651617 6.93106837 32.37497372 7.87031602 36.23046875 9.55078125 C36.92164795 9.83596619 37.61282715 10.12115112 38.32495117 10.41497803 C40.61913198 11.36562539 42.9028899 12.33910257 45.1875 13.3125 C46.82066477 13.99380019 48.45455325 14.67336778 50.08911133 15.35131836 C53.57815447 16.80043508 57.06357471 18.25783858 60.546875 19.72070312 C68.80597496 23.18216125 77.10483717 26.54644525 85.39813232 29.92489624 C90.02040015 31.81002214 94.63909062 33.70386273 99.2578125 35.59765625 C105.42116161 38.12458311 111.58566764 40.64861257 117.75267029 43.16661072 C120.94374959 44.47018616 124.13371843 45.77646156 127.32339478 47.08346558 C128.80240259 47.68886883 130.28186664 48.29315885 131.7618103 48.89627075 C133.78126894 49.71947533 135.79902707 50.54671516 137.81640625 51.375 C139.50938843 52.06722656 139.50938843 52.06722656 141.23657227 52.7734375 C144 54 144 54 147 56 C145.4375 58.0625 145.4375 58.0625 143 60 C137.11145149 59.71675336 132.28342638 57.67138452 126.9375 55.3125 C126.18017578 54.98572266 125.42285156 54.65894531 124.64257812 54.32226562 C123.01683114 53.62014698 121.39247253 52.91480754 119.76928711 52.20678711 C110.21119032 48.04160396 100.61482619 43.98483873 90.94906616 40.0758667 C88.98518226 39.2812147 87.02242911 38.48381638 85.05981445 37.68603516 C77.31714458 34.54183428 69.5646379 31.42314553 61.80305481 28.32591248 C57.49868428 26.60728088 53.19664871 24.88284568 48.89474487 23.15805054 C46.76024189 22.30414779 44.62460151 21.45308261 42.48782349 20.60488892 C39.47212982 19.40759126 36.46036455 18.20086849 33.44921875 16.9921875 C32.53814362 16.63330948 31.62706848 16.27443146 30.68838501 15.90467834 C29.8497995 15.56601242 29.01121399 15.2273465 28.1472168 14.87841797 C27.41544724 14.58675751 26.68367767 14.29509705 25.92973328 13.99459839 C23.85188559 12.92366077 22.60003856 11.6837253 21 10 C18.81726096 8.90612035 18.81726096 8.90612035 16.3671875 8.02734375 C15.03494141 7.51397461 15.03494141 7.51397461 13.67578125 6.99023438 C12.75152344 6.64283203 11.82726562 6.29542969 10.875 5.9375 C9.03665869 5.24462585 7.20057848 4.54571262 5.3671875 3.83984375 C4.55362793 3.53425537 3.74006836 3.22866699 2.90185547 2.91381836 C1 2 1 2 0 0 Z " fill="#FBD751" transform="translate(471,297)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1 45.87 1 91.74 1 139 C8.26 138.67 15.52 138.34 23 138 C29.55456755 137.98552824 36.09647198 138.01228767 42.6484375 138.12109375 C44.41060625 138.14550998 46.17278312 138.16934682 47.93496704 138.19264221 C52.48860191 138.25434329 57.04208597 138.32370814 61.59558105 138.39489746 C66.27589267 138.46663661 70.95630805 138.53081305 75.63671875 138.59570312 C84.75793049 138.72323731 93.87897718 138.8596031 103 139 C103 133.39 103 127.78 103 122 C103.33 122 103.66 122 104 122 C104.04898438 123.15757812 104.09796875 124.31515625 104.1484375 125.5078125 C104.22351478 127.0468967 104.29906043 128.5859581 104.375 130.125 C104.4059375 130.88554687 104.436875 131.64609375 104.46875 132.4296875 C104.50742187 133.17734375 104.54609375 133.925 104.5859375 134.6953125 C104.6173584 135.37609863 104.6487793 136.05688477 104.68115234 136.75830078 C105.02909765 139.68557797 105.02909765 139.68557797 107 145 C71.03 145 35.06 145 -2 145 C-1.67 143.35 -1.34 141.7 -1 140 C-0.90247927 138.02963544 -0.85416652 136.05652355 -0.84178162 134.08378601 C-0.8319928 132.89893112 -0.82220398 131.71407623 -0.81211853 130.49331665 C-0.80636307 129.20218964 -0.8006076 127.91106262 -0.79467773 126.58081055 C-0.7850925 125.20077729 -0.77508204 123.82074694 -0.76467896 122.4407196 C-0.73769376 118.70148409 -0.71664972 114.96223604 -0.69667697 111.22295737 C-0.67477793 107.31249961 -0.64740844 103.40208022 -0.62062073 99.49165344 C-0.57074675 92.08990381 -0.52578832 84.68813281 -0.48259836 77.28634149 C-0.43318068 68.85830738 -0.37827938 60.43031177 -0.32291877 52.00231493 C-0.20918003 34.66824556 -0.1023234 17.33414043 0 0 Z " fill="#EDE283" transform="translate(745,290)"/><path d="M0 0 C5.76859956 3.53028418 10.93857722 7.83121395 16.11328125 12.16796875 C19.7793343 15.21741471 23.56936984 18.10058347 27.36328125 20.98828125 C28.08725098 21.5395166 28.8112207 22.09075195 29.55712891 22.65869141 C31.04325375 23.78921831 32.52974773 24.91926014 34.01660156 26.04882812 C37.59634111 28.77100369 41.16696831 31.50506615 44.73828125 34.23828125 C46.14968866 35.31777491 47.56114711 36.39720185 48.97265625 37.4765625 C50.02356445 38.2802124 50.02356445 38.2802124 51.09570312 39.10009766 C53.27319025 40.76497216 55.45101119 42.42940917 57.62890625 44.09375 C65.04348638 49.76060767 72.45746251 55.4279252 79.83984375 61.13671875 C82.39817862 63.10668281 84.98204528 65.03964906 87.57421875 66.96484375 C88.32638672 67.52816406 89.07855469 68.09148437 89.85351562 68.671875 C91.31043108 69.76235796 92.77233444 70.84622381 94.24023438 71.921875 C99.80728264 76.10643079 105.9796531 80.9623968 108.23828125 87.73828125 C108.77770233 94.21133418 107.83273372 97.34660255 104.23828125 102.73828125 C103.90828125 101.74828125 103.57828125 100.75828125 103.23828125 99.73828125 C103.98078125 98.28421875 103.98078125 98.28421875 104.73828125 96.80078125 C106.45437821 94.00471232 106.45437821 94.00471232 105.9921875 91.765625 C102.84313622 83.29745084 93.4894464 77.99517771 86.51171875 72.8984375 C82.36197889 69.8601341 78.3549575 66.66754955 74.36328125 63.42578125 C69.61086517 59.58150134 64.79595993 55.94600233 59.74609375 52.49609375 C51.27951105 46.56157317 43.25035074 39.97135362 35.13134766 33.57446289 C30.88098235 30.23009966 26.58339235 26.95866226 22.23828125 23.73828125 C21.655625 23.29613281 21.07296875 22.85398437 20.47265625 22.3984375 C17.25932175 19.96143382 14.01731723 17.57353852 10.7265625 15.2421875 C10.10152832 14.79907227 9.47649414 14.35595703 8.83251953 13.89941406 C7.58148859 13.01456196 6.32861492 12.13230825 5.07373047 11.25292969 C2.23652179 9.24714035 -0.36027847 7.24852465 -2.76171875 4.73828125 C-6.26059791 2.98884167 -9.94380616 3.18551949 -13.76171875 3.73828125 C-18.70347993 6.66673232 -20.52238207 9.62826029 -22.0234375 14.96875 C-22.76171875 16.73828125 -22.76171875 16.73828125 -25.76171875 18.73828125 C-26.25358306 12.83590954 -25.32607443 8.56480254 -21.76171875 3.73828125 C-15.71124585 -2.15559118 -7.69527302 -3.51566222 0 0 Z " fill="#FBE33A" transform="translate(157.76171875,564.26171875)"/><path d="M0 0 C1.65 1.32 3.3 2.64 5 4 C4.34 4 3.68 4 3 4 C3 51.52 3 99.04 3 148 C-33.63 148 -70.26 148 -108 148 C-107.505 147.01 -107.505 147.01 -107 146 C-71.03 146.33 -35.06 146.66 2 147 C1.01 145.02 0.02 143.04 -1 141 C-1.38388208 138.28529975 -1.60029381 135.79028615 -1.6796875 133.06640625 C-1.71270966 132.22509659 -1.74573181 131.38378693 -1.77975464 130.51698303 C-2.28751145 115.21614503 -2.14667907 99.88883197 -2.12695312 84.58184814 C-2.12437906 81.09679892 -2.12919172 77.6117758 -2.13380814 74.12672997 C-2.15360005 56.51753906 -2.03915588 38.91959743 -1.5546875 21.31640625 C-1.53527225 20.57391066 -1.51585701 19.83141506 -1.49585342 19.0664196 C-1.43969401 16.97841649 -1.3771973 14.89071731 -1.31201172 12.80297852 C-1.2761496 11.62864761 -1.24028748 10.45431671 -1.20333862 9.24440002 C-1.00637301 6.10168553 -0.57727466 3.09339657 0 0 Z " fill="#FBC61A" transform="translate(850,288)"/><path d="M0 0 C15.36972142 -0.02346815 30.73944147 -0.04104701 46.10917664 -0.05181217 C53.24726972 -0.05694578 60.38535161 -0.06393183 67.5234375 -0.07543945 C73.75250157 -0.08547673 79.98155753 -0.09187471 86.21062946 -0.09408849 C89.50203392 -0.09538041 92.79341006 -0.09891148 96.08480835 -0.10573006 C109.42669975 -0.13225035 122.6982852 -0.13554168 136 1 C136 1.66 136 2.32 136 3 C137.98 3.495 137.98 3.495 140 4 C125.45856312 4.18806254 110.91688488 4.35069714 96.375 4.5 C95.21926861 4.51187725 94.06353722 4.5237545 92.87278366 4.53599167 C37.60348649 5.0951858 -17.66590441 5.08468513 -72.9375 5.0625 C-74.02541619 5.06207577 -75.11333239 5.06165154 -76.23421574 5.06121445 C-104.48948539 5.05001183 -132.74474385 5.02970212 -161 5 C-161 4.34 -161 3.68 -161 3 C-98.3 2.67 -35.6 2.34 29 2 C19.43 1.67 9.86 1.34 0 1 C0 0.67 0 0.34 0 0 Z " fill="#B8870A" transform="translate(362,821)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.33 15.51 1.66 31.02 2 47 C2.33 31.49 2.66 15.98 3 0 C5.08386084 4.16772168 5.24849914 5.95291382 5.24291992 10.49682617 C5.24599655 11.81466599 5.24907318 13.1325058 5.25224304 14.49028015 C5.24534683 15.92451147 5.23807997 17.35874105 5.23046875 18.79296875 C5.22927638 20.26459208 5.22882391 21.73621618 5.2290802 23.20783997 C5.22751798 26.28696478 5.21924601 29.36597289 5.20581055 32.44506836 C5.18877623 36.399785 5.18499762 40.354374 5.18575573 44.30912304 C5.18548445 47.34504931 5.18001086 50.38094745 5.17275429 53.4168644 C5.16956428 54.87577413 5.16759944 56.33468705 5.16686058 57.79360008 C5.16470309 59.82619747 5.15517478 61.85878306 5.14526367 63.89135742 C5.14145187 65.0495549 5.13764008 66.20775238 5.13371277 67.40104675 C5 70 5 70 4 71 C3.90087161 72.49085365 3.86920253 73.98632452 3.8671875 75.48046875 C3.86525391 76.8562207 3.86525391 76.8562207 3.86328125 78.25976562 C3.86714844 79.22591797 3.87101562 80.19207031 3.875 81.1875 C3.87113281 82.13431641 3.86726563 83.08113281 3.86328125 84.05664062 C3.86861364 87.87729993 3.9064108 91.4685928 4.5703125 95.23828125 C5 98 5 98 4.53295898 100.86547852 C3.66614413 106.51476282 3.87801125 112.21328605 3.90234375 117.9140625 C3.9045857 119.89546267 3.90682733 121.87686284 3.90905762 123.85826302 C3.91241947 125.98010279 3.91827182 128.10192272 3.92483521 130.22375488 C3.93845194 134.67488365 3.94427334 139.12600255 3.94897461 143.57714844 C3.96099113 153.84999524 3.98289107 164.12281638 4.00520325 174.39564514 C4.02551349 183.77448581 4.04357849 193.1533168 4.05341816 202.53217506 C4.05752847 206.21997179 4.06371861 209.9077382 4.07516479 213.59552002 C4.11670203 227.1666172 4.12696436 240.73292831 3.62109375 254.296875 C3.59048355 255.24709534 3.55987335 256.19731567 3.52833557 257.17633057 C3.48990036 258.0394989 3.45146515 258.90266724 3.41186523 259.79199219 C3.38084213 260.53777527 3.34981903 261.28355835 3.31785583 262.05194092 C3 264 3 264 1 267 C0.81799916 251.18765318 0.65345045 235.37514929 0.5 219.5625 C0.48812275 218.33946419 0.4762455 217.11642838 0.46400833 215.85633087 C-0.00455665 167.02909075 -0.0871413 118.20423121 -0.0625 69.375 C-0.06207577 68.50938399 -0.06165154 67.64376798 -0.06121445 66.75192118 C-0.05012473 44.50126975 -0.0300108 22.25063409 0 0 Z " fill="#FCD52E" transform="translate(16,124)"/><path d="M0 0 C38.61 0 77.22 0 117 0 C115.68 0.33 114.36 0.66 113 1 C113.495 3.475 113.495 3.475 114 6 C100.00496879 6.09348304 86.00998606 6.16373251 72.01470661 6.20724869 C65.51628613 6.22813313 59.01807524 6.2564671 52.51977539 6.30175781 C46.24984359 6.34518397 39.98011353 6.36913065 33.71004295 6.37950897 C31.31659964 6.38690607 28.9231675 6.40135063 26.52980995 6.42292023 C23.18019275 6.45191031 19.8314117 6.45595771 16.48168945 6.45410156 C15.48978607 6.46848267 14.49788269 6.48286377 13.47592163 6.49768066 C9.11917334 6.47151617 6.68427901 6.42114776 2.90739441 4.09661865 C1 2 1 2 0 0 Z " fill="#FAEA76" transform="translate(786,528)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C0.37312664 3.47785682 -1.66148112 6.59472382 -3.75 9.8125 C-15.8234124 29.15417821 -17.45250487 49.04206855 -17.41650391 71.24511719 C-17.42390365 73.43480895 -17.43261466 75.62449661 -17.44252014 77.81417847 C-17.46572962 83.73606729 -17.47098974 89.65785094 -17.47317934 95.57977962 C-17.47891547 101.88209813 -17.50226827 108.18435239 -17.52377319 114.4866333 C-17.55791719 125.13887091 -17.58236029 135.79108318 -17.59863281 146.44335938 C-17.63511794 170.27203637 -17.70061165 194.10063618 -17.76766205 217.929245 C-17.78209653 223.08216675 -17.79564478 228.23508969 -17.80844879 233.38801575 C-17.92278413 278.92958373 -18.32876759 324.46334186 -19 370 C-19.33 370 -19.66 370 -20 370 C-20.80945347 350.86240891 -21.15783352 331.76365312 -21.17700195 312.609375 C-21.18278243 309.79043872 -21.18992769 306.97150614 -21.19691467 304.15257263 C-21.21636248 295.80517638 -21.22668975 287.45777945 -21.23564246 279.11036634 C-21.23917442 275.95107063 -21.24331676 272.79177585 -21.24748212 269.63248092 C-21.2658957 255.65292473 -21.28164529 241.67336839 -21.28938007 227.69380188 C-21.29128898 224.29993692 -21.2932095 220.90607197 -21.29516602 217.51220703 C-21.29589163 216.2473959 -21.29589163 216.2473959 -21.2966319 214.95703304 C-21.30495115 201.26648003 -21.3303449 187.57601381 -21.36274669 173.88549876 C-21.39591282 159.75483901 -21.41383617 145.6242234 -21.41702431 131.49352455 C-21.41917717 123.58909279 -21.42774819 115.68478887 -21.45348549 107.78039551 C-21.47532135 101.06041722 -21.48317901 94.34059811 -21.47351871 87.62058836 C-21.46901511 84.2031185 -21.47287053 80.78623928 -21.49028015 77.36877251 C-21.5638752 62.05609508 -20.73455802 47.87477333 -17 33 C-16.77647008 32.00248215 -16.55294016 31.00496429 -16.3226366 29.97721863 C-13.87865814 19.30698968 -6.63878228 8.55936645 0 0 Z " fill="#F8C61C" transform="translate(67,78)"/><path d="M0 0 C1.33990048 -0.04533089 2.67982506 -0.08995644 4.01977539 -0.13378906 C5.20410156 -0.18639893 6.38842773 -0.23900879 7.60864258 -0.29321289 C11.73712967 0.3454779 13.08711333 1.91631318 15.72290039 5.07324219 C18.78540039 9.63773263 18.78540039 9.63773263 18.78540039 12.19824219 C17.7530275 12.1970488 17.7530275 12.1970488 16.69979858 12.1958313 C9.52914643 12.19339147 2.35957596 12.23260722 -4.81079102 12.29589844 C-7.48634863 12.31739049 -10.16035663 12.32162856 -12.83618164 12.31835938 C-16.68441275 12.31550142 -20.53070019 12.35083129 -24.37866211 12.39355469 C-25.57262604 12.38446075 -26.76658997 12.37536682 -27.99673462 12.36599731 C-35.17075701 12.38732903 -35.17075701 12.38732903 -40.8918457 16.24853516 C-42.04160889 17.70864014 -42.04160889 17.70864014 -43.21459961 19.19824219 C-43.87459961 19.19824219 -44.53459961 19.19824219 -45.21459961 19.19824219 C-45.02709961 16.82324219 -45.02709961 16.82324219 -44.21459961 14.19824219 C-41.65209961 12.88574219 -41.65209961 12.88574219 -39.21459961 12.19824219 C-39.54459961 8.89824219 -39.87459961 5.59824219 -40.21459961 2.19824219 C-36.40827606 1.2466613 -33.25708329 0.9987904 -29.35131836 0.88183594 C-28.68227982 0.86105484 -28.01324127 0.84027374 -27.32392883 0.81886292 C-25.90432802 0.77568369 -24.48466113 0.7346315 -23.06494141 0.69555664 C-20.94732742 0.63699298 -18.83001893 0.57155414 -16.71264648 0.50488281 C-13.24020729 0.39800496 -9.76776554 0.32283456 -6.29440308 0.25354004 C-4.19416874 0.19769897 -2.09848006 0.10141977 0 0 Z " fill="#C08307" transform="translate(712.214599609375,600.8017578125)"/><path d="M0 0 C0.89874816 0.00092179 1.79749632 0.00184359 2.72347927 0.00279331 C3.75138073 0.00141865 4.77928219 0.00004398 5.83833218 -0.00137234 C6.975527 0.00222294 8.11272182 0.00581821 9.2843771 0.00952244 C10.47445873 0.00937641 11.66454037 0.00923038 12.89068508 0.00907993 C16.16326569 0.00965889 19.43580402 0.01468801 22.70837617 0.02165389 C26.1250196 0.02788815 29.54166379 0.02849128 32.95831203 0.0296793 C39.43232563 0.0327924 45.90632242 0.0410055 52.3803286 0.05102879 C59.74901216 0.06219058 67.11769651 0.06770054 74.48638642 0.07272422 C89.64814464 0.08318813 104.80988712 0.10078717 119.97163296 0.12304783 C119.15646267 2.5855875 119.15646267 2.5855875 116.97163296 5.12304783 C113.34258723 5.92073372 109.71595592 5.77369505 106.01435757 5.72241306 C104.32139805 5.72832714 104.32139805 5.72832714 102.59423733 5.73436069 C98.85370292 5.74108816 95.114381 5.71187121 91.37397671 5.68164158 C88.7823094 5.67739362 86.19063829 5.67506315 83.59896755 5.67457676 C78.16400165 5.66840381 72.72947214 5.64629694 67.294631 5.61010838 C61.00694256 5.56835306 54.71956937 5.55079241 48.43175024 5.54748863 C42.38701103 5.54423844 36.34239123 5.52914213 30.29768467 5.50749493 C27.72317118 5.4985914 25.14864922 5.49187181 22.57412434 5.48733425 C18.98244232 5.47833002 15.39110359 5.45597284 11.79951382 5.42944431 C10.72673183 5.42877964 9.65394985 5.42811497 8.54865932 5.42743015 C7.57420361 5.41745502 6.59974789 5.4074799 5.59576321 5.39720249 C4.74607936 5.39255198 3.89639551 5.38790148 3.02096367 5.38311005 C0.97163296 5.12304783 0.97163296 5.12304783 -1.02836704 3.12304783 C-1.35836704 12.69304783 -1.68836704 22.26304783 -2.02836704 32.12304783 C-2.35836704 32.12304783 -2.68836704 32.12304783 -3.02836704 32.12304783 C-3.05302208 27.7264861 -3.07120547 23.32996063 -3.08329868 18.93335056 C-3.08833825 17.43659865 -3.09516992 15.93985167 -3.1038065 14.44311619 C-3.11588863 12.29604976 -3.12159896 10.14904821 -3.12602329 8.00195408 C-3.13126011 6.70846043 -3.13649693 5.41496677 -3.14189243 4.08227634 C-2.99224706 0.18152016 -2.99224706 0.18152016 0 0 Z " fill="#FDE118" transform="translate(273.0283670425415,728.8769521713257)"/><path d="M0 0 C-0.99 0.66 -1.98 1.32 -3 2 C-2.505 2.99 -2.505 2.99 -2 4 C-3.0415625 4.268125 -4.083125 4.53625 -5.15625 4.8125 C-35.44052147 12.95527165 -62.0273468 31.98240225 -78.234375 59.0625 C-82.63172239 66.71291986 -82.63172239 66.71291986 -85.90234375 74.8671875 C-86.26457031 75.57101563 -86.62679687 76.27484375 -87 77 C-89.625 77.8125 -89.625 77.8125 -92 78 C-86.04959402 51.65705684 -64.38815686 28.59138745 -42.19140625 14.4921875 C-11.47224803 -4.22810124 -11.47224803 -4.22810124 0 0 Z " fill="#FCEB66" transform="translate(114,15)"/><path d="M0 0 C25.74 0.33 51.48 0.66 78 1 C77 6 77 6 75 9 C72.4529799 9.25679473 70.15655149 9.31970826 67.61279297 9.2487793 C66.47118713 9.23480606 66.47118713 9.23480606 65.30651855 9.22055054 C62.78462799 9.18610646 60.26368384 9.13022673 57.7421875 9.07421875 C55.99628732 9.0461939 54.25036527 9.01950261 52.50442505 8.99409485 C47.90425627 8.92355378 43.30460834 8.83484938 38.70483398 8.74243164 C34.01303765 8.65135631 29.32097591 8.5773613 24.62890625 8.50195312 C15.41892915 8.35140532 6.20941189 8.18167877 -3 8 C-2.690625 7.236875 -2.38125 6.47375 -2.0625 5.6875 C-1.32106407 3.81210323 -0.63771783 1.91315348 0 0 Z " fill="#F9E67F" transform="translate(673,527)"/><path d="M0 0 C0.69480469 0.26039063 1.38960938 0.52078125 2.10546875 0.7890625 C0.56625802 5.00727924 -2.55072101 7.13064762 -6.01953125 9.7265625 C-7.29402331 10.70305224 -8.56741829 11.68097513 -9.83984375 12.66015625 C-10.50532227 13.17046387 -11.17080078 13.68077148 -11.85644531 14.20654297 C-15.25041054 16.84186671 -18.56985976 19.56722272 -21.89453125 22.2890625 C-31.77146744 30.3465318 -41.80044152 38.19585397 -51.92163086 45.94335938 C-56.85892909 49.73563577 -61.72476571 53.61529304 -66.56542969 57.5300293 C-70.00431233 60.30644516 -73.49566136 62.95381392 -77.08203125 65.5390625 C-80.61283719 68.24181827 -82.41073717 70.87039059 -84.04296875 74.9921875 C-85.01517148 77.04362444 -86.2217049 78.27510793 -87.89453125 79.7890625 C-88.39247951 73.81368336 -87.38720929 69.71878246 -83.89453125 64.7890625 C-81.12221279 61.82786081 -78.06075858 59.31843098 -74.89453125 56.7890625 C-74.38067871 56.37785156 -73.86682617 55.96664062 -73.33740234 55.54296875 C-69.82171794 52.73791247 -66.27808145 49.96998411 -62.72509766 47.21240234 C-59.77226994 44.91645868 -56.83390157 42.60219224 -53.89453125 40.2890625 C-50.42150977 37.55794535 -46.94704158 34.82878677 -43.46484375 32.109375 C-37.22383685 27.23004233 -31.03516933 22.29423957 -24.89453125 17.2890625 C-23.55473521 16.20306614 -22.21489168 15.11712836 -20.875 14.03125 C-18.21245235 11.87122971 -15.57340876 9.68613419 -12.9453125 7.484375 C-11.69957758 6.46050075 -10.45349921 5.43704421 -9.20703125 4.4140625 C-8.64306641 3.93130859 -8.07910156 3.44855469 -7.49804688 2.95117188 C-4.82554135 0.78279073 -3.50845132 -0.25567661 0 0 Z " fill="#FCE12F" transform="translate(220.89453125,655.2109375)"/><path d="M0 0 C48.28074347 -0.02298656 96.56148635 -0.04055889 144.84223424 -0.05106533 C150.56743025 -0.05231575 156.29262626 -0.0536101 162.01782227 -0.05493164 C163.15740498 -0.05519395 164.2969877 -0.05545626 165.47110323 -0.05572652 C183.82180593 -0.0600548 202.17250544 -0.0679264 220.52320626 -0.0771528 C239.41158064 -0.08656894 258.29995336 -0.09207229 277.18832999 -0.09408849 C287.7727954 -0.09532671 298.35725414 -0.09828114 308.94171715 -0.10573006 C394.84241232 -0.16450945 394.84241232 -0.16450945 430 1 C430 1.33 430 1.66 430 2 C422.87899082 2.78749984 415.75502633 3.29431629 408.60546875 3.74609375 C405.66032565 3.95349819 402.74481496 4.22724338 399.8125 4.5625 C391.85673407 5.39785542 383.88044337 5.43280789 376 4 C376 3.34 376 2.68 376 2 C251.92 1.67 127.84 1.34 0 1 C0 0.67 0 0.34 0 0 Z " fill="#EDDCA2" transform="translate(122,820)"/><path d="M0 0 C6.15234375 -0.09765625 6.15234375 -0.09765625 8 0 C8.33 0.33 8.66 0.66 9 1 C10.0828125 1.07347656 11.165625 1.14695312 12.28125 1.22265625 C18.50369387 1.94243717 23.87894492 4.81954043 29.5 7.4375 C31.90258896 8.53236732 34.30603869 9.62508573 36.7109375 10.71484375 C37.31718964 10.99069305 37.92344177 11.26654236 38.54806519 11.55075073 C45.64408466 14.76863478 52.83994823 17.73761123 60.04492188 20.70092773 C65.73859772 23.04541196 71.38856377 25.46457729 77 28 C75.4375 30.5625 75.4375 30.5625 73 33 C67.60664636 32.74582807 63.07372018 31.00544036 58.20703125 28.82421875 C57.47060898 28.50276382 56.73418671 28.1813089 55.97544861 27.85011292 C53.58406787 26.80418238 51.19820117 25.74631372 48.8125 24.6875 C46.3278362 23.59344107 43.84217793 22.50166733 41.35635376 21.4102478 C39.68157031 20.67479366 38.00723418 19.93832004 36.33334351 19.20083618 C31.03798058 16.87314785 25.71896344 14.61427628 20.37109375 12.41015625 C19.06331319 11.86714078 17.75561207 11.32393394 16.44799805 10.78051758 C14.02645381 9.77456025 11.59985947 8.7868872 9.16723633 7.80737305 C8.09626709 7.36047119 7.02529785 6.91356934 5.921875 6.453125 C4.98956055 6.07317383 4.05724609 5.69322266 3.09667969 5.30175781 C1 4 1 4 0.19238281 1.84667969 C0.12889648 1.23727539 0.06541016 0.62787109 0 0 Z " fill="#EAB224" transform="translate(549,429)"/><path d="M0 0 C7.62603713 0.01147165 15.25207553 0.01674814 22.87811923 0.021703 C38.47884169 0.03196795 54.07954675 0.04938441 69.68025649 0.07202661 C69.68025649 0.40202661 69.68025649 0.73202661 69.68025649 1.07202661 C64.80951265 2.03503325 60.05237874 2.24096093 55.10457289 2.27734888 C53.84504805 2.29219827 53.84504805 2.29219827 52.56007826 2.30734766 C49.80068662 2.33878855 47.04127779 2.36365083 44.28181899 2.38843286 C42.36224875 2.40901744 40.44268289 2.4300143 38.52312148 2.45140588 C33.48276257 2.50647122 28.44236381 2.55594874 23.40193617 2.60425317 C18.25378832 2.65458196 13.105698 2.71020852 7.95760024 2.76538599 C-2.13479848 2.87277739 -12.22724725 2.97426424 -22.31974351 3.07202661 C-22.31974351 3.40202661 -22.31974351 3.73202661 -22.31974351 4.07202661 C-29.0102675 4.85223832 -35.590025 5.22073457 -42.32364976 5.20483911 C-43.24580781 5.20579584 -44.16796587 5.20675256 -45.1180681 5.20773828 C-47.05842219 5.20841417 -48.99877862 5.20660144 -50.93912828 5.2023977 C-53.85055933 5.19708443 -56.76183307 5.20234067 -59.67325914 5.20874536 C-90.87464524 5.22152322 -90.87464524 5.22152322 -103.31974351 2.07202661 C-103.64974351 2.73202661 -103.97974351 3.39202661 -104.31974351 4.07202661 C-106.62974351 3.41202661 -108.93974351 2.75202661 -111.31974351 2.07202661 C-111.31974351 1.74202661 -111.31974351 1.41202661 -111.31974351 1.07202661 C-74.20897306 0.08150281 -37.12026764 -0.05689323 0 0 Z " fill="#D3B979" transform="translate(805.319743514061,819.9279733896255)"/><path d="M0 0 C0 40.59 0 81.18 0 123 C-0.33 123 -0.66 123 -1 123 C-1.33 84.06 -1.66 45.12 -2 5 C-2.33 5.99 -2.66 6.98 -3 8 C-5.16699219 9.52709961 -5.16699219 9.52709961 -8.046875 11.15234375 C-9.11019043 11.75868652 -10.17350586 12.3650293 -11.26904297 12.98974609 C-12.41775879 13.63250488 -13.56647461 14.27526367 -14.75 14.9375 C-15.92770742 15.60416616 -17.10495032 16.27165357 -18.28173828 16.93994141 C-20.68131885 18.30143695 -23.08347393 19.65823147 -25.48730469 21.01220703 C-28.75805445 22.85807016 -32.01013269 24.73488898 -35.2578125 26.62109375 C-36.20946289 27.17224854 -37.16111328 27.72340332 -38.14160156 28.29125977 C-39.92894899 29.32685487 -41.71482183 30.36500025 -43.49902344 31.40600586 C-44.70220215 32.09835327 -44.70220215 32.09835327 -45.9296875 32.8046875 C-46.62304199 33.20671387 -47.31639648 33.60874023 -48.03076172 34.02294922 C-50.01189189 35.00590024 -51.84052908 35.55119248 -54 36 C-52.66666667 34.66666667 -51.33333333 33.33333333 -50 32 C-51.65 31.67 -53.3 31.34 -55 31 C-52.12443819 28.76238983 -49.17829802 26.85850364 -46.02734375 25.03125 C-45.05385986 24.46510986 -44.08037598 23.89896973 -43.07739258 23.31567383 C-42.04122803 22.71650146 -41.00506348 22.1173291 -39.9375 21.5 C-38.87362061 20.88213623 -37.80974121 20.26427246 -36.71362305 19.62768555 C-33.47732652 17.74905252 -30.2389735 15.87401317 -27 14 C-25.12238596 12.91277747 -23.24478116 11.82553897 -21.3671875 10.73828125 C-18.90489896 9.31261179 -16.44232794 7.88745557 -13.97827148 6.46484375 C-13.25969971 6.04976562 -12.54112793 5.6346875 -11.80078125 5.20703125 C-11.13900879 4.82627441 -10.47723633 4.44551758 -9.79541016 4.05322266 C-8.23225926 3.13624782 -6.69724941 2.17163031 -5.16796875 1.19921875 C-3 0 -3 0 0 0 Z " fill="#F2E58F" transform="translate(974,217)"/><path d="M0 0 C0.81085052 -0.00095673 1.62170105 -0.00191345 2.4571228 -0.00289917 C4.16672849 -0.00357833 5.87633679 -0.00174248 7.5859375 0.00244141 C10.2083918 0.00780729 12.83067592 0.00248038 15.453125 -0.00390625 C17.11458371 -0.00324569 18.77604232 -0.001965 20.4375 0 C21.22395905 -0.00202423 22.01041809 -0.00404846 22.82070923 -0.00613403 C28.3559982 0.01784285 28.3559982 0.01784285 30.5859375 1.1328125 C32.03106154 4.7456226 32.5859375 7.19969092 32.5859375 11.1328125 C19.0559375 11.1328125 5.5259375 11.1328125 -8.4140625 11.1328125 C-12.4140625 3.1328125 -12.4140625 3.1328125 -12.4140625 1.1328125 C-8.27471561 -0.02324975 -4.26963247 -0.01104627 0 0 Z " fill="#B97D05" transform="translate(711.4140625,641.8671875)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1 39.6 1 79.2 1 120 C-12.86 119.505 -12.86 119.505 -27 119 C-25.79936908 115.39810723 -24.60185363 114.65694143 -21.625 112.375 C-17.7479372 109.36136354 -13.91504375 106.31021078 -10.125 103.1875 C-5.10246121 99.05086091 -5.10246121 99.05086091 -2.88128662 97.94828796 C0.20439251 94.75271348 -0.429856 91.12156923 -0.45410156 86.84692383 C-0.44376389 85.91014297 -0.43342621 84.97336212 -0.42277527 84.00819397 C-0.39324566 80.90763304 -0.39184594 77.80772201 -0.390625 74.70703125 C-0.37565023 72.55896247 -0.35892458 70.41090524 -0.34051514 68.26286316 C-0.29675058 62.60592127 -0.2768223 56.9491347 -0.26177979 51.29205322 C-0.24224154 45.52078023 -0.20026788 39.74967581 -0.16015625 33.97851562 C-0.08475546 22.65239563 -0.03452374 11.32631317 0 0 Z " fill="#6D4809" transform="translate(972,220)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C2.83819158 1.62249941 3.6704116 3.24808497 4.5 4.875 C4.9640625 5.77992188 5.428125 6.68484375 5.90625 7.6171875 C7 10 7 10 7 12 C7.99 12.33 8.98 12.66 10 13 C10.73578693 14.97561688 11.39031621 16.98189938 12 19 C13.0059248 21.14215073 14.04794389 23.2677163 15.125 25.375 C15.93324219 26.96441406 15.93324219 26.96441406 16.7578125 28.5859375 C17.16773438 29.38257813 17.57765625 30.17921875 18 31 C18.66 31 19.32 31 20 31 C20.09152344 31.67417969 20.18304688 32.34835938 20.27734375 33.04296875 C21.18352775 36.75097572 22.81283099 39.94828493 24.5625 43.3125 C24.89185547 43.95767578 25.22121094 44.60285156 25.56054688 45.26757812 C26.36824255 46.84785228 27.18337613 48.42432105 28 50 C28.66 50 29.32 50 30 50 C30.3403125 51.6396875 30.3403125 51.6396875 30.6875 53.3125 C32.22793028 57.64037555 33.0274121 58.01370605 37 60 C38.91988481 60.69645477 40.85923972 61.34102602 42.8125 61.9375 C46.37240993 63.07788527 49.70311885 64.23751637 53 66 C56.24159369 67.72884997 59.50089131 68.88028522 63 70 C67.24865276 71.36297632 71.09717607 72.93010516 75.03515625 75.0078125 C78.89878112 76.95882784 82.97147361 78.42762766 87 80 C89.50076206 80.99814667 92.00076862 81.99804029 94.5 83 C95.6859375 83.474375 96.871875 83.94875 98.09375 84.4375 C98.71934814 84.68798096 99.34494629 84.93846191 99.98950195 85.1965332 C101.37799619 85.75142507 102.76720281 86.30453653 104.15698242 86.85620117 C111.18430499 89.65182965 118.17402987 92.53686614 125.16369629 95.42489624 C138.00564429 100.72950423 150.8675311 105.98213627 163.75 111.1875 C180.56411662 117.98217218 197.32856831 124.89515334 214.08496094 131.83081055 C215.04110291 132.22654266 215.99724487 132.62227478 216.98236084 133.02999878 C218.77665803 133.77282476 220.57081552 134.51598831 222.36480713 135.259552 C226.23449808 136.86226851 230.10558834 138.45796733 234 140 C234 140.66 234 141.32 234 142 C227.8004682 140.02269999 221.78233841 137.76594519 215.78125 135.25390625 C214.90744186 134.89129196 214.03363373 134.52867767 213.13334656 134.15507507 C211.24504984 133.37123252 209.35730523 132.58605887 207.47006226 131.79968262 C202.30206634 129.64694838 197.12924174 127.50586485 191.95703125 125.36328125 C190.88302567 124.9181015 189.80902008 124.47292175 188.70246887 124.01425171 C177.54487893 119.39170008 166.36971752 114.81261148 155.1875 110.25 C153.69783218 109.64214157 153.69783218 109.64214157 152.17807007 109.02200317 C118.77764004 95.39927861 85.33642946 81.86900688 51.81958008 68.53515625 C49.82721894 67.74154998 47.83925548 66.93676861 45.85693359 66.1184082 C42.97489966 64.94889912 42.97489966 64.94889912 39.83447266 64.02807617 C33.70129075 61.97878375 30.4518639 60.06730275 27.1875 54.37890625 C26.08754161 52.12466643 25.02648177 49.85113295 24 47.5625 C23.42230434 46.35147705 22.84028436 45.14250828 22.25415039 43.93554688 C21.3610644 42.0939328 20.47143511 40.25132396 19.59645081 38.40103149 C16.78693685 32.46129385 13.64552445 26.73127455 10.4375 21 C6.59923143 14.13954939 3.16246999 7.19917432 0 0 Z " fill="#9E8856" transform="translate(285,140)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.02465504 4.39656173 1.04283842 8.7930872 1.05493164 13.18969727 C1.05997121 14.68644918 1.06680287 16.18319616 1.07543945 17.67993164 C1.08752159 19.82699807 1.09323191 21.97399962 1.09765625 24.12109375 C1.10289307 25.4145874 1.10812988 26.70808105 1.11352539 28.04077148 C1 31 1 31 0 32 C-1.56887635 32.09591199 -3.14207792 32.12187996 -4.71388245 32.12025452 C-6.2431134 32.12231651 -6.2431134 32.12231651 -7.80323792 32.12442017 C-8.931082 32.12082489 -10.05892609 32.11722961 -11.22094727 32.11352539 C-12.40127533 32.11367142 -13.58160339 32.11381744 -14.79769897 32.1139679 C-18.04342108 32.11338895 -21.28910055 32.10835986 -24.53481412 32.10139394 C-27.92343032 32.09515962 -31.31204728 32.09455654 -34.70066833 32.09336853 C-41.12155804 32.09025544 -47.54243081 32.08204236 -53.96331304 32.07201904 C-61.27153825 32.0608572 -68.57976424 32.05534727 -75.88799584 32.05032361 C-90.92534002 32.03985973 -105.96266832 32.02226073 -121 32 C-121 31.01 -121 30.02 -121 29 C-81.4 29 -41.8 29 -1 29 C-1 19.76 -1 10.52 -1 1 C-0.67 0.67 -0.34 0.34 0 0 Z " fill="#987C51" transform="translate(392,730)"/><path d="M0 0 C20.69647316 -0.04666797 41.39293769 -0.08196327 62.08945274 -0.10362434 C71.69865042 -0.11394814 81.30781546 -0.12802947 90.91699219 -0.15087891 C99.28985605 -0.1707791 107.66269628 -0.18370841 116.03558314 -0.18817699 C120.47121456 -0.1907901 124.90677835 -0.1969548 129.34238815 -0.21146011 C133.51360245 -0.22499085 137.68472097 -0.22923183 141.85595512 -0.22621536 C143.39027488 -0.22676756 144.9245977 -0.23077179 146.45889854 -0.23841095 C148.5471304 -0.24830188 150.63499648 -0.24599063 152.72323608 -0.24050903 C153.89391317 -0.24235262 155.06459026 -0.24419621 156.27074242 -0.24609566 C159 0 159 0 161 2 C160 3 160 3 157.87792873 3.12304783 C156.4634374 3.12166514 156.4634374 3.12166514 155.02037048 3.12025452 C153.40279091 3.12231651 153.40279091 3.12231651 151.75253296 3.12442017 C150.5592337 3.12082489 149.36593445 3.11722961 148.13647461 3.11352539 C146.88787155 3.11367142 145.63926849 3.11381744 144.35282898 3.1139679 C140.91909006 3.11338891 137.48541062 3.10835955 134.05168223 3.10139394 C130.46687541 3.09515998 126.88206787 3.09455657 123.29725647 3.09336853 C116.50449955 3.09025534 109.71175865 3.08204212 102.91900879 3.07201904 C95.18757506 3.06085753 87.45614058 3.05534736 79.72470081 3.05032361 C63.81645792 3.03985949 47.90823102 3.02226029 32 3 C32 2.67 32 2.34 32 2 C21.44 1.67 10.88 1.34 0 1 C0 0.67 0 0.34 0 0 Z " fill="#FEEA19" transform="translate(714,13)"/><path d="M0 0 C5.4930136 2.32396729 9.41485047 6.21838184 13.125 10.75 C26.27678611 25.9980315 45.60967769 32.98963033 65 36 C65 36.66 65 37.32 65 38 C66.98 38 68.96 38 71 38 C71 38.99 71 39.98 71 41 C50.71398157 42.6411161 31.4556472 34.78880921 16.01953125 21.91015625 C9.76544678 15.99478429 3.68043996 9.8627581 0 2 C0 1.34 0 0.68 0 0 Z " fill="#F7CA19" transform="translate(57,783)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1 22.11 1 44.22 1 67 C1.66 67 2.32 67 3 67 C3.02355355 77.86929514 3.04112757 88.73858386 3.05181217 99.60789967 C3.0569497 104.65926348 3.06387266 109.71060938 3.07543945 114.76196289 C3.13142693 139.86101077 2.91846271 164.91629103 2 190 C1.67 190 1.34 190 1 190 C-0.34725956 171.23517861 -0.13095275 152.44456664 -0.10139394 133.64417553 C-0.09507079 128.93305292 -0.09454961 124.22192942 -0.09336853 119.51080322 C-0.0902813 110.62205548 -0.08210369 101.73332029 -0.07201904 92.84457803 C-0.06077612 82.71129787 -0.055327 72.57801705 -0.05032361 62.44473219 C-0.03991839 41.6298145 -0.02237037 20.81490805 0 0 Z " fill="#F4B808" transform="translate(16,491)"/><path d="M0 0 C0 23.43 0 46.86 0 71 C-1.98 70.34 -3.96 69.68 -6 69 C-6 68.34 -6 67.68 -6 67 C-7.32 66.34 -8.64 65.68 -10 65 C-8.35 65 -6.7 65 -5 65 C-5.0169693 64.29700272 -5.0339386 63.59400543 -5.05142212 62.8697052 C-5.20971534 56.23448611 -5.35788477 49.59912647 -5.49477577 42.96342945 C-5.56550232 39.55220614 -5.64009761 36.1411602 -5.72363281 32.73022461 C-5.81956601 28.80604421 -5.89849536 24.88160936 -5.9765625 20.95703125 C-6.00875885 19.73603226 -6.0409552 18.51503326 -6.0741272 17.2570343 C-6.09429901 16.1162291 -6.11447083 14.97542389 -6.13525391 13.80004883 C-6.15746002 12.79855301 -6.17966614 11.79705719 -6.20254517 10.76521301 C-5.92237903 6.94029301 -4.94736312 4.09894122 -2.4375 1.1875 C-1 0 -1 0 0 0 Z " fill="#9E7125" transform="translate(618,353)"/><path d="M0 0 C0 3.99897642 -1.35316035 5.06701552 -4 8 C-5.1446875 8.8971875 -5.1446875 8.8971875 -6.3125 9.8125 C-8.51158363 11.60245179 -10.07217783 13.17308955 -11.875 15.3125 C-16.13005694 20.30960881 -20.81124395 24.86446041 -25.49365234 29.45629883 C-29.07414163 32.98902971 -32.46389461 36.59312329 -35.68041992 40.46166992 C-37.65800188 42.76708045 -39.85322209 44.85322209 -42 47 C-42.66 47.99 -43.32 48.98 -44 50 C-44.66 50 -45.32 50 -46 50 C-46 50.66 -46 51.32 -46 52 C-46.66 52 -47.32 52 -48 52 C-48.28875 52.639375 -48.5775 53.27875 -48.875 53.9375 C-50 56 -50 56 -52 57 C-51.38722388 59.96175123 -50.74627478 61.38058783 -49 64 C-49.495 65.485 -49.495 65.485 -50 67 C-50.47179687 66.29423828 -50.47179687 66.29423828 -50.953125 65.57421875 C-54.2987247 60.70697581 -56.97201559 57.1538716 -63 56 C-73.50981139 54.90463204 -73.50981139 54.90463204 -83.1875 58 C-86.11247136 60.65003932 -88.03634389 63.95303536 -89.859375 67.42578125 C-90.23578125 67.94527344 -90.6121875 68.46476563 -91 69 C-91.99 69 -92.98 69 -94 69 C-94.33452052 76.43378943 -94.13902852 82.19877155 -91 89 C-91.99 89 -92.98 89 -94 89 C-96.89720746 82.48128322 -97.23613076 75.053359 -95.16015625 68.24609375 C-92.06226698 61.41404838 -87.55405252 56.22925648 -80.765625 52.90625 C-72.98154152 50.00734995 -66.75018782 50.36323639 -59.078125 53.34375 C-56.7274918 54.20075425 -56.7274918 54.20075425 -53 54 C-50.68240232 52.04485057 -48.61565306 50.10368491 -46.51171875 47.9375 C-45.89029495 47.31278809 -45.26887115 46.68807617 -44.62861633 46.04443359 C-42.6387333 44.03878396 -40.66338555 42.01943057 -38.6875 40 C-37.36870575 38.66971264 -36.04905326 37.34027552 -34.72851562 36.01171875 C-29.18777588 30.41788012 -23.71029848 24.81807586 -18.60424805 18.8203125 C-15.27292115 15.04031351 -11.6435809 11.54118882 -8.0625 8 C-6.89364258 6.83791016 -6.89364258 6.83791016 -5.70117188 5.65234375 C-3.8030758 3.76589243 -1.90266851 1.88183755 0 0 Z " fill="#F4D447" transform="translate(700,704)"/><path d="M0 0 C4.74375 0.92239583 4.74375 0.92239583 6.921875 1.58203125 C9.25598637 2.05148598 10.68975211 1.75755446 13 1.25 C19.41063816 0.44343278 24.34199259 3.27635349 30 6 C32.20627402 7.01856888 34.41330965 8.03548967 36.62109375 9.05078125 C37.69858887 9.55303223 38.77608398 10.0552832 39.88623047 10.57275391 C44.23090292 12.56420405 48.63284289 14.39481892 53.0625 16.1875 C53.77599609 16.47818359 54.48949219 16.76886719 55.22460938 17.06835938 C56.81520866 17.71519238 58.407389 18.35813614 60 19 C58.02 19.99 58.02 19.99 56 21 C56 20.34 56 19.68 56 19 C53.69 19.33 51.38 19.66 49 20 C49.66 20.66 50.32 21.32 51 22 C44.10133307 21.54203765 38.47954551 18.78928966 32.25 15.9375 C30.02791567 14.93883064 27.80525225 13.94144886 25.58203125 12.9453125 C24.47939941 12.4493457 23.37676758 11.95337891 22.24072266 11.44238281 C17.50057838 9.33263651 12.72458567 7.31298328 7.9375 5.3125 C7.12893555 4.97404053 6.32037109 4.63558105 5.48730469 4.28686523 C3.65895909 3.52276543 1.82961066 2.7610657 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FBD84C" transform="translate(501,410)"/><path d="M0 0 C1.65 1.32 3.3 2.64 5 4 C4.34 4 3.68 4 3 4 C3 16.21 3 28.42 3 41 C2.67 41 2.34 41 2 41 C1.67 35.72 1.34 30.44 1 25 C1 63.28 1 101.56 1 141 C0.34 141 -0.32 141 -1 141 C-2.27862506 123.09488034 -2.15377355 105.17353615 -2.13037109 87.23413086 C-2.12474061 82.86497588 -2.1280206 78.49588271 -2.13380814 74.12672997 C-2.15360005 56.51753906 -2.03915588 38.91959743 -1.5546875 21.31640625 C-1.53527225 20.57391066 -1.51585701 19.83141506 -1.49585342 19.0664196 C-1.43969401 16.97841649 -1.3771973 14.89071731 -1.31201172 12.80297852 C-1.2761496 11.62864761 -1.24028748 10.45431671 -1.20333862 9.24440002 C-1.00637301 6.10168553 -0.57727466 3.09339657 0 0 Z " fill="#EBCF4D" transform="translate(850,288)"/><path d="M0 0 C4 0.5 4 0.5 8 1 C9.18013672 1.0928125 10.36027344 1.185625 11.57617188 1.28125 C16.55477836 1.91041494 20.76823931 3.76371485 25.3125 5.81640625 C26.16682617 6.19232407 27.02115234 6.56824188 27.90136719 6.95555115 C30.60538329 8.14804863 33.30266191 9.35498474 36 10.5625 C37.84202071 11.37791887 39.68446484 12.19238194 41.52734375 13.00585938 C46.02320206 14.99288478 50.51308002 16.99287735 55 19 C52.02819033 20.98120645 50.48883564 21.65962579 47 22 C45.65753688 21.35191436 44.32567199 20.68177416 43 20 C41.89269531 19.92265625 40.78539062 19.8453125 39.64453125 19.765625 C33.47126646 19.05775544 28.08492994 16.20265997 22.5 13.625 C20.32380843 12.63605614 18.14674343 11.64903172 15.96875 10.6640625 C14.94587891 10.19814697 13.92300781 9.73223145 12.86914062 9.25219727 C10.37285082 8.16272565 7.88321839 7.21068194 5.3125 6.31640625 C2 5 2 5 0.5 2.3125 C0.335 1.549375 0.17 0.78625 0 0 Z " fill="#FCE059" transform="translate(461,391)"/><path d="M0 0 C7.4854504 11.2281756 6.68470966 28.26772177 6.69921875 41.25390625 C6.70324015 42.17496595 6.70726154 43.09602566 6.7114048 44.04499626 C6.73048064 48.89916635 6.72487938 53.75256232 6.69848633 58.60668945 C6.6765724 63.59128932 6.74395531 68.5706838 6.8303709 73.5544138 C6.88099301 77.42345449 6.86497076 81.29020765 6.83109474 85.15934563 C6.82655307 86.99692715 6.84685694 88.83475743 6.89340782 90.67175484 C7.21273323 104.5630233 7.21273323 104.5630233 3.51736832 108.63288498 C-0.08817215 111.48931726 -4.02687099 113.42357245 -8.24387169 115.21279716 C-10.59391388 116.26622809 -12.64063198 117.65636952 -14.75 119.125 C-15.8225 119.74375 -16.895 120.3625 -18 121 C-18.99 120.67 -19.98 120.34 -21 120 C-19.515 119.505 -19.515 119.505 -18 119 C-18 118.34 -18 117.68 -18 117 C-17.01 117 -16.02 117 -15 117 C-14.67 116.01 -14.34 115.02 -14 114 C-13.030625 113.87625 -12.06125 113.7525 -11.0625 113.625 C-9.5465625 113.315625 -9.5465625 113.315625 -8 113 C-7.505 112.01 -7.505 112.01 -7 111 C-5.22265625 109.9296875 -5.22265625 109.9296875 -3.0625 108.875 C-2.35222656 108.52179688 -1.64195312 108.16859375 -0.91015625 107.8046875 C1 107 1 107 3 107 C2.96168749 96.73230082 2.90196072 86.46495906 2.81609726 76.19754124 C2.77685938 71.42814979 2.74455628 66.65893645 2.72900391 61.8894043 C2.71367927 57.27258441 2.6789609 52.65625498 2.63169098 48.03965569 C2.61703803 46.29257447 2.60896842 44.54542317 2.60811615 42.79828072 C2.59860705 33.0645442 2.00598082 24.08967719 -0.60812759 14.67285252 C-1.80471587 10.3341611 -2.35461074 6.49974106 -2 2 C-1.34 1.34 -0.68 0.68 0 0 Z " fill="#F2B006" transform="translate(967,85)"/><path d="M0 0 C0.87813858 -0.00175232 1.75627716 -0.00350464 2.661026 -0.00531006 C5.53827957 -0.00967677 8.41547051 -0.00680506 11.29272461 -0.00341797 C13.32604484 -0.00409339 15.35936498 -0.0050654 17.39268494 -0.00631714 C21.65339934 -0.0077879 25.91409273 -0.00566292 30.17480469 -0.00097656 C35.56038423 0.00466648 40.94591374 0.00138729 46.33149147 -0.00442886 C88.93511453 -0.04324304 88.93511453 -0.04324304 109.63256836 1.12939453 C109.63256836 1.45939453 109.63256836 1.78939453 109.63256836 2.12939453 C103.23123815 3.28140359 96.94664122 3.26349513 90.45507812 3.24291992 C88.63938072 3.24313896 88.63938072 3.24313896 86.78700256 3.24336243 C83.48584462 3.24278724 80.18475007 3.23778957 76.88360333 3.23078847 C73.42695635 3.22451556 69.97030842 3.22394802 66.51365662 3.22276306 C59.9760941 3.21966132 53.43854841 3.2114636 46.90099329 3.20141357 C39.45478392 3.19021642 32.00857372 3.18473292 24.56235802 3.17971814 C9.25241841 3.16927997 -6.05750444 3.15170303 -21.36743164 3.12939453 C-16.68493692 -1.55310019 -6.35271025 -0.01599938 0 0 Z " fill="#6C4208" transform="translate(776.367431640625,852.87060546875)"/><path d="M0 0 C2.109375 0.41015625 2.109375 0.41015625 4 1 C2.34873032 3.83548422 0.61120224 5.99425468 -2 8 C-6.13763214 9.0281923 -10.18680479 8.88556102 -14.43115234 8.79467773 C-16.30515213 8.79621101 -16.30515213 8.79621101 -18.2170105 8.79777527 C-21.63094177 8.79374237 -25.04188497 8.75872486 -28.45528746 8.70975757 C-32.02663019 8.66590243 -35.59801573 8.66187901 -39.16958618 8.65357971 C-45.92713482 8.63185053 -52.68388769 8.57444636 -59.44108641 8.50413328 C-67.13625059 8.42580381 -74.83145342 8.38738196 -82.52691722 8.35226524 C-98.3517385 8.27916011 -114.17576651 8.15609133 -130 8 C-130.268125 8.94875 -130.53625 9.8975 -130.8125 10.875 C-132 14 -132 14 -135 16 C-133.8741386 12.46157845 -132.66905241 9.33810482 -131 6 C-88.43 6 -45.86 6 -2 6 C-2.33 5.01 -2.66 4.02 -3 3 C-1.75 1.4375 -1.75 1.4375 0 0 Z " fill="#BFA669" transform="translate(637,647)"/><path d="M0 0 C2.85359322 1.42679661 2.87581233 3.00216622 4 6 C5.05225932 8.34330056 6.12086292 10.67851619 7.1953125 13.01171875 C8 15 8 15 8 17 C9.32 17.66 10.64 18.32 12 19 C11.67 19.66 11.34 20.32 11 21 C12.32295768 22.32295768 13.65621227 23.63570564 15 24.9375 C17 27 17 27 19 30 C19.66 30 20.32 30 21 30 C21.33 31.65 21.66 33.3 22 35 C22.53625 35.061875 23.0725 35.12375 23.625 35.1875 C28.0098678 36.68758635 31.16322913 40.09349823 34.25 43.4375 C38.91267518 47.7822655 44.65044949 51.76821653 51 53 C51 53.66 51 54.32 51 55 C51.66515625 55.11214844 52.3303125 55.22429688 53.015625 55.33984375 C55.97899554 55.99535373 58.79862065 56.8968401 61.67236328 57.86621094 C68.38586544 60.11614139 73.85650164 61.46087086 81 61 C83.0079077 61.28181161 85.0137698 61.59256816 87 62 C86.34 63.32 85.68 64.64 85 66 C60.24784224 65.34549583 33.72101674 50.61314416 17 33 C13.40230553 28.85294912 10.16273255 24.48422395 7 20 C6.36578125 19.10925781 5.7315625 18.21851563 5.078125 17.30078125 C1.32488257 11.60836356 0.02899627 6.81412297 0 0 Z " fill="#916C3D" transform="translate(28,790)"/><path d="M0 0 C4.15267212 0.66978583 7.96661322 1.97102758 11.9140625 3.37890625 C14.11646845 4.14268568 14.11646845 4.14268568 17 4 C18.3348989 4.66352629 19.66810156 5.33047124 21 6 C22.46754882 6.31382186 23.94604689 6.57886844 25.4296875 6.8046875 C32.00494082 8.03860393 37.96783714 10.56906146 44.125 13.125 C45.27226563 13.59292969 46.41953125 14.06085938 47.6015625 14.54296875 C50.4043785 15.68745195 53.20361972 16.83990166 56 18 C54.19848633 20.49707031 54.19848633 20.49707031 52 23 C46.16200789 23.08616963 41.06222162 20.56975511 35.8125 18.25 C34.13168849 17.52172429 32.45069885 16.79385958 30.76953125 16.06640625 C29.95693848 15.7120752 29.1443457 15.35774414 28.30712891 14.99267578 C26.28118665 14.12098465 24.24788545 13.28131319 22.19921875 12.46484375 C21.14347656 12.04332031 20.08773437 11.62179687 19 11.1875 C18.0925 10.83042969 17.185 10.47335937 16.25 10.10546875 C14 9 14 9 12.5078125 7.4921875 C10.51220539 5.51726025 8.50373266 4.88399704 5.875 3.9375 C1.10875332 2.21750663 1.10875332 2.21750663 0 0 Z " fill="#EDBF45" transform="translate(562,334)"/><path d="M0 0 C21.78 0 43.56 0 66 0 C66.495 1.98 66.495 1.98 67 4 C31.69 4 -3.62 4 -40 4 C-40 3.67 -40 3.34 -40 3 C-11.29 2.505 -11.29 2.505 18 2 C12.06 1.67 6.12 1.34 0 1 C0 0.67 0 0.34 0 0 Z " fill="#FCE54B" transform="translate(833,529)"/><path d="M0 0 C4.99156546 3.81269051 8.51789903 7.98831158 12.1875 13.0625 C12.70763672 13.76955078 13.22777344 14.47660156 13.76367188 15.20507812 C14.73021157 16.51972024 15.69374893 17.83657971 16.65307617 19.15649414 C17.31980347 20.06902954 17.31980347 20.06902954 18 21 C18.43618652 21.7307373 18.87237305 22.46147461 19.32177734 23.21435547 C20.88998249 25.24740791 20.88998249 25.24740791 23.53686523 25.40649414 C25.03262085 25.34643188 25.03262085 25.34643188 26.55859375 25.28515625 C27.66783203 25.25873047 28.77707031 25.23230469 29.91992188 25.20507812 C31.08072266 25.15802734 32.24152344 25.11097656 33.4375 25.0625 C49.94518026 24.42940637 65.81407036 27.95930317 78.62890625 38.95703125 C89.91086147 49.40721123 98.42857406 62.64562014 101 78 C101.03824623 80.33301986 101.04574284 82.66711508 101 85 C100.67 85 100.34 85 100 85 C99.70609375 83.5459375 99.70609375 83.5459375 99.40625 82.0625 C95.30389879 63.13590581 87.14237849 47.28882045 70.5625 36.5 C60.07973889 30.49737132 49.61967124 27.81097151 37.625 27.875 C36.90828125 27.87113281 36.1915625 27.86726562 35.453125 27.86328125 C31.73982583 27.86998396 28.43061347 28.11178315 24.796875 28.890625 C21 29 21 29 18.1640625 26.4921875 C17.28923847 25.30695287 16.44414544 24.09937696 15.625 22.875 C14.69431142 21.58572016 13.76331418 20.29666308 12.83203125 19.0078125 C12.36748535 18.34426758 11.90293945 17.68072266 11.42431641 16.99707031 C8.75529318 13.25476486 5.85070267 9.69116041 2.99658203 6.08935547 C0 2.2240216 0 2.2240216 0 0 Z " fill="#997D47" transform="translate(787,529)"/><path d="M0 0 C6.15234375 -0.09765625 6.15234375 -0.09765625 8 0 C8.33 0.33 8.66 0.66 9 1 C10.05574219 1.06316406 11.11148438 1.12632812 12.19921875 1.19140625 C18.22954755 1.88147064 23.51054399 4.58085721 28.97436523 7.0925293 C30.82133605 7.94156184 32.67445716 8.77573962 34.52929688 9.60742188 C43.49774781 13.66516521 43.49774781 13.66516521 47 16 C45.700625 15.979375 44.40125 15.95875 43.0625 15.9375 C41.70834367 15.91600546 40.35243917 15.92851801 39 16 C38.505 16.495 38.505 16.495 38 17 C30.69893395 18.04888555 24.86862609 14.63828357 18.375 11.625 C16.15383324 10.61677453 13.93248573 9.60894714 11.7109375 8.6015625 C10.73431152 8.15119629 9.75768555 7.70083008 8.75146484 7.23681641 C6.9266659 6.41654742 5.07205484 5.65946818 3.19384766 4.97021484 C2.46987793 4.65004395 1.7459082 4.32987305 1 4 C0.1875 1.875 0.1875 1.875 0 0 Z " fill="#F2BD2B" transform="translate(549,429)"/><path d="M0 0 C0.42410156 0.39832031 0.84820312 0.79664063 1.28515625 1.20703125 C5.32767445 4.85862461 8.88650302 7.12157254 14 9 C13.01 9.33 12.02 9.66 11 10 C10.62320279 14.39596744 11.69940663 16.31905061 14 20 C15.24384596 22.26429609 16.47406558 24.53208534 17.6875 26.8125 C18.03127686 27.45759521 18.37505371 28.10269043 18.72924805 28.76733398 C22.62064543 36.11107665 26.31291171 43.55224517 30 51 C30.57105469 52.10214844 31.14210938 53.20429688 31.73046875 54.33984375 C33 57 33 57 33 59 C33.99 59.495 33.99 59.495 35 60 C35 60.99 35 61.98 35 63 C35.66 63 36.32 63 37 63 C36.505 64.98 36.505 64.98 36 67 C32.56163809 65.85387936 32.45608868 65.53693893 30.92211914 62.47192383 C30.54026459 61.72146286 30.15841003 60.97100189 29.76498413 60.19779968 C29.35914093 59.3758461 28.95329773 58.55389252 28.53515625 57.70703125 C28.10514313 56.85683914 27.67513 56.00664703 27.23208618 55.13069153 C25.83352433 52.36225022 24.44812086 49.58743743 23.0625 46.8125 C21.16897316 43.05350037 19.2685687 39.29800047 17.3671875 35.54296875 C16.66957558 34.16232239 16.66957558 34.16232239 15.95787048 32.75378418 C11.89297893 24.73167018 7.64145699 16.82875895 3.20141602 9.00708008 C2.55064087 7.84728638 2.55064087 7.84728638 1.88671875 6.6640625 C1.33310669 5.69654053 1.33310669 5.69654053 0.76831055 4.70947266 C0 3 0 3 0 0 Z " fill="#C39F46" transform="translate(410,369)"/><path d="M0 0 C0.96099609 0.30744141 0.96099609 0.30744141 1.94140625 0.62109375 C6.97546809 2.18908022 11.75772262 3.33280106 17 4 C23.08563099 5.10605881 28.63160157 6.84522624 34.31640625 9.2578125 C35.05833725 9.56572723 35.80026825 9.87364197 36.56468201 10.19088745 C38.90023727 11.16202544 41.23137015 12.14329374 43.5625 13.125 C45.15922212 13.79104363 46.75622515 14.45641428 48.35351562 15.12109375 C52.23896277 16.73964609 56.12048251 18.36728889 60 20 C60 20.33 60 20.66 60 21 C55.86484243 20.52286643 52.6797192 19.90800255 49 18 C48.01 18.495 48.01 18.495 47 19 C44.6875 18.22265625 44.6875 18.22265625 42 17.0625 C38.61082782 15.50259272 38.61082782 15.50259272 35 15 C41.93 17.97 41.93 17.97 49 21 C45.01064903 22.32978366 42.74202849 20.95661792 39.05859375 19.39453125 C38.37628189 19.11405441 37.69397003 18.83357758 36.99098206 18.54460144 C34.80269359 17.64277467 32.62011501 16.727961 30.4375 15.8125 C28.99450611 15.21461192 27.55115011 14.61759703 26.10742188 14.02148438 C23.99993902 13.15101282 21.8933025 12.2788136 19.78948975 11.39950562 C15.18226793 9.47428103 10.54830851 7.64036029 5.8659668 5.90405273 C3.08535095 4.55685654 1.58584355 2.59501672 0 0 Z " fill="#F9CE42" transform="translate(528,320)"/><path d="M0 0 C3.7449616 3.65644433 7.22819804 7.45699535 10.625 11.4375 C11.14787598 12.04875732 11.67075195 12.66001465 12.20947266 13.28979492 C16.16584575 17.94733519 19.9668694 22.7098684 23.71337891 27.53686523 C27.39086626 32.26291399 31.17885452 36.88959247 35 41.5 C39.28637112 46.67172607 43.50686846 51.88085393 47.625 57.1875 C51.83344886 62.60445351 56.22692187 67.83220432 60.71777344 73.01660156 C64.3333626 77.19645972 67.81568472 81.46388966 71.2421875 85.80078125 C73.74950236 88.93771072 76.3650854 91.96984821 79 95 C80.32286246 90.03926578 80.08893197 85.08888488 80 80 C80.66 80 81.32 80 82 80 C82 77.69 82 75.38 82 73 C81.34 72.67 80.68 72.34 80 72 C81.65 70.68 83.3 69.36 85 68 C84.51529965 78.54641106 82.99225129 88.65031721 81 99 C77.44997371 97.5409782 75.73986477 95.72582586 73.4375 92.6875 C70.28250358 88.61521759 67.03969478 84.65872535 63.6875 80.75 C59.43928375 75.77102605 55.35952376 70.68462855 51.34106445 65.51928711 C45.88687716 58.53150049 40.21808345 51.72130609 34.56591797 44.89355469 C31.02471817 40.61143033 27.51195229 36.30611236 24 32 C23.51708496 31.40896484 23.03416992 30.81792969 22.53662109 30.20898438 C18.67705032 25.48394849 14.83098391 20.7482458 11 16 C10.45359863 15.32308105 9.90719727 14.64616211 9.34423828 13.94873047 C7.78593818 12.01223408 6.23534157 10.06986115 4.6875 8.125 C4.21328613 7.53614014 3.73907227 6.94728027 3.25048828 6.34057617 C0 2.23081247 0 2.23081247 0 0 Z " fill="#96794C" transform="translate(883,652)"/><path d="M0 0 C2 2 2 2 2.0625 4.5625 C2.041875 5.366875 2.02125 6.17125 2 7 C2.33 7.33 2.66 7.66 3 8 C3.09509559 10.61688441 3.12556 13.207289 3.11352539 15.82446289 C3.11367142 16.64390884 3.11381744 17.4633548 3.1139679 18.30763245 C3.11326852 21.02933353 3.10547501 23.75096705 3.09765625 26.47265625 C3.09579216 28.35452741 3.09436821 30.23639906 3.09336853 32.11827087 C3.08954267 37.08148529 3.07971181 42.04467064 3.06866455 47.00787354 C3.0584519 52.06839606 3.05387122 57.12892327 3.04882812 62.18945312 C3.0380896 72.12631488 3.02101236 82.06315503 3 92 C1.515 92.495 1.515 92.495 0 93 C0 62.31 0 31.62 0 0 Z " fill="#F3B805" transform="translate(938,118)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.00423194 1.1404414 1.00846388 2.2808828 1.01282406 3.45588303 C1.11592731 31.18006877 1.22466408 58.90422802 1.33933926 86.62836838 C1.35034405 89.29521428 1.36134084 91.96206022 1.37231445 94.62890625 C1.37504276 95.29177349 1.37777106 95.95464073 1.38058204 96.63759485 C1.42467739 107.37578343 1.46530404 118.11398249 1.50465261 128.85218939 C1.54509397 139.8675857 1.58932759 150.88296207 1.63687855 161.89832997 C1.66347192 168.08674204 1.68832486 174.27515025 1.70907402 180.4635849 C1.72864525 186.28456299 1.75279058 192.10550392 1.78049088 197.92644882 C1.78985871 200.0662379 1.79753496 202.20603514 1.80341911 204.34583664 C1.81168477 207.26093314 1.82596288 210.17593957 1.84178162 213.09100342 C1.84275972 213.94314257 1.84373783 214.79528173 1.84474558 215.67324328 C1.87015321 219.29926037 2.11604931 222.50219047 3 226 C3.06831987 228.4157906 3.08487642 230.83334713 3.0625 233.25 C3.05347656 234.51328125 3.04445313 235.7765625 3.03515625 237.078125 C3.01775391 238.52445313 3.01775391 238.52445313 3 240 C2.67 240 2.34 240 2 240 C-0.44999708 228.25371475 -0.26944623 216.62785119 -0.22705078 204.6862793 C-0.22648581 202.44793706 -0.22680491 200.20959446 -0.22793579 197.97125244 C-0.22850694 191.92879363 -0.21679125 185.88641508 -0.20278788 179.84397483 C-0.19024073 173.51657763 -0.18910688 167.18917835 -0.18673706 160.86177063 C-0.18123766 150.25264126 -0.16876603 139.64353803 -0.15087891 129.03442383 C-0.13248486 118.11320134 -0.11834567 107.19198683 -0.10986328 96.27075195 C-0.10933783 95.59611936 -0.10881239 94.92148677 -0.10827102 94.22641077 C-0.1056607 90.84154489 -0.10313334 87.45667896 -0.10064721 84.07181299 C-0.07995697 56.04785501 -0.04461862 28.02392933 0 0 Z " fill="#E3C243" transform="translate(15,528)"/><path d="M0 0 C13.22098616 10.34685873 27.0976425 28.31676691 31 45 C30.11328125 47.33203125 30.11328125 47.33203125 29 49 C25.64068888 46.25707624 24.22005031 42.52419285 22.4375 38.6875 C18.9991464 31.51565515 14.87356344 25.23457919 10.1015625 18.890625 C8.44646665 16.6140991 7.13074212 14.55970194 6 12 C5.34 12 4.68 12 4 12 C0.3692252 8.51445619 0.39841065 4.7809278 0 0 Z " fill="#FBCE13" transform="translate(936,37)"/><path d="M0 0 C0.4861377 0.36496582 0.97227539 0.72993164 1.47314453 1.10595703 C4.95499776 3.71880922 8.43888473 6.32880106 11.9296875 8.9296875 C38.60778498 28.82335495 38.60778498 28.82335495 41 36 C41.53942108 42.47305293 40.59445247 45.6083213 37 51 C36.67 50.01 36.34 49.02 36 48 C36.495 47.030625 36.99 46.06125 37.5 45.0625 C39.21609696 42.26643107 39.21609696 42.26643107 38.75390625 40.02734375 C34.89640185 29.65405471 21.49513239 22.67284466 12.91503906 16.5 C10.95047723 15.08015329 9.00572178 13.63635114 7.0625 12.1875 C6.4655835 11.76815186 5.86866699 11.34880371 5.25366211 10.91674805 C2.00655678 8.46813478 1.0471317 7.20507525 0.12109375 3.17578125 C0.08113281 2.12777344 0.04117188 1.07976563 0 0 Z " fill="#FBE135" transform="translate(225,616)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C2.65354329 9.74275953 3.14835669 19.47784728 3.45074081 29.23785305 C3.59604125 33.77304058 3.79204745 38.29311296 4.11230469 42.81958008 C6.07405353 71.27896125 6.07405353 71.27896125 0.76950073 78.72794342 C-5.53945496 85.49454613 -14.21996537 89.24054094 -22.66052246 92.63113403 C-26.98941253 94.40556438 -30.98731711 96.6075399 -35 99 C-35 98.01 -35 97.02 -35 96 C-33.17089844 94.57714844 -33.17089844 94.57714844 -30.609375 93.109375 C-29.6709375 92.56410156 -28.7325 92.01882812 -27.765625 91.45703125 C-26.77046875 90.89371094 -25.7753125 90.33039063 -24.75 89.75 C-23.80125 89.20214844 -22.8525 88.65429688 -21.875 88.08984375 C-20.92109375 87.53941406 -19.9671875 86.98898438 -18.984375 86.421875 C-18.06700562 85.87715042 -17.14963623 85.33242584 -16.20446777 84.77119446 C-13 83 -13 83 -9.83947754 81.74308777 C-6.28064484 80.1778051 -3.78503901 78.73136923 -1 76 C0.75878455 70.24145306 0.54232173 64.66425247 0.390625 58.69140625 C0.39068138 56.99746393 0.39603039 55.30351426 0.40643311 53.60960388 C0.41957902 49.16779449 0.36118364 44.7297404 0.28753662 40.28863525 C0.22504945 35.75044078 0.23068106 31.21237718 0.23046875 26.67382812 C0.22006832 17.78137113 0.13403942 8.89139306 0 0 Z " fill="#B1A07E" transform="translate(972,116)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1 37.95 1 75.9 1 115 C0.67 115 0.34 115 0 115 C-2.65986886 104.59831241 -2.25464378 94.10333711 -2.1953125 83.45703125 C-2.19157616 81.47735233 -2.18873212 79.49767155 -2.18673706 77.51799011 C-2.17914951 72.34116389 -2.15954361 67.16445226 -2.1373291 61.9876709 C-2.11676486 56.69166615 -2.10771285 51.39564265 -2.09765625 46.09960938 C-2.07629256 35.73302293 -2.04221641 25.36652105 -2 15 C-1.67 15 -1.34 15 -1 15 C-0.67 10.05 -0.34 5.1 0 0 Z " fill="#E9A804" transform="translate(18,646)"/><path d="M0 0 C3.96504322 2.89931374 6.66005795 6.63801803 9.33984375 10.7109375 C8.67984375 12.0309375 8.01984375 13.3509375 7.33984375 14.7109375 C6.98792969 14.10765625 6.63601563 13.504375 6.2734375 12.8828125 C2.89055867 7.40661178 0.40271507 4.07442971 -5.66015625 1.7109375 C-8.73554652 1.28349156 -11.57904216 1.37510673 -14.66015625 1.7109375 C-15.34335937 1.78183594 -16.0265625 1.85273437 -16.73046875 1.92578125 C-22.70136598 2.96776136 -26.71730881 6.22163998 -30.66015625 10.7109375 C-32.56187558 13.61186529 -34.1811476 16.57515473 -35.66015625 19.7109375 C-36.32015625 19.7109375 -36.98015625 19.7109375 -37.66015625 19.7109375 C-37.66015625 22.0209375 -37.66015625 24.3309375 -37.66015625 26.7109375 C-37.99015625 26.7109375 -38.32015625 26.7109375 -38.66015625 26.7109375 C-39.24035937 19.02324611 -37.75333639 11.8376742 -33.046875 5.55859375 C-23.98817829 -3.9419906 -11.59985335 -6.34052016 0 0 Z " fill="#FBEA5A" transform="translate(496.66015625,625.2890625)"/><path d="M0 0 C4.88037803 -0.32146203 7.89356132 0.58251081 12.25 2.75 C16.2336648 4.68064983 20.18283684 6.52930326 24.3125 8.125 C27.34552168 9.29907291 30.19611339 10.59024181 33.0625 12.125 C35.7627613 13.52076131 38.1387854 14.32505256 41.125 14.875 C47.77144851 16.13654031 53.87021407 19.22720921 60 22 C60 22.99 60 23.98 60 25 C60.928125 24.938125 61.85625 24.87625 62.8125 24.8125 C66 25 66 25 67.4375 26.5 C69.08339692 28.40783642 69.08339692 28.40783642 72.6875 28.1875 C73.780625 28.125625 74.87375 28.06375 76 28 C76.495 28.99 76.495 28.99 77 30 C79.34038186 31.13102526 79.34038186 31.13102526 82.0625 32.125 C82.98160156 32.47820312 83.90070313 32.83140625 84.84765625 33.1953125 C85.55792969 33.46085937 86.26820313 33.72640625 87 34 C86.67 34.99 86.34 35.98 86 37 C79.68341946 35.00878681 73.61688305 32.6599785 67.55078125 30.0078125 C66.66705841 29.62510696 65.78333557 29.24240143 64.87283325 28.84809875 C62.0177983 27.61069426 59.16510637 26.36799159 56.3125 25.125 C54.34201617 24.26929497 52.3713934 23.41390982 50.40063477 22.55883789 C46.46004994 20.84866741 42.52030645 19.13657844 38.58105469 17.42333984 C33.57186696 15.24623925 28.55684516 13.08298406 23.5390625 10.92578125 C21.47977039 10.03914139 19.4205779 9.15227058 17.36141968 8.26531982 C16.08659136 7.71678957 14.81138788 7.16913035 13.53579712 6.62237549 C11.79222571 5.87467137 10.05035946 5.12299463 8.30859375 4.37109375 C7.34751709 3.95786865 6.38644043 3.54464355 5.39624023 3.11889648 C3 2 3 2 0 0 Z " fill="#AC864A" transform="translate(512,378)"/><path d="M0 0 C3.79929012 1.26643004 4.25132753 2.52720191 6.375 5.875 C7.08503174 6.90584717 7.79506348 7.93669434 8.52661133 8.9987793 C10.39946916 11.83887203 11.69312355 14.6281982 12.9309082 17.79272461 C15.56893327 23.69743054 18.45256259 28.46486831 24 32 C35.62166107 35.19228472 48.19272332 34.18080176 60.12335205 33.76818848 C64.62119909 33.63322959 69.1196035 33.60763825 73.61914062 33.57226562 C82.4168658 33.48726495 91.20640971 33.28252865 100 33 C100 33.66 100 34.32 100 35 C96.82180107 35.93830156 93.96731318 36.12658772 90.65917969 36.12939453 C89.05535431 36.13412277 89.05535431 36.13412277 87.41912842 36.13894653 C86.26503479 36.1369223 85.11094116 36.13489807 83.921875 36.1328125 C82.72250305 36.13376923 81.5231311 36.13472595 80.28741455 36.13571167 C77.7420649 36.1363927 75.19671351 36.13454379 72.65136719 36.13037109 C68.80659937 36.12507792 64.9619514 36.13028938 61.1171875 36.13671875 C40.05277231 36.1462305 40.05277231 36.1462305 30.44921875 35.69140625 C28.67937622 35.60934937 28.67937622 35.60934937 26.8737793 35.52563477 C23.66968057 34.93958222 22.32482765 34.11113415 20.0625 31.8125 C18.98359202 30.2468024 17.97086653 28.6348913 17 27 C16.23753889 25.81742112 15.4702459 24.63794935 14.69921875 23.4609375 C13.10432193 21.01804865 11.54989212 18.55550495 10.015625 16.07421875 C8.440914 13.67247929 7.07957144 11.91671343 5 10 C4 8.1875 4 8.1875 3 6 C2.46375 4.9275 1.9275 3.855 1.375 2.75 C0.92125 1.8425 0.4675 0.935 0 0 Z " fill="#8F6007" transform="translate(646,502)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C2 34.65 2 69.3 2 105 C2.66 105 3.32 105 4 105 C5.54560026 107.11519398 6.96953106 109.23109431 8.375 111.4375 C9.27920972 112.82554998 10.18554324 114.21221826 11.09375 115.59765625 C11.56941406 116.32355957 12.04507813 117.04946289 12.53515625 117.79736328 C14.91262393 121.37228218 17.38940479 124.87475163 19.875 128.375 C20.62136719 129.42772095 20.62136719 129.42772095 21.3828125 130.50170898 C22.40170479 131.93746538 23.42124032 133.37276549 24.44140625 134.80761719 C38.87735849 155.1138282 38.87735849 155.1138282 44 163 C43.67 163.66 43.34 164.32 43 165 C35.65687939 154.90015969 28.39904543 144.7485318 21.26025391 134.50317383 C16.60456589 127.83366946 11.86591826 121.22737338 7.0859375 114.64648438 C6.57804688 113.94716797 6.07015625 113.24785156 5.546875 112.52734375 C4.87930176 111.61069946 4.87930176 111.61069946 4.19824219 110.67553711 C1.85806363 107.40319696 0.74994313 105.61699034 0.7215271 101.61506653 C0.71036362 100.71904221 0.69920013 99.82301788 0.68769836 98.89984131 C0.68553818 97.91944885 0.68337799 96.9390564 0.68115234 95.92895508 C0.67110672 94.89463852 0.6610611 93.86032196 0.65071106 92.79466248 C0.61977501 89.36962448 0.60281486 85.94466502 0.5859375 82.51953125 C0.56723425 80.14726582 0.54766148 77.7750071 0.5272522 75.40275574 C0.47583601 69.1540217 0.43626104 62.90526607 0.39910889 56.65643311 C0.35912868 50.28196836 0.30800908 43.90759416 0.2578125 37.53320312 C0.16094089 25.02220008 0.07619396 12.51114518 0 0 Z " fill="#B8A260" transform="translate(643,333)"/><path d="M0 0 C0.9215538 0.00222061 1.8431076 0.00444122 2.79258728 0.00672913 C3.83359085 0.00680466 4.87459442 0.00688019 5.94714355 0.00695801 C7.07941879 0.01211929 8.21169403 0.01728058 9.37828064 0.02259827 C10.53106003 0.02401321 11.68383942 0.02542816 12.87155151 0.02688599 C16.57043503 0.03250446 20.26925903 0.0450601 23.96812439 0.05775452 C26.46877456 0.06276714 28.96942567 0.06733045 31.47007751 0.07142639 C37.61528027 0.0824799 43.76044808 0.099236 49.90562439 0.12025452 C50.40062439 1.11025452 50.40062439 1.11025452 50.90562439 2.12025452 C33.41562439 2.12025452 15.92562439 2.12025452 -2.09437561 2.12025452 C-2.75437561 3.44025452 -3.41437561 4.76025452 -4.09437561 6.12025452 C-5.61000061 7.54212952 -5.61000061 7.54212952 -7.34437561 8.87025452 C-10.02412389 11.06378042 -12.03538423 13.22984754 -14.03187561 16.05775452 C-16.59452098 19.63871423 -19.42371794 22.23889599 -22.79359436 25.04603577 C-27.58952962 29.36970575 -31.79671967 34.30909189 -36.09437561 39.12025452 C-37.41437561 38.79025452 -38.73437561 38.46025452 -40.09437561 38.12025452 C-2.09437561 0.12025452 -2.09437561 0.12025452 0 0 Z " fill="#F5D351" transform="translate(671.0943756103516,598.8797454833984)"/><path d="M0 0 C3.44158693 1.42208179 5.03276288 3.01863834 7.12890625 6.0703125 C7.68900391 6.885 8.24910156 7.6996875 8.82617188 8.5390625 C9.39916016 9.39242188 9.97214844 10.24578125 10.5625 11.125 C11.13935547 11.95515625 11.71621094 12.7853125 12.31054688 13.640625 C15.69434665 18.62070402 18.14092125 23.27059717 20 29 C19.01 29.99 18.02 30.98 17 32 C16.401875 31.030625 15.80375 30.06125 15.1875 29.0625 C13.28872491 25.76947958 13.28872491 25.76947958 10 25 C8.77319336 23.58886719 8.77319336 23.58886719 7.58984375 21.796875 C7.15736328 21.14589844 6.72488281 20.49492187 6.27929688 19.82421875 C5.83650391 19.13972656 5.39371094 18.45523437 4.9375 17.75 C4.49083984 17.08097656 4.04417969 16.41195313 3.58398438 15.72265625 C1.28393284 12.22272731 -0.46479576 8.9077926 -2 5 C-2.66 4.67 -3.32 4.34 -4 4 C-2.68 2.68 -1.36 1.36 0 0 Z " fill="#D39C11" transform="translate(624,458)"/><path d="M0 0 C0.99 1.485 0.99 1.485 2 3 C7.04461214 9.72097555 13.34149325 14.54627042 20.02832031 19.51953125 C23.78486473 22.34019561 27.48239024 25.23732361 31.1875 28.125 C31.96762451 28.73150391 32.74774902 29.33800781 33.55151367 29.96289062 C37.43539419 32.98575138 41.2994296 36.02841688 45.125 39.125 C49.33930438 42.52269177 53.66166633 45.76360808 58 49 C64.09846943 53.5507063 70.10735979 58.18399226 76 63 C77.00675781 63.82113281 78.01351562 64.64226562 79.05078125 65.48828125 C81.70331736 67.65547403 84.35300663 69.82604346 87 72 C86.01 72.495 86.01 72.495 85 73 C74.04861296 64.65476583 63.14667616 56.24927478 52.28808594 47.78369141 C48.42277656 44.77046581 44.55545895 41.7598234 40.6875 38.75 C39.5588855 37.87166504 39.5588855 37.87166504 38.4074707 36.97558594 C34.55774214 33.98168133 30.70219352 30.99581819 26.83300781 28.02709961 C24.76355249 26.43926182 22.69729132 24.8472858 20.63134766 23.25488281 C19.47361857 22.36432197 18.31427052 21.47586401 17.15380859 20.58886719 C15.24389842 19.12746346 13.34028129 17.65816867 11.4375 16.1875 C10.85323242 15.74317627 10.26896484 15.29885254 9.66699219 14.84106445 C5.1978021 11.36901832 1.52698559 8.32751968 0.25 2.6875 C0.1675 1.800625 0.085 0.91375 0 0 Z " fill="#987F41" transform="translate(133,582)"/><path d="M0 0 C0.66 0.99 1.32 1.98 2 3 C1.67 3.66 1.34 4.32 1 5 C0.896875 5.556875 0.79375 6.11375 0.6875 6.6875 C-1.08532609 12.65064231 -4.47962155 16.87269793 -9 21 C-9.76957031 21.71542969 -10.53914062 22.43085937 -11.33203125 23.16796875 C-13.85448116 25.48620233 -16.41924359 27.74709212 -19 30 C-19.928125 30.845625 -20.85625 31.69125 -21.8125 32.5625 C-27.01009088 34.90651157 -32.38877759 34.29970921 -38 34 C-35.07400628 32.04933752 -32.13276145 30.53023809 -29 28.9375 C-15.92953374 21.88613611 -7.51116384 12.7323387 0 0 Z " fill="#B88103" transform="translate(929,782)"/><path d="M0 0 C0.33 0.66 0.66 1.32 1 2 C1.99 2.33 2.98 2.66 4 3 C2.51858996 7.46919771 0.046937 10.81854969 -2.875 14.4375 C-3.59115479 15.335896 -3.59115479 15.335896 -4.32177734 16.25244141 C-8.0162283 20.85463753 -11.79929343 25.38156112 -15.625 29.875 C-16.14562012 30.48786865 -16.66624023 31.1007373 -17.20263672 31.73217773 C-18.44502474 33.17526559 -19.71930033 34.59080204 -21 36 C-21.33 36 -21.66 36 -22 36 C-21.95875 35.2575 -21.9175 34.515 -21.875 33.75 C-22.00398134 30.91241048 -22.57051222 29.41226062 -24 27 C-23.01 27 -22.02 27 -21 27 C-18.73600659 24.76514709 -18.73600659 24.76514709 -16.4375 21.8125 C-15.79083374 21.01513428 -15.79083374 21.01513428 -15.13110352 20.20166016 C-13.7411649 18.47762344 -12.3682557 16.74128642 -11 15 C-10.52949219 14.40203613 -10.05898438 13.80407227 -9.57421875 13.18798828 C-4.3352124 6.88351153 -4.3352124 6.88351153 0 0 Z " fill="#FCCF37" transform="translate(968,557)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.09257494 12.20420055 1.16370148 24.40831793 1.20724869 36.61279774 C1.22814647 42.27950735 1.25650433 47.94597722 1.30175781 53.61254883 C1.34513705 59.07847648 1.36912059 64.54417316 1.37950897 70.01025963 C1.38691458 72.09834112 1.40137554 74.18640961 1.42292023 76.27439308 C1.4518487 79.19338176 1.45596041 82.11140922 1.45410156 85.03051758 C1.46848267 85.89870117 1.48286377 86.76688477 1.49768066 87.66137695 C1.45726596 93.50496579 1.45726596 93.50496579 -0.90338135 96.06059265 C-3 97 -3 97 -5 97 C-5 96.34 -5 95.68 -5 95 C-4.01 94.505 -4.01 94.505 -3 94 C-0.91121629 84.58483322 -1.8724711 74.02904471 -1.90234375 64.42578125 C-1.90421244 62.6478835 -1.90563421 60.86998524 -1.90663147 59.09208679 C-1.91042119 54.44795267 -1.92022056 49.8038506 -1.93133545 45.159729 C-1.94162643 40.40662062 -1.94614545 35.65350698 -1.95117188 30.90039062 C-1.96184654 21.60024646 -1.97887957 12.30012591 -2 3 C-1.34 3 -0.68 3 0 3 C0 2.01 0 1.02 0 0 Z " fill="#F6C419" transform="translate(971,222)"/><path d="M0 0 C0.89874816 0.00092179 1.79749632 0.00184359 2.72347927 0.00279331 C3.75138073 0.00141865 4.77928219 0.00004398 5.83833218 -0.00137234 C6.975527 0.00222294 8.11272182 0.00581821 9.2843771 0.00952244 C10.47445873 0.00937641 11.66454037 0.00923038 12.89068508 0.00907993 C16.16326569 0.00965889 19.43580402 0.01468801 22.70837617 0.02165389 C26.1250196 0.02788815 29.54166379 0.02849128 32.95831203 0.0296793 C39.43232563 0.0327924 45.90632242 0.0410055 52.3803286 0.05102879 C59.74901216 0.06219058 67.11769651 0.06770054 74.48638642 0.07272422 C89.64814464 0.08318813 104.80988712 0.10078717 119.97163296 0.12304783 C119.97163296 0.45304783 119.97163296 0.78304783 119.97163296 1.12304783 C73.93663296 1.61804783 73.93663296 1.61804783 26.97163296 2.12304783 C26.97163296 2.45304783 26.97163296 2.78304783 26.97163296 3.12304783 C22.49278857 3.31886129 18.0135487 3.50331143 13.53413296 3.68554783 C12.25473843 3.74162205 10.97534389 3.79769627 9.65717983 3.8554697 C7.83476772 3.92797947 7.83476772 3.92797947 5.97553921 4.00195408 C4.84962368 4.04908543 3.72370815 4.09621677 2.56367397 4.14477634 C-0.02836704 4.12304783 -0.02836704 4.12304783 -1.02836704 3.12304783 C-1.35836704 12.69304783 -1.68836704 22.26304783 -2.02836704 32.12304783 C-2.35836704 32.12304783 -2.68836704 32.12304783 -3.02836704 32.12304783 C-3.05302208 27.7264861 -3.07120547 23.32996063 -3.08329868 18.93335056 C-3.08833825 17.43659865 -3.09516992 15.93985167 -3.1038065 14.44311619 C-3.11588863 12.29604976 -3.12159896 10.14904821 -3.12602329 8.00195408 C-3.13126011 6.70846043 -3.13649693 5.41496677 -3.14189243 4.08227634 C-2.99224706 0.18152016 -2.99224706 0.18152016 0 0 Z " fill="#F9E87E" transform="translate(273.0283670425415,728.8769521713257)"/><path d="M0 0 C3.465 1.485 3.465 1.485 7 3 C6.01 3.66 5.02 4.32 4 5 C3.67 12.26 3.34 19.52 3 27 C41.61 27 80.22 27 120 27 C120 27.33 120 27.66 120 28 C80.4 28 40.8 28 0 28 C0 18.76 0 9.52 0 0 Z " fill="#FEBE0A" transform="translate(271,731)"/><path d="M0 0 C2.875 2.4375 2.875 2.4375 5 5 C5.763125 5.886875 6.52625 6.77375 7.3125 7.6875 C9 10 9 10 9 12 C7.68 12 6.36 12 5 12 C4.608125 11.0925 4.21625 10.185 3.8125 9.25 C1.01296601 4.23014594 -2.57421611 1.70938902 -8 0 C-11.45428556 -0.10131982 -11.45428556 -0.10131982 -15.0625 0.25 C-16.87427734 0.38148438 -16.87427734 0.38148438 -18.72265625 0.515625 C-22.6704809 1.09909372 -24.86201662 1.78967538 -27.59765625 4.69921875 C-33.57467879 12.81203068 -35.49142717 18.93484343 -35 29 C-35.99 28.67 -36.98 28.34 -38 28 C-38.6924463 18.18265019 -37.97082506 10.82190925 -31.42578125 3.15625 C-22.24990811 -5.57045453 -10.82344161 -5.6694218 0 0 Z " fill="#F8D43A" transform="translate(557,692)"/><path d="M0 0 C2.68797302 -0.3742218 2.68797302 -0.3742218 6.14624023 -0.37231445 C8.08351234 -0.38165764 8.08351234 -0.38165764 10.05992126 -0.39118958 C11.47614933 -0.38250085 12.89237365 -0.3731828 14.30859375 -0.36328125 C15.75586446 -0.36276275 17.20313587 -0.36328006 18.65040588 -0.36479187 C21.68607068 -0.36470208 24.72147029 -0.35425994 27.75708008 -0.33618164 C31.64896268 -0.31351423 35.54045694 -0.31294588 39.43238735 -0.31969929 C42.42209831 -0.32304083 45.41172071 -0.31640539 48.40141487 -0.30657005 C49.83634032 -0.30271942 51.27127563 -0.30156927 52.70620537 -0.3031559 C54.71228111 -0.30352667 56.71834382 -0.28942758 58.72436523 -0.2746582 C59.86638901 -0.27005081 61.00841278 -0.26544342 62.18504333 -0.26069641 C65 0 65 0 68 2 C67 3 67 3 64.26023865 3.12025452 C63.03668167 3.11803391 61.81312469 3.11581329 60.55249023 3.11352539 C59.54277664 3.11374443 59.54277664 3.11374443 58.51266479 3.1139679 C56.27794216 3.11326878 54.0433019 3.10547652 51.80859375 3.09765625 C50.26302638 3.09579206 48.71745843 3.09436816 47.17189026 3.09336853 C43.09642923 3.0895434 39.02100363 3.07971317 34.94555664 3.06866455 C30.78988118 3.05845032 26.63420001 3.05387089 22.47851562 3.04882812 C14.31899413 3.03809089 6.15950147 3.02101454 -2 3 C-1.34 2.01 -0.68 1.02 0 0 Z " fill="#FEF273" transform="translate(780,432)"/><path d="M0 0 C0.495 1.485 0.495 1.485 1 3 C-3.45355997 8.22345731 -7.97709845 13.07407456 -13.23828125 17.4921875 C-15.01589245 18.90784519 -15.01589245 18.90784519 -16.204422 20.57295227 C-18.89995854 22.71524812 -21.08597489 22.35974123 -24.4909668 22.34057617 C-25.1448941 22.34101425 -25.79882141 22.34145233 -26.4725647 22.34190369 C-28.63175423 22.33981539 -30.79016505 22.31648388 -32.94921875 22.29296875 C-34.44708329 22.28737291 -35.94495332 22.28310275 -37.44282532 22.28010559 C-41.38358746 22.2686558 -45.32401745 22.23918778 -49.26464844 22.20599365 C-53.28641262 22.17529548 -57.30823053 22.16160082 -61.33007812 22.14648438 C-69.22020444 22.11431793 -77.11006089 22.06312028 -85 22 C-85 20.35 -85 18.7 -85 17 C-84.34 17.66 -83.68 18.32 -83 19 C-80.19604253 19.32843179 -80.19604253 19.32843179 -76.86962891 19.30639648 C-75.58134186 19.32238388 -74.29305481 19.33837128 -72.96572876 19.35484314 C-71.55267734 19.36121963 -70.1396212 19.36661244 -68.7265625 19.37109375 C-67.28168644 19.38005769 -65.83681136 19.38917949 -64.39193726 19.39845276 C-61.36055239 19.41495641 -58.32927815 19.42264523 -55.29785156 19.42553711 C-51.41470417 19.43092007 -47.53259754 19.4685885 -43.64974403 19.51428127 C-40.66427831 19.5440374 -37.67906351 19.55126034 -34.69346237 19.55226326 C-33.26210136 19.55646917 -31.83073984 19.56891864 -30.39952469 19.58978081 C-28.39624754 19.61665462 -26.39259547 19.60877078 -24.38916016 19.59936523 C-23.24935699 19.60443588 -22.10955383 19.60950653 -20.93521118 19.61473083 C-17.09767903 18.81102398 -16.19484101 17.13203544 -14 14 C-13.34 14 -12.68 14 -12 14 C-11.77570313 13.44828125 -11.55140625 12.8965625 -11.3203125 12.328125 C-9.59614817 9.28788256 -7.37484178 7.18574327 -4.875 4.75 C-3.96492187 3.85796875 -3.05484375 2.9659375 -2.1171875 2.046875 C-1.06917969 1.03367187 -1.06917969 1.03367187 0 0 Z " fill="#F9E04B" transform="translate(651,687)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C2.48825515 19.38294005 3.20167632 38.6841423 3.1875 58.125 C3.1882251 59.096651 3.1889502 60.068302 3.18969727 61.06939697 C3.18870961 72.7531193 2.90514188 84.34877212 2 96 C1.67 96 1.34 96 1 96 C0.16685662 74.90457436 -0.13517002 53.85026174 -0.06866455 32.73986816 C-0.05814379 29.02385062 -0.05380767 25.30782524 -0.04882812 21.59179688 C-0.03833364 14.39451136 -0.0214388 7.19726217 0 0 Z " fill="#FCD523" transform="translate(850,295)"/><path d="M0 0 C2 3 2 3 2.75 5.5 C4.27974047 9.78327331 6.46422152 13.49630183 8.7578125 17.4140625 C10 20 10 20 10 24 C10.66 24 11.32 24 12 24 C12 24.99 12 25.98 12 27 C12.54527344 27.18175781 13.09054687 27.36351562 13.65234375 27.55078125 C19.1015625 29.3671875 24.55078125 31.18359375 30 33 C30 33.66 30 34.32 30 35 C30.67289062 35.11085938 31.34578125 35.22171875 32.0390625 35.3359375 C35.60606936 36.13592585 38.96328968 37.33518177 42.375 38.625 C43.41587769 39.01606934 43.41587769 39.01606934 44.4777832 39.41503906 C50.72730815 41.80940642 56.76641646 44.58096225 62.79296875 47.484375 C65.50042073 48.76390164 68.20594846 49.92657907 71 51 C71 51.66 71 52.32 71 53 C67.61356979 52.40583299 64.62510409 51.5584772 61.46020508 50.22167969 C60.15778618 49.67540924 60.15778618 49.67540924 58.82905579 49.11810303 C57.90191269 48.72334778 56.97476959 48.32859253 56.01953125 47.921875 C55.0515007 47.51342346 54.08347015 47.10497192 53.08610535 46.68414307 C51.03845883 45.81887735 48.99179312 44.95128739 46.94604492 44.08154297 C43.8434976 42.76317187 40.7374755 41.45328116 37.63085938 40.14453125 C35.63520206 39.29998611 33.63975267 38.45494942 31.64453125 37.609375 C30.72750931 37.22271667 29.81048737 36.83605835 28.86567688 36.43768311 C26.23257617 35.31542263 23.61365161 34.16679529 21 33 C20.08903061 32.59850739 19.17806122 32.19701477 18.23948669 31.78335571 C13.3048866 29.48938252 9.98154612 27.83401536 7.43359375 22.8046875 C6.92892578 21.84175781 6.42425781 20.87882812 5.90429688 19.88671875 C5.42025391 18.89285156 4.93621094 17.89898437 4.4375 16.875 C3.91865234 15.87339844 3.39980469 14.87179687 2.86523438 13.83984375 C1.02951197 10.26438442 -0.72790469 6.81628594 -2 3 C-1.34 3 -0.68 3 0 3 C0 2.01 0 1.02 0 0 Z " fill="#A78952" transform="translate(372,295)"/><path d="M0 0 C9.54160898 -0.06167245 19.08322685 -0.10211954 28.625 -0.125 C29.33388996 -0.12671204 30.04277992 -0.12842407 30.7731514 -0.13018799 C56.89328707 -0.18587145 82.91809095 0.5142341 109 2 C109 2.33 109 2.66 109 3 C72.60979522 3.31611939 36.35578685 2.45024447 0 1 C0 0.67 0 0.34 0 0 Z " fill="#D09C0A" transform="translate(299,821)"/><path d="M0 0 C3.75038309 2.82108463 6.72039898 5.80544595 9.6875 9.4375 C10.45449219 10.36433594 11.22148438 11.29117188 12.01171875 12.24609375 C14 15 14 15 16 20 C-0.5 20 -17 20 -34 20 C-34 19.67 -34 19.34 -34 19 C-21.13 18.67 -8.26 18.34 5 18 C3.02 15.36 1.04 12.72 -1 10 C-0.67 9.34 -0.34 8.68 0 8 C0.495 8.495 0.495 8.495 1 9 C0.505 4.545 0.505 4.545 0 0 Z " fill="#E6BF59" transform="translate(918,739)"/><path d="M0 0 C18.92206778 -0.14958497 37.78083246 0.26142926 56.6875 1 C59.26235251 1.09681484 61.83722232 1.19317083 64.41210938 1.2890625 C70.60828106 1.52078548 76.80421986 1.75804458 83 2 C83 2.33 83 2.66 83 3 C49.34 3 15.68 3 -19 3 C-19 2.67 -19 2.34 -19 2 C-12.73 1.67 -6.46 1.34 0 1 C0 0.67 0 0.34 0 0 Z " fill="#FEF027" transform="translate(293,730)"/><path d="M0 0 C7.82469982 -0.02560621 15.64938862 -0.04297307 23.47412109 -0.05493164 C26.1294149 -0.05935244 28.78465286 -0.06671902 31.43994141 -0.07543945 C59.7392097 -0.16597155 59.7392097 -0.16597155 73 1 C73 1.66 73 2.32 73 3 C74.32 3.33 75.64 3.66 77 4 C56.96733386 4.12750914 37.01680962 3.89089967 17 3 C17 2.67 17 2.34 17 2 C11.39 1.67 5.78 1.34 0 1 C0 0.67 0 0.34 0 0 Z " fill="#BA8F24" transform="translate(425,821)"/><path d="M0 0 C14.12537853 -0.11685116 28.25068202 -0.20466413 42.37644482 -0.25906086 C48.93545977 -0.28516713 55.49415029 -0.3205853 62.05297852 -0.37719727 C68.38127651 -0.43147832 74.70926223 -0.46141277 81.03777504 -0.47438622 C83.45356476 -0.48363296 85.86933716 -0.50168953 88.28499413 -0.52865028 C91.66587791 -0.56488699 95.0454673 -0.56994736 98.42651367 -0.56762695 C99.92839485 -0.59459152 99.92839485 -0.59459152 101.46061707 -0.62210083 C109.02600274 -0.56582548 109.02600274 -0.56582548 112.1608429 2.53547668 C112.76776474 3.34876938 113.37468658 4.16206207 114 5 C113.67 5.66 113.34 6.32 113 7 C112.01 6.67 111.02 6.34 110 6 C109.3125 3.9375 109.3125 3.9375 109 2 C108.41612015 2.00222061 107.8322403 2.00444122 107.23066711 2.00672913 C71.47160239 2.13590263 35.75018876 1.82527449 0 1 C0 0.67 0 0.34 0 0 Z " fill="#E9B007" transform="translate(443,565)"/><path d="M0 0 C0 0.66 0 1.32 0 2 C-2.25513207 3.83114266 -4.52345536 5.54979525 -6.875 7.25 C-8.35141435 8.33567208 -9.82663043 9.42297518 -11.30078125 10.51171875 C-12.07373535 11.08196777 -12.84668945 11.6522168 -13.64306641 12.23974609 C-17.49797956 15.11875208 -21.27735237 18.09275348 -25.0625 21.0625 C-30.80380819 25.54822658 -36.57708777 29.98320591 -42.4375 34.3125 C-43.05826416 34.77470947 -43.67902832 35.23691895 -44.31860352 35.71313477 C-50.11690049 39.96239884 -54.91759361 40.932447 -62 40 C-66.24859742 38.28202688 -69.19908815 35.99507229 -72.0625 32.4375 C-73.12719233 29.66929993 -72.83135992 28.74988282 -72 26 C-71.69707031 26.54269531 -71.39414063 27.08539062 -71.08203125 27.64453125 C-67.6985344 33.57816481 -67.6985344 33.57816481 -62 37 C-52.65864091 38.09713949 -47.15085883 35.09693213 -39.93530273 29.41821289 C-39.19352783 28.82645264 -38.45175293 28.23469238 -37.6875 27.625 C-36.08906929 26.36521567 -34.49009734 25.10611781 -32.890625 23.84765625 C-32.08044922 23.20844238 -31.27027344 22.56922852 -30.43554688 21.91064453 C-25.92483626 18.37206982 -21.35899979 14.90583426 -16.79736328 11.43334961 C-12.34067111 8.03709393 -7.92461451 4.59660625 -3.56640625 1.07421875 C-2 0 -2 0 0 0 Z " fill="#8A7B56" transform="translate(207,708)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C4.00156476 1.1059367 6.00668391 1.14666127 8.01101685 1.15821838 C9.29271759 1.1680072 10.57441833 1.17779602 11.8949585 1.18788147 C13.32336388 1.19378606 14.75176966 1.19959648 16.18017578 1.20532227 C17.67799146 1.21489808 19.17580441 1.22490798 20.6736145 1.23532104 C24.74772894 1.26240834 28.82185501 1.28339715 32.89600992 1.30332303 C37.15081825 1.32515904 41.40559057 1.35255937 45.66036987 1.37937927 C53.72095775 1.42933848 61.78156557 1.47426531 69.84219253 1.51740164 C79.0174206 1.56674646 88.19261256 1.62167479 97.36780572 1.67708123 C116.2451703 1.79095081 135.12256894 1.89777899 154 2 C154 2.33 154 2.66 154 3 C103.18 3 52.36 3 0 3 C0 2.01 0 1.02 0 0 Z " fill="#DFC78B" transform="translate(396,585)"/><path d="M0 0 C0 0.33 0 0.66 0 1 C-7.12100918 1.78749984 -14.24497367 2.29431629 -21.39453125 2.74609375 C-24.33967435 2.95349819 -27.25518504 3.22724338 -30.1875 3.5625 C-38.14326593 4.39785542 -46.11955663 4.43280789 -54 3 C-54 2.34 -54 1.68 -54 1 C-59.28 1 -64.56 1 -70 1 C-70 0.67 -70 0.34 -70 0 C-46.67741797 -1.63007294 -23.34459254 -0.65423013 0 0 Z " fill="#C6A44F" transform="translate(552,821)"/><path d="M0 0 C6.87947032 2.1802629 13.45055898 4.80254035 20.0625 7.6875 C21.02349609 8.10322266 21.98449219 8.51894531 22.97460938 8.94726562 C25.31787486 9.96151487 27.65960887 10.97914002 30 12 C28.02 12.99 28.02 12.99 26 14 C26 13.34 26 12.68 26 12 C23.69 12.33 21.38 12.66 19 13 C19.66 13.66 20.32 14.32 21 15 C15.669877 14.45806986 11.42105958 13.15341447 6.5625 10.9375 C5.92634766 10.65583984 5.29019531 10.37417969 4.63476562 10.08398438 C3.08636949 9.39710188 1.54266643 8.69965593 0 8 C0.66 7.67 1.32 7.34 2 7 C2 6.34 2 5.68 2 5 C2.66 4.67 3.32 4.34 4 4 C2.68 3.34 1.36 2.68 0 2 C0 1.34 0 0.68 0 0 Z " fill="#F6C73E" transform="translate(531,417)"/><path d="M0 0 C0.89877365 -0.00137466 1.7975473 -0.00274933 2.72355652 -0.00416565 C4.18335937 0.00122726 4.18335937 0.00122726 5.6726532 0.00672913 C7.22456612 0.00651009 7.22456612 0.00651009 8.80783081 0.00628662 C12.22202157 0.00698238 15.63615754 0.01475908 19.05033875 0.02259827 C21.41973847 0.02446364 23.78913857 0.02588698 26.15853882 0.02688599 C32.39085457 0.03070175 38.62314696 0.04052405 44.85545349 0.05158997 C51.21663599 0.06182428 57.57782226 0.06638794 63.93901062 0.07142639 C76.4175365 0.08214713 88.89604505 0.0992123 101.3745575 0.12025452 C101.3745575 0.45025452 101.3745575 0.78025452 101.3745575 1.12025452 C100.61369339 1.13056198 99.85282928 1.14086945 99.06890869 1.15148926 C90.92789651 1.26221867 82.78692765 1.37577138 74.64598083 1.49119568 C71.51614626 1.53555876 68.38630409 1.57931647 65.25645447 1.62260437 C42.52609181 1.93551479 42.52609181 1.93551479 19.80033875 2.47962952 C18.82530899 2.50747025 17.85027924 2.53531097 16.84570312 2.56399536 C12.45695799 2.69148939 8.0691428 2.83171874 3.68144226 2.99110413 C2.17030128 3.03832082 0.6591527 3.08529512 -0.852005 3.13197327 C-2.12640442 3.17797668 -3.40080383 3.2239801 -4.71382141 3.27137756 C-7.6254425 3.12025452 -7.6254425 3.12025452 -9.6254425 1.12025452 C-6.36009613 0.39289282 -3.34325425 -0.0039659 0 0 Z " fill="#A06B06" transform="translate(120.62544250488281,852.8797454833984)"/><path d="M0 0 C14.0277345 9.61901794 14.0277345 9.61901794 15.65625 16.95703125 C15.90574462 19.65642448 16.03486546 22.29045567 16 25 C12.40922229 23.78502999 10.40536707 22.80949542 8.3125 19.625 C7.89613281 18.99851562 7.47976563 18.37203125 7.05078125 17.7265625 C5.91823275 15.86564639 4.97394663 13.94789325 4 12 C3.10666556 10.85221737 2.21055279 9.70659465 1.3125 8.5625 C-1.02496994 5.39119575 -1.02496994 5.39119575 -0.8125 2.0625 C-0.544375 1.381875 -0.27625 0.70125 0 0 Z " fill="#F3B923" transform="translate(904,724)"/><path d="M0 0 C20.55634396 -1.91472991 20.55634396 -1.91472991 26.11816406 1.17773438 C29.60566303 4.23905017 31.89959968 7.89689241 34 12 C33.67 12.66 33.34 13.32 33 14 C24.42 14 15.84 14 7 14 C7 13.67 7 13.34 7 13 C13.435 12.505 13.435 12.505 20 12 C20.33 8.37 20.66 4.74 21 1 C10.605 1.495 10.605 1.495 0 2 C0 1.34 0 0.68 0 0 Z " fill="#C4A15A" transform="translate(727,676)"/><path d="M0 0 C4.28879579 3.78913026 7.14703458 8.49904816 10.25 13.25 C10.80429687 14.09046875 11.35859375 14.9309375 11.9296875 15.796875 C13.29069425 17.86185075 14.64729288 19.92958185 16 22 C15.01 22.33 14.02 22.66 13 23 C12.67 23.99 12.34 24.98 12 26 C9.21506127 22.596186 6.67403408 19.11493665 4.24609375 15.453125 C2.95958248 13.70080197 2.95958248 13.70080197 0 13 C-1.640625 10.78515625 -1.640625 10.78515625 -3.25 8.0625 C-3.79140625 7.16660156 -4.3328125 6.27070313 -4.890625 5.34765625 C-5.25671875 4.57292969 -5.6228125 3.79820312 -6 3 C-5.67 2.34 -5.34 1.68 -5 1 C-3.68 2.98 -2.36 4.96 -1 7 C1.30671915 4.28450846 1.30671915 4.28450846 0.625 1.8125 C0.41875 1.214375 0.2125 0.61625 0 0 Z " fill="#E0A617" transform="translate(642,482)"/><path d="M0 0 C1.53617912 4.09647766 0.69045256 7.78823937 0 12 C-0.33 12.33 -0.66 12.66 -1 13 C-1.26918224 15.65294055 -1.47497207 18.27717329 -1.625 20.9375 C-1.66931152 21.71005127 -1.71362305 22.48260254 -1.75927734 23.27856445 C-2.09844233 30.10980519 -1.66684701 36.53239555 -0.375 43.25 C0.05249493 46.38496281 -0.34017977 48.92083893 -1 52 C-7.96330466 41.555043 -6.99255622 25.97818516 -4.6875 14.1875 C-3.65367536 9.08401644 -2.15224807 4.70841945 0 0 Z " fill="#BB8521" transform="translate(761,600)"/><path d="M0 0 C-1.71896484 0.23783203 -1.71896484 0.23783203 -3.47265625 0.48046875 C-5.00275771 0.71514689 -6.53269756 0.95088043 -8.0625 1.1875 C-8.81466797 1.28869141 -9.56683594 1.38988281 -10.34179688 1.49414062 C-16.84384129 2.53559363 -21.67339697 4.88517866 -25.671875 10.23828125 C-26.02765625 10.92277344 -26.3834375 11.60726562 -26.75 12.3125 C-27.859375 14.42578125 -27.859375 14.42578125 -29 16 C-29.99 16 -30.98 16 -32 16 C-32.33452052 23.43378943 -32.13902852 29.19877155 -29 36 C-29.99 36 -30.98 36 -32 36 C-34.89720746 29.48128322 -35.23613076 22.053359 -33.16015625 15.24609375 C-30.06226698 8.41404838 -25.55405252 3.22925648 -18.765625 -0.09375 C-12.40135737 -2.46389105 -6.13719398 -3.40052029 0 0 Z " fill="#FAED6E" transform="translate(638,757)"/><path d="M0 0 C2.475 0.99 2.475 0.99 5 2 C5 2.66 5 3.32 5 4 C5.66 4 6.32 4 7 4 C7.84026396 5.76755526 8.67198722 7.53917263 9.5 9.3125 C9.9640625 10.29863281 10.428125 11.28476562 10.90625 12.30078125 C12 15 12 15 12 18 C12.66 18 13.32 18 14 18 C15.33819498 20.6226232 16.6707151 23.24786599 18 25.875 C18.3815625 26.62136719 18.763125 27.36773437 19.15625 28.13671875 C19.5171875 28.85214844 19.878125 29.56757813 20.25 30.3046875 C20.58515625 30.96452637 20.9203125 31.62436523 21.265625 32.30419922 C22 34 22 34 22 36 C21.34 36 20.68 36 20 36 C19.67 36.66 19.34 37.32 19 38 C16.45208807 33.07180693 13.90699211 28.14217404 11.36450195 23.21118164 C10.49906543 21.53369855 9.63285891 19.85661248 8.76586914 18.17993164 C7.52027283 15.77073305 6.27744684 13.36012323 5.03515625 10.94921875 C4.64658951 10.19912033 4.25802277 9.44902191 3.85768127 8.67619324 C2.38397414 5.81097769 1.0206056 3.06181681 0 0 Z " fill="#ECA904" transform="translate(350,259)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1 22.77 1 45.54 1 69 C0.34 69 -0.32 69 -1 69 C-1.7555387 57.28915011 -2.10691171 45.61128755 -2.125 33.875 C-2.12951172 32.63588867 -2.13402344 31.39677734 -2.13867188 30.12011719 C-2.13577148 28.38616699 -2.13577148 28.38616699 -2.1328125 26.6171875 C-2.13168457 25.58190918 -2.13055664 24.54663086 -2.12939453 23.47998047 C-2 21 -2 21 -1 19 C-0.84932786 17.5534758 -0.75138964 16.1012066 -0.68359375 14.6484375 C-0.64169922 13.79765625 -0.59980469 12.946875 -0.55664062 12.0703125 C-0.51732422 11.18085938 -0.47800781 10.29140625 -0.4375 9.375 C-0.39431641 8.4778125 -0.35113281 7.580625 -0.30664062 6.65625 C-0.20043139 4.43765717 -0.09838806 2.2189512 0 0 Z " fill="#EEC932" transform="translate(850,360)"/><path d="M0 0 C0.66 0.66 1.32 1.32 2 2 C8.04150243 3.35894543 14.46886742 3.13603131 20.62890625 3.09765625 C21.94156715 3.09553383 21.94156715 3.09553383 23.28074646 3.09336853 C26.04136762 3.08782719 28.80190388 3.07528612 31.5625 3.0625 C33.44856653 3.0574774 35.33463434 3.05291583 37.22070312 3.04882812 C41.81383417 3.03787707 46.40690275 3.02065384 51 3 C51 2.34 51 1.68 51 1 C53.31 1 55.62 1 58 1 C57.67 1.66 57.34 2.32 57 3 C65.58 3 74.16 3 83 3 C83.495 3.99 83.495 3.99 84 5 C56.28 5 28.56 5 0 5 C-0.33 3.68 -0.66 2.36 -1 1 C-0.67 0.67 -0.34 0.34 0 0 Z " fill="#7C4A02" transform="translate(642,570)"/><path d="M0 0 C29.7 0 59.4 0 90 0 C89.67 1.32 89.34 2.64 89 4 C88.505 3.01 88.505 3.01 88 2 C78.84637816 1.97680057 69.69276649 1.95904618 60.53912163 1.94818783 C56.28844029 1.94297563 52.03777911 1.93590821 47.78710938 1.92456055 C43.68279956 1.91367254 39.57850909 1.90771064 35.47418594 1.90512276 C33.91055115 1.90327916 32.34691739 1.8996791 30.78329086 1.89426994 C28.58841435 1.88698099 26.3936172 1.88601236 24.19873047 1.88647461 C22.95074677 1.884254 21.70276306 1.88203339 20.41696167 1.87974548 C17.18520715 1.99348193 14.18099773 2.45526835 11 3 C7.9375 2.625 7.9375 2.625 5 2 C4.05125 1.814375 3.1025 1.62875 2.125 1.4375 C1.42375 1.293125 0.7225 1.14875 0 1 C0 0.67 0 0.34 0 0 Z " fill="#F4C30A" transform="translate(313,448)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C2 21.12 2 42.24 2 64 C-0.50357861 63.1654738 -2.66785852 62.20628008 -5 61 C-3.35 61 -1.7 61 0 61 C-0.02212303 59.94217316 -0.02212303 59.94217316 -0.04469299 58.86297607 C-0.18282086 52.21262308 -0.31578317 45.56218913 -0.4429636 38.91161728 C-0.50852783 35.49260828 -0.57607936 32.07366277 -0.64819336 28.65478516 C-0.73103663 24.72308946 -0.80519886 20.79125301 -0.87890625 16.859375 C-0.90594131 15.63321472 -0.93297638 14.40705444 -0.96083069 13.14373779 C-0.98092697 12.00285706 -1.00102325 10.86197632 -1.02172852 9.68652344 C-1.05170677 8.18094879 -1.05170677 8.18094879 -1.08229065 6.6449585 C-1.00779862 4.25066049 -0.69212187 2.28271657 0 0 Z " fill="#945F03" transform="translate(613,357)"/><path d="M0 0 C4.15267212 0.66978583 7.96661322 1.97102758 11.9140625 3.37890625 C14.11646845 4.14268568 14.11646845 4.14268568 17 4 C18.3338875 4.66555717 19.66715795 5.33235168 21 6 C22.63502761 6.38283573 24.2827109 6.71442777 25.9375 7 C29.50058165 7.6631437 32.69531121 8.4578119 36 10 C35.34 10.33 34.68 10.66 34 11 C34 11.66 34 12.32 34 13 C33.34 13.66 32.68 14.32 32 15 C25.78356005 14.65829294 16.9451232 12.07317203 12.5625 7.5 C10.5287168 5.54756813 8.51653504 4.88860664 5.875 3.9375 C1.10875332 2.21750663 1.10875332 2.21750663 0 0 Z " fill="#F8CA40" transform="translate(562,334)"/><path d="M0 0 C0.71800781 0.19335938 1.43601562 0.38671875 2.17578125 0.5859375 C12.04299521 3.06810091 21.88446763 4.09205887 32 5 C32 5.66 32 6.32 32 7 C33.98 7 35.96 7 38 7 C38 7.99 38 8.98 38 10 C30.90783284 10.57374835 24.24738994 9.69718368 17.3125 8.3125 C16.51739014 8.16393555 15.72228027 8.01537109 14.90307617 7.86230469 C9.22879869 6.65854515 4.59626328 4.58661561 0 1 C0 0.67 0 0.34 0 0 Z " fill="#F7D02B" transform="translate(90,814)"/><path d="M0 0 C14.57746916 -1.18999748 32.39278015 5.74471546 43.71875 14.8359375 C53.92958764 23.65093572 61.42940997 34.22578685 66 47 C66.16015625 49.88671875 66.16015625 49.88671875 66 52 C64.10389358 49.15584037 63.03569739 46.6727987 61.8125 43.5 C54.96361452 26.88994635 43.87608648 15.8059979 27.578125 8.45703125 C18.62034831 5.103025 9.3302964 3.02194075 0 1 C0 0.67 0 0.34 0 0 Z " fill="#A88949" transform="translate(868,49)"/><path d="M0 0 C2.85359322 1.42679661 2.87581233 3.00216622 4 6 C5.05225932 8.34330056 6.12086292 10.67851619 7.1953125 13.01171875 C8 15 8 15 8 17 C9.32 17.66 10.64 18.32 12 19 C11.67 19.66 11.34 20.32 11 21 C12.32295768 22.32295768 13.65621227 23.63570564 15 24.9375 C17 27 17 27 19 30 C19.66 30 20.32 30 21 30 C21.33 31.65 21.66 33.3 22 35 C22.53625 35.061875 23.0725 35.12375 23.625 35.1875 C27.11156962 36.38027382 29.24940393 38.56197166 32 41 C30.515 41.495 30.515 41.495 29 42 C26.625 40.25 26.625 40.25 24 38 C23.22011719 37.56945312 22.44023438 37.13890625 21.63671875 36.6953125 C12.96254535 31.11814027 2.61793518 16.88727598 0.28515625 6.95703125 C0.04314128 4.60650232 -0.08521197 2.35930637 0 0 Z " fill="#B1893B" transform="translate(28,790)"/><path d="M0 0 C2.89061441 2.73568282 5.13199539 5.48134856 7.28515625 8.82421875 C7.89351318 9.76249512 8.50187012 10.70077148 9.12866211 11.66748047 C9.76682861 12.66408691 10.40499512 13.66069336 11.0625 14.6875 C12.39793902 16.76724725 13.73388095 18.84667166 15.0703125 20.92578125 C15.73063477 21.95396973 16.39095703 22.9821582 17.07128906 24.04150391 C18.8168202 26.7190161 20.60609857 29.35576871 22.4296875 31.98046875 C22.94136475 32.72917236 23.45304199 33.47787598 23.98022461 34.24926758 C24.9206048 35.62100326 25.87619138 36.98249466 26.84985352 38.33081055 C30.16627577 43.23570161 30.55198636 47.14743232 30 53 C29.67 53 29.34 53 29 53 C29 50.36 29 47.72 29 45 C27.515 44.505 27.515 44.505 26 44 C24.6484375 42.29296875 24.6484375 42.29296875 23.375 40.1875 C22.73691406 39.15689453 22.73691406 39.15689453 22.0859375 38.10546875 C21 36 21 36 20.6640625 34.05078125 C19.65358643 30.93019339 17.31955134 29.28310125 15 27 C13.2894222 24.72395869 11.76691915 22.345673 10.25 19.9375 C9.85167969 19.32583984 9.45335937 18.71417969 9.04296875 18.08398438 C7.12592803 15.07845443 5.75597873 12.47585874 5 9 C4.34 8.54625 3.68 8.0925 3 7.625 C1 6 1 6 0.25 2.8125 C0.12625 1.4203125 0.12625 1.4203125 0 0 Z " fill="#E5B943" transform="translate(974,457)"/><path d="M0 0 C5.89193982 1.92777456 11.72867797 3.96573867 17.53515625 6.13671875 C18.29928329 6.42102249 19.06341034 6.70532623 19.85069275 6.99824524 C22.25516495 7.89323099 24.65884391 8.79032504 27.0625 9.6875 C28.70762994 10.30027079 30.35281179 10.91290221 31.99804688 11.52539062 C35.99929884 13.0153195 39.99984161 14.50713771 44 16 C41 18 41 18 37.22265625 17.4765625 C30.41118953 15.75678792 23.93989957 12.99678866 17.4375 10.375 C16.12980555 9.85354366 14.82186443 9.33270546 13.51367188 8.8125 C10.33997606 7.5477061 7.16890434 6.2767405 4 5 C4 4.34 4 3.68 4 3 C2.68 2.67 1.36 2.34 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FBEC7F" transform="translate(531,206)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C2.83819158 1.62249941 3.6704116 3.24808497 4.5 4.875 C4.9640625 5.77992188 5.428125 6.68484375 5.90625 7.6171875 C7 10 7 10 7 12 C7.99 12.33 8.98 12.66 10 13 C10.73578693 14.97561688 11.39031621 16.98189938 12 19 C13.0059248 21.14215073 14.04794389 23.2677163 15.125 25.375 C15.93324219 26.96441406 15.93324219 26.96441406 16.7578125 28.5859375 C17.16773438 29.38257813 17.57765625 30.17921875 18 31 C18.66 31 19.32 31 20 31 C20.09152344 31.67417969 20.18304688 32.34835938 20.27734375 33.04296875 C21.18352775 36.75097572 22.81283099 39.94828493 24.5625 43.3125 C24.89185547 43.95767578 25.22121094 44.60285156 25.56054688 45.26757812 C26.36824255 46.84785228 27.18337613 48.42432105 28 50 C28.66 50 29.32 50 30 50 C30.3403125 51.6396875 30.3403125 51.6396875 30.6875 53.3125 C31.65644095 57.02984606 31.65644095 57.02984606 34.1875 58.8125 C37.10426218 60.12049906 37.10426218 60.12049906 40.75 61 C42.35875 61.495 42.35875 61.495 44 62 C44.33 62.99 44.66 63.98 45 65 C43.41531323 64.54636829 41.83230076 64.08688548 40.25 63.625 C39.36828125 63.36976563 38.4865625 63.11453125 37.578125 62.8515625 C31.56986667 60.86701657 31.56986667 60.86701657 29.45117188 57.64355469 C28.96197266 56.66290039 28.47277344 55.68224609 27.96875 54.671875 C27.4111499 53.57230469 26.8535498 52.47273438 26.27905273 51.33984375 C25.68600279 50.14324521 25.09298596 48.94663025 24.5 47.75 C23.25641702 45.28385792 22.00482856 42.82180052 20.75390625 40.359375 C20.44002457 39.73865112 20.12614288 39.11792725 19.80274963 38.47839355 C16.36628353 31.70171719 12.70268706 25.05308878 8.99609375 18.42089844 C5.67104092 12.41549407 2.76055455 6.28423779 0 0 Z " fill="#CBAC4D" transform="translate(285,140)"/><path d="M0 0 C1.65 0 3.3 0 5 0 C4.67 0.99 4.34 1.98 4 3 C3.34 3 2.68 3 2 3 C2 3.99 2 4.98 2 6 C-33.64 6 -69.28 6 -106 6 C-106 5.67 -106 5.34 -106 5 C-70.69 5 -35.38 5 1 5 C0.505 2.525 0.505 2.525 0 0 Z " fill="#FDD031" transform="translate(899,529)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C6.37429739 4.69929538 10.56364855 9.52561886 10.5 16.1875 C10.335 17.445625 10.17 18.70375 10 20 C4.02954791 17.81568826 -0.2628599 13.7908202 -3 8 C-2.68233554 4.68095408 -1.67519104 2.97211313 0 0 Z " fill="#F9D456" transform="translate(751,529)"/><path d="M0 0 C6.6 0 13.2 0 20 0 C20 0.33 20 0.66 20 1 C18.02 1.33 16.04 1.66 14 2 C16.97 2.495 16.97 2.495 20 3 C20 5.97 20 8.94 20 12 C15.67578354 10.41555427 11.73557417 8.282196 7.75 6 C7.11320313 5.64421875 6.47640625 5.2884375 5.8203125 4.921875 C1.12118676 2.24237351 1.12118676 2.24237351 0 0 Z " fill="#A16601" transform="translate(951,339)"/><path d="M0 0 C4.84111765 0.58838199 8.96071195 2.07653116 13.375 4.0625 C14.01566406 4.34416016 14.65632813 4.62582031 15.31640625 4.91601562 C16.88029659 5.60459421 18.44053941 6.30144711 20 7 C17 9 17 9 14.3125 8.625 C13.549375 8.41875 12.78625 8.2125 12 8 C13.55461771 9.55461771 15.47215611 10.17310116 17.47265625 11.06640625 C18.37177734 11.46923828 19.27089844 11.87207031 20.19726562 12.28710938 C21.14279297 12.70798828 22.08832031 13.12886719 23.0625 13.5625 C24.4865918 14.19961914 24.4865918 14.19961914 25.93945312 14.84960938 C28.29206505 15.90178255 30.64560933 16.95181454 33 18 C29.47731356 19.20003604 29.0976993 19.04627862 25.4375 17.3125 C24.74914062 16.93738281 24.06078125 16.56226563 23.3515625 16.17578125 C20.72923086 14.86461543 18.08871653 13.93912446 15.3125 13 C8.52179177 10.61102508 4.14263588 6.83735056 0 1 C0 0.67 0 0.34 0 0 Z " fill="#FDEE7A" transform="translate(407,365)"/><path d="M0 0 C15.84 0.495 15.84 0.495 32 1 C32 1.33 32 1.66 32 2 C40.25 2 48.5 2 57 2 C57 2.66 57 3.32 57 4 C55.96762711 3.99880661 55.96762711 3.99880661 54.91439819 3.99758911 C47.74374604 3.99514928 40.57417557 4.03436504 33.40380859 4.09765625 C30.72825098 4.1191483 28.05424298 4.12338637 25.37841797 4.12011719 C21.53018686 4.11725924 17.68389942 4.15258911 13.8359375 4.1953125 C12.64197357 4.18621857 11.44800964 4.17712463 10.21786499 4.16775513 C3.0438426 4.18908684 3.0438426 4.18908684 -2.67724609 8.05029297 C-3.82700928 9.51039795 -3.82700928 9.51039795 -5 11 C-5.66 11 -6.32 11 -7 11 C-6.8125 8.625 -6.8125 8.625 -6 6 C-4.34795544 5.29788106 -2.68076231 4.63028587 -1 4 C-0.67 2.68 -0.34 1.36 0 0 Z " fill="#C19845" transform="translate(674,609)"/><path d="M0 0 C15.84 0 31.68 0 48 0 C46.02 0.99 46.02 0.99 44 2 C44 2.66 44 3.32 44 4 C39.87450943 3.88879348 35.74982493 3.75848948 31.625 3.625 C30.46871094 3.5940625 29.31242188 3.563125 28.12109375 3.53125 C21.21961964 3.29730173 14.71516393 2.63321078 8 1 C7.67 1.66 7.34 2.32 7 3 C4.69 2.34 2.38 1.68 0 1 C0 0.67 0 0.34 0 0 Z " fill="#D4BD85" transform="translate(694,821)"/><path d="M0 0 C5.19735403 1.48817946 10.27850708 3.08591749 15.3125 5.0625 C21.40236112 7.33965437 27.56843175 8.22289477 34 9 C34 9.66 34 10.32 34 11 C39.94 12.485 39.94 12.485 46 14 C45.67 14.66 45.34 15.32 45 16 C45.66 16.66 46.32 17.32 47 18 C40.85737429 17.57144472 35.74130213 15.42954828 30.0859375 13.05859375 C27.13968871 12.04791853 25.07844803 11.77684113 22 12 C22 11.34 22 10.68 22 10 C21.36908447 9.76812988 20.73816895 9.53625977 20.08813477 9.29736328 C17.24348355 8.24724852 14.4030012 7.18628616 11.5625 6.125 C10.56927734 5.76019531 9.57605469 5.39539063 8.55273438 5.01953125 C7.60849609 4.66503906 6.66425781 4.31054688 5.69140625 3.9453125 C4.81685791 3.62062988 3.94230957 3.29594727 3.04125977 2.96142578 C1 2 1 2 0 0 Z " fill="#FEED65" transform="translate(322,131)"/><path d="M0 0 C4.9653896 0.40383945 7.71491683 2.96199171 11.1875 6.25 C11.98704102 6.96736328 11.98704102 6.96736328 12.80273438 7.69921875 C17.26965909 11.84587339 18.79450966 14.87659978 19.375 20.875 C19.2881069 25.4455773 17.50100811 28.24848783 15 32 C14.67 31.01 14.34 30.02 14 29 C14.495 28.030625 14.99 27.06125 15.5 26.0625 C17.20224648 23.2730972 17.20224648 23.2730972 16.796875 21.05859375 C14.85883102 16.05198013 10.300313 12.0402504 6.1875 8.75 C3.92056553 6.93645242 3.16516462 5.59921338 2 3 C1.34 2.67 0.68 2.34 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FADA38" transform="translate(247,635)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.57394909 12.70659517 0.48891427 22.4223971 -6.8515625 33.24609375 C-8.25204707 35.31105098 -8.25204707 35.31105098 -10 39 C-7.69 41.97 -5.38 44.94 -3 48 C-3.66 49.32 -4.32 50.64 -5 52 C-5.2475 51.360625 -5.495 50.72125 -5.75 50.0625 C-6.36875 49.0415625 -6.36875 49.0415625 -7 48 C-7.9590625 47.814375 -7.9590625 47.814375 -8.9375 47.625 C-11 47 -11 47 -12.875 44.25 C-14 41 -14 41 -13.28515625 38.59765625 C-11.50727855 35.00407366 -9.1637988 31.98360403 -6.75390625 28.79296875 C-2.71862252 22.36707149 -1.4759932 15.97495094 -0.8125 8.5 C-0.73064453 7.67757812 -0.64878906 6.85515625 -0.56445312 6.0078125 C-0.36661362 4.00614225 -0.18191276 2.00318047 0 0 Z " fill="#F4C752" transform="translate(861,615)"/><path d="M0 0 C4.63566101 1.04958362 8.94645898 2.33014042 13.375 4.0625 C18.57845739 6.02016439 23.46527614 6.75988183 29 7 C29.06316406 7.62648437 29.12632812 8.25296875 29.19140625 8.8984375 C29.45824219 9.59195313 29.72507812 10.28546875 30 11 C32.2492114 12.07128705 32.2492114 12.07128705 34.9375 12.625 C39.81904762 13.81904762 39.81904762 13.81904762 42 16 C34.9533063 14.71878296 28.44805282 12.46937836 21.76586914 9.94482422 C19.86300821 9.24247334 17.93288816 8.61491448 16 8 C15.01 8.495 15.01 8.495 14 9 C12.08203125 8.29296875 12.08203125 8.29296875 9.8125 7.1875 C5.91107192 5.36304577 2.16803369 4.06417881 -2 3 C-1.34 2.67 -0.68 2.34 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FDED6A" transform="translate(391,157)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1 6.93 1 13.86 1 21 C-1.92875 22.32 -4.8575 23.64 -7.875 25 C-8.79651855 25.41765625 -9.71803711 25.8353125 -10.66748047 26.265625 C-11.39338379 26.59046875 -12.11928711 26.9153125 -12.8671875 27.25 C-13.61081543 27.58515625 -14.35444336 27.9203125 -15.12060547 28.265625 C-17 29 -17 29 -19 29 C-18.92313965 30.4226416 -18.92313965 30.4226416 -18.84472656 31.87402344 C-18.66416888 35.39964974 -18.50232383 38.92511366 -18.35302734 42.45214844 C-18.28464771 43.97724112 -18.2088663 45.50202091 -18.12548828 47.02636719 C-18.00678158 49.22029592 -17.9149166 51.41398042 -17.828125 53.609375 C-17.78560608 54.2886908 -17.74308716 54.96800659 -17.69927979 55.66790771 C-17.58786627 59.17848242 -17.75212257 60.69650365 -20.01074219 63.46191406 C-20.66719727 63.96948242 -21.32365234 64.47705078 -22 65 C-21.84152588 64.50145508 -21.68305176 64.00291016 -21.51977539 63.48925781 C-20.8044961 60.06371173 -20.76415926 56.65752883 -20.68359375 53.171875 C-20.6524221 52.04836639 -20.6524221 52.04836639 -20.62062073 50.90216064 C-20.55542912 48.51819712 -20.49638217 46.13412688 -20.4375 43.75 C-20.39428584 42.13019746 -20.35067063 40.51040557 -20.30664062 38.890625 C-20.19977904 34.92719168 -20.09842667 30.9636514 -20 27 C-17.42047597 25.82421696 -14.83696062 24.659209 -12.25 23.5 C-11.52039063 23.16613281 -10.79078125 22.83226562 -10.0390625 22.48828125 C-9.33007812 22.17246094 -8.62109375 21.85664062 -7.890625 21.53125 C-7.24125977 21.23798828 -6.59189453 20.94472656 -5.92285156 20.64257812 C-4 20 -4 20 0 20 C0 13.4 0 6.8 0 0 Z " fill="#B8A474" transform="translate(1008,587)"/><path d="M0 0 C2.328125 1.53125 2.328125 1.53125 4 3 C3.01 3.33 2.02 3.66 1 4 C1 3.34 1 2.68 1 2 C-0.98 2.33 -2.96 2.66 -5 3 C-5 3.33 -5 3.66 -5 4 C-6.216875 4.20625 -7.43375 4.4125 -8.6875 4.625 C-13.36998516 5.80183698 -15.33891975 7.93011256 -18 12 C-18.68960962 13.99220557 -19.36079057 15.99105606 -20 18 C-20.99 18.66 -21.98 19.32 -23 20 C-23.49186431 14.09762829 -22.56435568 9.82652129 -19 5 C-13.65009889 -0.21143308 -7.25292006 -1.35147579 0 0 Z " fill="#FAE642" transform="translate(155,563)"/><path d="M0 0 C2.5009467 3.75142005 3.17052468 7.20361132 4.125 11.5625 C4.30385742 12.36864746 4.48271484 13.17479492 4.66699219 14.00537109 C5.88647253 19.78106228 6.38156945 25.08567355 6 31 C5.01 30.67 4.02 30.34 3 30 C2.20043945 28.06982422 2.20043945 28.06982422 1.61328125 25.5546875 C1.2894043 24.18570313 1.2894043 24.18570313 0.95898438 22.7890625 C0.63897461 21.34660156 0.63897461 21.34660156 0.3125 19.875 C0.08755859 18.9365625 -0.13738281 17.998125 -0.36914062 17.03125 C-1.54319529 11.93535317 -2.47865317 7.23049988 -2 2 C-1.34 1.34 -0.68 0.68 0 0 Z " fill="#EDBF32" transform="translate(967,85)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C1.649375 1.680625 1.29875 2.36125 0.9375 3.0625 C-0.45340813 7.42067881 0.42307661 10.92307581 1.625 15.25 C3.90614054 18.15326977 6.54370674 18.90550713 10 20 C14.37172751 19.8251309 17.67533433 18.87538652 21 16 C22.30001303 13.07237066 23.20102372 10.09846898 24 7 C24.33 7 24.66 7 25 7 C25.91128255 14.59402122 25.91128255 14.59402122 23.76953125 17.8984375 C20.07804622 21.63549642 17.00499699 23.13800528 11.6875 23.3125 C7.03654292 23.22931215 4.45126103 22.28691526 1 19 C-2.05630569 13.87142643 -2.93928277 7.87966614 -2 2 C-1.34 1.34 -0.68 0.68 0 0 Z " fill="#F8DD5C" transform="translate(618,773)"/><path d="M0 0 C3.16552079 0.47962436 5.60264975 1.26432006 8.5625 2.5625 C11.99405914 4.25720409 11.99405914 4.25720409 16 4 C16 4.99 16 5.98 16 7 C16.67933594 7.10183594 17.35867188 7.20367187 18.05859375 7.30859375 C22.25138247 8.29414966 26.021744 10.12276304 29.91601562 11.91601562 C33.26953232 13.41331551 35.24531117 14 39 14 C40.02408568 14.9753197 41.01834406 15.98198643 42 17 C44.28695115 18.43062639 46.63173477 19.70415676 49 21 C47 22 47 22 44.71948242 21.24658203 C43.77435791 20.83778809 42.8292334 20.42899414 41.85546875 20.0078125 C40.79505371 19.5538208 39.73463867 19.0998291 38.64208984 18.63208008 C37.5020752 18.13474365 36.36206055 17.63740723 35.1875 17.125 C34.02943848 16.62701904 32.87137695 16.12903809 31.67822266 15.6159668 C29.28881807 14.58784538 26.90080772 13.55647801 24.51416016 12.52197266 C20.23696212 10.66953049 15.95147869 8.83687171 11.6652832 7.00537109 C7.77463244 5.342083 3.88704557 3.67169265 0 2 C0 1.34 0 0.68 0 0 Z " fill="#AF8C50" transform="translate(445,348)"/><path d="M0 0 C3.87448028 0.51648683 5.79559911 1.30673576 8.48828125 4.1328125 C9.10864258 4.7712207 9.72900391 5.40962891 10.36816406 6.06738281 C11.00979492 6.74639648 11.65142578 7.42541016 12.3125 8.125 C13.64527545 9.49920218 14.97989169 10.87162161 16.31640625 12.2421875 C17.26990967 13.22396973 17.26990967 13.22396973 18.24267578 14.22558594 C20.86352057 16.87191824 23.6312585 19.31267604 26.484375 21.703125 C26.98453125 22.13109375 27.4846875 22.5590625 28 23 C28.58265625 23.46921875 29.1653125 23.9384375 29.765625 24.421875 C30.37664063 25.20304688 30.37664063 25.20304688 31 26 C30.57714844 28.09863281 30.57714844 28.09863281 30 30 C29.33991943 29.33468262 28.67983887 28.66936523 27.99975586 27.98388672 C25.52119439 25.4881598 23.04030387 22.99479398 20.55786133 20.50292969 C19.48922816 19.42930516 18.4214987 18.35478027 17.35473633 17.27929688 C11.74369619 11.62357867 6.09737757 6.13736493 0 1 C0 0.67 0 0.34 0 0 Z " fill="#9C6F2A" transform="translate(843,718)"/><path d="M0 0 C5.81175268 2.45881844 10.13279032 6.40894112 13 12 C13.391875 12.70125 13.78375 13.4025 14.1875 14.125 C15 16 15 16 15 19 C15.99 18.67 16.98 18.34 18 18 C18.99 18.99 19.98 19.98 21 21 C20.67 21.66 20.34 22.32 20 23 C13.6421257 21.97089839 9.72771233 16.214252 5.9609375 11.38671875 C0.752437 4.15269028 0.752437 4.15269028 0 0 Z " fill="#F1C418" transform="translate(57,783)"/><path d="M0 0 C24.75 0.495 24.75 0.495 50 1 C49.67 1.66 49.34 2.32 49 3 C43.14673162 3.02480684 37.29349418 3.04291055 31.44018555 3.05493164 C29.45092231 3.05994564 27.46166273 3.06675849 25.47241211 3.07543945 C22.60529678 3.08763384 19.73823038 3.09325777 16.87109375 3.09765625 C15.54723915 3.10539818 15.54723915 3.10539818 14.19664001 3.11329651 C9.35354428 3.11373181 4.77531522 2.81805934 0 2 C0 1.34 0 0.68 0 0 Z " fill="#A78A46" transform="translate(483,853)"/><path d="M0 0 C6.45353615 2.05764921 12.7361263 4.42383482 19 7 C15.5647952 9.29013653 14.014669 9.17842973 10 9 C13.465 10.485 13.465 10.485 17 12 C13.0062979 13.33123403 11.37754568 12.26957871 7.5 10.75 C6.3553125 10.31171875 5.210625 9.8734375 4.03125 9.421875 C1.35775371 8.16781231 -0.15218371 7.24377693 -2 5 C-0.35 4.67 1.3 4.34 3 4 C2.01 3.34 1.02 2.68 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FCE064" transform="translate(374,253)"/><path d="M0 0 C9.6865146 9.481509 17.69455615 20.3972325 25.70214844 31.29248047 C26.87764765 32.83902702 28.14173125 34.3172401 29.4140625 35.78515625 C29.93742188 36.51605469 30.46078125 37.24695313 31 38 C30.67 38.99 30.34 39.98 30 41 C26 36.25 26 36.25 26 34 C24.68 33.34 23.36 32.68 22 32 C22 31.01 22 30.02 22 29 C21.01 28.67 20.02 28.34 19 28 C18.01477444 26.29227569 17.03494315 24.58062384 16.109375 22.83984375 C14.48795556 20.15079953 12.23947936 18.18054569 10 16 C8.8125 13.8125 8.8125 13.8125 8 12 C7.34 11.34 6.68 10.68 6 10 C5.30251417 8.68252676 4.63040043 7.35085807 4 6 C3.34 6 2.68 6 2 6 C1.34 4.02 0.68 2.04 0 0 Z " fill="#8E5E06" transform="translate(747,536)"/><path d="M0 0 C4.20969919 1.50346399 5.91860139 4.14555814 8 8 C7.8125 10.125 7.8125 10.125 7 12 C6.814375 12.7425 6.62875 13.485 6.4375 14.25 C6.293125 14.8275 6.14875 15.405 6 16 C2.50892621 14.83630874 2.14777237 14.11026462 0.3125 11.0625 C-0.12449219 10.35222656 -0.56148437 9.64195312 -1.01171875 8.91015625 C-2 7 -2 7 -2 5 C-2.66 4.67 -3.32 4.34 -4 4 C-2.68 2.68 -1.36 1.36 0 0 Z " fill="#CB941C" transform="translate(624,458)"/><path d="M0 0 C3.74496234 3.65644505 7.22820379 7.45698468 10.625 11.4375 C11.14352539 12.04368164 11.66205078 12.64986328 12.19628906 13.27441406 C17.21137788 19.17863824 21.98675504 25.25862371 26.73486328 31.37792969 C29.78188769 35.28461247 32.89528732 39.1391252 36 43 C35.505 43.99 35.505 43.99 35 45 C28.05906156 37.02942846 21.30213178 28.96483495 14.82421875 20.61328125 C12.79527943 18.00133834 10.73070844 15.42192552 8.64453125 12.85546875 C8.08894531 12.17025146 7.53335938 11.48503418 6.9609375 10.77905273 C5.88009574 9.4486505 4.79558034 8.12122257 3.70703125 6.79711914 C0 2.22186864 0 2.22186864 0 0 Z " fill="#917146" transform="translate(883,652)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.29023834 5.40337336 1.5747818 10.8070089 1.85449219 16.2109375 C1.95000701 18.04174503 2.04696503 19.87247795 2.14550781 21.703125 C2.7605063 33.14962745 3.14594048 44.53556422 3 56 C2.67 56 2.34 56 2 56 C-0.47011992 44.25509499 -0.22938696 32.62798901 -0.125 20.6875 C-0.11494709 18.67513468 -0.10582534 16.66276448 -0.09765625 14.65039062 C-0.07583286 9.7668046 -0.04143115 4.88345743 0 0 Z " fill="#C3AD6E" transform="translate(1005,528)"/><path d="M0 0 C4.90161095 0.62594246 8.84709213 2.71819643 13.1875 4.9375 C13.91130859 5.29779297 14.63511719 5.65808594 15.38085938 6.02929688 C20.7324953 8.7324953 20.7324953 8.7324953 23 11 C22.01 11.33 21.02 11.66 20 12 C19.67 11.01 19.34 10.02 19 9 C17.7934375 9.2784375 17.7934375 9.2784375 16.5625 9.5625 C15.716875 9.706875 14.87125 9.85125 14 10 C13.67 9.67 13.34 9.34 13 9 C11.9275 8.87625 10.855 8.7525 9.75 8.625 C5.99418094 7.99903016 3.92291711 7.40710821 1 5 C0.1875 2.3125 0.1875 2.3125 0 0 Z " fill="#FBD824" transform="translate(900,17)"/><path d="M0 0 C3.465 1.485 3.465 1.485 7 3 C6.01 3.66 5.02 4.32 4 5 C3.49095616 7.4157113 3.49095616 7.4157113 3.48828125 10.2265625 C3.45283203 11.2578125 3.41738281 12.2890625 3.38085938 13.3515625 C3.35830078 14.43179688 3.33574219 15.51203125 3.3125 16.625 C3.27833984 17.71296875 3.24417969 18.8009375 3.20898438 19.921875 C3.12631666 22.61448063 3.05722913 25.30675291 3 28 C2.01 28 1.02 28 0 28 C0 18.76 0 9.52 0 0 Z " fill="#F9CA06" transform="translate(271,731)"/><path d="M0 0 C0 7.92 0 15.84 0 24 C-0.99 23.67 -1.98 23.34 -3 23 C-3.33 17.06 -3.66 11.12 -4 5 C-5.98 6.32 -7.96 7.64 -10 9 C-8.5124715 4.98367305 -4.56813239 0 0 0 Z " fill="#644112" transform="translate(973,316)"/><path d="M0 0 C3.63 1.32 7.26 2.64 11 4 C7 5 7 5 4 4 C4 4.99 4 5.98 4 7 C4.54817383 7.11786865 5.09634766 7.2357373 5.66113281 7.35717773 C8.37935603 8.10426351 10.8402034 9.15208927 13.421875 10.28515625 C14.44667969 10.73310547 15.47148437 11.18105469 16.52734375 11.64257812 C17.59082031 12.11115234 18.65429688 12.57972656 19.75 13.0625 C20.82894531 13.53494141 21.90789062 14.00738281 23.01953125 14.49414062 C25.68092538 15.65997257 28.3410137 16.82868927 31 18 C27.32666271 19.22444576 26.5683084 18.65749402 23.11328125 17.12890625 C22.17548828 16.71962891 21.23769531 16.31035156 20.27148438 15.88867188 C19.29501953 15.45103516 18.31855469 15.01339844 17.3125 14.5625 C16.32443359 14.12873047 15.33636719 13.69496094 14.31835938 13.24804688 C11.87498095 12.17390467 9.43590696 11.09095482 7 10 C7.33 11.98 7.66 13.96 8 16 C5.86555934 13.25214237 4.02037559 10.46859452 2.3125 7.4375 C1.65701172 6.29087891 1.65701172 6.29087891 0.98828125 5.12109375 C0 3 0 3 0 0 Z " fill="#FDE76A" transform="translate(340,239)"/><path d="M0 0 C-4.38707136 2.3502168 -8.16916667 3.07171885 -13.11328125 3.375 C-18.77969259 3.8637268 -23.82143316 5.16038086 -29.1875 7 C-30.0844458 7.30035156 -30.9813916 7.60070312 -31.90551758 7.91015625 C-38.77717103 10.32044953 -45.00925874 13.42347697 -51.2019043 17.2421875 C-52.77304099 18.20891264 -54.38330287 19.11156406 -56 20 C-56.66 19.67 -57.32 19.34 -58 19 C-40.72802823 7.43528846 -21.11384036 -0.6046346 0 0 Z " fill="#FAC81F" transform="translate(129,17)"/><path d="M0 0 C5.03405033 0.47194222 9.48120657 2.88335384 14 5 C12.4375 7.5625 12.4375 7.5625 10 10 C5.16930351 10 1.93165314 8.7402431 -2 6 C-0.68 5.67 0.64 5.34 2 5 C1.01 3.68 0.02 2.36 -1 1 C-0.67 0.67 -0.34 0.34 0 0 Z " fill="#E4B334" transform="translate(612,452)"/><path d="M0 0 C2.53149646 1.26574823 2.62100714 2.18269593 3.6875 4.75 C5.7918805 9.13215564 8.54657464 11.96861299 13 14 C14.32 14 15.64 14 17 14 C17 14.66 17 15.32 17 16 C24.62951555 16.34855655 30.92444501 16.0017506 38 13 C38 13.66 38 14.32 38 15 C29.593472 18.46151153 23.16148896 20.90031633 14.375 17.3125 C7.51357337 13.93493027 3.33301685 9.92241962 0 3 C0 2.01 0 1.02 0 0 Z " fill="#AD9154" transform="translate(520,720)"/><path d="M0 0 C2.87807599 2.71491623 5.05201341 5.40306817 7.12890625 8.765625 C7.68900391 9.65507812 8.24910156 10.54453125 8.82617188 11.4609375 C9.9918283 13.3333305 11.15323435 15.20837573 12.31054688 17.0859375 C12.86935547 17.97023438 13.42816406 18.85453125 14.00390625 19.765625 C14.75909546 20.98427246 14.75909546 20.98427246 15.52954102 22.22753906 C16.25741821 23.10490723 16.25741821 23.10490723 17 24 C17.99 24 18.98 24 20 24 C20.33 22.68 20.66 21.36 21 20 C21.33 20 21.66 20 22 20 C22 24.29 22 28.58 22 33 C18.36588434 29.55863565 15.52760862 26.08143671 12.79296875 21.89453125 C12.42271072 21.32925217 12.0524527 20.76397308 11.67097473 20.18156433 C10.89758775 18.99771102 10.12716488 17.81191636 9.35961914 16.62426758 C8.18074839 14.8020639 6.9905252 12.98766297 5.79882812 11.17382812 C5.046195 10.01867193 4.2942178 8.86308804 3.54296875 7.70703125 C2.86258545 6.6600708 2.18220215 5.61311035 1.48120117 4.53442383 C0 2 0 2 0 0 Z " fill="#B07A08" transform="translate(982,490)"/><path d="M0 0 C3.650625 -0.020625 7.30125 -0.04125 11.0625 -0.0625 C12.76805054 -0.07615601 12.76805054 -0.07615601 14.50805664 -0.09008789 C19.78490299 -0.10446875 24.80344891 0.0638837 30 1 C30 1.33 30 1.66 30 2 C25.52115561 2.19581346 21.04191574 2.3802636 16.5625 2.5625 C15.28310547 2.61857422 14.00371094 2.67464844 12.68554688 2.73242188 C10.86313477 2.80493164 10.86313477 2.80493164 9.00390625 2.87890625 C7.87799072 2.9260376 6.7520752 2.97316895 5.59204102 3.02172852 C3 3 3 3 2 2 C1.67 11.57 1.34 21.14 1 31 C0.67 31 0.34 31 0 31 C0 20.77 0 10.54 0 0 Z " fill="#FAED59" transform="translate(270,730)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C0.48999699 13.79558147 -1.87949596 27.38102966 -4 41 C-4.33 41 -4.66 41 -5 41 C-5.13422417 32.99129139 -4.78765325 25.12637037 -4.12109375 17.15234375 C-3.81350339 13.97213908 -3.81350339 13.97213908 -5 11 C-4.34 10.67 -3.68 10.34 -3 10 C-2.08968728 7.65613191 -2.08968728 7.65613191 -1.375 4.9375 C-1.11460937 4.01839844 -0.85421875 3.09929688 -0.5859375 2.15234375 C-0.39257812 1.44207031 -0.19921875 0.73179687 0 0 Z " fill="#BFAA86" transform="translate(973,678)"/><path d="M0 0 C0.5667041 0.21696533 1.1334082 0.43393066 1.71728516 0.6574707 C-2.2842895 3.00579645 -6.28617234 5.35359585 -10.28833008 7.70092773 C-11.64713696 8.49798691 -13.00586246 9.29518483 -14.36450195 10.0925293 C-16.32790609 11.24475839 -18.29161142 12.3964727 -20.25537109 13.5480957 C-21.152687 14.07490936 -21.152687 14.07490936 -22.06813049 14.61236572 C-26.12344539 16.98967391 -30.19793757 19.33113189 -34.28271484 21.6574707 C-34.28271484 20.6674707 -34.28271484 19.6774707 -34.28271484 18.6574707 C-32.421875 17.21875 -32.421875 17.21875 -29.82177734 15.73168945 C-28.87431641 15.1819043 -27.92685547 14.63211914 -26.95068359 14.06567383 C-25.94650391 13.4978418 -24.94232422 12.93000977 -23.90771484 12.3449707 C-21.96223088 11.22417453 -20.01691744 10.1030823 -18.07177734 8.98168945 C-16.62786621 8.1625708 -16.62786621 8.1625708 -15.15478516 7.3269043 C-13.23578183 6.21145507 -11.33866483 5.05749993 -9.46533203 3.86694336 C-8.14903809 3.03042236 -8.14903809 3.03042236 -6.80615234 2.17700195 C-5.64092041 1.41480347 -5.64092041 1.41480347 -4.45214844 0.63720703 C-2.28271484 -0.3425293 -2.28271484 -0.3425293 0 0 Z " fill="#83704E" transform="translate(971.28271484375,193.342529296875)"/><path d="M0 0 C1.2065625 0.0309375 1.2065625 0.0309375 2.4375 0.0625 C1.2928125 1.5784375 1.2928125 1.5784375 0.125 3.125 C-5.01323676 10.43822902 -5.99138095 16.27838287 -5.5625 25.0625 C-6.5525 24.7325 -7.5425 24.4025 -8.5625 24.0625 C-9.19511132 15.09347729 -8.52993496 8.68466249 -3.5625 1.0625 C-2.5625 0.0625 -2.5625 0.0625 0 0 Z " fill="#EAB826" transform="translate(527.5625,695.9375)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C0.95458849 2.49129308 -0.11208814 3.96769402 -1.1875 5.4375 C-1.77917969 6.26121094 -2.37085938 7.08492187 -2.98046875 7.93359375 C-5.38717801 10.39616473 -6.70895033 10.35409306 -10 11 C-12.10329936 12.98511022 -12.10329936 12.98511022 -13.9375 15.4375 C-17.07018168 19.16604016 -19.10509547 20.99876953 -24 22 C-25.34721283 22.63815344 -26.68747118 23.29325371 -28 24 C-23.81240606 19.62168396 -19.25952932 15.81965199 -14.5625 12 C-13.08452396 10.79180299 -11.6066574 9.58347205 -10.12890625 8.375 C-9.42910645 7.80394531 -8.72930664 7.23289062 -8.00830078 6.64453125 C-5.32439482 4.44676921 -2.66039978 2.22613484 0 0 Z " fill="#F9E244" transform="translate(205,665)"/><path d="M0 0 C0.66 0.66 1.32 1.32 2 2 C0.2675 1.938125 0.2675 1.938125 -1.5 1.875 C-9.3098216 1.94374843 -14.37364372 3.49688288 -20.16796875 8.9140625 C-23.10708608 12.26052019 -25.10780829 15.9881897 -27 20 C-27.66 20 -28.32 20 -29 20 C-29 22.31 -29 24.62 -29 27 C-29.33 27 -29.66 27 -30 27 C-30.19392201 21.47322267 -29.7479503 17.24385089 -28 12 C-26.68 12 -25.36 12 -24 12 C-23.773125 11.443125 -23.54625 10.88625 -23.3125 10.3125 C-20.40668631 5.19273303 -16.68084098 2.335462 -11.1953125 0.5 C-7.50155038 -0.3412839 -3.75063257 -0.59916744 0 0 Z " fill="#F4BC1D" transform="translate(488,625)"/><path d="M0 0 C0.99 1.0828125 0.99 1.0828125 2 2.1875 C6.93886339 7.14047443 13.00331316 11.09684544 20.125 11.25 C24.50618469 11.2285236 28.0135878 10.18806944 32.0546875 8.55859375 C34 8 34 8 37 9 C29.66423876 13.37324228 23.53910856 15.3372661 14.91796875 13.57421875 C9.37271253 11.79142434 4.796044 8.40189641 1 4 C0.27734375 1.77734375 0.27734375 1.77734375 0 0 Z " fill="#AA975E" transform="translate(608,793)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.375 2.6875 1.375 2.6875 1 6 C-2.17330908 9.66151048 -4.6597293 11.24438858 -9.4375 12.0625 C-14.3867015 12.38018523 -17.0196026 10.843141 -21 8 C-23 6 -23 6 -23.125 3.375 C-23.08375 2.59125 -23.0425 1.8075 -23 1 C-22.4225 1.78375 -21.845 2.5675 -21.25 3.375 C-18.63505928 6.42576418 -17.13969739 7.79221947 -13.109375 8.18359375 C-7.69001958 8.37767338 -7.69001958 8.37767338 -3 6 C-1.23272142 2.9665533 -1.23272142 2.9665533 0 0 Z " fill="#F9E460" transform="translate(494,650)"/><path d="M0 0 C0.495 0.99 0.495 0.99 1 2 C3.35599235 2.46751788 3.35599235 2.46751788 6.0625 2.625 C7.44115234 2.73714844 7.44115234 2.73714844 8.84765625 2.8515625 C9.55792969 2.90054688 10.26820313 2.94953125 11 3 C11 3.33 11 3.66 11 4 C-7.15 4 -25.3 4 -44 4 C-44 3.67 -44 3.34 -44 3 C-32.45 3 -20.9 3 -9 3 C-9 2.34 -9 1.68 -9 1 C-5.94152152 0.45627049 -3.11227195 0 0 0 Z " fill="#AE7403" transform="translate(719,608)"/><path d="M0 0 C6.75 0.875 6.75 0.875 9 2 C9.72693904 3.97888961 10.39816251 5.97954558 11 8 C5.03596489 9.83508773 1.24817912 7.71739052 -4 5 C-3.01 4.67 -2.02 4.34 -1 4 C-0.26676204 1.98491642 -0.26676204 1.98491642 0 0 Z " fill="#E1AB27" transform="translate(603,449)"/><path d="M0 0 C7.18216433 2.27435204 14.0758202 5.03584181 21 8 C21 8.33 21 8.66 21 9 C19.700625 8.979375 18.40125 8.95875 17.0625 8.9375 C15.70834367 8.91600546 14.35243917 8.92851801 13 9 C12.67 9.33 12.34 9.66 12 10 C10.33382885 10.04063832 8.66611905 10.042721 7 10 C7 9.34 7 8.68 7 8 C5.68 7.67 4.36 7.34 3 7 C3 6.01 3 5.02 3 4 C2.34 4 1.68 4 1 4 C0.67 2.68 0.34 1.36 0 0 Z " fill="#EFC040" transform="translate(575,436)"/><path d="M0 0 C0.85715607 0.00990463 1.71431213 0.01980927 2.59744263 0.03001404 C5.31935073 0.06901728 8.03713635 0.1568005 10.7578125 0.24609375 C12.6093165 0.28122635 14.46088411 0.31316195 16.3125 0.34179688 C20.83751156 0.41873174 25.35946466 0.53940689 29.8828125 0.68359375 C29.8828125 1.01359375 29.8828125 1.34359375 29.8828125 1.68359375 C25.647204 1.85111871 21.41140676 2.01168707 17.17529297 2.16577148 C15.73381427 2.21918965 14.29240509 2.27451893 12.85107422 2.33178711 C10.78107697 2.41370372 8.71092823 2.48877734 6.640625 2.5625 C4.77108154 2.63319702 4.77108154 2.63319702 2.86376953 2.70532227 C-0.1171875 2.68359375 -0.1171875 2.68359375 -2.1171875 1.68359375 C-2.4471875 2.34359375 -2.7771875 3.00359375 -3.1171875 3.68359375 C-3.7771875 3.68359375 -4.4371875 3.68359375 -5.1171875 3.68359375 C-5.4471875 4.34359375 -5.7771875 5.00359375 -6.1171875 5.68359375 C-7.4371875 5.68359375 -8.7571875 5.68359375 -10.1171875 5.68359375 C-12.34060131 7.42275011 -12.34060131 7.42275011 -14.3671875 9.68359375 C-15.07359375 10.42609375 -15.78 11.16859375 -16.5078125 11.93359375 C-17.03890625 12.51109375 -17.57 13.08859375 -18.1171875 13.68359375 C-18.7771875 13.35359375 -19.4371875 13.02359375 -20.1171875 12.68359375 C-19.4159375 12.00296875 -18.7146875 11.32234375 -17.9921875 10.62109375 C-16.43913714 9.10898227 -15.10073369 7.66040001 -13.8444519 5.88951111 C-9.81027892 0.31767509 -6.67738982 -0.29344917 0 0 Z " fill="#DA9C05" transform="translate(678.1171875,600.31640625)"/><path d="M0 0 C0 0.66 0 1.32 0 2 C1.32 2 2.64 2 4 2 C4.33 2.66 4.66 3.32 5 4 C7.80972258 5.44500019 9.76156752 6 12.9375 6 C16.33896745 6 18.84003242 6.79620283 22 8 C22 8.99 22 9.98 22 11 C14.68998045 10.86946394 9.16361148 8.55970806 2.67382812 5.43920898 C-1.03438982 3.69227655 -3.87461409 2.56027863 -8 3 C-7.67 2.01 -7.34 1.02 -7 0 C-2.25 -1.125 -2.25 -1.125 0 0 Z " fill="#FDE056" transform="translate(417,272)"/><path d="M0 0 C5.11415138 1.45089606 10.10740626 2.92435331 14.9609375 5.12109375 C17.75087084 6.32365122 20.59381257 7.36866576 23.4375 8.4375 C28.47332913 10.35646491 33.23955732 12.47976564 38 15 C38 15.66 38 16.32 38 17 C30.20769499 14.51719884 22.64401238 11.56184271 15.0625 8.5 C13.81966843 8.00909694 12.57682993 7.51821141 11.33398438 7.02734375 C10.16287109 6.55425781 8.99175781 6.08117187 7.78515625 5.59375 C6.19006226 4.95469727 6.19006226 4.95469727 4.56274414 4.30273438 C2 3 2 3 0 0 Z " fill="#AC8E48" transform="translate(329,203)"/><path d="M0 0 C9.41948758 3.47851635 18.76684211 7.04792863 28 11 C28 11.33 28 11.66 28 12 C23.86484243 11.52286643 20.6797192 10.90800255 17 9 C16.01 9.495 16.01 9.495 15 10 C12.6171875 9.22265625 12.6171875 9.22265625 9.875 8.0625 C8.96492187 7.68222656 8.05484375 7.30195313 7.1171875 6.91015625 C6.41851563 6.60980469 5.71984375 6.30945313 5 6 C5 5.01 5 4.02 5 3 C3.35 3.33 1.7 3.66 0 4 C0 2.68 0 1.36 0 0 Z " fill="#F4CA57" transform="translate(560,329)"/><path d="M0 0 C15.18 0.33 30.36 0.66 46 1 C46 1.33 46 1.66 46 2 C40.05149341 2.65783485 34.09329146 3.18325474 28.125 3.625 C26.86945312 3.72039063 25.61390625 3.81578125 24.3203125 3.9140625 C21.42761134 3.98893241 19.72326642 3.69784919 17 3 C15.63323368 2.86070644 14.2625433 2.75634699 12.890625 2.68359375 C12.13652344 2.64169922 11.38242187 2.59980469 10.60546875 2.55664062 C9.43951172 2.49766602 9.43951172 2.49766602 8.25 2.4375 C7.06083984 2.37272461 7.06083984 2.37272461 5.84765625 2.30664062 C3.89862185 2.20097009 1.94933252 2.10002034 0 2 C0 1.34 0 0.68 0 0 Z " fill="#DFCC9D" transform="translate(506,820)"/><path d="M0 0 C-5.82475253 4.85396045 -11.39164597 7.6340295 -19 7 C-18.67 5.68 -18.34 4.36 -18 3 C-17.34 3 -16.68 3 -16 3 C-16 2.34 -16 1.68 -16 1 C-10.26696495 -0.57300962 -5.84340558 -1.24327778 0 0 Z " fill="#B17903" transform="translate(902,816)"/><path d="M0 0 C3.41266885 2.27511257 3.54170632 3.3542658 5 7 C5.99 7.66 6.98 8.32 8 9 C7.01 9 6.02 9 5 9 C6.58272015 11.06297302 8.16615676 13.12538949 9.75 15.1875 C10.41515625 16.0547168 10.41515625 16.0547168 11.09375 16.93945312 C13.69330026 20.32269133 16.32229468 23.67789363 19 27 C18.67 27.66 18.34 28.32 18 29 C12.4564427 22.5756906 6.96282291 16.12144955 1.8125 9.375 C1.07644531 8.41335938 0.34039063 7.45171875 -0.41796875 6.4609375 C-2 4 -2 4 -2 1 C-1.34 0.67 -0.68 0.34 0 0 Z " fill="#F5CB39" transform="translate(846,655)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C4.12348901 1.12067685 6.25070888 1.17744375 8.37744141 1.20532227 C9.03122269 1.21522186 9.68500397 1.22512146 10.3585968 1.23532104 C12.52288167 1.26694711 14.6871885 1.29169772 16.8515625 1.31640625 C18.35086645 1.33697483 19.85016459 1.35797128 21.34945679 1.37937927 C25.29825131 1.43460988 29.24709826 1.48401476 33.19598389 1.53222656 C37.22445346 1.58243439 41.25284678 1.6381242 45.28125 1.69335938 C53.18743556 1.80095303 61.09368485 1.90239529 69 2 C69 2.33 69 2.66 69 3 C46.23 3 23.46 3 0 3 C0 2.01 0 1.02 0 0 Z " fill="#E9D190" transform="translate(396,585)"/><path d="M0 0 C0 0.66 0 1.32 0 2 C-2.2756682 3.85300035 -4.56326102 5.59314772 -6.9375 7.3125 C-8.39937284 8.38414189 -9.86027649 9.45710689 -11.3203125 10.53125 C-12.08504883 11.09328125 -12.84978516 11.6553125 -13.63769531 12.234375 C-16.03585837 14.02680113 -18.39262489 15.86316813 -20.7421875 17.71875 C-21.50668213 18.31905029 -22.27117676 18.91935059 -23.05883789 19.5378418 C-24.54582251 20.70877573 -26.02694622 21.88719617 -27.50170898 23.07348633 C-28.17790283 23.60224365 -28.85409668 24.13100098 -29.55078125 24.67578125 C-30.14544189 25.14927002 -30.74010254 25.62275879 -31.3527832 26.1105957 C-31.89636475 26.40409912 -32.43994629 26.69760254 -33 27 C-33.99 26.67 -34.98 26.34 -36 26 C-35.05382812 25.29617188 -34.10765625 24.59234375 -33.1328125 23.8671875 C-31.7965625 22.87021038 -30.46065308 21.87277668 -29.125 20.875 C-28.06514893 20.08367676 -28.06514893 20.08367676 -26.98388672 19.27636719 C-22.95467448 16.25555889 -18.95887977 13.19846797 -15 10.0859375 C-14.18644043 9.44672363 -13.37288086 8.80750977 -12.53466797 8.14892578 C-10.94182436 6.89369401 -9.35223746 5.63431732 -7.76611328 4.37060547 C-7.04149902 3.79971191 -6.31688477 3.22881836 -5.5703125 2.640625 C-4.60762451 1.87540527 -4.60762451 1.87540527 -3.62548828 1.09472656 C-2 0 -2 0 0 0 Z " fill="#806F47" transform="translate(207,708)"/><path d="M0 0 C0 0.66 0 1.32 0 2 C-11.46312316 6.47272781 -21.52731549 10.39595824 -34 10 C-34 9.67 -34 9.34 -34 9 C-32.02 8.67 -30.04 8.34 -28 8 C-28 7.67 -28 7.34 -28 7 C-26.78183594 6.74605469 -25.56367187 6.49210938 -24.30859375 6.23046875 C-22.68481575 5.88318675 -21.06112225 5.53550945 -19.4375 5.1875 C-18.63763672 5.02185547 -17.83777344 4.85621094 -17.01367188 4.68554688 C-13.20362655 3.86133299 -9.66282337 2.95874278 -6.09765625 1.36328125 C-3 0 -3 0 0 0 Z " fill="#8E6F45" transform="translate(913,846)"/><path d="M0 0 C-0.48470035 10.54641106 -2.00774871 20.65031721 -4 31 C-4.99 30.67 -5.98 30.34 -7 30 C-7 29.34 -7 28.68 -7 28 C-6.34 28 -5.68 28 -5 28 C-5 22.72 -5 17.44 -5 12 C-4.34 12 -3.68 12 -3 12 C-3 9.69 -3 7.38 -3 5 C-3.66 4.67 -4.32 4.34 -5 4 C-1.125 0 -1.125 0 0 0 Z " fill="#BA995E" transform="translate(968,720)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.02505615 1.16047852 1.0501123 2.32095703 1.07592773 3.51660156 C1.17015772 7.82546882 1.27034035 12.13418073 1.37231445 16.44287109 C1.41560433 18.30709192 1.45728361 20.17135088 1.49731445 22.03564453 C1.55516113 24.7165882 1.61881405 27.397341 1.68359375 30.078125 C1.70030624 30.91055725 1.71701874 31.7429895 1.73423767 32.60064697 C1.75418289 33.38115417 1.77412811 34.16166138 1.79467773 34.96582031 C1.81022202 35.64976868 1.8257663 36.33371704 1.84178162 37.03839111 C2.00936805 39.11614606 2.49296272 40.98151263 3 43 C3.06831987 45.4157906 3.08487642 47.83334713 3.0625 50.25 C3.05347656 51.51328125 3.04445313 52.7765625 3.03515625 54.078125 C3.02355469 55.04234375 3.01195312 56.0065625 3 57 C2.67 57 2.34 57 2 57 C-0.52328854 45.10470006 -0.22820875 33.28337042 -0.125 21.1875 C-0.11494778 19.12695749 -0.10582591 17.06641021 -0.09765625 15.00585938 C-0.07582581 10.00378682 -0.04142003 5.00194713 0 0 Z " fill="#D7B344" transform="translate(15,711)"/><path d="M0 0 C3.50417774 3.33080877 6.28820615 6.65093498 8.91796875 10.703125 C9.61470703 11.7653125 10.31144531 12.8275 11.02929688 13.921875 C11.74150391 15.02015625 12.45371094 16.1184375 13.1875 17.25 C14.61305958 19.44638023 16.04498257 21.638174 17.48046875 23.828125 C18.10848389 24.7965332 18.73649902 25.76494141 19.38354492 26.76269531 C20.80679509 29.09635246 20.80679509 29.09635246 23 30 C23.8515625 32.06640625 23.8515625 32.06640625 24.625 34.5625 C24.88539063 35.38878906 25.14578125 36.21507812 25.4140625 37.06640625 C25.70410156 38.02353516 25.70410156 38.02353516 26 39 C22.50099967 35.78060015 19.94620511 32.15195381 17.375 28.1875 C16.4977061 26.85005685 15.62009213 25.5128236 14.7421875 24.17578125 C14.29327148 23.4895166 13.84435547 22.80325195 13.38183594 22.09619141 C12.0028474 20.0043194 10.60319096 17.92798766 9.1953125 15.85546875 C8.74365723 15.18813721 8.29200195 14.52080566 7.82666016 13.83325195 C6.96235555 12.55747219 6.09498967 11.28375931 5.22412109 10.01245117 C3.04542162 6.77918267 1.2804235 3.68817637 0 0 Z " fill="#ECB617" transform="translate(644,495)"/><path d="M0 0 C5.24972347 4.10037573 9.20962911 8.52964787 13 14 C11.02 14.33 9.04 14.66 7 15 C6.67 14.01 6.34 13.02 6 12 C5.34 12 4.68 12 4 12 C0.3692252 8.51445619 0.39841065 4.7809278 0 0 Z " fill="#FAD027" transform="translate(936,37)"/><path d="M0 0 C3.91665027 -0.02953391 7.83327113 -0.04697503 11.75 -0.0625 C12.84183594 -0.07087891 13.93367187 -0.07925781 15.05859375 -0.08789062 C22.4247337 -0.10968394 29.67078775 0.2649241 37 1 C37 1.33 37 1.66 37 2 C29.69848081 2.86611124 22.47545439 3.21191474 15.125 3.25 C14.10664062 3.270625 13.08828125 3.29125 12.0390625 3.3125 C11.059375 3.31765625 10.0796875 3.3228125 9.0703125 3.328125 C7.75184326 3.34214355 7.75184326 3.34214355 6.40673828 3.35644531 C3.53418682 2.93101164 2.1560024 1.89518052 0 0 Z " fill="#AF8525" transform="translate(746,822)"/><path d="M0 0 C7.45627684 -0.12680254 14.91227555 -0.21435293 22.36938477 -0.2746582 C24.9059488 -0.29979839 27.44244042 -0.33391537 29.97875977 -0.37719727 C33.62534451 -0.43786661 37.27097132 -0.46621574 40.91796875 -0.48828125 C42.05147263 -0.51408768 43.1849765 -0.5398941 44.35282898 -0.56648254 C53.12602184 -0.56960611 53.12602184 -0.56960611 56.25512695 2.53051758 C56.83093506 3.34544678 57.40674316 4.16037598 58 5 C57.67 5.66 57.34 6.32 57 7 C56.01 6.67 55.02 6.34 54 6 C53.505 4.02 53.505 4.02 53 2 C35.51 1.67 18.02 1.34 0 1 C0 0.67 0 0.34 0 0 Z " fill="#F4C208" transform="translate(499,565)"/><path d="M0 0 C4.99156546 3.81269051 8.51789903 7.98831158 12.1875 13.0625 C12.70763672 13.76955078 13.22777344 14.47660156 13.76367188 15.20507812 C14.75471803 16.55305278 15.7417953 17.90395806 16.72412109 19.25830078 C17.74329914 20.64957827 18.79766394 22.01505662 19.86328125 23.37109375 C21 25 21 25 21 27 C23.64 27 26.28 27 29 27 C29 27.33 29 27.66 29 28 C26.07084081 28.70574624 23.95377616 29.21400224 21 29 C18.6544715 26.92585497 17.31909191 25.40715973 15.625 22.875 C14.69431142 21.58572016 13.76331418 20.29666308 12.83203125 19.0078125 C12.36748535 18.34426758 11.90293945 17.68072266 11.42431641 16.99707031 C8.75529318 13.25476486 5.85070267 9.69116041 2.99658203 6.08935547 C0 2.2240216 0 2.2240216 0 0 Z " fill="#9F875B" transform="translate(787,529)"/><path d="M0 0 C3 1 3 1 4.76171875 4.0703125 C5.413232 5.41728023 6.05450457 6.76923145 6.6875 8.125 C7.38847773 9.58436668 8.09166108 11.04267567 8.796875 12.5 C9.15716797 13.24636719 9.51746094 13.99273437 9.88867188 14.76171875 C11.94246041 18.89817158 14.19362132 22.93392075 16.47338867 26.94970703 C18.49737766 30.62921917 19.54953919 33.82530685 20 38 C17.22260768 34.57890868 15.23903986 30.83878346 13.2421875 26.93359375 C12.8936673 26.25829117 12.54514709 25.58298859 12.18606567 24.88722229 C11.45317079 23.46519249 10.72207449 22.04223445 9.99267578 20.6184082 C8.8758901 18.43923684 7.75285998 16.26337206 6.62890625 14.08789062 C5.91629585 12.70331579 5.20404389 11.3185564 4.4921875 9.93359375 C3.98907547 8.95851112 3.98907547 8.95851112 3.47579956 7.96372986 C2.12944553 5.33015591 0.93713466 2.81140399 0 0 Z " fill="#CAA954" transform="translate(350,259)"/><path d="M0 0 C2.01852758 4.03705515 2.32836073 6.2112257 2.5625 10.625 C2.67206498 14.97107346 2.67206498 14.97107346 4 19 C3.91219597 21.04498425 3.75758462 23.08744948 3.5625 25.125 C3.46066406 26.22070312 3.35882812 27.31640625 3.25390625 28.4453125 C3.12822266 29.70988281 3.12822266 29.70988281 3 31 C2.67 31 2.34 31 2 31 C1.67 29.35 1.34 27.7 1 26 C0.34 26 -0.32 26 -1 26 C-0.67 17.42 -0.34 8.84 0 0 Z " fill="#D9A325" transform="translate(888,611)"/><path d="M0 0 C3 1 3 1 4.421875 3.43359375 C4.86015625 4.42488281 5.2984375 5.41617188 5.75 6.4375 C6.19859375 7.42621094 6.6471875 8.41492188 7.109375 9.43359375 C7.40328125 10.28050781 7.6971875 11.12742187 8 12 C7.67 12.66 7.34 13.32 7 14 C6.67 13.67 6.34 13.34 6 13 C5.34 13.66 4.68 14.32 4 15 C0.84345952 10.41078616 -1.57202798 6.70629354 -2 1 C-1.34 0.67 -0.68 0.34 0 0 Z " fill="#FAC63B" transform="translate(853,599)"/><path d="M0 0 C6.625 0.75 6.625 0.75 10 3 C9.67 4.32 9.34 5.64 9 7 C4.06729471 8.6442351 1.45975807 7.18615592 -3 5 C-3 4.01 -3 3.02 -3 2 C-2.01 2 -1.02 2 0 2 C0 1.34 0 0.68 0 0 Z " fill="#EBB731" transform="translate(596,345)"/><path d="M0 0 C0 0.99 0 1.98 0 3 C-0.99 3.66 -1.98 4.32 -3 5 C-2.38722388 7.96175123 -1.74627478 9.38058783 0 12 C-0.33 12.99 -0.66 13.98 -1 15 C-1.31453125 14.52949219 -1.6290625 14.05898438 -1.953125 13.57421875 C-2.38109375 12.95160156 -2.8090625 12.32898438 -3.25 11.6875 C-3.66765625 11.07261719 -4.0853125 10.45773437 -4.515625 9.82421875 C-8.21678703 5.27568542 -11.47687482 4.50741322 -17.25 3.8125 C-18.51328125 3.65394531 -19.7765625 3.49539063 -21.078125 3.33203125 C-22.04234375 3.22246094 -23.0065625 3.11289062 -24 3 C-24 2.67 -24 2.34 -24 2 C-21.7722603 1.77692458 -19.54268636 1.57211822 -17.3125 1.375 C-16.07113281 1.25898437 -14.82976563 1.14296875 -13.55078125 1.0234375 C-10.02305934 1.00015221 -8.17895569 1.65677929 -5 3 C-2.19832713 1.73666727 -2.19832713 1.73666727 0 0 Z " fill="#F4CF40" transform="translate(651,756)"/><path d="M0 0 C0.33 0.66 0.66 1.32 1 2 C-4.8580664 8.79775623 -10.91916889 15.40235323 -17 22 C-18.32 21.67 -19.64 21.34 -21 21 C-14.07 14.07 -7.14 7.14 0 0 Z " fill="#F5CF32" transform="translate(652,616)"/><path d="M0 0 C3.81228048 1.27076016 4.29706436 2.58184929 6.4375 5.9375 C7.47197266 7.53658203 7.47197266 7.53658203 8.52734375 9.16796875 C8.9126123 9.76786621 9.29788086 10.36776367 9.69482422 10.98583984 C12.25405648 14.93527234 14.88394022 18.83808794 17.5 22.75 C18.55233662 24.32795611 19.60443998 25.90606783 20.65625 27.484375 C21.10806641 28.16209961 21.55988281 28.83982422 22.02539062 29.53808594 C22.34701172 30.02051758 22.66863281 30.50294922 23 31 C22.67 31.66 22.34 32.32 22 33 C17.64869014 27.39604033 13.69487991 21.58718187 9.83203125 15.63671875 C8.33110529 13.47653746 6.89105926 11.79622738 5 10 C4 8.1875 4 8.1875 3 6 C2.46375 4.9275 1.9275 3.855 1.375 2.75 C0.92125 1.8425 0.4675 0.935 0 0 Z " fill="#8B5802" transform="translate(646,502)"/><path d="M0 0 C3.48576282 0.61034757 6.5871923 1.51608461 9.86328125 2.84765625 C11.19262695 3.38422852 11.19262695 3.38422852 12.54882812 3.93164062 C13.46083984 4.30482422 14.37285156 4.67800781 15.3125 5.0625 C16.24384766 5.43955078 17.17519531 5.81660156 18.13476562 6.20507812 C20.42478917 7.13283125 22.71309996 8.06458001 25 9 C25 9.33 25 9.66 25 10 C17.01790621 9.69121494 10.36897561 8.06446761 3 5 C3 4.01 3 3.02 3 2 C2.01 2 1.02 2 0 2 C0 1.34 0 0.68 0 0 Z " fill="#F7D66B" transform="translate(505,307)"/><path d="M0 0 C7.81699809 2.12444599 15.17894518 5.0163673 22.625 8.1875 C23.72457031 8.65091797 24.82414062 9.11433594 25.95703125 9.59179688 C28.63998883 10.72330507 31.32088144 11.85943902 34 13 C33.67 13.66 33.34 14.32 33 15 C27.84311842 13.42428618 23.08386085 11.61921754 18.31640625 9.10546875 C14.28526088 7.1816675 10.05824865 5.74884624 5.85546875 4.24609375 C3.14618278 3.06379249 1.95871903 2.10780313 0 0 Z " fill="#F2BA10" transform="translate(343,207)"/><path d="M0 0 C3.52308802 0.59608886 6.48586391 1.52678335 9.72265625 3.03125 C10.59083984 3.42957031 11.45902344 3.82789063 12.35351562 4.23828125 C13.24748047 4.65464844 14.14144531 5.07101562 15.0625 5.5 C16.84362843 6.32599351 18.62613293 7.14902776 20.41015625 7.96875 C21.19527588 8.33419922 21.98039551 8.69964844 22.78930664 9.07617188 C24.8516616 9.93801077 26.81978442 10.52524307 29 11 C29 11.66 29 12.32 29 13 C31.475 13.495 31.475 13.495 34 14 C33.67 14.66 33.34 15.32 33 16 C16.665 9.07 16.665 9.07 0 2 C0 1.34 0 0.68 0 0 Z " fill="#EBA805" transform="translate(458,444)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C2.33 0.99 2.66 1.98 3 3 C1.25 6.1875 1.25 6.1875 -1 9 C-1.99 9 -2.98 9 -4 9 C-4.33452052 16.43378943 -4.13902852 22.19877155 -1 29 C-1.99 29 -2.98 29 -4 29 C-6.91661295 22.43762087 -7.3884157 14.79067452 -4.9140625 8.03515625 C-1.83742877 1.83742877 -1.83742877 1.83742877 0 0 Z " fill="#F6DD62" transform="translate(610,764)"/><path d="M0 0 C0.495 0.99 0.495 0.99 1 2 C-6.50214261 2.62611026 -13.92279835 3.05527099 -21.453125 2.92578125 C-23.12097046 2.90064453 -23.12097046 2.90064453 -24.82250977 2.875 C-27.0421386 2.83377349 -29.26152559 2.77554976 -31.48022461 2.69921875 C-37.68238343 2.52601962 -37.68238343 2.52601962 -43.23828125 5.01171875 C-43.81964844 5.66785156 -44.40101563 6.32398438 -45 7 C-44.42655063 4.13275314 -44.1385485 3.1385485 -42 1 C-40.16500854 0.7215271 -40.16500854 0.7215271 -37.91748047 0.68115234 C-37.07675995 0.66128265 -36.23603943 0.64141296 -35.36984253 0.62094116 C-34.46146637 0.60938995 -33.55309021 0.59783875 -32.6171875 0.5859375 C-31.22308151 0.55688828 -31.22308151 0.55688828 -29.80081177 0.5272522 C-26.8256352 0.46736315 -23.85042012 0.4210339 -20.875 0.375 C-18.86066 0.33682879 -16.84633646 0.29777757 -14.83203125 0.2578125 C-9.88815425 0.161654 -4.94420083 0.0776576 0 0 Z " fill="#BE9A4E" transform="translate(744,652)"/><path d="M0 0 C0.33 0.66 0.66 1.32 1 2 C1.66 2 2.32 2 3 2 C3.83229672 7.32669904 1.00300393 10.8776946 -2 15 C-2.66 15.66 -3.32 16.32 -4 17 C-4.94405504 12.96206159 -5.66578564 9.51292335 -3.953125 5.62109375 C-2.71180489 3.67194223 -1.42928464 1.81504312 0 0 Z " fill="#FAD445" transform="translate(795,596)"/><path d="M0 0 C8.22244835 0.35749775 14.87162483 4.64882755 20.625 10.375 C21.40875 11.24125 22.1925 12.1075 23 13 C22.67 13.99 22.34 14.98 22 16 C21.34 15.67 20.68 15.34 20 15 C20 14.34 20 13.68 20 13 C19.4225 12.71125 18.845 12.4225 18.25 12.125 C17.5075 11.75375 16.765 11.3825 16 11 C15.278125 10.690625 14.55625 10.38125 13.8125 10.0625 C12 9 12 9 11 6 C8.45048953 4.53159883 8.45048953 4.53159883 5.4375 3.3125 C4.42558594 2.87550781 3.41367187 2.43851563 2.37109375 1.98828125 C1.58863281 1.66214844 0.80617188 1.33601562 0 1 C0 0.67 0 0.34 0 0 Z " fill="#FADF76" transform="translate(831,584)"/><path d="M0 0 C7.53502092 1.18974015 13.7525656 4.0359824 20.546875 7.34375 C23.33757325 8.68227495 26.11059388 9.89717324 29 11 C29 11.66 29 12.32 29 13 C25.16022316 12.35952645 21.84403286 11.22822779 18.26171875 9.71484375 C17.19501953 9.26689453 16.12832031 8.81894531 15.02929688 8.35742188 C13.92650391 7.88884766 12.82371094 7.42027344 11.6875 6.9375 C10.56537109 6.46505859 9.44324219 5.99261719 8.28710938 5.50585938 C5.52295723 4.34138677 2.760696 3.17263728 0 2 C0 1.34 0 0.68 0 0 Z " fill="#A8874A" transform="translate(414,335)"/><path d="M0 0 C4.33092399 -0.6496386 6.67024509 0.14068186 10.125 2.625 C13.5774423 5.40282714 15.81003621 8.16756337 18 12 C17.34 13.32 16.68 14.64 16 16 C15.64808594 15.39671875 15.29617188 14.7934375 14.93359375 14.171875 C10.84405286 7.55173047 7.47023811 4.49007937 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FBD948" transform="translate(488,624)"/><path d="M0 0 C0.33 0.66 0.66 1.32 1 2 C1.99 2.33 2.98 2.66 4 3 C2.68954637 6.93136089 1.16791954 9.31206827 -2 12 C-2.99 12.33 -3.98 12.66 -5 13 C-5.875 11 -5.875 11 -6 8 C-4.26346566 5.10933821 -2.19022601 2.55843792 0 0 Z " fill="#FBC624" transform="translate(968,557)"/><path d="M0 0 C0.88365234 0.00451172 1.76730469 0.00902344 2.67773438 0.01367188 C4.84768559 0.02540134 7.01760172 0.04333505 9.1875 0.0625 C9.1875 1.0525 9.1875 2.0425 9.1875 3.0625 C6.10472144 3.2599877 3.0212715 3.44373332 -0.0625 3.625 C-0.93519531 3.68107422 -1.80789063 3.73714844 -2.70703125 3.79492188 C-3.55136719 3.84326172 -4.39570312 3.89160156 -5.265625 3.94140625 C-6.04067383 3.9885376 -6.81572266 4.03566895 -7.61425781 4.08422852 C-9.88025063 4.06183032 -11.67755302 3.82192444 -13.8125 3.0625 C-14.1425 2.4025 -14.4725 1.7425 -14.8125 1.0625 C-9.89747242 -0.22985715 -5.03959898 -0.04885517 0 0 Z " fill="#BD9A46" transform="translate(751.8125,820.9375)"/><path d="M0 0 C2.28506263 6.09350035 -0.1435334 13.05930689 -2 19 C-2.66 19 -3.32 19 -4 19 C-4.33 23.95 -4.66 28.9 -5 34 C-5.33 34 -5.66 34 -6 34 C-6.59700364 22.12626099 -4.95420881 10.83819911 0 0 Z " fill="#D8B254" transform="translate(761,600)"/><path d="M0 0 C7.86379677 2.18340181 15.41675284 4.99285026 23 8 C22.34 8.66 21.68 9.32 21 10 C15.73707342 9.69041608 11.69721489 8.20481515 7 6 C7 5.34 7 4.68 7 4 C6.01 4 5.02 4 4 4 C4 3.34 4 2.68 4 2 C2.68 2 1.36 2 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FBEC80" transform="translate(478,186)"/><path d="M0 0 C13.56034398 -1.10696686 26.20692582 5.04491574 38 11 C33.98119739 12.33960087 32.89044701 11.20805934 29.125 9.375 C19.85252468 5.07688729 9.9495659 3.12208033 0 1 C0 0.67 0 0.34 0 0 Z " fill="#896A3D" transform="translate(868,49)"/><path d="M0 0 C0.33 0.66 0.66 1.32 1 2 C1.66 2 2.32 2 3 2 C5.10575375 7.52760359 6.37851209 12.06997733 6 18 C6.99 18.33 7.98 18.66 9 19 C9.33 19.99 9.66 20.98 10 22 C9.34 22.33 8.68 22.66 8 23 C8 22.34 8 21.68 8 21 C7.34 21 6.68 21 6 21 C2.75773658 13.92923365 0.39016315 7.80326294 0 0 Z " fill="#F3BC05" transform="translate(48,758)"/><path d="M0 0 C3.68510036 3.39304113 6.40229246 7.18581217 9.1875 11.3125 C9.63802734 11.95123047 10.08855469 12.58996094 10.55273438 13.24804688 C13.46755893 17.561288 14.65661743 20.79539758 15 26 C6.78491803 16.26360656 6.78491803 16.26360656 5.48046875 10.83984375 C5.15895017 8.78816219 5.15895017 8.78816219 3 7.625 C1 6 1 6 0.25 2.8125 C0.12625 1.4203125 0.12625 1.4203125 0 0 Z " fill="#E6B945" transform="translate(974,457)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C2.01417969 1.0621875 2.02835938 2.124375 2.04296875 3.21875 C2.27323898 11.37070164 2.52513192 17.53590342 8 24 C8.66 24.99 9.32 25.98 10 27 C4.36147426 24.66061166 2.45806911 19.70784263 -0.3125 14.5625 C-1.61303679 9.7150447 -1.58461842 4.75385527 0 0 Z " fill="#F9C723" transform="translate(606,773)"/><path d="M0 0 C2.52349243 3.12432397 4.27256146 6.38060496 6 10 C6.66 10 7.32 10 8 10 C8.3403125 11.6396875 8.3403125 11.6396875 8.6875 13.3125 C9.65644095 17.02984606 9.65644095 17.02984606 12.1875 18.8125 C15.10426218 20.12049906 15.10426218 20.12049906 18.75 21 C19.8225 21.33 20.895 21.66 22 22 C22.33 22.99 22.66 23.98 23 25 C21.41531323 24.54636829 19.83230076 24.08688548 18.25 23.625 C17.36828125 23.36976563 16.4865625 23.11453125 15.578125 22.8515625 C11.20794611 21.40807917 8.81712874 20.36369498 6.640625 16.19140625 C6.24746094 15.44439453 5.85429687 14.69738281 5.44921875 13.92773438 C5.05347656 13.14720703 4.65773438 12.36667969 4.25 11.5625 C3.83878906 10.78583984 3.42757813 10.00917969 3.00390625 9.20898438 C0 3.41573661 0 3.41573661 0 0 Z " fill="#BCA252" transform="translate(307,180)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C1.34 2.32 0.68 3.64 0 5 C-0.66 5 -1.32 5 -2 5 C-2.28875 6.051875 -2.5775 7.10375 -2.875 8.1875 C-5.458 16.941 -5.458 16.941 -9 20 C-9.49927193 14.00873682 -8.29833713 10.03707716 -5 5 C-3.42595336 3.15395097 -1.81991285 1.61770031 0 0 Z " fill="#F5D93D" transform="translate(142,715)"/><path d="M0 0 C0 3.99897642 -1.35316035 5.06701552 -4 8 C-4.763125 8.598125 -5.52625 9.19625 -6.3125 9.8125 C-9.38019188 12.30945851 -11.79883671 15.08867404 -14.3515625 18.09765625 C-15.83728192 19.81221871 -17.37451089 21.41884241 -19 23 C-19.99 22.67 -20.98 22.34 -22 22 C-14.74 14.74 -7.48 7.48 0 0 Z " fill="#F8DD64" transform="translate(700,704)"/><path d="M0 0 C4.66154042 1.49835228 5.86610751 4.88463591 8 9 C6.02 10.32 4.04 11.64 2 13 C1.01 12.01 0.02 11.02 -1 10 C-0.649375 9.278125 -0.29875 8.55625 0.0625 7.8125 C1.10409017 4.6877295 0.89096572 3.11838004 0 0 Z " fill="#F6D46A" transform="translate(793,583)"/><path d="M0 0 C3.96 1.32 7.92 2.64 12 4 C12 4.33 12 4.66 12 5 C10.35 5 8.7 5 7 5 C7 5.99 7 6.98 7 8 C7.67546875 8.18175781 8.3509375 8.36351563 9.046875 8.55078125 C9.93890625 8.80214844 10.8309375 9.05351563 11.75 9.3125 C12.63171875 9.55613281 13.5134375 9.79976562 14.421875 10.05078125 C17.05772505 11.02125331 18.85407326 12.21005644 21 14 C14.43843514 13.32701899 8.21163982 11.26834853 3.5625 6.5 C2 4 2 4 0 0 Z " fill="#FDF287" transform="translate(267,106)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.78734859 9.99057873 1.78734859 9.99057873 -1.4375 14.125 C-2.283125 14.74375 -3.12875 15.3625 -4 16 C-4.33 16.33 -4.66 16.66 -5 17 C-6.97712807 17.09900199 -8.95790038 17.12970773 -10.9375 17.125 C-12.55978516 17.12886719 -12.55978516 17.12886719 -14.21484375 17.1328125 C-17 17 -17 17 -19 16 C-18.67 15.01 -18.34 14.02 -18 13 C-17.29875 13.350625 -16.5975 13.70125 -15.875 14.0625 C-12.36525448 15.20698224 -10.53258582 15.03033753 -7 14 C-4.08754352 12.6878339 -4.08754352 12.6878339 -2 10 C-1.00121307 6.70348562 -0.43639228 3.41297844 0 0 Z " fill="#F7DC5F" transform="translate(555,710)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.59552101 13.18417347 0.40848664 24.17772066 -8 35 C-10.3125 37 -10.3125 37 -12 38 C-10.39304616 34.61736216 -8.46526281 31.49772468 -6.5 28.3125 C-1.12033502 19.07108381 -0.62026491 10.5608263 0 0 Z " fill="#A98D56" transform="translate(861,615)"/><path d="M0 0 C1.48828125 1.01953125 1.48828125 1.01953125 3 3 C3.2172101 5.64996326 3.28351554 8.05076558 3.1875 10.6875 C3.17396484 11.38939453 3.16042969 12.09128906 3.14648438 12.81445312 C3.11120182 14.54329829 3.05739583 16.27174765 3 18 C2.01 18.33 1.02 18.66 0 19 C-0.06058594 18.18015625 -0.12117187 17.3603125 -0.18359375 16.515625 C-0.26738281 15.43796875 -0.35117187 14.3603125 -0.4375 13.25 C-0.51871094 12.18265625 -0.59992187 11.1153125 -0.68359375 10.015625 C-0.89494147 7.10287232 -0.89494147 7.10287232 -1.66015625 4.796875 C-2 3 -2 3 0 0 Z " fill="#EFA70A" transform="translate(858,610)"/><path d="M0 0 C3.47781111 3.40355179 6.7444899 6.89917978 9.875 10.625 C10.67679688 11.56601562 11.47859375 12.50703125 12.3046875 13.4765625 C12.86414063 14.30929687 13.42359375 15.14203125 14 16 C13.67 16.99 13.34 17.98 13 19 C8.2 16.53846154 8.2 16.53846154 7.1875 13.8125 C7.0946875 12.9153125 7.0946875 12.9153125 7 12 C6.34 12 5.68 12 5 12 C4.16180842 10.37750059 3.3295884 8.75191503 2.5 7.125 C2.0359375 6.22007812 1.571875 5.31515625 1.09375 4.3828125 C0 2 0 2 0 0 Z " fill="#F5D370" transform="translate(774,558)"/><path d="M0 0 C1.9434004 2.9151006 3.09231048 5.56492622 4.375 8.8125 C6.20547858 13.29364192 8.10118617 17.1349149 11 21 C10.67 21.66 10.34 22.32 10 23 C9.401875 22.34 8.80375 21.68 8.1875 21 C6.12498166 18.6626154 6.12498166 18.6626154 3 19 C2.34 17.35 1.68 15.7 1 14 C1.99 14 2.98 14 4 14 C3.51917969 13.62230469 3.03835937 13.24460937 2.54296875 12.85546875 C0.46337042 10.35468595 0.50158423 8.52693196 0.3125 5.3125 C0.24675781 4.31863281 0.18101563 3.32476563 0.11328125 2.30078125 C0.07589844 1.54152344 0.03851563 0.78226563 0 0 Z " fill="#E9BA28" transform="translate(53,765)"/><path d="M0 0 C0.12375 0.639375 0.2475 1.27875 0.375 1.9375 C0.684375 2.9584375 0.684375 2.9584375 1 4 C1.66 4.33 2.32 4.66 3 5 C2.49202991 9.3177458 1.80317221 13.03302114 0 17 C-1.32 16.67 -2.64 16.34 -4 16 C-3.27275406 10.47293087 -1.66554027 5.30039859 0 0 Z " fill="#F2B626" transform="translate(886,637)"/><path d="M0 0 C3.6650836 1.32332222 6.55097774 2.94815556 9.6875 5.25 C14.03297185 8.38004664 18.49631032 11.11715887 23.1640625 13.73828125 C23.76992187 14.15464844 24.37578125 14.57101562 25 15 C25 15.66 25 16.32 25 17 C20.64597276 15.46086372 16.91123359 13.19394114 13.0625 10.6875 C12.46759766 10.30916016 11.87269531 9.93082031 11.25976562 9.54101562 C7.25070339 6.95155576 3.57245985 4.1688537 0 1 C0 0.67 0 0.34 0 0 Z " fill="#9E7D48" transform="translate(50,827)"/><path d="M0 0 C0 0.99 0 1.98 0 3 C-0.99 3.66 -1.98 4.32 -3 5 C-1.125 1.125 -1.125 1.125 0 0 Z M-5 5 C-4.34 5.33 -3.68 5.66 -3 6 C-7.62 10.62 -12.24 15.24 -17 20 C-17 17 -17 17 -14.375 14.08203125 C-13.25750594 12.98449244 -12.13214357 11.89492105 -11 10.8125 C-10.42765625 10.25369141 -9.8553125 9.69488281 -9.265625 9.11914062 C-7.85037212 7.73926907 -6.42602845 6.36873266 -5 5 Z M-26 24 C-24.68 24 -23.36 24 -22 24 C-22.66 25.32 -23.32 26.64 -24 28 C-24.66 28 -25.32 28 -26 28 C-26 26.68 -26 25.36 -26 24 Z " fill="#D59906" transform="translate(657,614)"/><path d="M0 0 C5.99932374 1.8331267 11.44920563 4.07321751 17 7 C16.01 7.66 15.02 8.32 14 9 C11.4375 8.375 11.4375 8.375 8 7 C7.13761719 6.6596875 6.27523437 6.319375 5.38671875 5.96875 C2.91926408 4.99154023 0.45800685 4.00069054 -2 3 C-1.34 2.67 -0.68 2.34 0 2 C0 1.34 0 0.68 0 0 Z " fill="#CC9522" transform="translate(509,466)"/><path d="M0 0 C6.1121134 2.35695876 6.1121134 2.35695876 8 5 C8.10699219 5.90492188 8.21398437 6.80984375 8.32421875 7.7421875 C9.13257969 11.63914139 10.64951195 13.7342854 13.0625 16.875 C14.16271484 18.32519531 14.16271484 18.32519531 15.28515625 19.8046875 C16.13400391 20.89136719 16.13400391 20.89136719 17 22 C16.67 22.66 16.34 23.32 16 24 C9.97168924 16.29032365 4.73222179 8.58190704 0 0 Z " fill="#BA8103" transform="translate(946,437)"/><path d="M0 0 C2 3 2 3 2.75 5.5 C3.92062383 8.77774673 5.33390049 11.42998439 7.0625 14.4375 C9.50027283 18.7792268 10.77966898 22.0425521 11 27 C8.85744037 24.26667107 7.12159688 21.53241997 5.51953125 18.453125 C5.07802734 17.60878906 4.63652344 16.76445312 4.18164062 15.89453125 C3.72982422 15.02183594 3.27800781 14.14914062 2.8125 13.25 C2.34908203 12.36183594 1.88566406 11.47367187 1.40820312 10.55859375 C0.26894272 8.37403255 -0.86700223 6.18781392 -2 4 C-1.34 3.67 -0.68 3.34 0 3 C0 2.01 0 1.02 0 0 Z " fill="#C9A54A" transform="translate(372,295)"/><path d="M0 0 C2.26904809 1.76481518 3.3803772 3.57056581 5 6 C-1.73350102 7.31742411 -4.22963016 5.31261972 -10 2 C-10 1.67 -10 1.34 -10 1 C-6.60647414 0.22433695 -3.47914854 -0.36622616 0 0 Z " fill="#FDDF55" transform="translate(373,252)"/><path d="M0 0 C0.83402344 0.20496094 1.66804688 0.40992188 2.52734375 0.62109375 C9.03033872 2.17793905 15.33643284 3.43529092 22 4 C21.67 4.66 21.34 5.32 21 6 C15.32418128 7.73141137 10.73014668 7.2804393 5.4375 4.6875 C1.18649518 2.37299035 1.18649518 2.37299035 0 0 Z " fill="#F6CA19" transform="translate(90,814)"/><path d="M0 0 C2.65354511 0.97296654 3.79877896 1.65792423 5.25 4.125 C6.70963089 9.72025174 6.86393553 13.98303492 4 19 C3.34 19.99 2.68 20.98 2 22 C1.67 21.01 1.34 20.02 1 19 C1.7425 17.5459375 1.7425 17.5459375 2.5 16.0625 C4.21551338 13.26868238 4.21551338 13.26868238 3.75390625 11.04296875 C2.92406701 8.79423341 1.87348857 7.16465143 0.4375 5.25 C-0.01753906 4.63640625 -0.47257812 4.0228125 -0.94140625 3.390625 C-1.46541016 2.70226562 -1.46541016 2.70226562 -2 2 C-1.34 2 -0.68 2 0 2 C0 1.34 0 0.68 0 0 Z " fill="#D7B444" transform="translate(260,645)"/><path d="M0 0 C3.3 0.99 6.6 1.98 10 3 C9.01 3.495 9.01 3.495 8 4 C6.86649466 6.01669827 6.86649466 6.01669827 6 8 C4.58208592 7.54554036 3.16571954 7.08625056 1.75 6.625 C0.96109375 6.36976563 0.1721875 6.11453125 -0.640625 5.8515625 C-2.86627958 5.04826333 -4.90931672 4.10288338 -7 3 C-4.47946405 1.73973202 -3.1457902 2.08125555 -0.375 2.4375 C0.85089844 2.59025391 0.85089844 2.59025391 2.1015625 2.74609375 C2.72804688 2.82988281 3.35453125 2.91367187 4 3 C2.68 2.67 1.36 2.34 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FBEB70" transform="translate(736,286)"/><path d="M0 0 C2.42992214 2.42992214 3.37961094 4.72618469 4.75 7.875 C5.45382812 9.44894531 5.45382812 9.44894531 6.171875 11.0546875 C7 14 7 14 6.140625 16.3828125 C5.76421875 16.91648437 5.3878125 17.45015625 5 18 C1.52098436 15.31166973 0.89331594 12.19171325 0 8 C-0.14598431 5.306354 -0.09478095 2.70125696 0 0 Z " fill="#F5C531" transform="translate(960,68)"/><path d="M0 0 C4.15267212 0.66978583 7.96661322 1.97102758 11.9140625 3.37890625 C14.11646845 4.14268568 14.11646845 4.14268568 17 4 C19.53347634 5.85376317 21.78113042 7.78113042 24 10 C22.39482903 9.91266424 20.79078338 9.80447776 19.1875 9.6875 C17.84751953 9.60048828 17.84751953 9.60048828 16.48046875 9.51171875 C13.58784763 8.91497329 12.97730578 8.09604738 11 6 C8.54194701 4.85929104 8.54194701 4.85929104 5.875 3.9375 C1.10875332 2.21750663 1.10875332 2.21750663 0 0 Z " fill="#F6C232" transform="translate(562,334)"/><path d="M0 0 C6.72045875 2.19037174 13.36724003 4.55765661 20 7 C12.42279444 9.36681252 4.75612055 5.29021474 -2 2 C-1.34 1.34 -0.68 0.68 0 0 Z " fill="#FBEC7C" transform="translate(619,240)"/><path d="M0 0 C0.66 0.99 1.32 1.98 2 3 C-2.29 7.29 -6.58 11.58 -11 16 C-11.66 15.67 -12.32 15.34 -13 15 C-13 14.34 -13 13.68 -13 13 C-12.34 13 -11.68 13 -11 13 C-10.34 11.68 -9.68 10.36 -9 9 C-8.34 9 -7.68 9 -7 9 C-6.67 8.01 -6.34 7.02 -6 6 C-5.01 6 -4.02 6 -3 6 C-2.87625 5.38125 -2.7525 4.7625 -2.625 4.125 C-2 2 -2 2 0 0 Z " fill="#D1A02D" transform="translate(666,755)"/><path d="M0 0 C3.3 0 6.6 0 10 0 C10.66 1.32 11.32 2.64 12 4 C12.66 4.66 13.32 5.32 14 6 C13.236875 5.814375 12.47375 5.62875 11.6875 5.4375 C8.91032625 4.77180827 8.91032625 4.77180827 6 6 C2.8125 4.5625 2.8125 4.5625 0 3 C0 2.01 0 1.02 0 0 Z " fill="#FDE461" transform="translate(444,384)"/><path d="M0 0 C5.85659906 1.66153012 11.4590134 3.47041916 17 6 C16.34 6.66 15.68 7.32 15 8 C9.61076854 7.6227538 4.66727239 5.63282032 0 3 C0 2.01 0 1.02 0 0 Z " fill="#FCEB77" transform="translate(647,251)"/><path d="M0 0 C0.96164063 -0.01675781 1.92328125 -0.03351562 2.9140625 -0.05078125 C3.72617188 0.06910156 4.53828125 0.18898438 5.375 0.3125 C6.035 1.3025 6.695 2.2925 7.375 3.3125 C2.425 3.9725 -2.525 4.6325 -7.625 5.3125 C-8.285 4.3225 -8.945 3.3325 -9.625 2.3125 C-6.34357559 0.36075231 -3.79716428 0.01535242 0 0 Z " fill="#FEEF57" transform="translate(119.625,13.6875)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C1.649375 1.680625 1.29875 2.36125 0.9375 3.0625 C-0.45775783 7.43430786 0.31109494 11.03927022 1.8125 15.3125 C2.90687325 17.15097822 2.90687325 17.15097822 5 18 C7.49016793 19.24508396 7.98686718 20.46716796 9 23 C2.06698565 20.99712919 2.06698565 20.99712919 0 18 C-1.96733491 12.82280288 -2.76281072 7.50794213 -2 2 C-1.34 1.34 -0.68 0.68 0 0 Z " fill="#F7D45E" transform="translate(618,773)"/><path d="M0 0 C6.68156207 5.7270532 9.98218375 13.56185933 12 22 C11.01 22.33 10.02 22.66 9 23 C8.77957031 22.10861328 8.77957031 22.10861328 8.5546875 21.19921875 C6.87869446 15.00575023 4.43987419 9.78752173 1.20703125 4.25 C0 2 0 2 0 0 Z " fill="#F2B205" transform="translate(925,78)"/><path d="M0 0 C0 0.99 0 1.98 0 3 C-1.8125 4.5625 -1.8125 4.5625 -4 6 C-4.99 6.66 -5.98 7.32 -7 8 C-8.36125 8.433125 -8.36125 8.433125 -9.75 8.875 C-12.42508676 9.80099157 -14.36624198 10.7423467 -16.75 12.1875 C-18.35875 13.0846875 -18.35875 13.0846875 -20 14 C-20.66 13.67 -21.32 13.34 -22 13 C-20.92878906 12.38511719 -19.85757813 11.77023437 -18.75390625 11.13671875 C-17.35649678 10.32078168 -15.95937622 9.50434965 -14.5625 8.6875 C-13.85544922 8.28337891 -13.14839844 7.87925781 -12.41992188 7.46289062 C-11.40961914 6.86831055 -11.40961914 6.86831055 -10.37890625 6.26171875 C-9.7557251 5.90037842 -9.13254395 5.53903809 -8.49047852 5.16674805 C-6.68474836 3.97441115 -6.68474836 3.97441115 -6 1 C-4.7934375 1.0309375 -4.7934375 1.0309375 -3.5625 1.0625 C-1.06645115 1.29633621 -1.06645115 1.29633621 0 0 Z " fill="#FEEF63" transform="translate(925,247)"/><path d="M0 0 C3.63 0 7.26 0 11 0 C11 0.33 11 0.66 11 1 C15.95 1.33 20.9 1.66 26 2 C26 2.33 26 2.66 26 3 C25.39526855 2.98952637 24.79053711 2.97905273 24.16748047 2.96826172 C21.4033633 2.92645332 18.63931292 2.90059549 15.875 2.875 C14.92367187 2.85824219 13.97234375 2.84148438 12.9921875 2.82421875 C7.91416745 2.78895472 3.75512475 2.96666383 -1 5 C-0.67 3.35 -0.34 1.7 0 0 Z " fill="#FBD649" transform="translate(806,588)"/><path d="M0 0 C0.99 1.32 1.98 2.64 3 4 C2.13375 4.309375 2.13375 4.309375 1.25 4.625 C-1.25846353 5.93895805 -1.25846353 5.93895805 -2.9375 8.9375 C-5.05500739 12.08167763 -6.6576537 13.32882685 -10 15 C-8.63055898 12.05043472 -7.12169591 9.47531189 -5 7 C-4.34 7 -3.68 7 -3 7 C-3 6.34 -3 5.68 -3 5 C-4.65 5 -6.3 5 -8 5 C-6.8125 3.5 -6.8125 3.5 -5 2 C-2.3125 1.8125 -2.3125 1.8125 0 2 C0 1.34 0 0.68 0 0 Z " fill="#AE7C1D" transform="translate(778,575)"/><path d="M0 0 C12.21 0 24.42 0 37 0 C37 0.33 37 0.66 37 1 C36.13834229 1.03758423 36.13834229 1.03758423 35.25927734 1.07592773 C32.63100279 1.19269875 30.00301605 1.31505419 27.375 1.4375 C26.47136719 1.47681641 25.56773437 1.51613281 24.63671875 1.55664062 C20.00605008 1.77634388 15.57315005 2.20619669 11 3 C7.9375 2.625 7.9375 2.625 5 2 C4.05125 1.814375 3.1025 1.62875 2.125 1.4375 C1.42375 1.293125 0.7225 1.14875 0 1 C0 0.67 0 0.34 0 0 Z " fill="#E5AE0F" transform="translate(313,448)"/><path d="M0 0 C2.44664205 1.22332103 2.74337967 2.11244298 3.9453125 4.52734375 C4.29980469 5.23697266 4.65429688 5.94660156 5.01953125 6.67773438 C5.38433594 7.42345703 5.74914062 8.16917969 6.125 8.9375 C6.49753906 9.67935547 6.87007813 10.42121094 7.25390625 11.18554688 C10 16.73305861 10 16.73305861 10 19 C10.66 19.33 11.32 19.66 12 20 C12 20.99 12 21.98 12 23 C12.66 23 13.32 23 14 23 C13.67 24.32 13.34 25.64 13 27 C10.32497991 25.66248996 10.30594725 24.53704659 9.3125 21.75 C7.17827957 16.12636975 4.3548569 11.00992635 1.390625 5.78515625 C0 3 0 3 0 0 Z " fill="#F5B508" transform="translate(433,409)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C4.10827055 3.16240582 4.33817465 4.50657469 4.625 8.1875 C4.69976563 9.08855469 4.77453125 9.98960938 4.8515625 10.91796875 C4.90054688 11.60503906 4.94953125 12.29210937 5 13 C4.01 13.495 4.01 13.495 3 14 C2.10828827 12.2375228 1.23707344 10.46466209 0.375 8.6875 C-0.11226562 7.70136719 -0.59953125 6.71523437 -1.1015625 5.69921875 C-1.39804687 4.80847656 -1.69453125 3.91773437 -2 3 C-1.34 2.01 -0.68 1.02 0 0 Z " fill="#F9C313" transform="translate(956,63)"/><path d="M0 0 C0.33 0.66 0.66 1.32 1 2 C2.65 2 4.3 2 6 2 C6 2.33 6 2.66 6 3 C5.14019531 3.08636719 4.28039062 3.17273437 3.39453125 3.26171875 C-4.4505017 4.19422539 -10.88579946 5.80263129 -18.16015625 8.9765625 C-20.99852706 9.99946917 -23.01385791 10.20820807 -26 10 C-23.17001302 8.56889041 -20.32206046 7.1928195 -17.4375 5.875 C-16.67308594 5.52179687 -15.90867187 5.16859375 -15.12109375 4.8046875 C-13 4 -13 4 -10 4 C-10 3.34 -10 2.68 -10 2 C-6.7 2 -3.4 2 0 2 C0 1.34 0 0.68 0 0 Z " fill="#EFC31F" transform="translate(120,47)"/><path d="M0 0 C5.04806914 0.35991718 7.52239866 3.04398041 10.8125 6.5625 C11.31458984 7.08263672 11.81667969 7.60277344 12.33398438 8.13867188 C13.56529127 9.4168857 14.7839407 10.70727147 16 12 C15.34 12.66 14.68 13.32 14 14 C13.57589844 13.56429687 13.15179687 13.12859375 12.71484375 12.6796875 C9.05592307 8.96447573 5.31400922 5.47569109 1.28515625 2.1640625 C0.64900391 1.58785156 0.64900391 1.58785156 0 1 C0 0.67 0 0.34 0 0 Z " fill="#98681C" transform="translate(843,718)"/><path d="M0 0 C0.33 0.99 0.66 1.98 1 3 C-7.67514677 13.07436399 -7.67514677 13.07436399 -12 16 C-12.66 16 -13.32 16 -14 16 C-14 15.34 -14 14.68 -14 14 C-13.34 14 -12.68 14 -12 14 C-11.66355469 13.17242188 -11.66355469 13.17242188 -11.3203125 12.328125 C-9.59614817 9.28788256 -7.37484178 7.18574327 -4.875 4.75 C-3.96492187 3.85796875 -3.05484375 2.9659375 -2.1171875 2.046875 C-1.41851563 1.37140625 -0.71984375 0.6959375 0 0 Z " fill="#F7D95B" transform="translate(651,687)"/><path d="M0 0 C0 0.33 0 0.66 0 1 C-1.98 1 -3.96 1 -6 1 C-6 1.66 -6 2.32 -6 3 C-7.56020867 3.65134925 -9.12328579 4.29582964 -10.6875 4.9375 C-11.55761719 5.29714844 -12.42773438 5.65679688 -13.32421875 6.02734375 C-15.88179265 6.9570312 -18.3221323 7.54162625 -21 8 C-15.42794828 1.34948665 -8.51005438 -0.54319496 0 0 Z " fill="#FAE76A" transform="translate(547,688)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C0.47940093 4.88014936 -1.86078531 6.73906562 -5.125 9.25 C-6.03507813 9.95640625 -6.94515625 10.6628125 -7.8828125 11.390625 C-8.58148438 11.92171875 -9.28015625 12.4528125 -10 13 C-10.99 12.34 -11.98 11.68 -13 11 C-8.4954955 6.12012012 -8.4954955 6.12012012 -5.9375 5.5 C-2.89379668 4.71452818 -1.77171717 2.46774892 0 0 Z " fill="#FDE123" transform="translate(205,668)"/><path d="M0 0 C6.85618326 1.92556636 13.43252132 4.2472483 20 7 C16.81815261 8.0219601 14.67756672 7.94954615 11.4375 7.1875 C10.67308594 7.01605469 9.90867187 6.84460938 9.12109375 6.66796875 C7 6 7 6 4 4 C4 3.34 4 2.68 4 2 C2.68 2 1.36 2 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FAEA7B" transform="translate(698,271)"/><path d="M0 0 C0 0.33 0 0.66 0 1 C2.64 1.33 5.28 1.66 8 2 C8 2.33 8 2.66 8 3 C4.7097621 3.25422542 1.41811775 3.47409878 -1.875 3.6875 C-3.28072266 3.79674805 -3.28072266 3.79674805 -4.71484375 3.90820312 C-6.05869141 3.99038086 -6.05869141 3.99038086 -7.4296875 4.07421875 C-8.25710449 4.13182373 -9.08452148 4.18942871 -9.93701172 4.2487793 C-10.61779785 4.16668213 -11.29858398 4.08458496 -12 4 C-12.66 3.01 -13.32 2.02 -14 1 C-9.32798795 -0.20568053 -4.78503708 -0.09382426 0 0 Z " fill="#D89305" transform="translate(822,551)"/><path d="M0 0 C7.92 0 15.84 0 24 0 C23.67 1.32 23.34 2.64 23 4 C22.67 3.34 22.34 2.68 22 2 C21.10692139 2.01571045 21.10692139 2.01571045 20.19580078 2.03173828 C17.50557657 2.07323949 14.81541963 2.09930704 12.125 2.125 C10.71927734 2.15013672 10.71927734 2.15013672 9.28515625 2.17578125 C7.94130859 2.18544922 7.94130859 2.18544922 6.5703125 2.1953125 C5.74289551 2.20578613 4.91547852 2.21625977 4.06298828 2.22705078 C2 2 2 2 0 0 Z " fill="#F8CA10" transform="translate(379,448)"/><path d="M0 0 C6.20477864 1.93624298 12.10825719 4.25609141 18 7 C18 7.33 18 7.66 18 8 C15.6577388 7.70098793 13.33238456 7.36470013 11 7 C10.20851563 6.88914062 9.41703125 6.77828125 8.6015625 6.6640625 C6.28586757 6.26687211 4.18826553 5.85902986 2 5 C0.4375 2.375 0.4375 2.375 0 0 Z " fill="#FBE885" transform="translate(435,376)"/><path d="M0 0 C-0.52268466 2.76276177 -1.10869587 5.3260876 -2 8 C-4.0625 8.6875 -4.0625 8.6875 -6 9 C-6 8.01 -6 7.02 -6 6 C-7.65 6 -9.3 6 -11 6 C-3.28571429 0 -3.28571429 0 0 0 Z " fill="#FAE66E" transform="translate(973,217)"/><path d="M0 0 C0.53367187 0.18175781 1.06734375 0.36351562 1.6171875 0.55078125 C7.37591783 2.4936055 13.16993922 4.28384432 19 6 C19 6.33 19 6.66 19 7 C13.25045148 7.20907449 7.39402468 7.25981244 2 5 C0.4375 2.375 0.4375 2.375 0 0 Z " fill="#F3CC41" transform="translate(92,811)"/><path d="M0 0 C0.625 1.8125 0.625 1.8125 1 4 C0.01 5.485 0.01 5.485 -1 7 C-1.309375 8.010625 -1.61875 9.02125 -1.9375 10.0625 C-3 13 -3 13 -6 15 C-6.31563182 9.73946963 -5.66590937 6.55426184 -3 2 C-2.01 2 -1.02 2 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FCDC0D" transform="translate(138,568)"/><path d="M0 0 C-0.33 1.65 -0.66 3.3 -1 5 C-4.55780196 4.39009109 -7.6828589 3.4216319 -11 2 C-10.34 1.67 -9.68 1.34 -9 1 C-9 0.34 -9 -0.32 -9 -1 C-5.23375329 -2.25541557 -3.62811066 -1.37061958 0 0 Z " fill="#F8C52E" transform="translate(542,423)"/><path d="M0 0 C4.29 0.33 8.58 0.66 13 1 C12.34 2.32 11.68 3.64 11 5 C7.7 4.67 4.4 4.34 1 4 C0.67 2.68 0.34 1.36 0 0 Z " fill="#A77825" transform="translate(102,851)"/><path d="M0 0 C2.5999298 2.51027705 4.99091227 4.9863684 7 8 C7 8.66 7 9.32 7 10 C6.01 10.33 5.02 10.66 4 11 C1.3125 9.5625 1.3125 9.5625 -1 8 C-0.67 5.36 -0.34 2.72 0 0 Z " fill="#F8C439" transform="translate(933,569)"/><path d="M0 0 C5.85659906 1.66153012 11.4590134 3.47041916 17 6 C13.16455058 7.38076179 9.92847503 6.85712183 6 6 C4.25 4.5 4.25 4.5 3 3 C2.01 2.67 1.02 2.34 0 2 C0 1.34 0 0.68 0 0 Z " fill="#F5D05C" transform="translate(532,318)"/><path d="M0 0 C3.63 1.32 7.26 2.64 11 4 C7 5 7 5 4 4 C4.30035156 4.61488281 4.60070312 5.22976562 4.91015625 5.86328125 C5.29042969 6.67152344 5.67070312 7.47976562 6.0625 8.3125 C6.44535156 9.11300781 6.82820313 9.91351563 7.22265625 10.73828125 C8 13 8 13 7 16 C5.82558465 13.89983377 4.66035988 11.79541245 3.5 9.6875 C3.16613281 9.09259766 2.83226562 8.49769531 2.48828125 7.88476562 C0.93174886 5.04171156 0 3.29339012 0 0 Z " fill="#DDC76E" transform="translate(340,239)"/><path d="M0 0 C-0.33 0.66 -0.66 1.32 -1 2 C-7.6 2 -14.2 2 -21 2 C-20.67 1.34 -20.34 0.68 -20 0 C-13.28664163 -1.23525794 -6.69782737 -1.15923935 0 0 Z " fill="#B99F65" transform="translate(729,854)"/><path d="M0 0 C3.52238047 1.56367357 6.27123994 3.69495889 9.25 6.125 C10.14203125 6.84945312 11.0340625 7.57390625 11.953125 8.3203125 C12.62859375 8.87460937 13.3040625 9.42890625 14 10 C13.67 10.66 13.34 11.32 13 12 C12.01 12 11.02 12 10 12 C9.34 10.35 8.68 8.7 8 7 C6.824375 7.0928125 6.824375 7.0928125 5.625 7.1875 C4.75875 7.125625 3.8925 7.06375 3 7 C1.25372522 4.38058783 0.61277612 2.96175123 0 0 Z " fill="#E8BA2C" transform="translate(69,795)"/><path d="M0 0 C-0.34347427 3.20575987 -0.9707854 3.97516759 -3.5 6.125 C-4.325 6.74375 -5.15 7.3625 -6 8 C-6.33 8.66 -6.66 9.32 -7 10 C-7.99 10 -8.98 10 -10 10 C-9.52723148 5.74508335 -7.07452523 3.77457155 -4 1 C-2 0 -2 0 0 0 Z " fill="#FAE47B" transform="translate(806,588)"/><path d="M0 0 C0 0.33 0 0.66 0 1 C-5.94 1.495 -5.94 1.495 -12 2 C-12 2.66 -12 3.32 -12 4 C-17.95703125 5.7578125 -17.95703125 5.7578125 -20 6 C-20.99 5.34 -21.98 4.68 -23 4 C-15.23800667 0.07519976 -8.62396205 -0.48661855 0 0 Z " fill="#F7E284" transform="translate(829,583)"/><path d="M0 0 C3 1.5625 3 1.5625 6 4 C6.375 7.75 6.375 7.75 6 11 C2.22730267 9.74243422 1.11611635 8.32532569 -1 5 C-0.75 2.1875 -0.75 2.1875 0 0 Z " fill="#FBC424" transform="translate(927,564)"/><path d="M0 0 C2.1875 0.3125 2.1875 0.3125 4 1 C3.01 2.485 3.01 2.485 2 4 C2 4.66 2 5.32 2 6 C0.35 6.66 -1.3 7.32 -3 8 C-3.33 7.34 -3.66 6.68 -4 6 C-5.98 6.99 -5.98 6.99 -8 8 C-6.33333333 6.33333333 -4.66666667 4.66666667 -3 3 C-2.484375 2.38125 -1.96875 1.7625 -1.4375 1.125 C-0.963125 0.75375 -0.48875 0.3825 0 0 Z " fill="#FBE541" transform="translate(166,696)"/><path d="M0 0 C0 0.66 0 1.32 0 2 C-0.7425 2.4125 -1.485 2.825 -2.25 3.25 C-5.23731331 4.89076054 -5.23731331 4.89076054 -7.125 8.1875 C-7.74375 9.115625 -8.3625 10.04375 -9 11 C-9.99 11 -10.98 11 -12 11 C-10.18999153 4.8459712 -6.57254582 0 0 0 Z " fill="#F7E04C" transform="translate(473,626)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.71105791 6.99206943 1.71105791 6.99206943 -0.16015625 9.64453125 C-2.64752237 11.85198917 -4.56426681 12.9526377 -7.875 13.3125 C-8.926875 13.1578125 -8.926875 13.1578125 -10 13 C-8.8553125 12.1646875 -8.8553125 12.1646875 -7.6875 11.3125 C-3.95749286 8.10295897 -2.10770399 4.37753905 0 0 Z " fill="#E9B321" transform="translate(408,458)"/><path d="M0 0 C4.84111765 0.58838199 8.96071195 2.07653116 13.375 4.0625 C14.01566406 4.34416016 14.65632812 4.62582031 15.31640625 4.91601562 C16.88029659 5.60459421 18.44053941 6.30144711 20 7 C20 7.99 20 8.98 20 10 C18.329375 9.13375 18.329375 9.13375 16.625 8.25 C12.54699723 6.19643432 8.37495724 4.53055674 4.1015625 2.9296875 C2 2 2 2 0 0 Z " fill="#A56903" transform="translate(589,349)"/><path d="M0 0 C2.31 0.33 4.62 0.66 7 1 C7 1.66 7 2.32 7 3 C8.01320313 3.03867188 8.01320313 3.03867188 9.046875 3.078125 C16.42367067 3.54716981 16.42367067 3.54716981 19.625 6.0625 C20.305625 7.0215625 20.305625 7.0215625 21 8 C14.52028291 7.29568293 7.86617569 5.93308784 2 3 C1.34 2.01 0.68 1.02 0 0 Z " fill="#FDEE71" transform="translate(366,146)"/><path d="M0 0 C-0.33 0.66 -0.66 1.32 -1 2 C-1.66 2 -2.32 2 -3 2 C-3 2.66 -3 3.32 -3 4 C-5.95664519 5.4783226 -8.74229737 5.06032783 -12 5 C-10.68 4.34 -9.36 3.68 -8 3 C-8.99 2.67 -9.98 2.34 -11 2 C-11 1.34 -11 0.68 -11 0 C-3.57142857 -1.28571429 -3.57142857 -1.28571429 0 0 Z " fill="#CC9E31" transform="translate(886,819)"/><path d="M0 0 C0 3.34419152 -0.47519394 4.06840321 -2.375 6.6875 C-2.81585937 7.31011719 -3.25671875 7.93273437 -3.7109375 8.57421875 C-4.13632812 9.04472656 -4.56171875 9.51523437 -5 10 C-5.66 10 -6.32 10 -7 10 C-7 10.66 -7 11.32 -7 12 C-9.375 13.6875 -9.375 13.6875 -12 15 C-12.66 14.67 -13.32 14.34 -14 14 C-9.38 9.38 -4.76 4.76 0 0 Z " fill="#F6DC5C" transform="translate(661,744)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C0.67 4.62 0.34 9.24 0 14 C-0.66 14 -1.32 14 -2 14 C-2.33 15.32 -2.66 16.64 -3 18 C-4.42944945 15.64561267 -5.08661261 14.51967567 -4.625 11.75 C-4.41875 11.1725 -4.2125 10.595 -4 10 C-3.67 10 -3.34 10 -3 10 C-2.01 6.7 -1.02 3.4 0 0 Z " fill="#BE9349" transform="translate(973,678)"/><path d="M0 0 C4.47238653 1.41807378 8.71146306 3.11304374 13 5 C12.34 5.66 11.68 6.32 11 7 C6.86169011 6.69903201 4.48152976 6.32101984 1 4 C0.3125 1.875 0.3125 1.875 0 0 Z " fill="#FAD967" transform="translate(517,411)"/><path d="M0 0 C2.97 0 5.94 0 9 0 C9 0.99 9 1.98 9 3 C13.455 3.99 13.455 3.99 18 5 C18 5.99 18 6.98 18 8 C11.79522136 6.06375702 5.89174281 3.74390859 0 1 C0 0.67 0 0.34 0 0 Z " fill="#AF8A4E" transform="translate(494,370)"/><path d="M0 0 C0.99 1.485 0.99 1.485 2 3 C3.10500196 4.34995313 4.23188065 5.68216809 5.375 7 C6.25285156 8.0209375 6.25285156 8.0209375 7.1484375 9.0625 C8.97088616 10.96953488 10.84765468 12.48292841 13 14 C12.67 14.99 12.34 15.98 12 17 C10.36828877 15.59106853 8.74486055 14.17254042 7.125 12.75 C6.22007812 11.96109375 5.31515625 11.1721875 4.3828125 10.359375 C2.21655697 8.2144269 0.98951284 6.84342772 0 4 C0 2.68 0 1.36 0 0 Z " fill="#9D8944" transform="translate(133,582)"/><path d="M0 0 C5.27749285 0.53851968 9.25645564 1.77343836 14 4 C13.67 4.99 13.34 5.98 13 7 C7 5 7 5 1 3 C0.67 2.01 0.34 1.02 0 0 Z " fill="#A97E35" transform="translate(585,408)"/><path d="M0 0 C4.38889325 0.66498383 7.9811485 2.18757677 12 4 C12 4.66 12 5.32 12 6 C10.56138706 5.91253716 9.12402492 5.80434652 7.6875 5.6875 C6.88699219 5.62949219 6.08648438 5.57148438 5.26171875 5.51171875 C2.60933741 4.91161175 1.63496121 4.14291033 0 2 C0 1.34 0 0.68 0 0 Z " fill="#B37D25" transform="translate(560,396)"/><path d="M0 0 C3.03353834 2.02235889 3.56127267 2.64882212 5.0078125 5.7734375 C5.35457031 6.5159375 5.70132812 7.2584375 6.05859375 8.0234375 C6.41050781 8.79945313 6.76242187 9.57546875 7.125 10.375 C7.48464844 11.14328125 7.84429687 11.9115625 8.21484375 12.703125 C9.79287703 16.119242 11.17549726 19.3159859 12 23 C8.4242565 19.69476648 6.54761149 15.77059579 4.3125 11.5 C3.68891602 10.34177734 3.68891602 10.34177734 3.05273438 9.16015625 C2.66021484 8.41636719 2.26769531 7.67257812 1.86328125 6.90625 C1.50532471 6.22884766 1.14736816 5.55144531 0.77856445 4.85351562 C0 3 0 3 0 0 Z " fill="#F7B608" transform="translate(420,384)"/><path d="M0 0 C6.20477864 1.93624298 12.10825719 4.25609141 18 7 C18 7.33 18 7.66 18 8 C13.64988225 7.48822144 10.02434323 6.69446031 6 5 C4.34080104 4.63128912 2.6752357 4.28718326 1 4 C0.67 2.68 0.34 1.36 0 0 Z " fill="#F9E47E" transform="translate(454,384)"/><path d="M0 0 C-2.40794308 1.53641144 -4.82468647 3.05396395 -7.25 4.5625 C-8.27287109 5.21895508 -8.27287109 5.21895508 -9.31640625 5.88867188 C-9.98027344 6.29794922 -10.64414062 6.70722656 -11.328125 7.12890625 C-12.23933105 7.70233765 -12.23933105 7.70233765 -13.16894531 8.28735352 C-15.47988352 9.18677067 -16.69932794 8.80168206 -19 8 C-16.59205692 6.46358856 -14.17531353 4.94603605 -11.75 3.4375 C-11.06808594 2.99986328 -10.38617187 2.56222656 -9.68359375 2.11132812 C-9.01972656 1.70205078 -8.35585938 1.29277344 -7.671875 0.87109375 C-7.0644043 0.48880615 -6.45693359 0.10651855 -5.83105469 -0.28735352 C-3.52011648 -1.18677067 -2.30067206 -0.80168206 0 0 Z " fill="#7A613C" transform="translate(973,194)"/><path d="M0 0 C0.99 1.0828125 0.99 1.0828125 2 2.1875 C6.2834691 6.48317271 11.58446559 9.35857007 17 12 C15.4375 12.75 15.4375 12.75 13 13 C7.63406833 10.51577238 3.88190723 7.44999122 0 3 C0 2.01 0 1.02 0 0 Z " fill="#A28A47" transform="translate(608,793)"/><path d="M0 0 C3.80625982 1.49531636 5.77940501 3.58980056 8 7 C8.25 9.8125 8.25 9.8125 8 12 C4.72257902 8.89973691 2.06895163 6.02901106 0 2 C0 1.34 0 0.68 0 0 Z " fill="#F7C90E" transform="translate(57,783)"/><path d="M0 0 C1.65 0.33 3.3 0.66 5 1 C3.48328036 5.55015893 -0.16891053 7.50057264 -4 10 C-3.5205537 5.78087253 -2.83374881 3.20336822 0 0 Z " fill="#FCD629" transform="translate(218,655)"/><path d="M0 0 C0.66 0.66 1.32 1.32 2 2 C3.92901141 2.45974503 3.92901141 2.45974503 6.1328125 2.6328125 C7.34130859 2.75849609 7.34130859 2.75849609 8.57421875 2.88671875 C9.83685547 3.00466797 9.83685547 3.00466797 11.125 3.125 C12.39923828 3.25455078 12.39923828 3.25455078 13.69921875 3.38671875 C15.79869727 3.59902557 17.89926242 3.80053603 20 4 C20 4.33 20 4.66 20 5 C13.4 5 6.8 5 0 5 C-0.33 3.68 -0.66 2.36 -1 1 C-0.67 0.67 -0.34 0.34 0 0 Z " fill="#8F5A06" transform="translate(642,570)"/><path d="M0 0 C1.65 1.65 3.3 3.3 5 5 C4.67 5.66 4.34 6.32 4 7 C1.4375 7.625 1.4375 7.625 -1 8 C-1.66 6.35 -2.32 4.7 -3 3 C-2.01 2.01 -1.02 1.02 0 0 Z " fill="#DBA622" transform="translate(632,468)"/><path d="M0 0 C5.23272633 1.63958758 10.15196636 3.38952035 15 6 C11.42355152 7.2380014 8.66305234 6.74926071 5 6 C4.67 5.01 4.34 4.02 4 3 C3.01 3.33 2.02 3.66 1 4 C0.67 2.68 0.34 1.36 0 0 Z " fill="#FADE74" transform="translate(489,399)"/><path d="M0 0 C4.40797649 3.59168455 7.13635551 8.68988968 9 14 C8.5534668 16.15234375 8.5534668 16.15234375 8 18 C6.6589995 15.5664433 5.32705144 13.12864699 4 10.6875 C3.6184375 9.99720703 3.236875 9.30691406 2.84375 8.59570312 C0 3.33984375 0 3.33984375 0 0 Z " fill="#C0A155" transform="translate(410,369)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C-0.97 3.97 -0.97 3.97 -4 7 C-3.34 7.33 -2.68 7.66 -2 8 C-2 8.66 -2 9.32 -2 10 C-4.64 10 -7.28 10 -10 10 C-8.78934835 6.36804504 -7.46308874 5.57103808 -4.4375 3.3125 C-3.61121094 2.68988281 -2.78492188 2.06726563 -1.93359375 1.42578125 C-1.29550781 0.95527344 -0.65742187 0.48476563 0 0 Z " fill="#533101" transform="translate(955,329)"/><path d="M0 0 C1.65 0 3.3 0 5 0 C5 0.66 5 1.32 5 2 C5.66 2.33 6.32 2.66 7 3 C6.67 3.66 6.34 4.32 6 5 C6.66 5.33 7.32 5.66 8 6 C7.40832031 5.86722656 6.81664062 5.73445313 6.20703125 5.59765625 C2.14553475 4.68994822 -1.91374171 3.7908887 -6 3 C-6 2.67 -6 2.34 -6 2 C-4.02 2 -2.04 2 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FBCF07" transform="translate(895,17)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C1.67 2.65 1.34 4.3 1 6 C-2.96 6 -6.92 6 -11 6 C-8.66460191 4.44306794 -6.42031244 3.09799354 -3.9375 1.8125 C-2.89916016 1.26529297 -2.89916016 1.26529297 -1.83984375 0.70703125 C-1.23269531 0.47371094 -0.62554688 0.24039063 0 0 Z " fill="#D2A942" transform="translate(902,810)"/><path d="M0 0 C2.83704376 1.41852188 2.90743664 3.04365209 4 6 C4.53525834 7.2735457 5.0770948 8.54434384 5.625 9.8125 C6.07875 10.864375 6.5325 11.91625 7 13 C5.35 12.67 3.7 12.34 2 12 C0.86235649 7.73383684 0 4.43513689 0 0 Z " fill="#C18713" transform="translate(28,790)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.56293334 7.34940743 0.72343789 13.52445584 -3 20 C-3.99 20.66 -4.98 21.32 -6 22 C-5.67 19.36 -5.34 16.72 -5 14 C-4.01 13.67 -3.02 13.34 -2 13 C-1.34 8.71 -0.68 4.42 0 0 Z " fill="#C8AD64" transform="translate(654,776)"/><path d="M0 0 C8 -0.30769231 8 -0.30769231 11 2 C11.6015625 4.078125 11.6015625 4.078125 12 6 C6 4 6 4 0 2 C0 1.34 0 0.68 0 0 Z " fill="#AF833C" transform="translate(549,393)"/><path d="M0 0 C3.9492568 0.55105909 7.34920174 1.38935371 11 3 C11 3.33 11 3.66 11 4 C9.35 4 7.7 4 6 4 C7.32 5.65 8.64 7.3 10 9 C5.60246744 8.24180473 4.01129884 6.27348743 1.3125 2.875 C0 1 0 1 0 0 Z " fill="#F5E78D" transform="translate(407,365)"/><path d="M0 0 C4.40958108 0.66607439 8.26572186 2.26624729 12.3125 4.0625 C13.28026367 4.48499023 13.28026367 4.48499023 14.26757812 4.91601562 C15.84698358 5.6062743 17.42376493 6.30253198 19 7 C15.97680647 8.31741179 14.78571426 7.92824489 11.58203125 6.85546875 C10.32033951 6.31133936 9.06389153 5.75491704 7.8125 5.1875 C7.17119141 4.91357422 6.52988281 4.63964844 5.86914062 4.35742188 C1.13679545 2.27359089 1.13679545 2.27359089 0 0 Z " fill="#9A7F47" transform="translate(626,325)"/><path d="M0 0 C1.41623216 -0.05447047 2.83308191 -0.09300508 4.25 -0.125 C5.03890625 -0.14820313 5.8278125 -0.17140625 6.640625 -0.1953125 C9.20731941 0.0171622 10.7916067 0.71345895 13 2 C11.35 2 9.7 2 8 2 C8 2.66 8 3.32 8 4 C4.7 4 1.4 4 -2 4 C-0.68 3.67 0.64 3.34 2 3 C2 2.34 2 1.68 2 1 C1.34 0.67 0.68 0.34 0 0 Z " fill="#FBD81E" transform="translate(887,15)"/><path d="M0 0 C0 0.66 0 1.32 0 2 C1.32 2.33 2.64 2.66 4 3 C-7.385 2.505 -7.385 2.505 -19 2 C-19 1.67 -19 1.34 -19 1 C-12.62694402 0.25492456 -6.41688675 -0.10349817 0 0 Z " fill="#BB9539" transform="translate(498,822)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C1.07506212 4.78383679 0.60628829 6.56693694 -2.625 8.875 C-3.40875 9.24625 -4.1925 9.6175 -5 10 C-4.50769231 3.47692308 -4.50769231 3.47692308 -1.9375 1.0625 C-0.9784375 0.5365625 -0.9784375 0.5365625 0 0 Z " fill="#C89620" transform="translate(908,806)"/><path d="M0 0 C0.6953125 1.76953125 0.6953125 1.76953125 1 4 C-1.48964564 7.73446847 -4.66610683 10.57428942 -8.9375 11.9375 C-9.9584375 11.9684375 -9.9584375 11.9684375 -11 12 C-10.29875 11.319375 -9.5975 10.63875 -8.875 9.9375 C-5.72065663 6.79219487 -2.86065696 3.4111614 0 0 Z " fill="#C59C3B" transform="translate(921,794)"/><path d="M0 0 C0 0.66 0 1.32 0 2 C-1.46875 3.32861328 -1.46875 3.32861328 -3.5 4.8203125 C-4.221875 5.35527344 -4.94375 5.89023437 -5.6875 6.44140625 C-6.450625 6.99699219 -7.21375 7.55257812 -8 8.125 C-9.1446875 8.96998047 -9.1446875 8.96998047 -10.3125 9.83203125 C-12.20418566 11.22714943 -14.10008585 12.61611971 -16 14 C-16 11 -16 11 -14.74658203 9.6496582 C-13.88589111 8.98196411 -13.88589111 8.98196411 -13.0078125 8.30078125 C-12.07388672 7.57084961 -12.07388672 7.57084961 -11.12109375 6.82617188 C-10.46238281 6.32666016 -9.80367187 5.82714844 -9.125 5.3125 C-8.14853516 4.54583008 -8.14853516 4.54583008 -7.15234375 3.76367188 C-2.27816255 0 -2.27816255 0 0 0 Z " fill="#887952" transform="translate(207,708)"/><path d="M0 0 C3.13272458 0.07285406 5.26611628 0.24525653 7.51171875 2.5546875 C11 7.37231375 11 7.37231375 11 10 C9.68 10 8.36 10 7 10 C6.38125 8.63875 6.38125 8.63875 5.75 7.25 C4.10949282 4.20334382 2.55281639 2.28873194 0 0 Z " fill="#EEBE35" transform="translate(555,694)"/><path d="M0 0 C0.99 0.99 1.98 1.98 3 3 C-0.20782086 3.95376567 -3.08187396 4.11621181 -6.421875 4.09765625 C-7.44667969 4.09443359 -8.47148438 4.09121094 -9.52734375 4.08789062 C-10.59082031 4.07951172 -11.65429688 4.07113281 -12.75 4.0625 C-13.82894531 4.05798828 -14.90789063 4.05347656 -16.01953125 4.04882812 C-18.67974383 4.03705727 -21.33984365 4.02061399 -24 4 C-24 3.67 -24 3.34 -24 3 C-16.08 2.67 -8.16 2.34 0 2 C0 1.34 0 0.68 0 0 Z " fill="#DDCDAC" transform="translate(758,686)"/><path d="M0 0 C2.52060868 2.24212784 3.69675048 4.25448832 4.9375 7.375 C6.50578604 11.08681214 8.27612256 13.98427854 11 17 C6.49309645 14.98606913 3.61107681 12.17933965 1 8 C0.24986265 5.2269116 0.10172351 2.89912016 0 0 Z " fill="#F4C30C" transform="translate(133,577)"/><path d="M0 0 C3.37462715 0.54723683 5.08235 1.0549 8 3 C7.01 3.33 6.02 3.66 5 4 C4.67 4.99 4.34 5.98 4 7 C3.01 7 2.02 7 1 7 C1 6.34 1 5.68 1 5 C0.01 4.67 -0.98 4.34 -2 4 C-1.34 2.68 -0.68 1.36 0 0 Z " fill="#E9B638" transform="translate(598,446)"/><path d="M0 0 C0.89074219 0.28101563 1.78148437 0.56203125 2.69921875 0.8515625 C5.23860724 1.70466947 7.72898716 2.62214443 10.1875 3.6875 C6.46243 5.03141145 3.77661139 4.34560293 0 3.375 C-1.59908203 2.97861328 -1.59908203 2.97861328 -3.23046875 2.57421875 C-5.8125 1.6875 -5.8125 1.6875 -6.8125 -0.3125 C-4.06163109 -1.68793445 -2.89329274 -0.91526952 0 0 Z " fill="#FBEB7B" transform="translate(669.8125,259.3125)"/><path d="M0 0 C-3.08137704 3.08137704 -6.07260266 2.97281954 -10.33203125 3.09765625 C-11.48058594 3.08605469 -12.62914062 3.07445312 -13.8125 3.0625 C-14.97394531 3.05347656 -16.13539063 3.04445313 -17.33203125 3.03515625 C-18.21246094 3.02355469 -19.09289062 3.01195312 -20 3 C-15.50798566 -1.49201434 -6.05797722 -0.11218476 0 0 Z " fill="#7E5913" transform="translate(775,853)"/><path d="M0 0 C3.0103245 3.0103245 2.97819673 5.22903621 3.09765625 9.453125 C3.08605469 10.70609375 3.07445312 11.9590625 3.0625 13.25 C3.05347656 14.51328125 3.04445313 15.7765625 3.03515625 17.078125 C3.02355469 18.04234375 3.01195312 19.0065625 3 20 C2.67 20 2.34 20 2 20 C-0.29612756 6.3667426 -0.29612756 6.3667426 0 0 Z " fill="#DEB858" transform="translate(15,748)"/><path d="M0 0 C3.98069267 2.87494471 6.43571997 5.82117329 9 10 C8.01 10.33 7.02 10.66 6 11 C4.98805294 9.92781799 3.99081943 8.84173622 3 7.75 C2.443125 7.14671875 1.88625 6.5434375 1.3125 5.921875 C0 4 0 4 0 0 Z " fill="#F2C554" transform="translate(858,665)"/><path d="M0 0 C1.32 0.66 2.64 1.32 4 2 C1.36 4.64 -1.28 7.28 -4 10 C-4.33 8.68 -4.66 7.36 -5 6 C-4.34 5.01 -3.68 4.02 -3 3 C-2.34 3 -1.68 3 -1 3 C-0.67 2.01 -0.34 1.02 0 0 Z " fill="#BC8F26" transform="translate(648,635)"/><path d="M0 0 C3 2 3 2 3.9375 4.5 C4.77763578 7.14520215 4.77763578 7.14520215 7.125 8.3125 C7.74375 8.539375 8.3625 8.76625 9 9 C8.67 10.32 8.34 11.64 8 13 C4.50892621 11.83630874 4.14777237 11.11026462 2.3125 8.0625 C1.87550781 7.35222656 1.43851563 6.64195312 0.98828125 5.91015625 C0 4 0 4 0 2 C-0.66 1.67 -1.32 1.34 -2 1 C-1.34 0.67 -0.68 0.34 0 0 Z " fill="#D49804" transform="translate(622,461)"/><path d="M0 0 C0 0.66 0 1.32 0 2 C2.475 2.99 2.475 2.99 5 4 C3.265625 5.1171875 3.265625 5.1171875 1 6 C-1.140625 5.3203125 -1.140625 5.3203125 -3.25 4.125 C-3.95640625 3.73570312 -4.6628125 3.34640625 -5.390625 2.9453125 C-5.92171875 2.63335937 -6.4528125 2.32140625 -7 2 C-4.35261084 0.5393715 -3.10551666 0 0 0 Z " fill="#FBCE3D" transform="translate(531,417)"/><path d="M0 0 C5.46737191 1.74807129 10.75824848 3.65794081 16 6 C12.3732057 7.32646643 10.47187589 6.65982318 7 5.125 C4.00959022 3.82125427 1.1919589 2.69454661 -2 2 C-1.34 1.34 -0.68 0.68 0 0 Z " fill="#FAE17A" transform="translate(472,392)"/><path d="M0 0 C5 2 5 2 10 4 C9.01 4.33 8.02 4.66 7 5 C6.26676204 7.01508358 6.26676204 7.01508358 6 9 C2.91910327 6.22719294 1.31224548 3.93673644 0 0 Z " fill="#F3AA09" transform="translate(414,374)"/><path d="M0 0 C6.10737442 1.76463072 12.07433507 3.69557475 18 6 C14.14441231 7.13970202 12.71621771 6.5690697 9 5 C6.01671932 4.25166865 3.01292396 3.61702582 0 3 C0 2.01 0 1.02 0 0 Z " fill="#F8E777" transform="translate(718,279)"/><path d="M0 0 C3.3 0 6.6 0 10 0 C10.66 1.32 11.32 2.64 12 4 C12.66 4.66 13.32 5.32 14 6 C8.65155992 5.46515599 4.64203897 3.53309233 0 1 C0 0.67 0 0.34 0 0 Z " fill="#FDDE4E" transform="translate(383,261)"/><path d="M0 0 C2 2 2 2 2.125 5.875 C2.0883992 7.25014417 2.04669263 8.6251615 2 10 C2 11.32 2 12.64 2 14 C1.01 14.66 0.02 15.32 -1 16 C-0.67 10.72 -0.34 5.44 0 0 Z " fill="#D69507" transform="translate(19,752)"/><path d="M0 0 C1.1774734 0.73291712 2.34176854 1.48703801 3.5 2.25 C4.1496875 2.66765625 4.799375 3.0853125 5.46875 3.515625 C5.9740625 4.00546875 6.479375 4.4953125 7 5 C7 6.32 7 7.64 7 9 C6.01 9.33 5.02 9.66 4 10 C0 4.5 0 4.5 0 0 Z " fill="#F6CF48" transform="translate(772,563)"/><path d="M0 0 C0 1.32 0 2.64 0 4 C-2.3125 4.625 -2.3125 4.625 -5 5 C-5.99 4.34 -6.98 3.68 -8 3 C-7.67 2.01 -7.34 1.02 -7 0 C-4.3333581 -1.33332095 -2.83319697 -0.67102033 0 0 Z " fill="#EDB21B" transform="translate(567,433)"/><path d="M0 0 C4.00418935 0.65994973 7.50544452 1.88341725 11.25 3.4375 C12.30703125 3.86933594 13.3640625 4.30117188 14.453125 4.74609375 C17 6 17 6 18 8 C13.3110507 7.44380331 9.80075733 6.11817327 5.625 3.9375 C4.56539063 3.38964844 3.50578125 2.84179688 2.4140625 2.27734375 C1.61742187 1.85582031 0.82078125 1.43429687 0 1 C0 0.67 0 0.34 0 0 Z " fill="#EDAB09" transform="translate(428,339)"/><path d="M0 0 C-1.24252679 0.84443568 -2.4943886 1.6751458 -3.75 2.5 C-4.44609375 2.9640625 -5.1421875 3.428125 -5.859375 3.90625 C-8 5 -8 5 -12 5 C-12 6.98 -12 8.96 -12 11 C-14 8 -14 8 -13.89453125 5.98828125 C-12.68233753 3.29392926 -11.26412313 2.58334657 -8.6875 1.1875 C-7.51767578 0.52814453 -7.51767578 0.52814453 -6.32421875 -0.14453125 C-3.70485652 -1.10863264 -2.57361524 -0.9599526 0 0 Z " fill="#F4E378" transform="translate(862,283)"/><path d="M0 0 C0.66 0.99 1.32 1.98 2 3 C1.67 3.66 1.34 4.32 1 5 C0.9175 5.639375 0.835 6.27875 0.75 6.9375 C0 9 0 9 -2.4375 10.8125 C-3.283125 11.204375 -4.12875 11.59625 -5 12 C-5.66 11.67 -6.32 11.34 -7 11 C-4.69 7.37 -2.38 3.74 0 0 Z " fill="#B58E30" transform="translate(929,782)"/><path d="M0 0 C0.99 0.33 1.98 0.66 3 1 C-3.15034169 8.48291572 -3.15034169 8.48291572 -7 11 C-7 6.68381834 -4.86729652 5.07210341 -2 2 C-1.34 2 -0.68 2 0 2 C0 1.34 0 0.68 0 0 Z " fill="#D4A12F" transform="translate(700,720)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C-3.02065304 5.63342182 -8.07852282 9.58255173 -14 13 C-12.47605205 8.79467528 -9.3847135 6.74995834 -5.875 4.25 C-5.03001953 3.63318359 -5.03001953 3.63318359 -4.16796875 3.00390625 C-2.78398366 1.99523915 -1.39269459 0.99660714 0 0 Z " fill="#82774F" transform="translate(226,692)"/><path d="M0 0 C3.86779381 2.88538792 6.80698215 5.98188807 9.8125 9.75 C10.60269531 10.73484375 11.39289062 11.7196875 12.20703125 12.734375 C12.79871094 13.48203125 13.39039063 14.2296875 14 15 C11 15 11 15 9.0625 13.171875 C8.0415625 11.97304688 8.0415625 11.97304688 7 10.75 C6.319375 9.96109375 5.63875 9.1721875 4.9375 8.359375 C0 2.34677419 0 2.34677419 0 0 Z " fill="#7B4C03" transform="translate(860,680)"/><path d="M0 0 C5.17609824 3.28157862 9.85989729 6.45924219 14 11 C10.0942676 10.40683971 7.78196414 8.51378095 4.75 6.0625 C3.85796875 5.35222656 2.9659375 4.64195312 2.046875 3.91015625 C1.37140625 3.27980469 0.6959375 2.64945313 0 2 C0 1.34 0 0.68 0 0 Z " fill="#92743A" transform="translate(146,597)"/><path d="M0 0 C1.32 0.33 2.64 0.66 4 1 C4.0309375 2.11375 4.0309375 2.11375 4.0625 3.25 C5.14587926 6.42791249 5.74474412 6.72751232 8.5625 8.3125 C9.696875 8.869375 10.83125 9.42625 12 10 C10 11 10 11 6.5625 9.9375 C3.50413299 8.56123484 2.97183164 7.95547582 1.0625 4.9375 C0 2 0 2 0 0 Z " fill="#B7984F" transform="translate(444,435)"/><path d="M0 0 C1.46067199 0.45082469 2.91848032 0.91093537 4.375 1.375 C5.18710937 1.63023437 5.99921875 1.88546875 6.8359375 2.1484375 C9 3 9 3 11 5 C8.36 5.66 5.72 6.32 3 7 C3 6.34 3 5.68 3 5 C2.34 4.67 1.68 4.34 1 4 C0.375 1.9375 0.375 1.9375 0 0 Z " fill="#FCDF69" transform="translate(505,406)"/><path d="M0 0 C3.37705625 0.53725895 6.696686 1.11064623 10 2 C9.01 2.495 9.01 2.495 8 3 C10.64 4.32 13.28 5.64 16 7 C11.82366356 8.39211215 10.21039485 6.9535579 6.3125 5.0625 C5.13300781 4.49660156 3.95351563 3.93070312 2.73828125 3.34765625 C1.83464844 2.90292969 0.93101562 2.45820313 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FDE959" transform="translate(418,372)"/><path d="M0 0 C1.43931117 0.45261358 2.87638999 0.91232979 4.3125 1.375 C5.11300781 1.63023437 5.91351563 1.88546875 6.73828125 2.1484375 C9 3 9 3 12 5 C10.58376784 5.05447047 9.16691809 5.09300508 7.75 5.125 C6.96109375 5.14820313 6.1721875 5.17140625 5.359375 5.1953125 C2.79268059 4.9828378 1.2083933 4.28654105 -1 3 C-0.67 2.01 -0.34 1.02 0 0 Z " fill="#FBEB83" transform="translate(407,159)"/><path d="M0 0 C3.08917348 0.3432415 4.77105979 0.82193539 7.25 2.75 C9.17806461 5.22894021 9.6567585 6.91082652 10 10 C2.51708428 3.84965831 2.51708428 3.84965831 0 0 Z " fill="#B38C4F" transform="translate(874,748)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C0.38113585 2.67262717 -1.2452729 4.33795537 -2.875 6 C-3.77992188 6.928125 -4.68484375 7.85625 -5.6171875 8.8125 C-8 11 -8 11 -10 11 C-9.62565384 8.30353781 -9.22252008 7.20477603 -7.1875 5.33203125 C-6.1046875 4.57986328 -6.1046875 4.57986328 -5 3.8125 C-4.278125 3.30332031 -3.55625 2.79414062 -2.8125 2.26953125 C-2.214375 1.85058594 -1.61625 1.43164062 -1 1 C-0.67 0.67 -0.34 0.34 0 0 Z " fill="#DDA91C" transform="translate(711,695)"/><path d="M0 0 C0.78375 0.04125 1.5675 0.0825 2.375 0.125 C1.44538578 1.27724028 0.5059875 2.42159176 -0.4375 3.5625 C-1.22060547 4.51962891 -1.22060547 4.51962891 -2.01953125 5.49609375 C-3.625 7.125 -3.625 7.125 -6.625 8.125 C-4.21323529 0.20063025 -4.21323529 0.20063025 0 0 Z " fill="#F6CF37" transform="translate(527.625,695.875)"/><path d="M0 0 C1.43739513 -0.02712066 2.87493863 -0.04645067 4.3125 -0.0625 C5.51326172 -0.07990234 5.51326172 -0.07990234 6.73828125 -0.09765625 C9 0 9 0 12 1 C12.33 2.65 12.66 4.3 13 6 C12.34 5.731875 11.68 5.46375 11 5.1875 C7.35060933 3.74294953 3.67754567 2.37128822 0 1 C0 0.67 0 0.34 0 0 Z " fill="#FDF12F" transform="translate(147,565)"/><path d="M0 0 C1.72880982 -0.05449838 3.45812712 -0.09301688 5.1875 -0.125 C6.15042969 -0.14820313 7.11335937 -0.17140625 8.10546875 -0.1953125 C11.1852108 0.01249735 13.2829741 0.54255449 16 2 C16.33 2.99 16.66 3.98 17 5 C8.585 3.02 8.585 3.02 0 1 C0 0.67 0 0.34 0 0 Z " fill="#A28C63" transform="translate(833,556)"/><path d="M0 0 C-0.0625 1.8125 -0.0625 1.8125 -1 4 C-4.375 5.875 -4.375 5.875 -8 7 C-8.99 6.34 -9.98 5.68 -11 5 C-9.54462432 4.16151196 -8.08559627 3.32936066 -6.625 2.5 C-5.81289063 2.0359375 -5.00078125 1.571875 -4.1640625 1.09375 C-2 0 -2 0 0 0 Z " fill="#FAED7B" transform="translate(890,265)"/><path d="M0 0 C6.00477279 0.64916463 11.400781 2.85795003 17 5 C17 5.33 17 5.66 17 6 C10.80138093 6.67012098 5.64376389 4.24947173 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FAE98A" transform="translate(461,180)"/><path d="M0 0 C2.1464753 0.11344376 4.29220592 0.24106345 6.4375 0.375 C8.22994141 0.47941406 8.22994141 0.47941406 10.05859375 0.5859375 C11.02925781 0.72257813 11.99992187 0.85921875 13 1 C13.33 1.66 13.66 2.32 14 3 C12.22925083 3.02705729 10.45838289 3.04642195 8.6875 3.0625 C7.70136719 3.07410156 6.71523437 3.08570313 5.69921875 3.09765625 C3 3 3 3 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FAD415" transform="translate(114,821)"/><path d="M0 0 C0.33 0.66 0.66 1.32 1 2 C1.66 2 2.32 2 3 2 C4.3271261 5.9813783 4.06915913 9.85045227 4 14 C0.7354972 10.7354972 0.06763945 6.58952701 -0.125 2.0625 C-0.08375 1.381875 -0.0425 0.70125 0 0 Z " fill="#FAC909" transform="translate(48,758)"/><path d="M0 0 C0.391875 0.556875 0.78375 1.11375 1.1875 1.6875 C4.07190285 5.36760018 7.10732772 8.40488515 11 11 C11 11.66 11 12.32 11 13 C6.55366401 11.60258012 3.9510291 9.60681335 1 6 C0.1875 2.6875 0.1875 2.6875 0 0 Z " fill="#9A854B" transform="translate(134,734)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C1.52794881 4.24846075 -0.88877522 6.26819288 -4 9 C-4.66 9 -5.32 9 -6 9 C-5.8125 6.625 -5.8125 6.625 -5 4 C-2.4375 2.6875 -2.4375 2.6875 0 2 C0 1.34 0 0.68 0 0 Z " fill="#BC8D31" transform="translate(673,611)"/><path d="M0 0 C3.465 1.98 3.465 1.98 7 4 C6.01 4.33 5.02 4.66 4 5 C3.26676204 7.01508358 3.26676204 7.01508358 3 9 C0.9375 7.3125 0.9375 7.3125 -1 5 C-0.75 2.25 -0.75 2.25 0 0 Z " fill="#FADF3D" transform="translate(159,566)"/><path d="M0 0 C2.6645814 1.01070329 3.95195872 1.9399484 5.75 4.1875 C7.27739989 7.62414976 7.21888362 10.27897849 7 14 C6.67 14 6.34 14 6 14 C5.7525 12.9275 5.505 11.855 5.25 10.75 C3.97663779 6.92991338 2.85332641 5.66310465 0 3 C0 2.01 0 1.02 0 0 Z " fill="#F5CA47" transform="translate(403,449)"/><path d="M0 0 C2.97 0.99 5.94 1.98 9 3 C4.86621405 5.7558573 2.94796454 6.10756445 -2 6 C-1.01 5.67 -0.02 5.34 1 5 C0.67 3.35 0.34 1.7 0 0 Z " fill="#F0C041" transform="translate(566,432)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C-1.7187979 4.89588352 -4.65434941 6.28724659 -10 7 C-8.68 5.35 -7.36 3.7 -6 2 C-6.66 1.67 -7.32 1.34 -8 1 C-7.05125 1.020625 -6.1025 1.04125 -5.125 1.0625 C-2.09333717 1.22551826 -2.09333717 1.22551826 0 0 Z " fill="#FDEE6A" transform="translate(868,280)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C1.62492618 2.71928517 1.15781339 3.84218661 -0.8125 5.8125 C-3 7 -3 7 -5.25 6.6875 C-5.8275 6.460625 -6.405 6.23375 -7 6 C-5.1875 4 -5.1875 4 -3 2 C-2.01 2 -1.02 2 0 2 C0 1.34 0 0.68 0 0 Z " fill="#886325" transform="translate(929,834)"/><path d="M0 0 C-3.06117568 2.62386487 -3.73173127 3 -8 3 C-8 2.34 -8 1.68 -8 1 C-10.64 1.33 -13.28 1.66 -16 2 C-10.6950309 -1.53664607 -6.12563041 -1.10261347 0 0 Z " fill="#C4921F" transform="translate(902,816)"/><path d="M0 0 C0.33 0.99 0.66 1.98 1 3 C-2.3 5.97 -5.6 8.94 -9 12 C-9.66 11.67 -10.32 11.34 -11 11 C-7.37 7.37 -3.74 3.74 0 0 Z " fill="#F6D64A" transform="translate(667,671)"/><path d="M0 0 C0.33 0.99 0.66 1.98 1 3 C-2.63 6.3 -6.26 9.6 -10 13 C-10.66 12.67 -11.32 12.34 -12 12 C-8.04 8.04 -4.08 4.08 0 0 Z " fill="#F8DE70" transform="translate(692,645)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C0.25 6.625 0.25 6.625 -2 10 C-2.99 10 -3.98 10 -5 10 C-3.85017555 6.10828647 -2.70784225 3.06103907 0 0 Z " fill="#CA9F3A" transform="translate(767,590)"/><path d="M0 0 C2.475 0.495 2.475 0.495 5 1 C6.1796875 2.77734375 6.1796875 2.77734375 6.875 4.9375 C7.11992188 5.64777344 7.36484375 6.35804688 7.6171875 7.08984375 C8 9 8 9 7 11 C4.69 7.37 2.38 3.74 0 0 Z " fill="#BC9349" transform="translate(634,563)"/><path d="M0 0 C2.40072955 2.88087546 4.47291037 5.56404834 6 9 C4.68 9 3.36 9 2 9 C0.1875 6.75 0.1875 6.75 -1 4 C-0.6875 1.6875 -0.6875 1.6875 0 0 Z " fill="#EBB63B" transform="translate(658,505)"/><path d="M0 0 C3.25696479 0.41755959 4.63443291 0.63443291 7 3 C5.71034824 4.37562854 4.37310707 5.70766393 3 7 C2.34 7 1.68 7 1 7 C0.34 5.02 -0.32 3.04 -1 1 C-0.67 0.67 -0.34 0.34 0 0 Z " fill="#EAB93E" transform="translate(619,455)"/><path d="M0 0 C5.21979128 -0.1799928 9.07262981 0.02905192 14 2 C14 2.66 14 3.32 14 4 C9.03083364 3.48594831 4.70973649 2.76615118 0 1 C0 0.67 0 0.34 0 0 Z " fill="#96764D" transform="translate(89,850)"/><path d="M0 0 C0.97582031 0.00902344 1.95164062 0.01804687 2.95703125 0.02734375 C3.69308594 0.03894531 4.42914062 0.05054688 5.1875 0.0625 C4.1975 0.3925 3.2075 0.7225 2.1875 1.0625 C2.1875 1.7225 2.1875 2.3825 2.1875 3.0625 C-2.1025 2.7325 -6.3925 2.4025 -10.8125 2.0625 C-10.8125 1.7325 -10.8125 1.4025 -10.8125 1.0625 C-7.13862505 0.20951624 -3.7677607 -0.04539471 0 0 Z " fill="#CEB06C" transform="translate(519.8125,821.9375)"/><path d="M0 0 C-0.33 4.62 -0.66 9.24 -1 14 C-1.33 14 -1.66 14 -2 14 C-2.07347656 13.04287109 -2.07347656 13.04287109 -2.1484375 12.06640625 C-2.22320313 11.24011719 -2.29796875 10.41382813 -2.375 9.5625 C-2.44460938 8.73878906 -2.51421875 7.91507813 -2.5859375 7.06640625 C-2.72257813 6.38449219 -2.85921875 5.70257812 -3 5 C-3.66 4.67 -4.32 4.34 -5 4 C-1.125 0 -1.125 0 0 0 Z " fill="#C4A159" transform="translate(968,720)"/><path d="M0 0 C0.33 0.99 0.66 1.98 1 3 C-1.97 5.97 -4.94 8.94 -8 12 C-8.66 11.67 -9.32 11.34 -10 11 C-6.79239749 7.19364503 -3.59253891 3.45436433 0 0 Z " fill="#D89E0D" transform="translate(698,708)"/><path d="M0 0 C0.33 0.99 0.66 1.98 1 3 C-2.3 6.3 -5.6 9.6 -9 13 C-9.66 12.67 -10.32 12.34 -11 12 C-7.37 8.04 -3.74 4.08 0 0 Z " fill="#F8DA53" transform="translate(679,658)"/><path d="M0 0 C4.43458973 1.3937282 6.87378374 3.60582235 10 7 C8.02 7.33 6.04 7.66 4 8 C3.67 6.35 3.34 4.7 3 3 C2.01 2.67 1.02 2.34 0 2 C0 1.34 0 0.68 0 0 Z " fill="#F9E342" transform="translate(210,606)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C3.66565749 1.15222973 5.33656496 1.24917215 7.0078125 1.31640625 C7.99394531 1.35830078 8.98007812 1.40019531 9.99609375 1.44335938 C11.54490234 1.50233398 11.54490234 1.50233398 13.125 1.5625 C14.68541016 1.62727539 14.68541016 1.62727539 16.27734375 1.69335938 C18.85142528 1.7996288 21.42560508 1.90166583 24 2 C24 2.33 24 2.66 24 3 C16.08 3 8.16 3 0 3 C0 2.01 0 1.02 0 0 Z " fill="#F1DFB0" transform="translate(396,585)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C1.67 1.99 1.34 2.98 1 4 C-1.31 4.33 -3.62 4.66 -6 5 C-6 5.66 -6 6.32 -6 7 C-7.98 7.33 -9.96 7.66 -12 8 C-8.20182235 4.77730382 -4.42608146 2.25479622 0 0 Z " fill="#F9EB7E" transform="translate(938,236)"/><path d="M0 0 C1.79378179 2.69067269 2.97313958 5.08578257 4.1875 8.0625 C4.55230469 8.94035156 4.91710938 9.81820312 5.29296875 10.72265625 C6 13 6 13 5 15 C3.0625 13.6875 3.0625 13.6875 1 11 C0.3424775 7.34417489 0.12789352 3.70891212 0 0 Z " fill="#DAAB3F" transform="translate(53,765)"/><path d="M0 0 C3.98069267 2.87494471 6.43571997 5.82117329 9 10 C8.34 10.66 7.68 11.32 7 12 C7 11.01 7 10.02 7 9 C6.34 9 5.68 9 5 9 C5 8.34 5 7.68 5 7 C4.360625 6.773125 3.72125 6.54625 3.0625 6.3125 C1 5 1 5 0.25 2.375 C0.1675 1.59125 0.085 0.8075 0 0 Z " fill="#EEB93F" transform="translate(918,739)"/><path d="M0 0 C0.99 0.33 1.98 0.66 3 1 C0.03 3.97 -2.94 6.94 -6 10 C-6.33 9.01 -6.66 8.02 -7 7 C-4.69 4.69 -2.38 2.38 0 0 Z " fill="#CF9B23" transform="translate(684,737)"/><path d="M0 0 C0.99 0.33 1.98 0.66 3 1 C1.50902342 4.7952131 -0.75700849 6.61042731 -4 9 C-4.66 8.67 -5.32 8.34 -6 8 C-5.34 7.01 -4.68 6.02 -4 5 C-3.34 5 -2.68 5 -2 5 C-1.855625 4.360625 -1.71125 3.72125 -1.5625 3.0625 C-1 1 -1 1 0 0 Z " fill="#FDDF13" transform="translate(144,715)"/><path d="M0 0 C5.28 0.33 10.56 0.66 16 1 C16.33 2.65 16.66 4.3 17 6 C16.47921875 5.52949219 15.9584375 5.05898438 15.421875 4.57421875 C12.36207873 2.58535118 9.85472891 2.28111476 6.25 1.8125 C5.07953125 1.65394531 3.9090625 1.49539063 2.703125 1.33203125 C1.81109375 1.22246094 0.9190625 1.11289062 0 1 C0 0.67 0 0.34 0 0 Z " fill="#BC9B64" transform="translate(807,694)"/><path d="M0 0 C0.99 0.33 1.98 0.66 3 1 C2.46930939 4.82097239 1.50298434 7.06171403 -1 10 C-2.23076923 4.58461538 -2.23076923 4.58461538 -1.0625 1.625 C-0.5365625 0.820625 -0.5365625 0.820625 0 0 Z " fill="#F5C72C" transform="translate(792,600)"/><path d="M0 0 C4.875 3.75 4.875 3.75 6 6 C6.06950541 7.54023996 6.08452357 9.08334988 6.0625 10.625 C6.05347656 11.44226563 6.04445313 12.25953125 6.03515625 13.1015625 C6.02355469 13.72804688 6.01195312 14.35453125 6 15 C5.67 15 5.34 15 5 15 C5 12.36 5 9.72 5 7 C4.01 7 3.02 7 2 7 C1.34 4.69 0.68 2.38 0 0 Z " fill="#E1B240" transform="translate(492,507)"/><path d="M0 0 C3.73654172 0.80465131 7.19422782 2.17574885 10.75 3.5625 C12.50570313 4.24505859 12.50570313 4.24505859 14.296875 4.94140625 C15.18890625 5.29074219 16.0809375 5.64007813 17 6 C13.11899098 7.29366967 11.79788906 6.43316568 8 5 C7.28457031 4.73445312 6.56914062 4.46890625 5.83203125 4.1953125 C3.8849936 3.47163479 1.94215553 2.73667968 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FCBC0F" transform="translate(492,198)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C1.70351563 1.56203125 1.40703125 2.1240625 1.1015625 2.703125 C-0.00943503 5.01967305 -0.83464706 7.30709092 -1.625 9.75 C-1.88539062 10.54921875 -2.14578125 11.3484375 -2.4140625 12.171875 C-2.60742188 12.77515625 -2.80078125 13.3784375 -3 14 C-4.2238892 11.55222161 -4.016364 10.26609459 -3.75 7.5625 C-3.68296875 6.78003906 -3.6159375 5.99757813 -3.546875 5.19140625 C-2.91025468 2.64037768 -1.99028875 1.66392419 0 0 Z M-5 3 C-4.01 3.495 -4.01 3.495 -3 4 C-3.99 4.495 -3.99 4.495 -5 5 C-5 4.34 -5 3.68 -5 3 Z " fill="#F9D032" transform="translate(27,90)"/><path d="M0 0 C2.475 0.99 2.475 0.99 5 2 C5 2.99 5 3.98 5 5 C6.32 5.66 7.64 6.32 9 7 C7.02 7.99 7.02 7.99 5 9 C4.16094435 7.87926138 3.32892169 6.75325453 2.5 5.625 C2.0359375 4.99851562 1.571875 4.37203125 1.09375 3.7265625 C0 2 0 2 0 0 Z " fill="#B98B36" transform="translate(31,802)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C2.66 3.96 3.32 7.92 4 12 C3.34 12 2.68 12 2 12 C2 11.34 2 10.68 2 10 C1.34 10 0.68 10 0 10 C0 6.7 0 3.4 0 0 Z " fill="#F0B306" transform="translate(47,748)"/><path d="M0 0 C0.99 0 1.98 0 3 0 C1.44396229 3.81936528 -0.95604931 6.26044438 -4 9 C-4.66 9 -5.32 9 -6 9 C-4.4705003 5.55862568 -2.54630448 2.7777867 0 0 Z " fill="#C89430" transform="translate(690,664)"/><path d="M0 0 C1 3 1 3 0.25 5.5625 C-1 8 -1 8 -4 10 C-4.99 9.67 -5.98 9.34 -7 9 C-4.69 6.03 -2.38 3.06 0 0 Z " fill="#F8D349" transform="translate(956,573)"/><path d="M0 0 C0.66 0.66 1.32 1.32 2 2 C1.67 2.66 1.34 3.32 1 4 C2.32 4.33 3.64 4.66 5 5 C5.625 6.875 5.625 6.875 6 9 C5.34 9.66 4.68 10.32 4 11 C2.02 7.7 0.04 4.4 -2 1 C-1.34 0.67 -0.68 0.34 0 0 Z " fill="#B08336" transform="translate(623,542)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1 3.63 1 7.26 1 11 C-1.8290723 8.1709277 -2.37611108 7.61855575 -3 4 C-2.34 4 -1.68 4 -1 4 C-0.67 2.68 -0.34 1.36 0 0 Z " fill="#B58113" transform="translate(1003,510)"/><path d="M0 0 C3.25524265 3.02272532 5.61820737 6.25718301 8 10 C7.67 10.66 7.34 11.32 7 12 C2.5991297 8.17819158 1.19194469 5.52628901 0 0 Z " fill="#F1C74F" transform="translate(988,478)"/><path d="M0 0 C10.55808656 3.07517084 10.55808656 3.07517084 15 5 C11.30848068 6.36722938 9.52870887 5.5123038 6 4 C4.0075675 3.62406934 2.0081326 3.28020455 0 3 C0 2.01 0 1.02 0 0 Z " fill="#FAE87F" transform="translate(575,223)"/><path d="M0 0 C1.32 0.66 2.64 1.32 4 2 C3.34 2 2.68 2 2 2 C1.67 3.98 1.34 5.96 1 8 C-0.32 8.33 -1.64 8.66 -3 9 C-2.01 6.03 -1.02 3.06 0 0 Z " fill="#B4903E" transform="translate(933,773)"/><path d="M0 0 C0.66 0.66 1.32 1.32 2 2 C-3.50016964 3.30267176 -8.47032059 2.71033431 -14 2 C-14 1.67 -14 1.34 -14 1 C-4.44705882 -0.31764706 -4.44705882 -0.31764706 0 0 Z " fill="#F8DB4A" transform="translate(641,757)"/><path d="M0 0 C2.52748246 1.26374123 2.7343939 2.27205914 3.875 4.8125 C5.47896713 8.17118306 7.13848899 10.54727628 10 13 C7.19099964 12.64582169 6.18543998 12.21351117 4.296875 10.0390625 C3.78640625 9.24242187 3.2759375 8.44578125 2.75 7.625 C2.22921875 6.83351563 1.7084375 6.04203125 1.171875 5.2265625 C0 3 0 3 0 0 Z " fill="#BC9C48" transform="translate(520,720)"/><path d="M0 0 C0.66 0.99 1.32 1.98 2 3 C-0.97 5.475 -0.97 5.475 -4 8 C-4.33 7.01 -4.66 6.02 -5 5 C-4.67 4.34 -4.34 3.68 -4 3 C-3.34 3 -2.68 3 -2 3 C-2 2.34 -2 1.68 -2 1 C-1.34 0.67 -0.68 0.34 0 0 Z " fill="#D89F2A" transform="translate(697,657)"/><path d="M0 0 C0.66 0.66 1.32 1.32 2 2 C1.625 5.125 1.625 5.125 1 8 C0.34 8 -0.32 8 -1 8 C-1 10.31 -1 12.62 -1 15 C-1.33 15 -1.66 15 -2 15 C-2.19392201 9.47322267 -1.7479503 5.24385089 0 0 Z " fill="#F4D967" transform="translate(460,637)"/><path d="M0 0 C1.60379341 -0.05416188 3.20811406 -0.09286638 4.8125 -0.125 C5.70582031 -0.14820313 6.59914063 -0.17140625 7.51953125 -0.1953125 C10 0 10 0 13 2 C11.58696762 2.2506019 10.16920526 2.47461921 8.75 2.6875 C7.96109375 2.81511719 7.1721875 2.94273437 6.359375 3.07421875 C3.37172981 2.98023653 2.19073117 1.95457437 0 0 Z " fill="#FBF081" transform="translate(479,622)"/><path d="M0 0 C2.475 0.495 2.475 0.495 5 1 C5 2.65 5 4.3 5 6 C5.99 6.33 6.98 6.66 8 7 C7.67 8.32 7.34 9.64 7 11 C4.69 7.37 2.38 3.74 0 0 Z " fill="#BD964E" transform="translate(608,524)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C3.4631783 1.97440927 4.80713064 3.93238871 6.125 6 C6.49753906 6.57234375 6.87007812 7.1446875 7.25390625 7.734375 C8.17550408 9.15221782 9.08855821 10.57560725 10 12 C9.67 12.66 9.34 13.32 9 14 C5.48453819 9.51750177 2.35287886 5.22861968 0 0 Z " fill="#A67207" transform="translate(994,509)"/><path d="M0 0 C9.59453303 2.89066059 9.59453303 2.89066059 13 6 C8.02693484 5.50269348 4.36200187 4.44697666 0 2 C0 1.34 0 0.68 0 0 Z " fill="#F2CE68" transform="translate(531,417)"/><path d="M0 0 C4.38889325 0.66498383 7.9811485 2.18757677 12 4 C12 4.66 12 5.32 12 6 C7.61110675 5.33501617 4.0188515 3.81242323 0 2 C0 1.34 0 0.68 0 0 Z " fill="#AB8A55" transform="translate(431,342)"/><path d="M0 0 C1.43931117 0.45261358 2.87638999 0.91232979 4.3125 1.375 C5.11300781 1.63023437 5.91351563 1.88546875 6.73828125 2.1484375 C9 3 9 3 12 5 C7.90854474 6.16898722 6.45635697 6.24508059 2.625 4.1875 C1.75875 3.465625 0.8925 2.74375 0 2 C0 1.34 0 0.68 0 0 Z " fill="#F9DE78" transform="translate(374,253)"/><path d="M0 0 C3.96 1.32 7.92 2.64 12 4 C12 4.33 12 4.66 12 5 C10.02 5.33 8.04 5.66 6 6 C5.67 5.01 5.34 4.02 5 3 C3.68 3.33 2.36 3.66 1 4 C0.67 2.68 0.34 1.36 0 0 Z " fill="#F2DD82" transform="translate(267,106)"/><path d="M0 0 C0.66 0.99 1.32 1.98 2 3 C1.01 3.33 0.02 3.66 -1 4 C-1.12375 4.7425 -1.2475 5.485 -1.375 6.25 C-1.95486701 8.80141485 -2.73708739 10.7267573 -4 13 C-4.66 13 -5.32 13 -6 13 C-4.58707905 8.1725201 -2.57025846 4.2837641 0 0 Z " fill="#FAE86D" transform="translate(32,70)"/><path d="M0 0 C4.23429756 1.31061591 8.07407404 2.94356259 12 5 C11.01 5.66 10.02 6.32 9 7 C9 6.34 9 5.68 9 5 C7.68 5 6.36 5 5 5 C5 4.34 5 3.68 5 3 C2.03 2.505 2.03 2.505 -1 2 C-0.67 1.34 -0.34 0.68 0 0 Z " fill="#A7833E" transform="translate(941,777)"/><path d="M0 0 C2 2 2 2 2.1953125 4.1640625 C2.17210937 4.97617187 2.14890625 5.78828125 2.125 6.625 C2.10695313 7.44226563 2.08890625 8.25953125 2.0703125 9.1015625 C2.03550781 10.04128906 2.03550781 10.04128906 2 11 C1.01 11.495 1.01 11.495 0 12 C-0.06058594 11.37351562 -0.12117187 10.74703125 -0.18359375 10.1015625 C-0.26738281 9.28429687 -0.35117187 8.46703125 -0.4375 7.625 C-0.51871094 6.81289063 -0.59992187 6.00078125 -0.68359375 5.1640625 C-0.89090114 2.95727195 -0.89090114 2.95727195 -2 1 C-1.34 0.67 -0.68 0.34 0 0 Z " fill="#F1B31E" transform="translate(556,707)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C-1.3 4.3 -4.6 7.6 -8 11 C-8.66 10.67 -9.32 10.34 -10 10 C-6.66666667 6.66666667 -3.33333333 3.33333333 0 0 Z " fill="#CC9005" transform="translate(668,603)"/><path d="M0 0 C1.32 0.66 2.64 1.32 4 2 C-0.95 4.475 -0.95 4.475 -6 7 C-5.67 5.68 -5.34 4.36 -5 3 C-3.35 3 -1.7 3 0 3 C0 2.01 0 1.02 0 0 Z " fill="#AF8E4E" transform="translate(759,585)"/><path d="M0 0 C4.8274799 1.41292095 8.7162359 3.42974154 13 6 C10 7 10 7 7.51953125 6.00390625 C6.62621094 5.52824219 5.73289062 5.05257813 4.8125 4.5625 C3.91144531 4.08941406 3.01039063 3.61632812 2.08203125 3.12890625 C1.39496094 2.75636719 0.70789063 2.38382812 0 2 C0 1.34 0 0.68 0 0 Z " fill="#F4AE11" transform="translate(426,379)"/><path d="M0 0 C4.75481646 0.57634139 7.97048212 2.55068521 12 5 C10 6 10 6 7.6171875 5.22265625 C6.71226562 4.83980469 5.80734375 4.45695312 4.875 4.0625 C3.50988281 3.49208984 3.50988281 3.49208984 2.1171875 2.91015625 C1.41851562 2.60980469 0.71984375 2.30945313 0 2 C0 1.34 0 0.68 0 0 Z " fill="#AF9058" transform="translate(482,364)"/><path d="M0 0 C2.97 0.99 5.94 1.98 9 3 C8.01 3.495 8.01 3.495 7 4 C7 4.66 7 5.32 7 6 C6.01 5.67 5.02 5.34 4 5 C4.33 4.34 4.66 3.68 5 3 C3.35 3.33 1.7 3.66 0 4 C0 2.68 0 1.36 0 0 Z " fill="#F5CA55" transform="translate(589,341)"/><path d="M0 0 C1.1875 2.0625 1.1875 2.0625 2 4 C-0.31 4 -2.62 4 -5 4 C-5.66 2.68 -6.32 1.36 -7 0 C-3.98968256 -0.93423645 -3.13349732 -1.04449911 0 0 Z " fill="#FDDC56" transform="translate(446,284)"/><path d="M0 0 C1.62580966 0.11398665 3.25067157 0.24155659 4.875 0.375 C5.77992188 0.44460937 6.68484375 0.51421875 7.6171875 0.5859375 C10 1 10 1 12 3 C7.31034294 4.11658501 4.46236469 3.80619523 0 2 C0 1.34 0 0.68 0 0 Z " fill="#FBE46C" transform="translate(344,243)"/><path d="M0 0 C1.32 0.66 2.64 1.32 4 2 C-0.95 4.475 -0.95 4.475 -6 7 C-6 6.01 -6 5.02 -6 4 C-4.7934375 3.566875 -4.7934375 3.566875 -3.5625 3.125 C-0.8673532 2.26737432 -0.8673532 2.26737432 0 0 Z " fill="#917140" transform="translate(920,840)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C-1.33333333 4.33333333 -4.66666667 7.66666667 -8 11 C-6.46457536 6.52167812 -4.39145948 2.19572974 0 0 Z " fill="#F3B318" transform="translate(617,762)"/><path d="M0 0 C0.66 0.99 1.32 1.98 2 3 C-0.31 4.98 -2.62 6.96 -5 9 C-5.33 8.01 -5.66 7.02 -6 6 C-5.01 6 -4.02 6 -3 6 C-2.87625 5.38125 -2.7525 4.7625 -2.625 4.125 C-2 2 -2 2 0 0 Z " fill="#D9AC41" transform="translate(666,755)"/><path d="M0 0 C2 2 2 2 2.125 4.625 C2.08375 5.40875 2.0425 6.1925 2 7 C-0.4375 6.25 -0.4375 6.25 -3 5 C-3.8125 2.875 -3.8125 2.875 -4 1 C-3.01 1.33 -2.02 1.66 -1 2 C-0.67 1.34 -0.34 0.68 0 0 Z " fill="#F1B612" transform="translate(918,742)"/><path d="M0 0 C1.40742022 2.81484045 0.66652164 4.56936113 0.0625 7.625 C-0.13214844 8.62789062 -0.32679688 9.63078125 -0.52734375 10.6640625 C-0.68332031 11.43492187 -0.83929687 12.20578125 -1 13 C-1.66 12.34 -2.32 11.68 -3 11 C-2.54385965 3.81578947 -2.54385965 3.81578947 0 0 Z " fill="#E9A911" transform="translate(531,705)"/><path d="M0 0 C0 3.9765245 -1.38011503 5.0890167 -4 8 C-6.25 9.8125 -6.25 9.8125 -8 11 C-8.66 10.67 -9.32 10.34 -10 10 C-6.7 6.7 -3.4 3.4 0 0 Z " fill="#F7DF76" transform="translate(700,704)"/><path d="M0 0 C2.09350689 3.4019487 2.17942163 6.05272412 2 10 C0.68 9.67 -0.64 9.34 -2 9 C-1.51421457 5.87709365 -1.0013988 3.00419641 0 0 Z " fill="#E9B631" transform="translate(884,644)"/><path d="M0 0 C2.12508244 3.18762365 2.5020163 5.26512223 3 9 C1.35 9 -0.3 9 -2 9 C-1.125 5.125 -1.125 5.125 0 4 C0 2.68 0 1.36 0 0 Z " fill="#C59941" transform="translate(741,643)"/><path d="M0 0 C2 3 2 3 2 7 C2.61998741 9.01495907 3.27954236 11.0187415 4 13 C0.67829507 10.31100077 -0.50358331 6.91918656 -2 3 C-2 2.34 -2 1.68 -2 1 C-1.34 0.67 -0.68 0.34 0 0 Z " fill="#FDC925" transform="translate(853,599)"/><path d="M0 0 C2.97 0.495 2.97 0.495 6 1 C6.33 3.31 6.66 5.62 7 8 C3.75700849 5.61042731 1.49097658 3.7952131 0 0 Z " fill="#FBD44B" transform="translate(762,551)"/><path d="M0 0 C2.5 2.25 2.5 2.25 5 5 C5 6.32 5 7.64 5 9 C4.34 8.67 3.68 8.34 3 8 C3 7.34 3 6.68 3 6 C2.01 5.67 1.02 5.34 0 5 C0 3.35 0 1.7 0 0 Z " fill="#F8C448" transform="translate(913,543)"/><path d="M0 0 C2.31 0 4.62 0 7 0 C7 1.65 7 3.3 7 5 C4.03 4.505 4.03 4.505 1 4 C0.67 2.68 0.34 1.36 0 0 Z " fill="#F6C535" transform="translate(587,344)"/><path d="M0 0 C0 0.66 0 1.32 0 2 C-1.44860687 3.25106957 -2.90276867 4.49699773 -4.3984375 5.69140625 C-6.40476588 7.33072334 -8.20414101 9.13506951 -10 11 C-9.42380903 7.43235179 -8.13030516 5.74840503 -5.5625 3.25 C-4.94503906 2.63640625 -4.32757813 2.0228125 -3.69140625 1.390625 C-2 0 -2 0 0 0 Z " fill="#8E7C3C" transform="translate(80,69)"/><path d="M0 0 C4.40114397 0.50298788 6.71195019 2.08772731 10 5 C9.01 5.33 8.02 5.66 7 6 C6.67 5.01 6.34 4.02 6 3 C4.35 3.33 2.7 3.66 1 4 C0.67 2.68 0.34 1.36 0 0 Z " fill="#FBD635" transform="translate(913,23)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C0.75453595 4.73639216 -0.63404953 5.18756513 -4 7 C-4.33 6.01 -4.66 5.02 -5 4 C-3.35 2.68 -1.7 1.36 0 0 Z " fill="#FAE452" transform="translate(616,759)"/><path d="M0 0 C0.598125 0.763125 1.19625 1.52625 1.8125 2.3125 C3.46959332 4.3483575 5.10297674 6.1978279 7 8 C6.67 8.66 6.34 9.32 6 10 C1.77202073 6.91709845 1.77202073 6.91709845 0 5 C-0.375 2.1875 -0.375 2.1875 0 0 Z " fill="#F7D351" transform="translate(471,651)"/><path d="M0 0 C-1.28519565 2.86697492 -2.57129254 4.97607712 -5 7 C-5.66 7 -6.32 7 -7 7 C-6.22006468 2.47637516 -4.81844319 0 0 0 Z " fill="#BB8E2D" transform="translate(665,622)"/><path d="M0 0 C3.25543229 0.34879632 4.01873107 1.02133261 6.25 3.5625 C6.8275 4.366875 7.405 5.17125 8 6 C4.7 5.01 1.4 4.02 -2 3 C-1.34 2.67 -0.68 2.34 0 2 C0 1.34 0 0.68 0 0 Z " fill="#C1953C" transform="translate(509,466)"/><path d="M0 0 C5.29441695 -0.50423019 7.81413519 0.81076967 12 4 C10 5 10 5 7.6171875 4.22265625 C6.71226562 3.83980469 5.80734375 3.45695312 4.875 3.0625 C3.50988281 2.49208984 3.50988281 2.49208984 2.1171875 1.91015625 C1.41851563 1.60980469 0.71984375 1.30945313 0 1 C0 0.67 0 0.34 0 0 Z " fill="#B09260" transform="translate(512,378)"/><path d="M0 0 C5.94 1.485 5.94 1.485 12 3 C12 3.33 12 3.66 12 4 C10.741875 4.020625 9.48375 4.04125 8.1875 4.0625 C7.47980469 4.07410156 6.77210937 4.08570313 6.04296875 4.09765625 C4 4 4 4 1 3 C0.67 2.01 0.34 1.02 0 0 Z " fill="#F2D56E" transform="translate(99,814)"/><path d="M0 0 C0.65234375 1.796875 0.65234375 1.796875 1 4 C-0.36489377 6.33370072 -2.1419038 8.00594554 -4 10 C-4.33 9.01 -4.66 8.02 -5 7 C-4.00390625 5.17578125 -4.00390625 5.17578125 -2.5625 3.3125 C-2.08941406 2.68988281 -1.61632812 2.06726563 -1.12890625 1.42578125 C-0.75636719 0.95527344 -0.38382813 0.48476563 0 0 Z " fill="#8D7040" transform="translate(953,810)"/><path d="M0 0 C2.31 0.33 4.62 0.66 7 1 C7.33 2.32 7.66 3.64 8 5 C4.7 4.67 1.4 4.34 -2 4 C-2 3.67 -2 3.34 -2 3 C-0.35 2.67 1.3 2.34 3 2 C2.01 1.34 1.02 0.68 0 0 Z " fill="#E1C06A" transform="translate(628,765)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1 3.63 1 7.26 1 11 C0.34 11 -0.32 11 -1 11 C-1.33 8.36 -1.66 5.72 -2 3 C-1.34 3 -0.68 3 0 3 C0 2.01 0 1.02 0 0 Z " fill="#B88937" transform="translate(965,729)"/><path d="M0 0 C0.8353125 0.37125 0.8353125 0.37125 1.6875 0.75 C-0.5625 2.8125 -0.5625 2.8125 -3.3125 4.75 C-5.625 4.5 -5.625 4.5 -7.3125 3.75 C-2.88173077 -0.31153846 -2.88173077 -0.31153846 0 0 Z " fill="#F9E054" transform="translate(533.3125,691.25)"/><path d="M0 0 C0.99 0.66 1.98 1.32 3 2 C3.1875 5.125 3.1875 5.125 3 8 C2.34 8 1.68 8 1 8 C-0.625 6 -0.625 6 -2 4 C-1.34 2.68 -0.68 1.36 0 0 Z " fill="#FBC421" transform="translate(944,586)"/><path d="M0 0 C2.5 2.25 2.5 2.25 5 5 C5 6.32 5 7.64 5 9 C3.0625 7.875 3.0625 7.875 1 6 C0.25 2.8125 0.25 2.8125 0 0 Z " fill="#F4D67F" transform="translate(782,568)"/><path d="M0 0 C0.93423645 3.01031744 1.04449911 3.86650268 0 7 C-0.66 7 -1.32 7 -2 7 C-2 8.98 -2 10.96 -2 13 C-2.33 13 -2.66 13 -3 13 C-3.31563182 7.73946963 -2.66590937 4.55426184 0 0 Z " fill="#E9D85C" transform="translate(135,570)"/><path d="M0 0 C0.66 0.99 1.32 1.98 2 3 C1.01 3.495 1.01 3.495 0 4 C-0.474375 4.825 -0.94875 5.65 -1.4375 6.5 C-3 9 -3 9 -6 10 C-4.34832443 6.4213696 -2.21713508 3.25179812 0 0 Z " fill="#F1CA4F" transform="translate(968,557)"/><path d="M0 0 C3.08089673 2.77280706 4.68775452 5.06326356 6 9 C5.38125 8.814375 4.7625 8.62875 4.125 8.4375 C1.95839822 7.76313824 1.95839822 7.76313824 0 9 C0.185625 8.2575 0.37125 7.515 0.5625 6.75 C0.99203108 4.05009037 0.85122974 2.55368923 0 0 Z " fill="#DDAD41" transform="translate(642,482)"/><path d="M0 0 C0.99 0.33 1.98 0.66 3 1 C3.33 4.3 3.66 7.6 4 11 C0.88776687 6.85035583 0.47996422 4.99162787 0 0 Z " fill="#CBA84A" transform="translate(431,407)"/><path d="M0 0 C4.37859255 0.50522222 6.81651224 3.17827222 10 6 C9.01 6.33 8.02 6.66 7 7 C4.4375 5.125 4.4375 5.125 2 3 C1.34 2.67 0.68 2.34 0 2 C0 1.34 0 0.68 0 0 Z " fill="#BB7F08" transform="translate(50,825)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C0.84826645 3.46800047 -0.04783565 5.04783565 -2 7 C-2.66 6.67 -3.32 6.34 -4 6 C-4 5.01 -4 4.02 -4 3 C-2 1.3125 -2 1.3125 0 0 Z " fill="#AC7804" transform="translate(926,791)"/><path d="M0 0 C0.33 0.99 0.66 1.98 1 3 C-1.97 3 -4.94 3 -8 3 C-8.33 2.34 -8.66 1.68 -9 1 C-2.25 0 -2.25 0 0 0 Z " fill="#E6B01D" transform="translate(933,755)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C3.26237731 2.52475462 3.09856404 4.31200466 3.0625 7.125 C3.05347656 8.03507813 3.04445313 8.94515625 3.03515625 9.8828125 C3.02355469 10.58148437 3.01195312 11.28015625 3 12 C2.67 12 2.34 12 2 12 C1.67 10.02 1.34 8.04 1 6 C0.67 6 0.34 6 0 6 C0 4.02 0 2.04 0 0 Z " fill="#CF8B0B" transform="translate(965,708)"/><path d="M0 0 C1.32 0.66 2.64 1.32 4 2 C1.82575883 4.50037734 0.26954202 5.43628586 -3 6 C-2.42655063 3.13275314 -2.1385485 2.1385485 0 0 Z " fill="#E9BF29" transform="translate(655,683)"/><path d="M0 0 C1.57554035 2.88628401 2.46276373 5.53342384 3.125 8.75 C3.29257812 9.54921875 3.46015625 10.3484375 3.6328125 11.171875 C3.81457031 12.07679688 3.81457031 12.07679688 4 13 C0.71899921 10.04349379 -0.07365956 7.32292206 -1 3 C-0.67 2.01 -0.34 1.02 0 0 Z " fill="#BF9443" transform="translate(761,649)"/><path d="M0 0 C1.32 0.33 2.64 0.66 4 1 C3.54625 1.433125 3.0925 1.86625 2.625 2.3125 C0.79975666 4.10798342 0.79975666 4.10798342 -1 7 C-1.99 7.33 -2.98 7.66 -4 8 C-2.66666667 5.33333333 -1.33333333 2.66666667 0 0 Z " fill="#C38A05" transform="translate(693,645)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C1.25749403 5.08378283 0.17076699 9.01939223 -1 13 C-1.33 13 -1.66 13 -2 13 C-2.19294408 8.17639811 -1.75747614 4.50353262 0 0 Z " fill="#D0A437" transform="translate(472,636)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C2 0.66 2 1.32 2 2 C2.66 2 3.32 2 4 2 C4.33 2.99 4.66 3.98 5 5 C4.34 5.66 3.68 6.32 3 7 C1.68 6.01 0.36 5.02 -1 4 C-0.67 2.68 -0.34 1.36 0 0 Z " fill="#FDE529" transform="translate(170,576)"/><path d="M0 0 C2.90802461 2.21928194 4.95312762 3.92969143 7 7 C6.67 7.99 6.34 8.98 6 10 C2 5.25 2 5.25 2 3 C1.34 3 0.68 3 0 3 C0 2.01 0 1.02 0 0 Z " fill="#835506" transform="translate(771,567)"/><path d="M0 0 C4.875 4.75 4.875 4.75 6 7 C5.34 7.66 4.68 8.32 4 9 C3.896875 8.360625 3.79375 7.72125 3.6875 7.0625 C3.460625 6.381875 3.23375 5.70125 3 5 C2.01 4.67 1.02 4.34 0 4 C0 2.68 0 1.36 0 0 Z " fill="#A06A08" transform="translate(766,560)"/><path d="M0 0 C5.78461538 4.30769231 5.78461538 4.30769231 6.875 7.8125 C6.936875 8.8953125 6.936875 8.8953125 7 10 C3.60582235 6.87378374 1.3937282 4.43458973 0 0 Z " fill="#9F8C4E" transform="translate(787,529)"/><path d="M0 0 C2.31 0.33 4.62 0.66 7 1 C6.01 1.495 6.01 1.495 5 2 C5 2.66 5 3.32 5 4 C3.35 3.67 1.7 3.34 0 3 C0 2.01 0 1.02 0 0 Z " fill="#EFC043" transform="translate(596,345)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C-0.97 3.64 -3.94 6.28 -7 9 C-7 6 -7 6 -5.46875 4.39453125 C-4.49421875 3.61142578 -4.49421875 3.61142578 -3.5 2.8125 C-2.8503125 2.28269531 -2.200625 1.75289063 -1.53125 1.20703125 C-1.0259375 0.80871094 -0.520625 0.41039062 0 0 Z " fill="#452A03" transform="translate(971,316)"/><path d="M0 0 C0 0.66 0 1.32 0 2 C-2.31 2.66 -4.62 3.32 -7 4 C-6.625 2.0625 -6.625 2.0625 -6 0 C-3.50907189 -1.24546405 -2.58919267 -0.7767578 0 0 Z " fill="#BD8607" transform="translate(890,819)"/><path d="M0 0 C3.96 1.98 3.96 1.98 8 4 C8 4.33 8 4.66 8 5 C6.02 5.33 4.04 5.66 2 6 C1.34 4.02 0.68 2.04 0 0 Z " fill="#F1CD5B" transform="translate(84,806)"/><path d="M0 0 C2.31 1.65 4.62 3.3 7 5 C6.67 5.66 6.34 6.32 6 7 C5.01 7 4.02 7 3 7 C0 2.77777778 0 2.77777778 0 0 Z " fill="#ECC34A" transform="translate(76,800)"/><path d="M0 0 C0.66 0 1.32 0 2 0 C1.60196439 2.88575819 1.20990931 3.82189513 -1.0625 5.75 C-1.701875 6.1625 -2.34125 6.575 -3 7 C-2.25 2.25 -2.25 2.25 0 0 Z " fill="#D1A63E" transform="translate(671,750)"/><path d="M0 0 C0.66 1.32 1.32 2.64 2 4 C-2.625 6.125 -2.625 6.125 -6 5 C-4.02 3.35 -2.04 1.7 0 0 Z " fill="#FDE01C" transform="translate(162,701)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C0.88200014 2.33920838 -0.24461897 3.67122556 -1.375 5 C-2.00148438 5.7425 -2.62796875 6.485 -3.2734375 7.25 C-4.12808594 8.11625 -4.12808594 8.11625 -5 9 C-5.66 9 -6.32 9 -7 9 C-5.44499019 5.18315774 -2.96404505 2.80804268 0 0 Z " fill="#CA8D07" transform="translate(669,672)"/><path d="M0 0 C-0.33 1.32 -0.66 2.64 -1 4 C-2.65 4.33 -4.3 4.66 -6 5 C-6 4.01 -6 3.02 -6 2 C-2.25 0 -2.25 0 0 0 Z " fill="#FCCC27" transform="translate(955,581)"/><path d="M0 0 C0.99 0.66 1.98 1.32 3 2 C3.66 1.67 4.32 1.34 5 1 C4.67 1.99 4.34 2.98 4 4 C2.02 4 0.04 4 -2 4 C-2 4.66 -2 5.32 -2 6 C-2.66 5.67 -3.32 5.34 -4 5 C-2.68 3.35 -1.36 1.7 0 0 Z " fill="#F8D34A" transform="translate(961,567)"/><path d="M0 0 C2.88437779 1.29299694 4.87219421 2.65941363 7 5 C6.67 5.66 6.34 6.32 6 7 C5.01 6.67 4.02 6.34 3 6 C2.66666667 4.66666667 2.33333333 3.33333333 2 2 C1.01 1.67 0.02 1.34 -1 1 C-0.67 0.67 -0.34 0.34 0 0 Z " fill="#F0C246" transform="translate(550,565)"/><path d="M0 0 C4.55737263 0.43820891 7.57653445 0.85041169 11 4 C6.44262737 3.56179109 3.42346555 3.14958831 0 0 Z " fill="#F9E47B" transform="translate(416,369)"/><path d="M0 0 C1.2065625 0.0309375 1.2065625 0.0309375 2.4375 0.0625 C2.7675 1.3825 3.0975 2.7025 3.4375 4.0625 C1.4575 4.0625 -0.5225 4.0625 -2.5625 4.0625 C-2.8925 3.0725 -3.2225 2.0825 -3.5625 1.0625 C-2.5625 0.0625 -2.5625 0.0625 0 0 Z " fill="#FDE656" transform="translate(964.5625,222.9375)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C1.01 4.3 0.02 7.6 -1 11 C-1.33 11 -1.66 11 -2 11 C-2.05399736 9.54207116 -2.09279177 8.08357288 -2.125 6.625 C-2.15980469 5.40683594 -2.15980469 5.40683594 -2.1953125 4.1640625 C-2 2 -2 2 0 0 Z " fill="#D3B261" transform="translate(618,773)"/><path d="M0 0 C-1.44390925 3.80666984 -3.34952803 5.26602582 -7 7 C-7.66 6.67 -8.32 6.34 -9 6 C-7.8803014 4.99406757 -6.7540588 3.9954151 -5.625 3 C-4.68527344 2.1646875 -4.68527344 2.1646875 -3.7265625 1.3125 C-2 0 -2 0 0 0 Z " fill="#F8E551" transform="translate(186,682)"/><path d="M0 0 C0.66 0.33 1.32 0.66 2 1 C1.19152271 2.16945792 0.37810888 3.33550461 -0.4375 4.5 C-0.88996094 5.1496875 -1.34242188 5.799375 -1.80859375 6.46875 C-2.20175781 6.9740625 -2.59492187 7.479375 -3 8 C-3.33 8 -3.66 8 -4 8 C-4 6.35 -4 4.7 -4 3 C-3.01 3 -2.02 3 -1 3 C-0.67 2.01 -0.34 1.02 0 0 Z " fill="#B19252" transform="translate(980,658)"/><path d="M0 0 C2.1875 0.3125 2.1875 0.3125 4 1 C2.35 2.98 0.7 4.96 -1 7 C-1.66 5.68 -2.32 4.36 -3 3 C-1.75 1.4375 -1.75 1.4375 0 0 Z " fill="#B78C2E" transform="translate(637,647)"/><path d="M0 0 C0.66 0.66 1.32 1.32 2 2 C1.625 4.625 1.625 4.625 1 7 C0.01 7 -0.98 7 -2 7 C-1.125 1.125 -1.125 1.125 0 0 Z " fill="#DC9303" transform="translate(857,632)"/><path d="M0 0 C2.64 0.99 5.28 1.98 8 3 C8 3.99 8 4.98 8 6 C5.36 4.68 2.72 3.36 0 2 C0 1.34 0 0.68 0 0 Z " fill="#B27305" transform="translate(601,353)"/><path d="M0 0 C1.65 0 3.3 0 5 0 C5 1.32 5 2.64 5 4 C3.35 3.67 1.7 3.34 0 3 C0 2.01 0 1.02 0 0 Z " fill="#FDEA66" transform="translate(274,111)"/><path d="M0 0 C0.99 0.99 1.98 1.98 3 3 C2.34 4.65 1.68 6.3 1 8 C0.34 8 -0.32 8 -1 8 C-0.67 5.36 -0.34 2.72 0 0 Z " fill="#FBCE29" transform="translate(954,58)"/><path d="M0 0 C-4.455 1.485 -4.455 1.485 -9 3 C-9.66 2.01 -10.32 1.02 -11 0 C-9.54263913 -0.19491452 -8.08405407 -0.38069358 -6.625 -0.5625 C-5.81289063 -0.66691406 -5.00078125 -0.77132812 -4.1640625 -0.87890625 C-2 -1 -2 -1 0 0 Z " fill="#FBE884" transform="translate(636,793)"/><path d="M0 0 C2.46278801 2.46278801 2.99771255 4.70676982 4 8 C3.01 8 2.02 8 1 8 C-0.35439668 5.29120665 -0.06501451 2.99066732 0 0 Z " fill="#D3B651" transform="translate(605,785)"/><path d="M0 0 C2.475 0.495 2.475 0.495 5 1 C5.33 2.65 5.66 4.3 6 6 C3.97945196 4.35830472 1.97956942 2.69088222 0 1 C0 0.67 0 0.34 0 0 Z " fill="#BC9960" transform="translate(843,718)"/><path d="M0 0 C0.33 0 0.66 0 1 0 C1.21278058 4.46839215 0.59138085 7.82262526 -1 12 C-1.33 12 -1.66 12 -2 12 C-2.17835515 7.45194365 -1.99785435 4.1205746 0 0 Z " fill="#B79453" transform="translate(971,692)"/><path d="M0 0 C0 0.66 0 1.32 0 2 C-3.13498292 3.85776765 -5.37471432 4.20140476 -9 4 C-6.1329385 1.1329385 -4.08408532 0 0 0 Z " fill="#F3B80E" transform="translate(497,666)"/><path d="M0 0 C0.99 0.33 1.98 0.66 3 1 C1.35 2.98 -0.3 4.96 -2 7 C-2.66 6.67 -3.32 6.34 -4 6 C-1.125 1.125 -1.125 1.125 0 0 Z " fill="#EDBE20" transform="translate(656,612)"/><path d="M0 0 C0.33 0.66 0.66 1.32 1 2 C3.02463255 2.65213292 3.02463255 2.65213292 5 3 C4.67 3.99 4.34 4.98 4 6 C2.68 5.34 1.36 4.68 0 4 C0 2.68 0 1.36 0 0 Z " fill="#FDE420" transform="translate(209,606)"/><path d="M0 0 C2.64 0 5.28 0 8 0 C7 2 7 2 5.125 2.6875 C3 3 3 3 0 2 C0 1.34 0 0.68 0 0 Z " fill="#B37904" transform="translate(714,601)"/><path d="M0 0 C2.31 0 4.62 0 7 0 C6.01 1.485 6.01 1.485 5 3 C2.375 3.1875 2.375 3.1875 0 3 C0 2.01 0 1.02 0 0 Z " fill="#865503" transform="translate(693,571)"/><path d="M0 0 C2 2 2 2 2.125 4.625 C2.08375 5.40875 2.0425 6.1925 2 7 C1.34 6.67 0.68 6.34 0 6 C0 5.34 0 4.68 0 4 C-0.66 4 -1.32 4 -2 4 C-2 3.01 -2 2.02 -2 1 C-1.34 0.67 -0.68 0.34 0 0 Z " fill="#FDB90C" transform="translate(903,531)"/><path d="M0 0 C5.57142857 5.14285714 5.57142857 5.14285714 6 9 C0.42857143 3.85714286 0.42857143 3.85714286 0 0 Z " fill="#794E02" transform="translate(663,526)"/><path d="M0 0 C0.99 0.99 1.98 1.98 3 3 C2.01 4.485 2.01 4.485 1 6 C0.34 6 -0.32 6 -1 6 C-1.33 4.35 -1.66 2.7 -2 1 C-1.34 0.67 -0.68 0.34 0 0 Z " fill="#E7AD2A" transform="translate(648,491)"/><path d="M0 0 C1.9375 0.5625 1.9375 0.5625 4 2 C4.75 5.625 4.75 5.625 5 9 C0.57142857 3.85714286 0.57142857 3.85714286 0 0 Z " fill="#E6B023" transform="translate(984,474)"/><path d="M0 0 C-0.33 0.99 -0.66 1.98 -1 3 C-3.31 2.34 -5.62 1.68 -8 1 C-4.93251126 -0.86240388 -3.40254489 -1.2151946 0 0 Z " fill="#C3963F" transform="translate(508,465)"/><path d="M0 0 C0.99 0.33 1.98 0.66 3 1 C3 1.99 3 2.98 3 4 C3.66 4 4.32 4 5 4 C4.67 5.32 4.34 6.64 4 8 C3.34 7.67 2.68 7.34 2 7 C1.26924352 4.6859378 0.59861742 2.35171131 0 0 Z " fill="#E3A506" transform="translate(442,428)"/><path d="M0 0 C2.97 0.99 5.94 1.98 9 3 C9 3.33 9 3.66 9 4 C6.36 4 3.72 4 1 4 C0.67 2.68 0.34 1.36 0 0 Z " fill="#F6D26D" transform="translate(545,423)"/><path d="M0 0 C2.64 0.99 5.28 1.98 8 3 C5.35261084 4.4606285 4.10551666 5 1 5 C0.67 3.35 0.34 1.7 0 0 Z " fill="#F5D16B" transform="translate(551,325)"/><path d="M0 0 C2.29013653 3.4352048 2.17842973 4.985331 2 9 C-0.2477975 6.94766315 -1.0022242 5.99332739 -2 3 C-1.34 3 -0.68 3 0 3 C0 2.01 0 1.02 0 0 Z " fill="#D9B14A" transform="translate(372,295)"/><path d="M0 0 C3.55780196 0.60990891 6.6828589 1.5783681 10 3 C6.42355152 4.2380014 3.66305234 3.74926071 0 3 C0 2.01 0 1.02 0 0 Z " fill="#F6DB78" transform="translate(429,276)"/><path d="M0 0 C1.98 0 3.96 0 6 0 C6.33 0.99 6.66 1.98 7 3 C7.66 3.33 8.32 3.66 9 4 C3.46153846 3.38461538 3.46153846 3.38461538 1.125 1.4375 C0.75375 0.963125 0.3825 0.48875 0 0 Z " fill="#FDE972" transform="translate(372,258)"/><path d="M0 0 C0.33 0.66 0.66 1.32 1 2 C0.01 3.485 0.01 3.485 -1 5 C-2.65 4.67 -4.3 4.34 -6 4 C-4.03617993 2.49440461 -2.21736634 1.10868317 0 0 Z " fill="#FBEE7B" transform="translate(925,244)"/><path d="M0 0 C0.556875 0.226875 1.11375 0.45375 1.6875 0.6875 C-5.0625 4.6875 -5.0625 4.6875 -7.3125 4.6875 C-7.3125 4.0275 -7.3125 3.3675 -7.3125 2.6875 C-3.15982824 -0.42700382 -3.15982824 -0.42700382 0 0 Z " fill="#7F6946" transform="translate(971.3125,193.3125)"/></svg>`;

var HERMES_WELCOME_ICON = HERMES_ICON;

function setIconSafe(el, iconName, size) {
  try {
    if (typeof import_obsidian.setIcon === "function") {
      import_obsidian.setIcon(el, iconName);
    } else {
      var fallbackMap = {
        "plus": "+", "trash-2": "\uD83D\uDDD1", "copy": "\uD83D\uDCCB",
        "check": "\u2713", "chevron-down": "\u25BC", "chevron-right": "\u25B6",
        "file-text": "\uD83D\uDCC4", "image": "\uD83D\uDDBC", "square": "\u25A0",
        "refresh-cw": "\u21BB", "pencil": "\u270F", "brain": "\uD83E\uDDE0", "x": "\u2715",
        "type": "T", "wand-2": "\u2728", "zap": "\u26A1",
        "chevron-up": "\u25B2"
      };
      el.setText(fallbackMap[iconName] || iconName);
      return;
    }
    // Always force SVG size via inline style (Obsidian's default is too small for action buttons)
    var svg = el.querySelector("svg") || el.querySelector(".svg-icon");
    if (svg) {
      var s = size || "16";
      svg.style.width = s + "px";
      svg.style.height = s + "px";
      svg.style.minWidth = s + "px";
      svg.style.minHeight = s + "px";
      svg.style.strokeWidth = "2px";
    }
  } catch (e) {
    console.error("Hermes setIconSafe failed:", iconName, e);
    el.setText(iconName);
  }
}

// ============================================
// @ File Mention Popup
// ============================================
var FileMentionPopup = class {
  constructor(app, inputEl, onSelect) {
    this.app = app;
    this.inputEl = inputEl;
    this.onSelect = onSelect;
    this.popupEl = null;
    this.items = [];
    this.selectedIndex = 0;
    this.active = false;
    this.mentionStart = -1;
    this.currentQuery = "";
  }

  show(cursorPos) {
    this.mentionStart = cursorPos;
    this.active = true;
    this.selectedIndex = 0;

    if (!this.popupEl) {
      this.popupEl = document.createElement("div");
      this.popupEl.addClass("oc-mention-popup");
      document.body.appendChild(this.popupEl);
    }
    this._reposition();
    this.popupEl.style.display = "block";
    this.updateList("");
  }

  _reposition() {
    if (!this.popupEl) return;
    const rect = this.inputEl.getBoundingClientRect();
    this.popupEl.style.position = "fixed";
    this.popupEl.style.left = rect.left + "px";
    this.popupEl.style.width = rect.width + "px";
    this.popupEl.style.bottom = (window.innerHeight - rect.top) + "px";
    this.popupEl.style.top = "";
  }

  hide() {
    this.active = false;
    this.mentionStart = -1;
    if (this.popupEl) this.popupEl.style.display = "none";
  }

  updateList(query) {
    if (!this.popupEl) return;
    this.popupEl.empty();

    const files = this.app.vault.getMarkdownFiles()
      .filter(f => !f.path.startsWith("Hermes/"))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    const q = query.toLowerCase();
    this.items = files
      .filter(f => !q || f.basename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      .slice(0, 10);

    if (this.items.length === 0) {
      this.popupEl.createDiv({ cls: "oc-mention-empty", text: "No files found" });
      return;
    }

    this.items.forEach((file, i) => {
      const item = this.popupEl.createDiv({
        cls: "oc-mention-item" + (i === this.selectedIndex ? " selected" : "")
      });
      item.createSpan({ cls: "oc-mention-name", text: file.basename });
      const pathDisplay = file.parent?.path || "";
      if (pathDisplay) item.createSpan({ cls: "oc-mention-path", text: pathDisplay });
      item.addEventListener("click", () => this.select(file));
      item.addEventListener("mouseenter", () => {
        this.selectedIndex = i;
        this.highlightSelected();
      });
    });
  }

  highlightSelected() {
    if (!this.popupEl) return;
    const children = this.popupEl.querySelectorAll(".oc-mention-item");
    children.forEach((el, i) => el.toggleClass("selected", i === this.selectedIndex));
  }

  handleKey(e) {
    if (!this.active) return false;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.items.length - 1);
      this.highlightSelected();
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.highlightSelected();
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (this.items.length > 0) {
        e.preventDefault();
        this.select(this.items[this.selectedIndex]);
        return true;
      }
    }
    if (e.key === "Escape") {
      this.hide();
      return true;
    }
    return false;
  }

  handleInput() {
    if (!this.active) return;
    const val = this.inputEl.value;
    // Hide if @ was deleted or cursor moved before it
    if (val[this.mentionStart] !== "@" || this.inputEl.selectionStart <= this.mentionStart) {
      this.hide();
      return;
    }
    const query = val.slice(this.mentionStart + 1, this.inputEl.selectionStart);
    if (query.includes(" ") && query.length > 20) { this.hide(); return; }
    this.currentQuery = query;
    this.selectedIndex = 0;
    this.updateList(query);
  }

  select(file) {
    this.onSelect(file, this.mentionStart, this.currentQuery);
    this.hide();
  }
};

// ============================================
// Workflow Command Discovery
// ============================================
function normalizeVaultFolder(path) {
  return (path || "").trim().replace(/^\/+|\/+$/g, "");
}

function workflowCommandsFromVault(app, settings) {
  try {
    const workflowFolder = normalizeVaultFolder(settings?.workflowFolder || "");
    if (!workflowFolder) return [];
    const prefix = `${workflowFolder}/`;
    return app.vault.getMarkdownFiles()
      .filter(f => f.path.startsWith(prefix))
      .map(f => {
        const base = f.basename || f.name.replace(/\.md$/i, '');
        const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return {
          command: `/workflow-${slug}`,
          label: `/workflow-${slug}`,
          description: `Run workflow: ${base}`,
          prompt: `Use the vault workflow at \`${f.path}\` for this request. First read or inspect that workflow if you have vault file access, then apply it to the selected/current Obsidian context.` ,
          isWorkflow: true
        };
      });
  } catch (e) {
    return [];
  }
}

// ============================================
// Slash Command Popup
// ============================================
var SlashCommandPopup = class {
  constructor(inputEl, plugin, onSelect) {
    this.inputEl = inputEl;
    this.plugin = plugin;
    this.onSelect = onSelect;
    this.popupEl = null;
    this.items = [];
    this.selectedIndex = 0;
    this.active = false;
  }

  show(query) {
    this.active = true;
    this.selectedIndex = 0;

    if (!this.popupEl) {
      this.popupEl = document.createElement("div");
      this.popupEl.addClass("oc-slash-popup");
      document.body.appendChild(this.popupEl);
    }
    this._reposition();
    this.popupEl.style.display = "block";
    this.updateList(query);
  }

  _reposition() {
    if (!this.popupEl) return;
    const rect = this.inputEl.getBoundingClientRect();
    this.popupEl.style.position = "fixed";
    this.popupEl.style.left = rect.left + "px";
    this.popupEl.style.width = rect.width + "px";
    this.popupEl.style.bottom = (window.innerHeight - rect.top) + "px";
    this.popupEl.style.top = "";
  }

  hide() {
    this.active = false;
    if (this.popupEl) this.popupEl.style.display = "none";
  }

  updateList(query) {
    if (!this.popupEl) return;
    this.popupEl.empty();

    const q = (query || "").toLowerCase().replace(/^\//, '');
    const userCmds = (this.plugin?.settings?.customCommands || [])
      .filter(c => c.inSlash)
      .map(c => ({
        command: "/" + c.name.toLowerCase().replace(/\s+/g, "-"),
        label: "/" + c.name.toLowerCase().replace(/\s+/g, "-"),
        description: c.name,
        prompt: c.prompt,
        isCustom: true
      }));
    const workflowCmds = workflowCommandsFromVault(this.plugin.app, this.plugin.settings);
    const allCmds = [...SLASH_COMMANDS, ...workflowCmds, ...userCmds];
    const usage = this.plugin?.settings?.commandUsage || {};
    this.items = allCmds
      .filter(c => !q || c.command.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      .sort((a, b) => (usage[b.command] || 0) - (usage[a.command] || 0));

    if (this.items.length === 0) { this.hide(); return; }

    this.items.forEach((cmd, i) => {
      const item = this.popupEl.createDiv({
        cls: "oc-slash-item" + (i === this.selectedIndex ? " selected" : "")
      });
      item.createSpan({ cls: "oc-slash-cmd", text: cmd.command });
      item.createSpan({ cls: "oc-slash-desc", text: cmd.description });
      item.addEventListener("click", () => this.select(cmd));
      item.addEventListener("mouseenter", () => {
        this.selectedIndex = i;
        this.highlightSelected();
      });
    });
  }

  highlightSelected() {
    if (!this.popupEl) return;
    const children = this.popupEl.querySelectorAll(".oc-slash-item");
    children.forEach((el, i) => el.toggleClass("selected", i === this.selectedIndex));
  }

  handleKey(e) {
    if (!this.active) return false;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.items.length - 1);
      this.highlightSelected();
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.highlightSelected();
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (this.items.length > 0) {
        e.preventDefault();
        this.select(this.items[this.selectedIndex]);
        return true;
      }
    }
    if (e.key === "Escape") {
      this.hide();
      return true;
    }
    return false;
  }

  handleInput(value) {
    if (value.startsWith('/') && !value.includes(' ') && !value.includes('\n')) {
      this.show(value);
    } else {
      this.hide();
    }
  }

  select(cmd) {
    if (this.plugin?.settings) {
      const usage = this.plugin.settings.commandUsage || {};
      usage[cmd.command] = (usage[cmd.command] || 0) + 1;
      this.plugin.settings.commandUsage = usage;
      this.plugin.saveSettings();
    }
    this.onSelect(cmd);
    this.hide();
  }
};

// ============================================
// Rename Modal
// ============================================
var RenameModal = class extends import_obsidian.Modal {
  constructor(app, currentTitle, onSubmit) {
    super(app);
    this.currentTitle = currentTitle;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    this.titleEl.setText("Rename conversation");
    const input = this.contentEl.createEl("input", {
      type: "text", value: this.currentTitle, cls: "oc-rename-input"
    });
    input.style.width = "100%";
    input.style.padding = "8px";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { this.onSubmit(input.value.trim()); this.close(); }
      if (e.key === "Escape") this.close();
    });
    const btns = this.contentEl.createDiv({ cls: "oc-confirm-buttons" });
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: "Rename", cls: "mod-cta" }).addEventListener("click", () => {
      this.onSubmit(input.value.trim()); this.close();
    });
    setTimeout(() => { input.focus(); input.select(); }, 50);
  }
  onClose() { this.contentEl.empty(); }
};

// ============================================
// Inline Edit Manager (Phase 2)
// ============================================

// Single shared StateEffect + StateField to avoid appendConfig accumulation
var inlineEditEffect = cm_state.StateEffect.define();
var inlineEditField = cm_state.StateField.define({
  create() { return cm_view.Decoration.none; },
  update(value, tr) {
    value = value.map(tr.changes);
    for (let e of tr.effects) {
      if (e.is(inlineEditEffect)) {
        value = e.value;
      }
    }
    return value;
  },
  provide(field) { return cm_view.EditorView.decorations.from(field); }
});

// Single shared effects + field for selection highlight (same pattern as inlineEditField)
var selectionHighlightShowEffect = cm_state.StateEffect.define();
var selectionHighlightHideEffect = cm_state.StateEffect.define();
var selectionHighlightField = cm_state.StateField.define({
  create() { return cm_view.Decoration.none; },
  update(value, tr) {
    value = value.map(tr.changes);
    for (let e of tr.effects) {
      if (e.is(selectionHighlightShowEffect)) {
        const builder = new cm_state.RangeSetBuilder();
        builder.add(e.value.from, e.value.to, cm_view.Decoration.mark({ class: "oc-selection-highlight" }));
        return builder.finish();
      } else if (e.is(selectionHighlightHideEffect)) {
        return cm_view.Decoration.none;
      }
    }
    return value;
  },
  provide(field) { return cm_view.EditorView.decorations.from(field); }
});

var InlineEditManager = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.activeWidget = null;
    this.activeDiff = null;
    // Register shared StateFields once for all editor views
    this.plugin.registerEditorExtension([inlineEditField, selectionHighlightField]);
  }

  getActiveEditorView() {
    const leaf = this.plugin.app.workspace.activeLeaf;
    if (!leaf || !leaf.view || !leaf.view.editor) return null;
    return leaf.view.editor.cm; // CM6 EditorView
  }

  getActiveEditor() {
    const leaf = this.plugin.app.workspace.activeLeaf;
    if (!leaf || !leaf.view || !leaf.view.editor) return null;
    return leaf.view.editor;
  }

  async triggerInlineEdit(cursorMode) {
    const editor = this.getActiveEditor();
    if (!editor) { new import_obsidian.Notice("No active editor"); return; }

    const editorView = editor.cm;
    if (!editorView) { new import_obsidian.Notice("Cannot access editor view"); return; }

    const selection = editor.getSelection();
    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (!activeFile) { new import_obsidian.Notice("No active file"); return; }

    const isInsertMode = cursorMode || !selection;
    const selectedText = selection || "";
    const cursor = editor.getCursor();

    // Create inline input widget
    this.showInlineInput(editorView, editor, selectedText, activeFile, isInsertMode, cursor);
  }

  showInlineInput(editorView, editor, selectedText, file, isInsertMode, cursor) {
    // Remove previous widget if any
    this.clearWidget();

    // Determine position
    const pos = isInsertMode
      ? editor.posToOffset(cursor)
      : editor.posToOffset(editor.getCursor("from"));

    // Create the input container as a DOM element
    const container = document.createElement("div");
    container.addClass("oc-inline-edit-container");

    const input = document.createElement("input");
    input.type = "text";
    input.addClass("oc-inline-input");
    input.placeholder = isInsertMode ? "Describe what to insert..." : "Describe how to edit...";
    container.appendChild(input);

    const spinner = document.createElement("div");
    spinner.addClass("oc-inline-spinner");
    spinner.style.display = "none";
    container.appendChild(spinner);

    const cancelBtn = document.createElement("button");
    cancelBtn.addClass("oc-inline-cancel");
    cancelBtn.textContent = "×";
    cancelBtn.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
    cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); self.clearWidget(); });
    container.appendChild(cancelBtn);

    // Create CM6 widget
    const self = this;
    const widgetDeco = cm_view.Decoration.widget({
      widget: new (class extends cm_view.WidgetType {
        toDOM() { return container; }
        ignoreEvent() { return false; }
      })(),
      side: 1,
    });

    const decoSet = cm_view.Decoration.set([widgetDeco.range(pos)]);

    editorView.dispatch({
      effects: inlineEditEffect.of(decoSet)
    });

    this.activeWidget = { container, editorView };

    // Focus input after a tick
    setTimeout(() => input.focus(), 50);

    // Handle input events — stopPropagation prevents CM6 from intercepting keystrokes
    input.addEventListener("keydown", async (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const instruction = input.value.trim();
        if (!instruction) return;
        input.style.display = "none";
        spinner.style.display = "block";

        try {
          const result = await self.callInlineAPI(selectedText, instruction, file, isInsertMode);
          self.clearWidget();
          if (result) {
            self.showDiff(editorView, editor, selectedText, result, isInsertMode, cursor);
          }
        } catch (err) {
          new import_obsidian.Notice(`Inline edit failed: ${err.message}`);
          self.clearWidget();
        }
      } else if (e.key === "Escape") {
        self.clearWidget();
      }
    });

    // Re-focus input on click (in case editor stole focus)
    container.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      setTimeout(() => input.focus(), 0);
    });
  }

  async callInlineAPI(selectedText, instruction, file, isInsertMode) {
    let systemPrompt;
    if (isInsertMode) {
      systemPrompt = `You are an editing assistant embedded in Obsidian. The user placed the cursor in "${file.path}" and requested inserted content.
Output only the text to insert, wrapped in <insertion> tags:
<insertion>inserted text</insertion>
Do not explain or add pleasantries; output only the insertion.`;
    } else {
      systemPrompt = `You are an editing assistant embedded in Obsidian. The user selected text and gave an edit instruction.
Output only the revised text, wrapped in <replacement> tags:
<replacement>revised text</replacement>
Do not explain or add pleasantries; output only the replacement.`;
    }

    let userMsg;
    if (isInsertMode) {
      userMsg = `File: ${file.path}\nInstruction: ${instruction}`;
    } else {
      userMsg = `Selected text:\n${selectedText}\n\nInstruction: ${instruction}`;
    }

    const response = await this.plugin.api.chatSync(userMsg, systemPrompt);

    // Parse response
    if (isInsertMode) {
      const match = response.match(/<insertion>([\s\S]*?)<\/insertion>/);
      return match ? match[1] : response.trim();
    } else {
      const match = response.match(/<replacement>([\s\S]*?)<\/replacement>/);
      return match ? match[1] : response.trim();
    }
  }

  showDiff(editorView, editor, originalText, newText, isInsertMode, cursor) {
    this.clearDiff();

    if (isInsertMode) {
      // For insert mode, just show the new text with accept/reject
      const pos = editor.posToOffset(cursor);
      const container = document.createElement("div");
      container.addClass("oc-inline-diff-replace");

      const insSpan = document.createElement("span");
      insSpan.addClass("oc-diff-ins");
      insSpan.textContent = newText;
      container.appendChild(insSpan);

      const buttonsDiv = document.createElement("div");
      buttonsDiv.addClass("oc-inline-diff-buttons");

      const acceptBtn = document.createElement("button");
      acceptBtn.textContent = "✓ Accept";
      acceptBtn.addClass("oc-diff-accept");
      acceptBtn.addEventListener("click", () => {
        // Insert text at cursor
        editor.replaceRange(newText, cursor);
        this.clearDiff();
      });

      const rejectBtn = document.createElement("button");
      rejectBtn.textContent = "✗ Reject";
      rejectBtn.addClass("oc-diff-reject");
      rejectBtn.addEventListener("click", () => {
        this.clearDiff();
      });

      buttonsDiv.appendChild(acceptBtn);
      buttonsDiv.appendChild(rejectBtn);
      container.appendChild(buttonsDiv);

      const widgetDeco = cm_view.Decoration.widget({
        widget: new (class extends cm_view.WidgetType {
          toDOM() { return container; }
          eq() { return true; }
          ignoreEvent() { return false; }
        })(),
        side: 1,
      });

      const decoSet = cm_view.Decoration.set([widgetDeco.range(pos)]);

      editorView.dispatch({
        effects: inlineEditEffect.of(decoSet)
      });

      this.activeDiff = { container, editorView };
    } else {
      // For replace mode, show word-level diff
      const fromPos = editor.posToOffset(editor.getCursor("from"));
      const toPos = editor.posToOffset(editor.getCursor("to"));

      const container = document.createElement("div");
      container.addClass("oc-inline-diff-replace");

      const diffOps = computeWordDiff(originalText, newText);
      const diffContent = document.createElement("div");
      diffContent.addClass("oc-diff-content");

      for (const op of diffOps) {
        if (op.type === 'same') {
          diffContent.appendChild(document.createTextNode(op.text));
        } else if (op.type === 'del') {
          const span = document.createElement("span");
          span.addClass("oc-diff-del");
          span.textContent = op.text;
          diffContent.appendChild(span);
        } else if (op.type === 'ins') {
          const span = document.createElement("span");
          span.addClass("oc-diff-ins");
          span.textContent = op.text;
          diffContent.appendChild(span);
        }
      }
      container.appendChild(diffContent);

      const buttonsDiv = document.createElement("div");
      buttonsDiv.addClass("oc-inline-diff-buttons");

      const acceptBtn = document.createElement("button");
      acceptBtn.textContent = "✓ Accept";
      acceptBtn.addClass("oc-diff-accept");
      acceptBtn.addEventListener("click", () => {
        // Replace the selected text
        const from = editor.offsetToPos(fromPos);
        const to = editor.offsetToPos(toPos);
        editor.replaceRange(newText, from, to);
        this.clearDiff();
      });

      const rejectBtn = document.createElement("button");
      rejectBtn.textContent = "✗ Reject";
      rejectBtn.addClass("oc-diff-reject");
      rejectBtn.addEventListener("click", () => {
        this.clearDiff();
      });

      buttonsDiv.appendChild(acceptBtn);
      buttonsDiv.appendChild(rejectBtn);
      container.appendChild(buttonsDiv);

      const widgetDeco = cm_view.Decoration.widget({
        widget: new (class extends cm_view.WidgetType {
          toDOM() { return container; }
          eq() { return true; }
          ignoreEvent() { return false; }
        })(),
        side: 1,
      });

      const decoSet = cm_view.Decoration.set([widgetDeco.range(fromPos)]);

      editorView.dispatch({
        effects: inlineEditEffect.of(decoSet)
      });

      this.activeDiff = { container, editorView };
    }

    // Keyboard handler for accept/reject
    const onKey = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const acceptBtn = this.activeDiff?.container?.querySelector('.oc-diff-accept');
        if (acceptBtn) acceptBtn.click();
        document.removeEventListener("keydown", onKey);
      } else if (e.key === "Escape") {
        this.clearDiff();
        document.removeEventListener("keydown", onKey);
      }
    };
    document.addEventListener("keydown", onKey);
  }

  clearWidget() {
    if (this.activeWidget) {
      try { this.activeWidget.container.remove(); } catch (e) {}
      try {
        this.activeWidget.editorView.dispatch({
          effects: inlineEditEffect.of(cm_view.Decoration.none)
        });
      } catch (e) {}
      this.activeWidget = null;
    }
  }

  clearDiff() {
    if (this.activeDiff) {
      try { this.activeDiff.container.remove(); } catch (e) {}
      try {
        this.activeDiff.editorView.dispatch({
          effects: inlineEditEffect.of(cm_view.Decoration.none)
        });
      } catch (e) {}
      this.activeDiff = null;
    }
  }
};

// ============================================
// Main Chat View (v3.0)
// ============================================

var TEXTAREA_MIN_MAX_HEIGHT = 150;
var TEXTAREA_MAX_HEIGHT_PERCENT = 0.55;
var HERMES_VIEW_TYPE = "hermes-chat-view";

var HermesView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.activeConvId = null;
    this.isStreaming = false;
    this.abortController = null;
    this.autoScrollEnabled = true;
    this.streamingEl = null;
    this.streamingContentEl = null;
    this.thinkingEl = null;
    this.thinkingContentEl = null;
    this.mentionPopup = null;
    this.slashPopup = null;
    this.attachedFiles = []; // files attached via @
    this.attachedTextFiles = []; // non-vault files attached via button
    this.pastedImages = []; // images pasted/dropped
    this.selectionCheckInterval = null;
    this.storedSelection = null; // { notePath, selectedText, lineCount, startLine, from, to, editorView }
    this.inputHandoffGraceUntil = null;
    this.inputHistory = [];
    this.inputHistoryIndex = -1;
    this.inputDraft = "";
  }

  getViewType() { return HERMES_VIEW_TYPE; }
  getDisplayText() { return "Hermes"; }
  getIcon() { return "hermes-caduceus"; }

  onClose() {
    if (this.slashPopup?.popupEl) this.slashPopup.popupEl.remove();
    if (this.mentionPopup?.popupEl) this.mentionPopup.popupEl.remove();
  }

  async onOpen() {
    try { await this._onOpen(); }
    catch (e) {
      console.error("Hermes onOpen failed:", e);
      const container = this.containerEl.children[1];
      container.empty();
      container.createEl("p", { text: "\u274C Hermes failed to load: " + (e.message || e) });
      container.createEl("p", { text: "Check developer console (Ctrl+Shift+I) for details." });
    }
  }

  async _onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("hermes-container");

    // ---- Header ----
    const header = container.createDiv({ cls: "oc-header" });
    this.tabBarEl = header.createDiv({ cls: "oc-tab-bar" });
    const actions = header.createDiv({ cls: "oc-header-actions" });

    const clearBtn = actions.createEl("button", { cls: "oc-header-btn", attr: { "aria-label": "Delete Chat" } });
    setIconSafe(clearBtn, "trash-2");
    clearBtn.addEventListener("click", () => this.deleteCurrentConversation());

    // ---- Messages ----
    const messagesWrapper = container.createDiv({ cls: "oc-messages-wrapper" });
    this.messagesEl = messagesWrapper.createDiv({ cls: "oc-messages" });

    // Scroll to top button
    this.scrollTopBtnEl = messagesWrapper.createDiv({ cls: "oc-scroll-btn oc-scroll-top" });
    setIconSafe(this.scrollTopBtnEl, "chevron-up");
    this.scrollTopBtnEl.addEventListener("click", () => {
      this.messagesEl.scrollTo({ top: 0, behavior: "smooth" });
    });

    // Scroll to bottom button
    this.scrollBtnEl = messagesWrapper.createDiv({ cls: "oc-scroll-btn" });
    setIconSafe(this.scrollBtnEl, "chevron-down");
    this.scrollBtnEl.addEventListener("click", () => this.scrollToBottom());

    this.messagesEl.addEventListener("scroll", () => {
      const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
      const atBottom = scrollHeight - scrollTop - clientHeight < 30;
      const atTop = scrollTop < 30;
      this.autoScrollEnabled = atBottom;
      this.scrollBtnEl.toggleClass("visible", !atBottom);
      this.scrollTopBtnEl.toggleClass("visible", !atTop);
    });

    // ---- Input ----
    const inputContainer = container.createDiv({ cls: "oc-input-container" });
    const inputWrapper = inputContainer.createDiv({ cls: "oc-input-wrapper" });

    // Context row (attached files + images + selection)
    this.contextRowEl = inputWrapper.createDiv({ cls: "oc-context-row" });

    // Textarea
    this.inputEl = inputWrapper.createEl("textarea", {
      cls: "oc-input",
      attr: { placeholder: "Message Hermes... (@ to mention files, / for commands)", rows: "1" }
    });

    this.inputEl.addEventListener("input", () => {
      this.autoResizeInput();
      if (this.mentionPopup) this.mentionPopup.handleInput();
      // Slash command detection
      if (this.slashPopup) this.slashPopup.handleInput(this.inputEl.value);
    });

    // @ mention support
    this.mentionPopup = new FileMentionPopup(this.app, this.inputEl, (file, mentionStart, query) => {
      const val = this.inputEl.value;
      // Remove the @query text entirely — file is shown as a chip instead
      const queryEnd = mentionStart + 1 + query.length;
      const before = val.slice(0, mentionStart);
      const after = val.slice(queryEnd);
      this.inputEl.value = before + after;
      this.inputEl.selectionStart = this.inputEl.selectionEnd = before.length;
      this.autoResizeInput();
      this.inputEl.focus();
      if (!this.attachedFiles.find(f => f.path === file.path)) {
        this.attachedFiles.push(file);
        this.updateContextRow();
      }
    });

    // Slash command popup
    this.slashPopup = new SlashCommandPopup(this.inputEl, this.plugin, (cmd) => {
      if (cmd.isCustom || cmd.isWorkflow || cmd.prompt) {
        const sel = this.storedSelection?.selectedText || "";
        this.inputEl.value = (cmd.prompt || cmd.command).replace(/\{\{text\}\}/g, sel);
      } else {
        this.inputEl.value = cmd.command + " ";
      }
      this.autoResizeInput();
      this.inputEl.focus();
      this.inputEl.selectionStart = this.inputEl.selectionEnd = this.inputEl.value.length;
    });

    this.inputEl.addEventListener("keydown", (e) => {
      // Slash popup handling
      if (this.slashPopup && this.slashPopup.handleKey(e)) return;
      // @ mention popup handling
      if (this.mentionPopup && this.mentionPopup.handleKey(e)) return;

      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.sendMessage();
        return;
      }

      // Input history navigation (ArrowUp/Down, only when on first/last line)
      if (e.key === "ArrowUp" && !e.shiftKey && this.inputHistory.length > 0) {
        const val = this.inputEl.value;
        const cursor = this.inputEl.selectionStart;
        const onFirstLine = val.indexOf("\n") === -1 || cursor <= val.indexOf("\n");
        if (onFirstLine) {
          e.preventDefault();
          if (this.inputHistoryIndex === -1) this.inputDraft = val;
          this.inputHistoryIndex = Math.min(this.inputHistoryIndex + 1, this.inputHistory.length - 1);
          this.inputEl.value = this.inputHistory[this.inputHistoryIndex];
          this.autoResizeInput();
          this.inputEl.selectionStart = this.inputEl.selectionEnd = this.inputEl.value.length;
        }
        return;
      }
      if (e.key === "ArrowDown" && !e.shiftKey && this.inputHistoryIndex > -1) {
        const val = this.inputEl.value;
        const cursor = this.inputEl.selectionStart;
        const onLastLine = val.lastIndexOf("\n") === -1 || cursor > val.lastIndexOf("\n");
        if (onLastLine) {
          e.preventDefault();
          this.inputHistoryIndex--;
          this.inputEl.value = this.inputHistoryIndex === -1 ? this.inputDraft : this.inputHistory[this.inputHistoryIndex];
          this.autoResizeInput();
          this.inputEl.selectionStart = this.inputEl.selectionEnd = this.inputEl.value.length;
        }
      }
    });

    // Detect @ trigger
    this.inputEl.addEventListener("keyup", (e) => {
      if (e.key === "@" || e.key === "Process") {
        const pos = this.inputEl.selectionStart - 1;
        const val = this.inputEl.value;
        if (pos >= 0 && val[pos] === "@" && (pos === 0 || val[pos - 1] === " " || val[pos - 1] === "\n")) {
          this.mentionPopup.show(pos);
        }
      }
    });

    // Image paste
    this.inputEl.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (blob) this.addPastedImage(blob);
          return;
        }
      }
    });

    // Image drag & drop
    inputWrapper.addEventListener("dragover", (e) => {
      e.preventDefault();
      inputWrapper.addClass("drag-over");
    });
    inputWrapper.addEventListener("dragleave", () => inputWrapper.removeClass("drag-over"));
    inputWrapper.addEventListener("drop", (e) => {
      e.preventDefault();
      inputWrapper.removeClass("drag-over");
      const files = e.dataTransfer?.files;
      if (!files) return;
      for (const file of files) {
        if (file.type.startsWith("image/")) this.addPastedImage(file);
      }
    });

    // Toolbar
    const toolbar = inputWrapper.createDiv({ cls: "oc-input-toolbar" });
    const toolbarLeft = toolbar.createDiv({ cls: "oc-toolbar-left" });

    // Include current note toggle
    this.noteToggleBtn = toolbarLeft.createEl("button", {
      cls: "oc-toolbar-btn" + (this.plugin.settings.includeCurrentNote ? " active" : ""),
      attr: { "aria-label": "Include current note" }
    });
    setIconSafe(this.noteToggleBtn, "file-text");
    this.noteToggleBtn.addEventListener("click", () => {
      this.plugin.settings.includeCurrentNote = !this.plugin.settings.includeCurrentNote;
      this.noteToggleBtn.toggleClass("active", this.plugin.settings.includeCurrentNote);
      this.plugin.saveSettings();
      this.updateContextRow();
    });

    // Image attach button
    const attachBtn = toolbarLeft.createEl("button", {
      cls: "oc-toolbar-btn",
      attr: { "aria-label": "Attach file" }
    });
    setIconSafe(attachBtn, "paperclip");
    attachBtn.addEventListener("click", () => {
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/*,text/*,.md,.txt,.csv,.json,.pdf";
      fileInput.multiple = true;
      fileInput.addEventListener("change", () => {
        if (!fileInput.files) return;
        for (const f of fileInput.files) {
          if (f.type.startsWith("image/")) {
            // Images → base64 preview (existing path)
            this.addPastedImage(f);
          } else {
            // Text/other files → read content and append to context
            const reader = new FileReader();
            reader.onload = () => {
              const content = reader.result;
              if (!this.attachedTextFiles) this.attachedTextFiles = [];
              this.attachedTextFiles.push({ name: f.name, content });
              this.updateContextRow();
            };
            reader.readAsText(f);
          }
        }
      });
      fileInput.click();
    });

    const toolbarRight = toolbar.createDiv({ cls: "oc-toolbar-right" });

    toolbarRight.createDiv({ cls: "oc-send-hint", text: "Enter \u2192 send \u00B7 @ files \u00B7 / cmds" });

    // Model selector dropdown — from settings only (no auto-fetch, /v1/models returns agents not LLMs)
    const modelSelect = toolbarRight.createEl("select", { cls: "oc-model-select" });
    this.modelSelectEl = modelSelect;
    const defaultOpt = modelSelect.createEl("option", { text: "Default \u2728", attr: { value: "" } });
    defaultOpt.selected = true;
    for (const m of (this.plugin.settings.customModels || [])) {
      if (m.value && m.label) {
        modelSelect.createEl("option", { text: m.label, attr: { value: m.value } });
      }
    }
    modelSelect.addEventListener("change", async () => {
      const selectedValue = modelSelect.value;
      const selectedLabel = modelSelect.options[modelSelect.selectedIndex].text;
      if (!this.isStreaming) {
        this.inputEl.value = selectedValue ? `/model ${selectedValue}` : `/model default`;
        await this.sendMessage();
        // Persist model per-conversation
        const conv = this.plugin.conversationStore.getConversation(this.activeConvId);
        if (conv) {
          conv.model = selectedValue;
          this.plugin.conversationStore.saveConversation(this.activeConvId);
        }
        new import_obsidian.Notice(`Switching to ${selectedLabel}...`);
      } else {
        new import_obsidian.Notice("Wait for response to finish");
        const conv = this.plugin.conversationStore.getConversation(this.activeConvId);
        modelSelect.value = conv?.model || "";
      }
    });

    // Stop button (visible during streaming)
    this.stopBtn = toolbarRight.createEl("button", {
      cls: "oc-toolbar-btn oc-stop-btn",
      attr: { "aria-label": "Stop generating" }
    });
    setIconSafe(this.stopBtn, "square");
    this.stopBtn.style.display = "none";
    this.stopBtn.addEventListener("click", () => {
      if (this.abortController) this.abortController.abort();
    });

    // ---- Initialize ----
    await this.plugin.conversationStore.loadAll();
    const convs = this.plugin.conversationStore.getAllConversations();
    if (convs.length === 0) {
      this.newConversation();
    } else {
      // Restore all conversations as tabs (sorted by updatedAt desc)
      const allIds = convs.map(c => c.id);
      const tabState = this.plugin.settings._tabState;
      // Put previously open tabs first (preserving order), then append any new ones
      const prevTabs = (tabState?.tabs || []).filter(id => allIds.includes(id));
      const remaining = allIds.filter(id => !prevTabs.includes(id));
      this.openTabs = [...prevTabs, ...remaining];
      if (this.openTabs.length === 0) this.openTabs = [convs[0].id];
      const activeId = tabState?.activeId;
      this.switchToConversation(this.openTabs.includes(activeId) ? activeId : this.openTabs[0]);
    }

    this.updateContextRow();
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateContextRow()));

    // Start selection auto-detection (Phase 1, item 4)
    this.startSelectionDetection();
  }

  async onClose() {
    this.stopSelectionDetection();
    if (this.openTabs) {
      this.plugin.settings._tabState = { tabs: this.openTabs, activeId: this.activeConvId };
      await this.plugin.saveSettings();
    }
  }

  // ---- Selection Controller (Hermes-style) ----

  startSelectionDetection() {
    // Grace period: clicking chat panel gives 1.5s before clearing selection
    this._pointerDownHandler = () => {
      if (this.storedSelection) {
        this.inputHandoffGraceUntil = Date.now() + 1500;
      }
    };
    this.containerEl.addEventListener("pointerdown", this._pointerDownHandler);

    this.selectionCheckInterval = setInterval(() => this._pollSelection(), 250);
  }

  stopSelectionDetection() {
    if (this.selectionCheckInterval) {
      clearInterval(this.selectionCheckInterval);
      this.selectionCheckInterval = null;
    }
    if (this._pointerDownHandler) {
      this.containerEl.removeEventListener("pointerdown", this._pointerDownHandler);
    }
    this._clearSelectionHighlight();
    this.storedSelection = null;
  }

  _pollSelection() {
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view || !view.editor) {
      this._handleDeselection();
      return;
    }
    const editor = view.editor;
    // Get CM6 EditorView
    let editorView = null;
    try { editorView = editor.cm; } catch (e) {}

    const selectedText = editor.getSelection();
    if (selectedText && selectedText.trim()) {
      this.inputHandoffGraceUntil = null;
      const fromPos = editor.getCursor("from");
      const toPos = editor.getCursor("to");
      const from = editor.posToOffset(fromPos);
      const to = editor.posToOffset(toPos);
      const startLine = fromPos.line + 1;
      const notePath = (view.file && view.file.path) || "unknown";
      const lineCount = selectedText.split(/\r?\n/).length;

      const s = this.storedSelection;
      const sameRange = s && s.editorView === editorView && s.from === from && s.to === to && s.notePath === notePath;
      const unchanged = sameRange && s.selectedText === selectedText;
      if (!unchanged) {
        if (s && !sameRange) this._clearSelectionHighlight();
        this.storedSelection = { notePath, selectedText, lineCount, startLine, from, to, editorView };
        this.updateContextRow();
      }
    } else {
      this._handleDeselection();
    }
  }

  _isFocusInChatPanel() {
    const activeEl = document.activeElement;
    return activeEl && this.containerEl && this.containerEl.contains(activeEl);
  }

  _handleDeselection() {
    if (!this.storedSelection) return;
    // Don't clear if focus is in chat panel
    if (this._isFocusInChatPanel()) {
      this.inputHandoffGraceUntil = null;
      return;
    }
    // Don't clear during grace period
    if (this.inputHandoffGraceUntil && Date.now() <= this.inputHandoffGraceUntil) {
      return;
    }
    this.inputHandoffGraceUntil = null;
    this._clearSelectionHighlight();
    this.storedSelection = null;
    this.updateContextRow();
  }

  // CM6 decoration-based highlight (persists after focus change)
  _showSelectionHighlight() {
    const sel = this.storedSelection;
    if (!sel || !sel.editorView || sel.from === undefined || sel.to === undefined) return;
    try {
      sel.editorView.dispatch({ effects: selectionHighlightShowEffect.of({ from: sel.from, to: sel.to }) });
    } catch (e) {}
  }

  _clearSelectionHighlight() {
    const sel = this.storedSelection;
    if (!sel || !sel.editorView) return;
    try {
      sel.editorView.dispatch({ effects: selectionHighlightHideEffect.of(null) });
    } catch (e) {}
  }

  _getSelectionContext() {
    if (!this.storedSelection) return null;
    return {
      notePath: this.storedSelection.notePath,
      selectedText: this.storedSelection.selectedText,
      lineCount: this.storedSelection.lineCount,
      startLine: this.storedSelection.startLine
    };
  }

  _clearSelection() {
    this._clearSelectionHighlight();
    this.inputHandoffGraceUntil = null;
    this.storedSelection = null;
    this.updateContextRow();
  }

  getActiveEditor() {
    const leaf = this.app.workspace.activeLeaf;
    if (!leaf || !leaf.view || !leaf.view.editor) return null;
    return leaf.view.editor;
  }

  // ---- Image Handling ----

  async addPastedImage(blob) {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result;
      this.pastedImages.push({ data: base64, name: blob.name || `image-${Date.now()}.png`, type: blob.type });
      this.updateContextRow();
    };
    reader.readAsDataURL(blob);
  }

  showLightbox(src) {
    const overlay = document.createElement("div");
    overlay.addClass("oc-lightbox");
    const img = overlay.createEl("img", { attr: { src } });
    overlay.addEventListener("click", () => overlay.remove());
    document.body.appendChild(overlay);
    const onKey = (e) => { if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);
  }

  // ---- Tab Management ----

  get openTabs() { return this._openTabs || []; }
  set openTabs(val) { this._openTabs = val; }

  renderTabs() {
    this.tabBarEl.empty();

    // New Chat button
    const newBtn = this.tabBarEl.createDiv({ cls: "oc-tab-new", attr: { title: "New Chat" } });
    newBtn.createSpan({ text: "+" });
    newBtn.addEventListener("click", () => this.newConversation());

    // Current conversation title (clickable dropdown trigger)
    const activeConv = this.plugin.conversationStore.getConversation(this.activeConvId);
    const titleBtn = this.tabBarEl.createDiv({ cls: "oc-tab-title" });
    const titleLabel = activeConv ? (activeConv.title.length > 24 ? activeConv.title.slice(0, 24) + "\u2026" : activeConv.title) : "New Chat";
    titleBtn.createSpan({ text: titleLabel });
    titleBtn.createSpan({ cls: "oc-tab-arrow", text: "\u25BE" });
    if (this.isStreaming) titleBtn.addClass("streaming");

    titleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleConversationList();
    });

    // Right-click on title for rename/delete
    titleBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!activeConv) return;
      const menu = new import_obsidian.Menu();
      menu.addItem(item => item.setTitle("Rename").setIcon("pencil").onClick(() => {
        new RenameModal(this.app, activeConv.title, (newTitle) => {
          if (newTitle) {
            this.plugin.conversationStore.updateTitle(this.activeConvId, newTitle);
            this.plugin.conversationStore.saveConversation(this.activeConvId);
            this.renderTabs();
          }
        }).open();
      }));
      menu.addSeparator();
      menu.addItem(item => item.setTitle("Delete").setIcon("trash").onClick(() => {
        this.deleteConversation(this.activeConvId);
      }));
      menu.showAtMouseEvent(e);
    });
  }

  toggleConversationList() {
    // Remove existing dropdown if open
    const existing = this.tabBarEl.parentElement.querySelector('.oc-conv-dropdown');
    if (existing) { existing.remove(); return; }

    const allConvs = this.plugin.conversationStore.getAllConversations();
    const header = this.tabBarEl.parentElement;
    header.style.position = 'relative';
    const dropdown = header.createDiv({ cls: "oc-conv-dropdown" });

    for (const conv of allConvs) {
      const item = dropdown.createDiv({ cls: "oc-conv-item" + (conv.id === this.activeConvId ? " active" : "") });

      const info = item.createDiv({ cls: "oc-conv-info" });
      const title = conv.title.length > 30 ? conv.title.slice(0, 30) + "\u2026" : conv.title;
      info.createDiv({ cls: "oc-conv-title", text: title });
      const date = new Date(conv.updatedAt);
      const dateStr = `${date.getMonth()+1}/${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
      const msgCount = conv.messages ? conv.messages.length : 0;
      info.createDiv({ cls: "oc-conv-meta", text: `${dateStr} \u00B7 ${msgCount} msgs` });

      item.addEventListener("click", () => {
        dropdown.remove();
        if (!this.openTabs.includes(conv.id)) this.openTabs = [...this.openTabs, conv.id];
        this.switchToConversation(conv.id);
      });

      // Right-click for rename/delete
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const menu = new import_obsidian.Menu();
        menu.addItem(i => i.setTitle("Rename").setIcon("pencil").onClick(() => {
          new RenameModal(this.app, conv.title, (newTitle) => {
            if (newTitle) {
              this.plugin.conversationStore.updateTitle(conv.id, newTitle);
              this.plugin.conversationStore.saveConversation(conv.id);
              dropdown.remove();
              this.renderTabs();
            }
          }).open();
        }));
        menu.addSeparator();
        menu.addItem(i => i.setTitle("Delete").setIcon("trash").onClick(() => {
          dropdown.remove();
          this.deleteConversation(conv.id);
        }));
        menu.showAtMouseEvent(e);
      });
    }

    // Close dropdown on outside click or Escape
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target) && !this.tabBarEl.contains(e.target)) {
        dropdown.remove();
        document.removeEventListener("click", closeHandler);
        document.removeEventListener("keydown", escHandler);
      }
    };
    const escHandler = (e) => {
      if (e.key === "Escape") {
        dropdown.remove();
        document.removeEventListener("click", closeHandler);
        document.removeEventListener("keydown", escHandler);
      }
    };
    setTimeout(() => {
      document.addEventListener("click", closeHandler);
      document.addEventListener("keydown", escHandler);
    }, 0);
  }

  newConversation() {
    const conv = this.plugin.conversationStore.createConversation();
    this.openTabs = [...this.openTabs, conv.id];
    this.switchToConversation(conv.id);
  }

  closeTab(convId) {
    if (this.openTabs.length <= 1) return;
    const idx = this.openTabs.indexOf(convId);
    this.openTabs = this.openTabs.filter(id => id !== convId);
    if (this.activeConvId === convId) {
      this.switchToConversation(this.openTabs[Math.min(idx, this.openTabs.length - 1)]);
    } else {
      this.renderTabs();
    }
  }

  async deleteConversation(convId) {
    const conv = this.plugin.conversationStore.getConversation(convId);
    if (!conv) return;
    if (conv.messages.length > 0) {
      const confirmed = await new Promise(resolve => {
        const modal = new import_obsidian.Modal(this.app);
        modal.titleEl.setText("Delete conversation?");
        modal.contentEl.setText(`"${conv.title}" (${conv.messages.length} messages)`);
        const btns = modal.contentEl.createDiv({ cls: "oc-confirm-buttons" });
        btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => { resolve(false); modal.close(); });
        btns.createEl("button", { text: "Delete", cls: "mod-warning" }).addEventListener("click", () => { resolve(true); modal.close(); });
        modal.open();
      });
      if (!confirmed) return;
    }
    this.plugin.conversationStore.deleteConversation(convId);
    if (this.openTabs.includes(convId)) {
      this.closeTab(convId);
    }
    if (this.openTabs.length === 0) this.newConversation();
  }

  async deleteCurrentConversation() {
    if (this.activeConvId) await this.deleteConversation(this.activeConvId);
  }

  switchToConversation(convId) {
    this.activeConvId = convId;
    if (!this.openTabs.includes(convId)) this.openTabs = [...this.openTabs, convId];
    this.renderTabs();
    this.renderMessages();
    // Restore per-conversation model in dropdown
    if (this.modelSelectEl) {
      const conv = this.plugin.conversationStore.getConversation(convId);
      this.modelSelectEl.value = conv?.model || "";
    }
    // Persist tab state immediately so restart recovers correctly
    this.plugin.settings._tabState = { tabs: this.openTabs, activeId: this.activeConvId };
    this.plugin.saveSettings();
  }

  // ---- Message Rendering ----

  renderMessages() {
    this.messagesEl.empty();
    const conv = this.plugin.conversationStore.getConversation(this.activeConvId);
    if (!conv || conv.messages.length === 0) {
      const welcome = this.messagesEl.createDiv({ cls: "oc-welcome" });
      const greeting = welcome.createDiv({ cls: "oc-welcome-greeting" });
      const welcomeIcon = greeting.createSpan({ cls: "oc-welcome-icon" });
      welcomeIcon.innerHTML = HERMES_WELCOME_ICON;
      greeting.createSpan({ text: "Hey there" });
      welcome.createDiv({ cls: "oc-welcome-hint", text: "Enter to send \u00B7 @ to attach files \u00B7 / for commands \u00B7 paste images" });
      return;
    }
    for (let i = 0; i < conv.messages.length; i++) {
      const msg = conv.messages[i];
      this.appendMessageEl(msg.role, msg.content, i, msg.thinking);
    }
    this.scrollToBottom();
  }

  appendMessageEl(role, content, msgIndex, thinking) {
    // Hide welcome screen when first message appears
    const welcome = this.messagesEl.querySelector(".oc-welcome");
    if (welcome) welcome.remove();

    const msgEl = this.messagesEl.createDiv({ cls: `oc-message oc-message-${role}` });

    // User messages: body wrapper for Gemini-style flex layout (content left, actions right)
    const msgBodyEl = role === "user" ? msgEl.createDiv({ cls: "oc-message-body" }) : msgEl;

    // Role label (assistant only — user messages are visually distinct via alignment + background)
    if (role === "assistant") {
      const roleLabel = msgEl.createDiv({ cls: "oc-role-label" });
      const roleIcon = roleLabel.createSpan({ cls: "oc-role-icon" });
      roleIcon.innerHTML = HERMES_ICON;
      roleLabel.createSpan({ text: "Hermes" });
    } else if (role === "user") {
      // Render images ABOVE user message bubble (Hermes-style)
      const conv = this.plugin.conversationStore.getConversation(this.activeConvId);
      if (conv && typeof msgIndex === "number") {
        const msg = conv.messages[msgIndex];
        if (msg && msg.images && msg.images.length > 0) {
          const imagesEl = msgBodyEl.createDiv({ cls: "oc-message-images" });
          for (const imgData of msg.images) {
            const imgWrap = imagesEl.createDiv({ cls: "oc-message-image" });
            imgWrap.createEl("img", { attr: { src: imgData } });
            imgWrap.addEventListener("click", () => this.showLightbox(imgData));
          }
        }
      }
    }

    // Thinking block (collapsible)
    if (thinking && role === "assistant") {
      const thinkWrap = msgEl.createDiv({ cls: "oc-thinking" });
      const thinkHeader = thinkWrap.createDiv({ cls: "oc-thinking-header" });
      const thBrainIcon = thinkHeader.createSpan({ cls: "oc-think-icon" });
      setIconSafe(thBrainIcon, "brain", "12");
      thinkHeader.createSpan({ text: "Thinking" });
      const thChevron = thinkHeader.createSpan({ cls: "oc-think-chevron" });
      setIconSafe(thChevron, "chevron-right", "12");
      const thinkBody = thinkWrap.createDiv({ cls: "oc-thinking-body" });
      thinkBody.style.display = "none";
      thinkBody.setText(thinking);
      let expanded = false;
      thinkHeader.addEventListener("click", () => {
        expanded = !expanded;
        thinkBody.style.display = expanded ? "block" : "none";
        thinkHeader.toggleClass("expanded", expanded);
      });
    }

    const contentEl = msgBodyEl.createDiv({ cls: "oc-message-content" });

    if (role === "assistant") {
      import_obsidian.MarkdownRenderer.render(this.app, content, contentEl, "", this.plugin);
    } else if (role === "error") {
      contentEl.createEl("code").setText(content);
    } else {
      const lines = content.split("\n");
      lines.forEach((line, i) => { contentEl.appendText(line); if (i < lines.length - 1) contentEl.createEl("br"); });
    }

    // Message actions — Hermes style: small icon row, right-aligned
    if (role === "assistant" || role === "user") {
      const actionsEl = msgEl.createDiv({ cls: "oc-message-actions" });

      if (role === "user" && typeof msgIndex === "number") {
        // Edit & resend — inline editing
        const editBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Edit & resend" } });
        setIconSafe(editBtn, "pencil");
        editBtn.addEventListener("click", () => {
          if (this.isStreaming) return;
          // Replace message content with inline textarea
          const contentEl = msgEl.querySelector(".oc-message-content");
          if (!contentEl || msgEl.querySelector(".oc-inline-edit-textarea")) return;

          const originalHTML = contentEl.innerHTML;
          contentEl.empty();

          const textarea = contentEl.createEl("textarea", { cls: "oc-inline-edit-textarea" });
          textarea.value = content;
          textarea.rows = Math.min(content.split("\n").length + 1, 10);
          setTimeout(() => { textarea.focus(); textarea.selectionStart = textarea.selectionEnd = textarea.value.length; }, 0);

          const btnRow = msgEl.createDiv({ cls: "oc-inline-edit-btnrow" });
          const cancelBtn = btnRow.createEl("button", { cls: "oc-inline-edit-cancel-btn", text: "Cancel" });
          const confirmBtn = btnRow.createEl("button", { cls: "oc-inline-edit-confirm", text: "Send" });

          confirmBtn.addEventListener("click", () => {
            const newContent = textarea.value.trim();
            if (!newContent) return;
            this.plugin.conversationStore.truncateFrom(this.activeConvId, msgIndex);
            this.renderMessages();
            this._doSend(newContent, false);
          });

          cancelBtn.addEventListener("click", () => {
            contentEl.innerHTML = originalHTML;
            btnRow.remove();
          });

          textarea.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); confirmBtn.click(); }
            if (e.key === "Escape") { cancelBtn.click(); }
          });
        });
      }

      if (role === "assistant" && typeof msgIndex === "number") {
        // Regenerate
        const regenBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Regenerate" } });
        setIconSafe(regenBtn, "refresh-cw");
        regenBtn.addEventListener("click", () => {
          this.plugin.conversationStore.truncateFrom(this.activeConvId, msgIndex);
          this.renderMessages();
          this.resendLastUserMessage();
        });
      }

      // Copy (always last)
      const copyBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Copy" } });
      setIconSafe(copyBtn, "copy");
      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(content);
        setIconSafe(copyBtn, "check");
        copyBtn.addClass("copied");
        setTimeout(() => { setIconSafe(copyBtn, "copy"); copyBtn.removeClass("copied"); }, 1500);
      });
    }

    if (this.autoScrollEnabled) this.scrollToBottom();
    return msgEl;
  }

  // ---- Streaming Message ----

  startStreamingMessage() {
    this.streamingEl = this.messagesEl.createDiv({ cls: "oc-message oc-message-assistant" });

    this.thinkingEl = this.streamingEl.createDiv({ cls: "oc-thinking streaming" });
    this.thinkingHeaderEl = this.thinkingEl.createDiv({ cls: "oc-thinking-header expanded" });
    const stBrainIcon = this.thinkingHeaderEl.createSpan({ cls: "oc-think-icon" });
    setIconSafe(stBrainIcon, "brain", "12");
    this.thinkingHeaderEl.createSpan({ text: "Thinking..." });
    this.thinkingContentEl = this.thinkingEl.createDiv({ cls: "oc-thinking-body" });
    this.thinkingContentEl.style.display = "block";
    this.thinkingEl.style.display = "none";

    this.streamingContentEl = this.streamingEl.createDiv({ cls: "oc-message-content" });

    const loadingEl = this.streamingContentEl.createDiv({ cls: "oc-loading" });
    const dots = loadingEl.createDiv({ cls: "oc-loading-dots" });
    dots.createEl("span"); dots.createEl("span"); dots.createEl("span");

    this.scrollToBottom();
  }

  updateThinking(thinkingText) {
    if (!this.thinkingEl || !this.thinkingContentEl) return;
    this.thinkingEl.style.display = "block";
    this.thinkingContentEl.setText(thinkingText);
    if (this.autoScrollEnabled) this.scrollToBottom();
  }

  updateStreamingMessage(fullText) {
    if (!this.streamingContentEl) return;
    if (this.plugin.settings.streamMarkdown) {
      this.streamingContentEl.empty();
      import_obsidian.MarkdownRenderer.render(this.app, fullText, this.streamingContentEl, "", this.plugin);
    } else {
      this.streamingContentEl.textContent = fullText;
    }
    if (this.autoScrollEnabled) this.scrollToBottom();
  }

  finalizeStreamingMessage(fullText, thinkingText) {
    if (!this.streamingEl || !this.streamingContentEl) return;

    // Finalize thinking block
    if (thinkingText && this.thinkingEl) {
      this.thinkingEl.removeClass("streaming");
      this.thinkingHeaderEl.empty();
      const fBrainIcon = this.thinkingHeaderEl.createSpan({ cls: "oc-think-icon" });
      setIconSafe(fBrainIcon, "brain", "12");
      this.thinkingHeaderEl.createSpan({ text: "Thinking" });
      const fChevron = this.thinkingHeaderEl.createSpan({ cls: "oc-think-chevron" });
      setIconSafe(fChevron, "chevron-right", "12");
      this.thinkingContentEl.style.display = "none";
      this.thinkingHeaderEl.removeClass("expanded");
      let expanded = false;
      this.thinkingHeaderEl.addEventListener("click", () => {
        expanded = !expanded;
        this.thinkingContentEl.style.display = expanded ? "block" : "none";
        this.thinkingHeaderEl.toggleClass("expanded", expanded);
      });
    } else if (this.thinkingEl) {
      this.thinkingEl.remove();
    }

    // Re-render final content
    this.streamingContentEl.empty();
    import_obsidian.MarkdownRenderer.render(this.app, fullText, this.streamingContentEl, "", this.plugin);

    // Add action buttons — Hermes style: regenerate, then copy
    const actionsEl = this.streamingEl.createDiv({ cls: "oc-message-actions" });

    const regenBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Regenerate" } });
    setIconSafe(regenBtn, "refresh-cw");
    regenBtn.addEventListener("click", () => {
      const conv = this.plugin.conversationStore.getConversation(this.activeConvId);
      if (conv) {
        const idx = conv.messages.length - 1;
        this.plugin.conversationStore.truncateFrom(this.activeConvId, idx);
        this.renderMessages();
        this.resendLastUserMessage();
      }
    });

    const copyBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Copy" } });
    setIconSafe(copyBtn, "copy");
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(fullText);
      setIconSafe(copyBtn, "check");
      copyBtn.addClass("copied");
      setTimeout(() => { setIconSafe(copyBtn, "copy"); copyBtn.removeClass("copied"); }, 1500);
    });

    this.streamingEl = null;
    this.streamingContentEl = null;
    this.thinkingEl = null;
    this.thinkingHeaderEl = null;
    this.thinkingContentEl = null;
  }

  // ---- Send Message ----

  async resendLastUserMessage() {
    const conv = this.plugin.conversationStore.getConversation(this.activeConvId);
    if (!conv || conv.messages.length === 0) return;
    const lastUser = [...conv.messages].reverse().find(m => m.role === "user");
    if (!lastUser) return;
    await this._doSend(lastUser.content, true);
  }

  async sendMessage() {
    const content = this.inputEl.value.trim();
    if (!content || this.isStreaming) return;
    // Save to input history (newest first, max 50)
    if (this.inputHistory[0] !== content) {
      this.inputHistory.unshift(content);
      if (this.inputHistory.length > 50) this.inputHistory.pop();
    }
    this.inputHistoryIndex = -1;
    this.inputDraft = "";
    this.inputEl.value = "";
    this.autoResizeInput();
    await this._doSend(content, false);
  }

  async _compact() {
    const convId = this.activeConvId;
    const conv = this.plugin.conversationStore.getConversation(convId);
    if (!conv || conv.messages.length < 2) {
      new import_obsidian.Notice("Not enough conversation history to compact");
      return;
    }
    new import_obsidian.Notice("Compacting conversation history...");
    try {
      const history = conv.messages.map(m => `${m.role === "user" ? "User" : "AI"}：${m.content}`).join("\n\n");
      const summary = await this.plugin.api.chatSync(
        `Summarize the following conversation concisely. Preserve key information, decisions, and conclusions. Remove small talk and repetition:\n\n${history}`,
        "You are a conversation compactor. Output only the summary, without a prefix or explanation."
      );
      // Replace all messages with a single summary message
      conv.messages = [
        { role: "user", content: "[Conversation compacted]", timestamp: Date.now() },
        { role: "assistant", content: `**Conversation Summary**\n\n${summary}`, timestamp: Date.now() }
      ];
      conv.updatedAt = Date.now();
      await this.plugin.conversationStore.saveConversation(convId);
      this.renderMessages();
      new import_obsidian.Notice("✓ Conversation compacted");
    } catch (err) {
      new import_obsidian.Notice("Compaction failed: " + (err.message || err));
    }
  }

  async _doSend(content, isResend) {
    // Handle /compact before streaming starts
    if (content.trim() === "/compact") {
      await this._compact();
      return;
    }

    const hermesCommandMatch = content.trim().match(/^hermes\s+(\/[a-zA-Z][\w-]*(?:\s+.*)?)$/i);
    if (hermesCommandMatch) {
      content = hermesCommandMatch[1];
    }

    this.isStreaming = true;
    this.autoScrollEnabled = true;
    this.stopBtn.style.display = "";
    this.renderTabs();

    const convId = this.activeConvId;
    if (!convId) return;

    // Build enriched content with file context
    let userContent = content;
    const contextParts = [];

    // @ mentioned files — large files get reference-only treatment
    if (this.attachedFiles.length > 0) {
      const LARGE_FILE_THRESHOLD = 30000;
      for (const file of this.attachedFiles) {
        try {
          const fileContent = await this.app.vault.read(file);
          if (fileContent.length > LARGE_FILE_THRESHOLD) {
            const charCount = fileContent.length;
            const lineCount = fileContent.split('\n').length;
            // Built-in search: search the content directly, no vault_search.py needed
            const searchResult = builtinVaultSearch(fileContent, content);
            if (searchResult) {
              contextParts.push(`[Large file searched: ${file.path}] (${charCount} chars total)\n${searchResult}`);
            } else {
              // No focused match from built-in search; keep the fallback vault-relative.
              contextParts.push(`[Large file: ${file.path}] (${charCount} chars, ${lineCount} lines)\nBuilt-in search found no matches. Ask the user for narrower keywords or use available vault-relative file tools to inspect this file.`);
            }
          } else {
            // Normal file: inline content
            contextParts.push(`[Attached: ${file.path}]\n\`\`\`\n${fileContent}\n\`\`\``);
          }
        } catch (e) {}
      }
      this.attachedFiles = [];
    }

    // Non-vault text files attached via button
    if (this.attachedTextFiles && this.attachedTextFiles.length > 0) {
      for (const tf of this.attachedTextFiles) {
        contextParts.push(`[Attached file: ${tf.name}]\n\`\`\`\n${tf.content}\n\`\`\``);
      }
      this.attachedTextFiles = [];
    }

    // Current note — same large file threshold as attachments
    if (this.plugin.settings.includeCurrentNote) {
      const LARGE_FILE_THRESHOLD = 30000;
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile instanceof import_obsidian.TFile && activeFile.extension === "md") {
        if (!activeFile.path.startsWith(this.plugin.settings.conversationsPath || "Hermes/conversations")) {
          try {
            const noteContent = await this.app.vault.read(activeFile);
            if (noteContent.trim()) {
              if (noteContent.length > LARGE_FILE_THRESHOLD) {
                const searchResult = builtinVaultSearch(noteContent, content);
                if (searchResult) {
                  contextParts.push(`[Current note searched: ${activeFile.path}] (${noteContent.length} chars total)\n${searchResult}`);
                } else {
                  contextParts.push(`[Current note: ${activeFile.path}] (${noteContent.length} chars, large file)\nBuilt-in search found no matches. Ask the user for narrower keywords or use available vault-relative file tools to inspect this file.`);
                }
              } else {
                contextParts.push(`[Currently viewing: ${activeFile.path}]\n\`\`\`\n${noteContent}\n\`\`\``);
              }
            }
          } catch (e) {}
        }
      }
    }

    // Selection context (Hermes XML) — capture before clearing
    const selCtx = this._getSelectionContext();
    if (selCtx) {
      const lineAttr = selCtx.startLine && selCtx.lineCount
        ? ` lines="${selCtx.startLine}-${selCtx.startLine + selCtx.lineCount - 1}"`
        : "";
      contextParts.push(`<editor_selection path="${selCtx.notePath}"${lineAttr}>\n${selCtx.selectedText}\n</editor_selection>`);
    }

    if (contextParts.length > 0) userContent += "\n\n" + contextParts.join("\n\n");

    // Capture images before clearing (fix: must snapshot before clearing)
    const messageImages = this.pastedImages.map(img => img.data);

    // Handle images — build multimodal content
    let apiContent = userContent;
    if (this.pastedImages.length > 0) {
      apiContent = [
        { type: "text", text: userContent }
      ];
      for (const img of this.pastedImages) {
        apiContent.push({
          type: "image_url",
          image_url: { url: img.data }
        });
      }
    }
    this.pastedImages = [];

    // Add to store & render (display only user's typed text, selection context is API-only)
    if (!isResend) {
      this.plugin.conversationStore.addMessage(convId, "user", content, messageImages.length > 0 ? { images: messageImages } : undefined);
      const conv = this.plugin.conversationStore.getConversation(convId);
      this.appendMessageEl("user", content, conv ? conv.messages.length - 1 : undefined);
    }

    // Clear selection after send
    if (selCtx) {
      this._clearSelection();
    }

    this.startStreamingMessage();
    this.abortController = new AbortController();
    this.updateContextRow();

    try {
      const history = this.plugin.conversationStore.getMessages(convId);

      // Build API messages with system prompt (Phase 1, item 1)
      const systemPrompt = buildSystemPrompt(this.app, this.plugin.settings);
      const apiMessages = [
        { role: "system", content: systemPrompt },
        ...history.map((m, i) => {
          if (i === history.length - 1 && m.role === "user") {
            return { role: "user", content: apiContent };
          }
          return m;
        })
      ];

      const result = await this.plugin.api.chat(
        apiMessages,
        (text, _delta) => this.updateStreamingMessage(text),
        (thinkText) => this.updateThinking(thinkText),
        this.abortController.signal
      );

      const fullText = result.text;
      const thinkingText = result.thinking;

      const cleanText = this.plugin.actionExecutor.stripActionBlocks(fullText);
      const actions = this.plugin.actionExecutor.parseActions(fullText);

      this.finalizeStreamingMessage(cleanText, thinkingText);
      this.plugin.conversationStore.addMessage(convId, "assistant", cleanText, { thinking: thinkingText || undefined });

      if (actions.length > 0) await this.plugin.actionExecutor.execute(actions);
      await this.plugin.conversationStore.saveConversation(convId);

      // AI title generation (Phase 2, item 7)
      const conv = this.plugin.conversationStore.getConversation(convId);
      if (conv && conv.messages.length === 2 && conv._autoTitled) {
        // First exchange — generate a short title
        conv._autoTitled = false;
        this.generateTitle(convId, content);
      }

    } catch (err) {
      if (err.name === "AbortError") {
        this.finalizeStreamingMessage("*(cancelled)*", "");
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (this.streamingEl) { this.streamingEl.remove(); this.streamingEl = null; this.streamingContentEl = null; }
        this.appendMessageEl("error", errMsg);
      }
    }

    this.isStreaming = false;
    this.abortController = null;
    this.stopBtn.style.display = "none";
    this.renderTabs();
    this.inputEl.focus();
  }

  // ---- AI Title Generation (Phase 2) ----
  async generateTitle(convId, firstMessage) {
    try {
      const title = await this.plugin.api.chatSync(
        `Give this conversation a title of five words or fewer: ${firstMessage.slice(0, 200)}`,
        "You are a title generator. Output only the title, without quotes, punctuation, or explanation."
      );
      const cleanTitle = title.replace(/["""'']/g, '').trim().slice(0, 20);
      if (cleanTitle && cleanTitle.length > 0) {
        this.plugin.conversationStore.updateTitle(convId, cleanTitle);
        await this.plugin.conversationStore.saveConversation(convId);
        this.renderTabs();
      }
    } catch (e) {
      console.log("Hermes: Title generation failed (non-critical)", e);
    }
  }

  // ---- Helpers ----

  autoResizeInput() {
    this.inputEl.style.minHeight = "";
    const container = this.inputEl.closest(".hermes-container");
    const viewHeight = container ? container.clientHeight : window.innerHeight;
    const maxHeight = Math.max(TEXTAREA_MIN_MAX_HEIGHT, viewHeight * TEXTAREA_MAX_HEIGHT_PERCENT);
    const flexAllocatedHeight = this.inputEl.offsetHeight;
    const contentHeight = Math.min(this.inputEl.scrollHeight, maxHeight);
    if (contentHeight > flexAllocatedHeight) {
      this.inputEl.style.minHeight = `${contentHeight}px`;
    }
    this.inputEl.style.maxHeight = `${maxHeight}px`;
  }

  scrollToBottom() {
    requestAnimationFrame(() => { this.messagesEl.scrollTop = this.messagesEl.scrollHeight; });
  }

  updateContextRow() {
    this.contextRowEl.empty();
    let hasContent = false;

    // Show attached text files (non-vault)
    for (const tf of (this.attachedTextFiles || [])) {
      hasContent = true;
      const chip = this.contextRowEl.createDiv({ cls: "oc-context-chip" });
      chip.createSpan({ text: `📎 ${tf.name}` });
      const removeBtn = chip.createSpan({ cls: "oc-chip-remove", text: "\u00D7" });
      removeBtn.addEventListener("click", () => {
        this.attachedTextFiles = this.attachedTextFiles.filter(f => f.name !== tf.name);
        this.updateContextRow();
      });
    }

    // Show attached files
    for (const file of this.attachedFiles) {
      hasContent = true;
      const chip = this.contextRowEl.createDiv({ cls: "oc-context-chip" });
      chip.createSpan({ text: `\uD83D\uDCC4 ${file.basename}` });
      const removeBtn = chip.createSpan({ cls: "oc-chip-remove", text: "\u00D7" });
      removeBtn.addEventListener("click", () => {
        this.attachedFiles = this.attachedFiles.filter(f => f.path !== file.path);
        this.updateContextRow();
      });
    }

    // Show pasted images as thumbnails
    for (let i = 0; i < this.pastedImages.length; i++) {
      hasContent = true;
      const chip = this.contextRowEl.createDiv({ cls: "oc-image-chip" });
      const thumb = chip.createEl("img", {
        cls: "oc-image-thumb",
        attr: { src: this.pastedImages[i].data, alt: this.pastedImages[i].name }
      });
      thumb.addEventListener("click", () => this.showLightbox(this.pastedImages[i].data));
      const removeBtn = chip.createDiv({ cls: "oc-image-chip-remove" });
      removeBtn.setText("\u00D7");
      const idx = i;
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.pastedImages.splice(idx, 1);
        this.updateContextRow();
      });
    }

    // Show current note indicator
    if (this.plugin.settings.includeCurrentNote) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile instanceof import_obsidian.TFile && activeFile.extension === "md") {
        if (!activeFile.path.startsWith(this.plugin.settings.conversationsPath || "Hermes/conversations")) {
          hasContent = true;
          const chip = this.contextRowEl.createDiv({ cls: "oc-context-chip oc-context-auto" });
          chip.createSpan({ text: `\uD83D\uDCC4 ${activeFile.basename}` });
        }
      }
    }

    // Show selection indicator (Hermes-style: "N lines selected")
    if (this.storedSelection && this.storedSelection.selectedText.trim()) {
      hasContent = true;
      const chip = this.contextRowEl.createDiv({ cls: "oc-context-chip oc-selection-indicator" });
      const selIcon = chip.createSpan({ cls: "oc-context-chip-icon" });
      setIconSafe(selIcon, "type", "12");
      const n = this.storedSelection.lineCount || 1;
      chip.createSpan({ text: ` ${n} line${n > 1 ? "s" : ""} selected` });
      // Maintain CM6 highlight
      this._showSelectionHighlight();
    }

    this.contextRowEl.toggleClass("has-content", hasContent);
  }
};

// ============================================
// Settings Tab
// ============================================
var HermesSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Hermes Settings" });

    new import_obsidian.Setting(containerEl)
      .setName("Gateway URL")
      .setDesc("URL of the Hermes Agent API server")
      .addText(text => text.setPlaceholder("http://127.0.0.1:18789").setValue(this.plugin.settings.gatewayUrl)
        .onChange(async (val) => { this.plugin.settings.gatewayUrl = val.replace(/\/+$/, ""); await this.plugin.saveSettings(); }));

    const statusInfo = secureTokenStorage.getStatusInfo();
    const tokenSetting = new import_obsidian.Setting(containerEl).setName("Gateway Token").setDesc("Authentication token");
    const statusEl = containerEl.createDiv({ cls: "oc-token-status" });
    statusEl.innerHTML = `<span class="oc-status-${statusInfo.secure ? "secure" : "insecure"}">${statusInfo.secure ? "\uD83D\uDD12" : "\u26A0\uFE0F"} ${statusInfo.description}</span>`;

    if (statusInfo.method === "envVar") {
      tokenSetting.addButton(btn => btn.setButtonText("Using Environment Variable").setDisabled(true));
    } else {
      const currentToken = secureTokenStorage.getToken(this.plugin.settings.gatewayTokenEncrypted, this.plugin.settings.gatewayTokenPlaintext);
      tokenSetting.addText(text => {
        text.setPlaceholder("Enter your token").setValue(currentToken)
          .onChange(async (val) => {
            const { encrypted, plaintext } = secureTokenStorage.setToken(val);
            this.plugin.settings.gatewayTokenEncrypted = encrypted;
            this.plugin.settings.gatewayTokenPlaintext = plaintext;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });
    }

    containerEl.createEl("h3", { text: "Model & API" });

    new import_obsidian.Setting(containerEl).setName("Default model").setDesc("Model name sent with each request (e.g. hermes/obsidian, anthropic/claude-sonnet-4, gpt-4o)")
      .addText(t => t.setPlaceholder("hermes/obsidian").setValue(this.plugin.settings.defaultModel)
        .onChange(async v => { this.plugin.settings.defaultModel = v || "hermes/obsidian"; await this.plugin.saveSettings(); }));

    new import_obsidian.Setting(containerEl).setName("Scopes header").setDesc("Optional x-hermes-scopes header. Leave empty unless your Hermes API server requires it.")
      .addText(t => t.setPlaceholder("").setValue(this.plugin.settings.scopes)
        .onChange(async v => { this.plugin.settings.scopes = v; await this.plugin.saveSettings(); }));

    new import_obsidian.Setting(containerEl).setName("Custom models").setDesc("Additional models for the dropdown selector, one per line: value|label (e.g. gpt-4o|GPT-4o)")
      .addTextArea(t => {
        const val = (this.plugin.settings.customModels || []).map(m => `${m.value}|${m.label}`).join('\n');
        t.setPlaceholder("gpt-4o|GPT-4o\nclaude-sonnet-4|Sonnet 4").setValue(val)
          .onChange(async v => {
            this.plugin.settings.customModels = v.split('\n').filter(l => l.includes('|')).map(l => {
              const [value, ...rest] = l.split('|');
              return { value: value.trim(), label: rest.join('|').trim() };
            });
            await this.plugin.saveSettings();
          });
        t.inputEl.rows = 4;
      });

    containerEl.createEl("h3", { text: "Behavior" });

    new import_obsidian.Setting(containerEl).setName("Include current note").setDesc("Attach focused note as context")
      .addToggle(t => t.setValue(this.plugin.settings.includeCurrentNote).onChange(async v => { this.plugin.settings.includeCurrentNote = v; await this.plugin.saveSettings(); }));

    // ---- Custom Commands ----
    containerEl.createEl("h3", { text: "Custom Commands" });
    containerEl.createEl("p", { text: "Custom prompt templates can appear in the slash menu or editor right-click menu. Use {{text}} for the selected text.", cls: "setting-item-description" });

    const renderCustomCommands = () => {
      listEl.empty();
      const cmds = this.plugin.settings.customCommands || [];
      cmds.forEach((cmd, idx) => {
        const row = listEl.createDiv({ cls: "oc-custom-cmd-row" });

        const nameInput = row.createEl("input", { type: "text", cls: "oc-custom-cmd-name" });
        nameInput.placeholder = "Command name";
        nameInput.value = cmd.name;
        nameInput.addEventListener("change", async () => {
          cmds[idx].name = nameInput.value.trim();
          await this.plugin.saveSettings();
        });

        const promptInput = row.createEl("textarea", { cls: "oc-custom-cmd-prompt" });
        promptInput.placeholder = "Prompt; supports the {{text}} placeholder";
        promptInput.value = cmd.prompt;
        promptInput.rows = 2;
        promptInput.addEventListener("change", async () => {
          cmds[idx].prompt = promptInput.value;
          await this.plugin.saveSettings();
        });

        const toggles = row.createDiv({ cls: "oc-custom-cmd-toggles" });

        const slashLabel = toggles.createEl("label", { cls: "oc-custom-cmd-toggle" });
        const slashCb = slashLabel.createEl("input", { type: "checkbox" });
        slashCb.checked = !!cmd.inSlash;
        slashLabel.createSpan({ text: "/ slash" });
        slashCb.addEventListener("change", async () => {
          cmds[idx].inSlash = slashCb.checked;
          await this.plugin.saveSettings();
        });

        const menuLabel = toggles.createEl("label", { cls: "oc-custom-cmd-toggle" });
        const menuCb = menuLabel.createEl("input", { type: "checkbox" });
        menuCb.checked = !!cmd.inMenu;
        menuLabel.createSpan({ text: "Context menu" });
        menuCb.addEventListener("change", async () => {
          cmds[idx].inMenu = menuCb.checked;
          await this.plugin.saveSettings();
        });

        const delBtn = row.createEl("button", { cls: "oc-custom-cmd-del", text: "×" });
        delBtn.addEventListener("click", async () => {
          this.plugin.settings.customCommands.splice(idx, 1);
          await this.plugin.saveSettings();
          renderCustomCommands();
        });
      });

      const addBtn = listEl.createEl("button", { cls: "oc-custom-cmd-add", text: "+ Add command" });
      addBtn.addEventListener("click", async () => {
        if (!this.plugin.settings.customCommands) this.plugin.settings.customCommands = [];
        this.plugin.settings.customCommands.push({ name: "", prompt: "", inSlash: false, inMenu: true });
        await this.plugin.saveSettings();
        renderCustomCommands();
      });
    };

    const listEl = containerEl.createDiv({ cls: "oc-custom-cmd-list" });
    renderCustomCommands();

    new import_obsidian.Setting(containerEl).setName("Markdown during streaming").setDesc("On: render Markdown while streaming (prettier, but slower for long replies). Off: stream as plain text, render once at the end.")
      .addToggle(t => t.setValue(this.plugin.settings.streamMarkdown).onChange(async v => { this.plugin.settings.streamMarkdown = v; await this.plugin.saveSettings(); }));

    new import_obsidian.Setting(containerEl).setName("Show file actions").setDesc("Display file action indicators")
      .addToggle(t => t.setValue(this.plugin.settings.showActionsInChat).onChange(async v => { this.plugin.settings.showActionsInChat = v; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "Advanced" });

    new import_obsidian.Setting(containerEl).setName("Vault search script").setDesc("Path to vault_search.py for large file search (optional)")
      .addText(t => t.setPlaceholder("Leave empty to disable").setValue(this.plugin.settings.vaultSearchPath)
        .onChange(async v => { this.plugin.settings.vaultSearchPath = v; await this.plugin.saveSettings(); }));

    new import_obsidian.Setting(containerEl).setName("Workflow folder").setDesc("Optional vault-relative folder containing Markdown workflow files. Leave empty unless your vault has one.")
      .addText(t => t.setPlaceholder("Examples: Hermes/workflows or _agent/workflows").setValue(this.plugin.settings.workflowFolder || "")
        .onChange(async v => { this.plugin.settings.workflowFolder = normalizeVaultFolder(v); await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "Audit Log" });
    new import_obsidian.Setting(containerEl).setName("Enable audit logging")
      .addToggle(t => t.setValue(this.plugin.settings.auditLogEnabled).onChange(async v => { this.plugin.settings.auditLogEnabled = v; await this.plugin.saveSettings(); }));
    new import_obsidian.Setting(containerEl).setName("Audit log path")
      .addText(t => t.setPlaceholder("Hermes/audit-log.md").setValue(this.plugin.settings.auditLogPath)
        .onChange(async v => { this.plugin.settings.auditLogPath = v || "Hermes/audit-log.md"; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "Storage" });
    new import_obsidian.Setting(containerEl).setName("Conversations folder")
      .addText(t => t.setPlaceholder("Hermes/conversations").setValue(this.plugin.settings.conversationsPath)
        .onChange(async v => { this.plugin.settings.conversationsPath = v || "Hermes/conversations"; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "Connection Test" });
    const testContainer = containerEl.createDiv({ cls: "oc-test-container" });
    const testBtn = testContainer.createEl("button", { text: "Test Connection" });
    const testResult = testContainer.createEl("span", { cls: "oc-test-result" });
    testBtn.addEventListener("click", async () => {
      testResult.setText("Testing...");
      testResult.removeClass("oc-test-success", "oc-test-error");
      try {
        const response = await this.plugin.api.chatSync("Say 'Connected!' in one word");
        testResult.setText(`\u2713 ${response}`);
        testResult.addClass("oc-test-success");
      } catch (err) {
        testResult.setText(`\u2717 ${err instanceof Error ? err.message : "Failed"}`);
        testResult.addClass("oc-test-error");
      }
    });
  }
};

// ============================================
// Plugin Entry Point
// ============================================
var HermesPlugin = class extends import_obsidian.Plugin {
  async openHermesWithPrompt(prompt, send = false) {
    await this.activateView();
    const leaves = this.app.workspace.getLeavesOfType(HERMES_VIEW_TYPE);
    if (leaves.length > 0) {
      const view = leaves[0].view;
      if (view instanceof HermesView) {
        view.inputEl.value = prompt;
        view.autoResizeInput();
        view.inputEl.focus();
        view.inputEl.selectionStart = view.inputEl.selectionEnd = view.inputEl.value.length;
        if (send) await view.sendMessage();
      }
    }
  }

  async onload() {
    await this.loadSettings();
    this.api = new HermesAPI(this.settings);
    this.actionExecutor = new ActionExecutor(this.app, () => this.settings);
    this.conversationStore = new ConversationStore(this.app, () => this.settings);
    this.inlineEditManager = new InlineEditManager(this);

    (0, import_obsidian.addIcon)("hermes-caduceus", HERMES_ICON);

    this.registerView(HERMES_VIEW_TYPE, (leaf) => new HermesView(leaf, this));
    // Backwards compat: register old view types so Obsidian does not error on workspace restore.
    this.registerView("clawdian-chat-view", (leaf) => new HermesView(leaf, this));
    this.registerView("openclaw-chat-view", (leaf) => new HermesView(leaf, this));

    this.addRibbonIcon("hermes-caduceus", "Obsidian Hermes", () => this.activateView());

    // ---- Commands ----
    this.addCommand({ id: "open-chat", name: "Open Hermes", callback: () => this.activateView() });

    this.addCommand({
      id: "new-chat", name: "New Chat",
      callback: async () => {
        await this.activateView();
        const leaves = this.app.workspace.getLeavesOfType(HERMES_VIEW_TYPE);
        if (leaves.length > 0) { const view = leaves[0].view; if (view instanceof HermesView) view.newConversation(); }
      }
    });

    // Send selection to Hermes
    this.addCommand({
      id: "send-selection", name: "Send selection to Hermes",
      editorCallback: async (editor) => {
        const selection = editor.getSelection();
        if (!selection) { new import_obsidian.Notice("No text selected"); return; }
        await this.activateView();
        const leaves = this.app.workspace.getLeavesOfType(HERMES_VIEW_TYPE);
        if (leaves.length > 0) {
          const view = leaves[0].view;
          if (view instanceof HermesView) {
            view.inputEl.value = selection;
            view.autoResizeInput();
            view.inputEl.focus();
          }
        }
      }
    });

    // Summarize current note
    this.addCommand({
      id: "summarize-note", name: "Summarize current note",
      editorCallback: async (editor, markdownView) => {
        const file = markdownView.file;
        if (!file) { new import_obsidian.Notice("No file open"); return; }
        await this.activateView();
        const leaves = this.app.workspace.getLeavesOfType(HERMES_VIEW_TYPE);
        if (leaves.length > 0) {
          const view = leaves[0].view;
          if (view instanceof HermesView) {
            view.inputEl.value = `Summarize this note: ${file.basename}`;
            view.autoResizeInput();
            view.sendMessage();
          }
        }
      }
    });


    // Workflow-oriented Hermes commands
    const workflowCommandDefs = [
      { id: "workflow-review-note", name: "Hermes workflow: Review active note", prompt: "Review the active note for structure, clarity, links, tags, stale claims, and actionable next edits. Distinguish fact, inference, interpretation, and suggestion. If this vault has a configured workflow folder, use the relevant workflow there when available." },
      { id: "workflow-create-note", name: "Hermes workflow: Create note", prompt: "Ask only for missing essentials. Draft a vault-native Markdown note with frontmatter, wikilinks where useful, and clear status. If this vault has a configured workflow folder, use the relevant workflow there when available." },
      { id: "workflow-research-pack", name: "Hermes workflow: Build research context pack", prompt: "Build a concise context pack: question, sources/material, claims, uncertainties, connections, and next actions. If this vault has a configured workflow folder, use the relevant workflow there when available." }
    ];
    for (const def of workflowCommandDefs) {
      this.addCommand({
        id: def.id,
        name: def.name,
        callback: async () => this.openHermesWithPrompt(def.prompt, false)
      });
    }

    // Ask about selection
    this.addCommand({
      id: "ask-about-selection", name: "Ask Hermes about selection",
      editorCallback: async (editor) => {
        const selection = editor.getSelection();
        if (!selection) { new import_obsidian.Notice("No text selected"); return; }
        await this.activateView();
        const leaves = this.app.workspace.getLeavesOfType(HERMES_VIEW_TYPE);
        if (leaves.length > 0) {
          const view = leaves[0].view;
          if (view instanceof HermesView) {
            view.inputEl.value = `Explain this:\n\n${selection}`;
            view.autoResizeInput();
            view.inputEl.focus();
          }
        }
      }
    });

    // Inline Edit command (Phase 2)
    this.addCommand({
      id: "inline-edit", name: "Inline Edit (selection)",
      editorCallback: async (editor) => {
        const selection = editor.getSelection();
        if (!selection) {
          new import_obsidian.Notice("Select text first, or use 'Inline Edit at cursor'");
          return;
        }
        this.inlineEditManager.triggerInlineEdit(false);
      }
    });

    // Inline Edit at cursor (Phase 2)
    this.addCommand({
      id: "inline-edit-cursor", name: "Inline Edit at cursor (insert)",
      editorCallback: async (editor) => {
        this.inlineEditManager.triggerInlineEdit(true);
      }
    });

    // ---- Editor context menu ----
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const selection = editor.getSelection();
        if (selection) {
          // Custom commands with inMenu: true
          const menuCmds = (this.settings.customCommands || []).filter(c => c.inMenu);
          for (const cmd of menuCmds) {
            menu.addItem(item => {
              item.setTitle(cmd.name)
                .setIcon("hermes-caduceus")
                .onClick(async () => {
                  await this.activateView();
                  const leaves = this.app.workspace.getLeavesOfType(HERMES_VIEW_TYPE);
                  if (leaves.length > 0) {
                    const view = leaves[0].view;
                    if (view instanceof HermesView) {
                      if (!view.storedSelection) {
                        const activeView = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
                        if (activeView && activeView.editor) {
                          const ed = activeView.editor;
                          const fromPos = ed.getCursor("from");
                          view.storedSelection = {
                            notePath: activeView.file?.path || "",
                            selectedText: selection,
                            lineCount: selection.split(/\r?\n/).length,
                            startLine: fromPos.line + 1,
                            from: ed.posToOffset(fromPos),
                            to: ed.posToOffset(ed.getCursor("to")),
                            editorView: ed.cm
                          };
                          view.updateContextRow();
                        }
                      }
                      view.inputEl.value = cmd.prompt.replace(/\{\{text\}\}/g, selection);
                      view.autoResizeInput();
                      view.inputEl.focus();
                    }
                  }
                });
            });
          }
          // Inline edit in context menu
          menu.addItem(item => {
            item.setTitle("Inline Edit with Hermes")
              .setIcon("wand-2")
              .onClick(() => {
                this.inlineEditManager.triggerInlineEdit(false);
              });
          });
        }
      })
    );

    this.addSettingTab(new HermesSettingTab(this.app, this));
    console.log("Hermes Obsidian plugin loaded");
  }

  onunload() {
    if (this.inlineEditManager) {
      this.inlineEditManager.clearWidget();
      this.inlineEditManager.clearDiff();
    }
    console.log("Hermes unloaded");
  }

  async loadSettings() {
    const data = await this.loadData() || {};
    if (data.gatewayToken && !data.gatewayTokenPlaintext && !data.gatewayTokenEncrypted) {
      data.gatewayTokenPlaintext = data.gatewayToken;
      delete data.gatewayToken;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // Migrate legacy explainPrompt to customCommands
    if (this.settings.explainPrompt && (!this.settings.customCommands || this.settings.customCommands.length === 0)) {
      this.settings.customCommands = [{
        name: "Explain",
        prompt: this.settings.explainPrompt,
        inSlash: false,
        inMenu: true
      }];
    }
    delete this.settings.explainPrompt;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.api = new HermesAPI(this.settings);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = null;
    let leaves = workspace.getLeavesOfType(HERMES_VIEW_TYPE);
    if (leaves.length === 0) leaves = workspace.getLeavesOfType("clawdian-chat-view");
    if (leaves.length === 0) leaves = workspace.getLeavesOfType("openclaw-chat-view");
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: HERMES_VIEW_TYPE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }
};
