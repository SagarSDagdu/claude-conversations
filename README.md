# claude-conversations

Browse and search your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) conversation history from the browser.

Claude Code saves every conversation locally but doesn't provide a way to browse them after you close the terminal. This tool reads those conversation files and gives you a searchable, filterable UI to find and resume any past session.

## Features

- **Browse all conversations** across every project you've used Claude Code in
- **Search by metadata** — prompt text, git branch, project path, or summary
- **Search by content** — searches inside conversation messages (debounced, server-side) with matching snippets shown inline
- **Time filters** — Today, This Week, This Month
- **Expand preview** — shows the first ~10 and last ~20 lines of a conversation so you can see what it was about and where you left off
- **View full conversation** — opens the complete conversation in a new tab with proper Markdown rendering and syntax-highlighted code blocks
- **Export as Markdown** — download any conversation as a `.md` file
- **One-click copy** of `claude --resume <id>` to jump back into a session
- **Includes active sessions** — not just completed ones
- **Proper role labels** — distinguishes between You, Claude, and Tool Output
- **Zero dependencies** — just Node.js (Markdown rendering uses CDN-loaded [marked](https://github.com/markedjs/marked) + [highlight.js](https://github.com/highlightjs/highlight.js))

## Install

```bash
npm install -g claude-conversations
```

## Usage

```bash
claude-conversations
```

This starts a local server and opens your browser to `http://localhost:3456`.

### Options

```
-p, --port <port>   Port to run the server on (default: 3456)
-h, --help          Show help
```

### Without installing

```bash
npx claude-conversations
```

### Or clone and run

```bash
git clone https://github.com/sagardagdu/claude-conversations.git
cd claude-conversations
node server.js
```

## How it works

Claude Code stores conversation data in `~/.claude/projects/`. Each project directory contains:

- **`sessions-index.json`** — an index of completed sessions with metadata and summaries
- **`<session-id>.jsonl`** — raw conversation logs (one JSON object per line)

This tool reads both sources. The index is used when available (it's faster and has summaries), and JSONL files are parsed directly for any sessions not yet in the index (e.g. active/in-progress conversations).

All data stays local. Nothing is sent anywhere.

## License

MIT
