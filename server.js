const http = require("http");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const { exec } = require("child_process");

const PORT = parseInt(process.env.CC_PORT, 10) || 3456;
const CLAUDE_PROJECTS_DIR = path.join(
  process.env.HOME,
  ".claude",
  "projects"
);

async function getAllSessions() {
  const sessions = [];
  const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);

  for (const dirName of projectDirs) {
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    // Load from sessions-index.json where available
    const indexedIds = new Set();
    const indexPath = path.join(dirPath, "sessions-index.json");
    if (fs.existsSync(indexPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(indexPath, "utf8"));
        for (const entry of data.entries || []) {
          indexedIds.add(entry.sessionId);
          sessions.push({
            sessionId: entry.sessionId,
            project: entry.projectPath || dirName,
            projectDir: dirName,
            branch: entry.gitBranch || "",
            firstPrompt: entry.firstPrompt || "",
            summary: entry.summary || "",
            messageCount: entry.messageCount || 0,
            created: entry.created || "",
            modified: entry.modified || "",
          });
        }
      } catch (e) {
        // skip malformed index
      }
    }

    // Also parse any JSONL files not in the index (e.g. active sessions)
    const jsonlFiles = fs
      .readdirSync(dirPath)
      .filter((f) => f.endsWith(".jsonl"));

    for (const file of jsonlFiles) {
      const sessionId = file.replace(".jsonl", "");
      if (indexedIds.has(sessionId)) continue;
      const filePath = path.join(dirPath, file);
      try {
        const session = await parseJsonlFile(filePath, sessionId, dirName);
        if (session) sessions.push(session);
      } catch (e) {
        // skip unreadable files
      }
    }
  }

  // Sort by modified date descending
  sessions.sort((a, b) => {
    const da = a.modified ? new Date(a.modified) : new Date(0);
    const db = b.modified ? new Date(b.modified) : new Date(0);
    return db - da;
  });

  return sessions;
}

async function parseJsonlFile(filePath, sessionId, dirName) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream });

  let firstPrompt = "";
  let branch = "";
  let project = "";
  let created = "";
  let modified = "";
  let messageCount = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);

      if (entry.gitBranch && !branch) branch = entry.gitBranch;
      if (entry.cwd && !project) project = entry.cwd;

      if (entry.timestamp) {
        if (!created) created = entry.timestamp;
        modified = entry.timestamp;
      }

      if (entry.type === "user" && !firstPrompt) {
        const msg = entry.message;
        if (msg && msg.content) {
          if (typeof msg.content === "string") {
            firstPrompt = msg.content;
          } else if (Array.isArray(msg.content)) {
            const textPart = msg.content.find(
              (c) => c.type === "text" || typeof c === "string"
            );
            if (textPart) {
              firstPrompt =
                typeof textPart === "string" ? textPart : textPart.text || "";
            }
          }
        }
      }

      if (entry.type === "user" || entry.type === "assistant") {
        messageCount++;
      }
    } catch (e) {
      // skip malformed lines
    }
  }

  if (!firstPrompt) return null;

  return {
    sessionId,
    project: project || dirName,
    projectDir: dirName,
    branch,
    firstPrompt,
    summary: "",
    messageCount,
    created,
    modified,
  };
}

function entryToLines(entry) {
  const result = extractMessage(entry);
  if (!result || !result.text.trim()) return [];
  return result.text.split("\n").map((l) => ({ role: result.role, text: l }));
}

async function getSessionPreview(sessionId) {
  const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  for (const dirName of projectDirs) {
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    const filePath = path.join(dirPath, sessionId + ".jsonl");
    if (!fs.existsSync(filePath)) continue;

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream });
    const allLines = [];

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "user" && entry.type !== "assistant") continue;
        const lines = entryToLines(entry);
        allLines.push(...lines);
      } catch (e) {
        // skip
      }
    }

    const FIRST = 10;
    const LAST = 20;

    if (allLines.length <= FIRST + LAST) {
      return { lines: allLines, truncated: false };
    }

    const first = allLines.slice(0, FIRST);
    const last = allLines.slice(-LAST);
    return { lines: [...first, { role: "separator", text: "" }, ...last], truncated: true };
  }
  return { lines: [], truncated: false };
}

async function getFullSession(sessionId) {
  const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  for (const dirName of projectDirs) {
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    const filePath = path.join(dirPath, sessionId + ".jsonl");
    if (!fs.existsSync(filePath)) continue;

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream });

    let branch = "";
    let project = "";
    let created = "";
    let modified = "";
    const turns = [];

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.gitBranch && !branch) branch = entry.gitBranch;
        if (entry.cwd && !project) project = entry.cwd;
        if (entry.timestamp) {
          if (!created) created = entry.timestamp;
          modified = entry.timestamp;
        }
        if (entry.type !== "user" && entry.type !== "assistant") continue;
        const msg = extractMessage(entry);
        if (!msg) continue;
        turns.push(msg);
      } catch (e) {
        // skip
      }
    }

    return { sessionId, branch, project, created, modified, turns };
  }
  return null;
}

function buildFullSessionHTML(session) {
  const esc = (s) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  // Embed turns as JSON for client-side markdown rendering
  const turnsJSON = JSON.stringify(session.turns);

  const meta = [];
  if (session.project)
    meta.push("<strong>Project:</strong> " + esc(session.project));
  if (session.branch)
    meta.push("<strong>Branch:</strong> " + esc(session.branch));
  if (session.created)
    meta.push(
      "<strong>Started:</strong> " + new Date(session.created).toLocaleString()
    );
  if (session.modified)
    meta.push(
      "<strong>Last active:</strong> " +
        new Date(session.modified).toLocaleString()
    );
  meta.push("<strong>Messages:</strong> " + session.turns.length);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Conversation ${esc(session.sessionId.slice(0, 8))}</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github-dark.min.css">
  <script src="https://cdn.jsdelivr.net/npm/highlight.js@11/highlight.min.js"><\/script>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
      background: #1a1a2e;
      color: #e0e0e0;
    }
    .header {
      background: #16213e;
      border-bottom: 1px solid #0f3460;
      padding: 20px 32px;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .header h1 { font-size: 20px; color: #e94560; margin-bottom: 10px; }
    .meta { font-size: 13px; color: #888; display: flex; gap: 20px; flex-wrap: wrap; }
    .resume {
      margin-top: 8px;
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 12px;
      color: #555;
    }
    .resume code {
      background: #1a1a2e;
      border: 1px solid #0f3460;
      padding: 2px 8px;
      border-radius: 4px;
      color: #e94560;
    }
    .container { max-width: 900px; margin: 0 auto; padding: 24px 32px; }
    .turn { margin-bottom: 24px; }
    .turn-label { font-weight: 600; margin-bottom: 6px; font-size: 13px; }
    .label-user { color: #3b82f6; }
    .label-assistant { color: #e94560; }
    .label-tool { color: #888; }

    /* Markdown content styling */
    .turn-text { line-height: 1.7; font-size: 14px; }
    .turn-user .turn-text { color: #93c5fd; }
    .turn-assistant .turn-text { color: #d1d5db; }
    .turn-tool details {
      border: 1px solid #0f3460;
      border-radius: 6px;
      background: #111827;
    }
    .turn-tool summary {
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
      color: #666;
      user-select: none;
    }
    .turn-tool summary:hover { color: #999; }
    .turn-tool .turn-text {
      color: #888;
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 12px;
      white-space: pre-wrap;
      padding: 8px 12px;
      max-height: 400px;
      overflow-y: auto;
    }

    .turn-text p { margin-bottom: 10px; }
    .turn-text h1, .turn-text h2, .turn-text h3, .turn-text h4 {
      color: #f0f0f0;
      margin: 16px 0 8px;
    }
    .turn-text h1 { font-size: 20px; }
    .turn-text h2 { font-size: 17px; }
    .turn-text h3 { font-size: 15px; }

    .turn-text ul, .turn-text ol {
      margin: 8px 0 8px 24px;
    }
    .turn-text li { margin-bottom: 4px; }

    .turn-text pre {
      background: #111827;
      border: 1px solid #0f3460;
      border-radius: 8px;
      padding: 14px 16px;
      overflow-x: auto;
      margin: 10px 0;
    }
    .turn-text pre code {
      background: none;
      border: none;
      padding: 0;
      font-size: 13px;
      color: #e0e0e0;
    }
    .turn-text code {
      background: #111827;
      border: 1px solid #0f3460;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 13px;
      font-family: "SF Mono", "Fira Code", monospace;
      color: #e94560;
    }

    .turn-text blockquote {
      border-left: 3px solid #e94560;
      padding-left: 14px;
      margin: 10px 0;
      color: #aaa;
    }

    .turn-text table {
      border-collapse: collapse;
      margin: 10px 0;
      width: 100%;
    }
    .turn-text th, .turn-text td {
      border: 1px solid #0f3460;
      padding: 6px 12px;
      text-align: left;
      font-size: 13px;
    }
    .turn-text th { background: #16213e; color: #f0f0f0; }

    .turn-text a { color: #60a5fa; }
    .turn-text hr { border: none; border-top: 1px solid #0f3460; margin: 16px 0; }
    .turn-text img { max-width: 100%; border-radius: 8px; }

    .loading { text-align: center; padding: 40px; color: #888; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Conversation ${esc(session.sessionId.slice(0, 8))}...</h1>
    <div class="meta">${meta.join('<span style="color:#333;"> | </span>')}</div>
    <div class="resume">Resume: <code>claude --resume ${esc(session.sessionId)}</code></div>
  </div>
  <div class="container" id="container">
    <div class="loading">Rendering conversation...</div>
  </div>

  <script>
    var turns = ${turnsJSON};

    marked.setOptions({
      highlight: function(code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      },
      breaks: true,
      gfm: true
    });

    var container = document.getElementById('container');
    container.innerHTML = '';

    var roleClass = { user: 'turn-user', assistant: 'turn-assistant', tool: 'turn-tool' };
    var labelClass = { user: 'label-user', assistant: 'label-assistant', tool: 'label-tool' };
    var labelText = { user: 'You', assistant: 'Claude', tool: 'Tool Output' };

    turns.forEach(function(t) {
      var div = document.createElement('div');
      div.className = 'turn ' + (roleClass[t.role] || 'turn-assistant');

      if (t.role === 'tool') {
        // Collapsed by default
        var details = document.createElement('details');
        var summary = document.createElement('summary');
        var preview = t.text.split('\\n')[0].slice(0, 80);
        summary.textContent = 'Tool Output' + (preview ? ': ' + preview + (t.text.length > 80 ? '...' : '') : '');
        details.appendChild(summary);

        var text = document.createElement('div');
        text.className = 'turn-text';
        text.textContent = t.text;
        details.appendChild(text);

        div.appendChild(details);
      } else {
        var label = document.createElement('div');
        label.className = 'turn-label ' + (labelClass[t.role] || 'label-assistant');
        label.textContent = labelText[t.role] || 'Claude';
        div.appendChild(label);

        var text = document.createElement('div');
        text.className = 'turn-text';
        text.innerHTML = marked.parse(t.text);
        div.appendChild(text);
      }

      container.appendChild(div);
    });
  <\/script>
</body>
</html>`;
}

// Returns { text, role } where role may differ from entry.type
// (e.g. tool_result entries are type "user" but we label them "tool")
function extractMessage(entry) {
  const msg = entry.message;
  if (!msg) return null;

  if (entry.type === "user") {
    if (typeof msg.content === "string") {
      return { text: msg.content, role: "user" };
    }
    if (Array.isArray(msg.content)) {
      const textParts = msg.content.filter((c) => c.type === "text");
      const toolParts = msg.content.filter((c) => c.type === "tool_result");

      // If there are real text parts, this is a human message
      const humanText = textParts.map((c) => c.text || "").filter(Boolean).join("\n");
      if (humanText.trim()) {
        return { text: humanText, role: "user" };
      }

      // Otherwise it's purely tool results — label as tool output
      if (toolParts.length > 0) {
        const toolText = toolParts
          .map((c) => {
            if (typeof c.content === "string") return c.content.slice(0, 500);
            return "";
          })
          .filter(Boolean)
          .join("\n");
        if (toolText.trim()) {
          return { text: toolText, role: "tool" };
        }
      }
      return null;
    }
  }

  // assistant
  if (Array.isArray(msg.content)) {
    const parts = msg.content
      .filter((c) => c.type === "text" || c.type === "tool_use")
      .map((c) => {
        if (c.type === "text") return c.text || "";
        if (c.type === "tool_use") return "_Used tool: " + c.name + "_";
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return parts.trim() ? { text: parts, role: "assistant" } : null;
  }
  if (typeof msg.content === "string") {
    return msg.content.trim() ? { text: msg.content, role: "assistant" } : null;
  }
  return null;
}

// Backward compat wrapper for content search
function extractMessageText(entry) {
  const result = extractMessage(entry);
  return result ? result.text : "";
}

async function exportSessionMarkdown(sessionId) {
  const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  for (const dirName of projectDirs) {
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    const filePath = path.join(dirPath, sessionId + ".jsonl");
    if (!fs.existsSync(filePath)) continue;

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream });

    let branch = "";
    let project = "";
    let created = "";
    let modified = "";
    const turns = [];

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);

        if (entry.gitBranch && !branch) branch = entry.gitBranch;
        if (entry.cwd && !project) project = entry.cwd;
        if (entry.timestamp) {
          if (!created) created = entry.timestamp;
          modified = entry.timestamp;
        }

        if (entry.type !== "user" && entry.type !== "assistant") continue;
        const msg = extractMessage(entry);
        if (!msg) continue;

        turns.push({ ...msg, timestamp: entry.timestamp });
      } catch (e) {
        // skip
      }
    }

    // Build markdown
    let md = "# Claude Conversation\n\n";
    md += "| | |\n|---|---|\n";
    md += "| **Session** | `" + sessionId + "` |\n";
    if (project) md += "| **Project** | " + project + " |\n";
    if (branch) md += "| **Branch** | " + branch + " |\n";
    if (created) md += "| **Started** | " + new Date(created).toLocaleString() + " |\n";
    if (modified) md += "| **Last active** | " + new Date(modified).toLocaleString() + " |\n";
    md += "| **Messages** | " + turns.length + " |\n";
    md += "\n---\n\n";

    for (const t of turns) {
      const label = t.role === "user" ? "You" : t.role === "tool" ? "Tool Output" : "Claude";
      md += "### " + label + "\n\n";
      md += t.text + "\n\n";
    }

    return md;
  }
  return null;
}

async function searchContent(query) {
  const lower = query.toLowerCase();
  const matchingIds = new Set();
  const snippets = {}; // sessionId -> first matching snippet

  const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  for (const dirName of projectDirs) {
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const jsonlFiles = fs
      .readdirSync(dirPath)
      .filter((f) => f.endsWith(".jsonl"));

    for (const file of jsonlFiles) {
      const sessionId = file.replace(".jsonl", "");
      if (matchingIds.has(sessionId)) continue;

      const filePath = path.join(dirPath, file);
      const fileStream = fs.createReadStream(filePath);
      const rl = readline.createInterface({ input: fileStream });

      for await (const line of rl) {
        if (!line.trim()) continue;
        // Quick lowercase check on raw line before parsing JSON
        if (!line.toLowerCase().includes(lower)) continue;

        try {
          const entry = JSON.parse(line);
          if (entry.type !== "user" && entry.type !== "assistant") continue;
          const text = extractMessageText(entry);
          if (!text) continue;

          const textLower = text.toLowerCase();
          const idx = textLower.indexOf(lower);
          if (idx === -1) continue;

          matchingIds.add(sessionId);
          // Extract a snippet around the match
          const start = Math.max(0, idx - 60);
          const end = Math.min(text.length, idx + query.length + 60);
          let snippet = (start > 0 ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : "");
          snippets[sessionId] = snippet;
          break; // one match per session is enough
        } catch (e) {
          // skip
        }
      }
    }
  }

  return { matchingIds: [...matchingIds], snippets };
}

function handleRequest(req, res) {
  const exportMatch = req.url.match(/^\/api\/sessions\/([a-f0-9-]+)\/export$/);
  if (exportMatch) {
    const sessionId = exportMatch[1];
    exportSessionMarkdown(sessionId)
      .then((md) => {
        if (!md) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="claude-${sessionId.slice(0, 8)}.md"`,
        });
        res.end(md);
      })
      .catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  const fullMatch = req.url.match(/^\/session\/([a-f0-9-]+)$/);
  if (fullMatch) {
    const sessionId = fullMatch[1];
    getFullSession(sessionId)
      .then((session) => {
        if (!session) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Session not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(buildFullSessionHTML(session));
      })
      .catch((err) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error: " + err.message);
      });
    return;
  }

  const searchMatch = req.url.match(/^\/api\/search\?q=(.+)$/);
  if (searchMatch) {
    const query = decodeURIComponent(searchMatch[1]);
    if (query.length < 2) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ matchingIds: [], snippets: {} }));
      return;
    }
    searchContent(query)
      .then((result) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      })
      .catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  const previewMatch = req.url.match(/^\/api\/sessions\/([a-f0-9-]+)\/preview$/);
  if (previewMatch) {
    const sessionId = previewMatch[1];
    getSessionPreview(sessionId)
      .then((result) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      })
      .catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
  } else if (req.url === "/api/sessions") {
    getAllSessions()
      .then((sessions) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(sessions));
      })
      .catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
  } else {
    const htmlPath = path.join(__dirname, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  }
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nClaude Conversations running at ${url}\n`);

  // Auto-open browser
  const openCmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${openCmd} ${url}`);
});
