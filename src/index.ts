#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BASE_DIRS } from "./config.js";

// Tool registrations
import { registerDirectoryTree } from "./tools/directory-tree.js";
import { registerListDirectory } from "./tools/list-directory.js";
import { registerSearchMarkdown } from "./tools/search-markdown.js";
import { registerReadToc } from "./tools/read-toc.js";
import { registerReadSection } from "./tools/read-section.js";
import { registerReadFull } from "./tools/read-full.js";
import { registerLinkedFiles } from "./tools/linked-files.js";
import { registerBacklinks } from "./tools/backlinks.js";

// Resource registrations
import { registerVaultContext } from "./resources/vault-context.js";
import { registerServerInfo } from "./resources/server-info.js";

// MCP server instance
const server = new McpServer({
    name: "markdown-explorer-mcp",
    version: "5.0.0",
});

// Register tools
registerDirectoryTree(server);
registerListDirectory(server);
registerSearchMarkdown(server);
registerReadToc(server);
registerReadSection(server);
registerReadFull(server);
registerLinkedFiles(server);
registerBacklinks(server);

// Register resources
registerVaultContext(server);
registerServerInfo(server);

// Start server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`Markdown Explorer MCP server v5.0.0 started (BASE_DIRS: ${BASE_DIRS.join(", ")})`);
}

main().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
});
