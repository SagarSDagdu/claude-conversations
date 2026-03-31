#!/usr/bin/env node

const path = require("path");

// Allow overriding port via CLI arg or env
const args = process.argv.slice(2);
let port = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" || args[i] === "-p") {
    port = parseInt(args[i + 1], 10);
  }
  if (args[i] === "--help" || args[i] === "-h") {
    console.log(`
claude-conversations - Browse your Claude Code conversation history

Usage:
  claude-conversations [options]

Options:
  -p, --port <port>  Port to run the server on (default: 3456)
  -h, --help         Show this help message

Once running, open the URL shown in your browser.
`);
    process.exit(0);
  }
}

if (port) {
  process.env.CC_PORT = String(port);
}

require(path.join(__dirname, "..", "server.js"));
