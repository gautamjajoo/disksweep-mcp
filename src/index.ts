#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.js";
import { report } from "./cli.js";

const cmd = process.argv[2];

if (cmd === "report") {
  report().then(
    (out) => {
      process.stdout.write(out + "\n");
    },
    (err: Error) => {
      process.stderr.write(`disksweep: ${err.message}\n`);
      process.exit(1);
    },
  );
} else if (cmd === "--version" || cmd === "-v") {
  process.stdout.write(VERSION + "\n");
} else if (cmd === "--help" || cmd === "-h") {
  process.stdout.write(`disksweep-mcp ${VERSION}

  disksweep-mcp           run the MCP server (stdio) — add it to Claude Code, Codex or Claude Desktop
  disksweep-mcp report    scan incrementally and print a read-only report (for your own routines)
`);
} else {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
