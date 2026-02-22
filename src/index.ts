#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BASE_DIRS } from "./config.js";

// 도구 등록
import { registerDirectoryTree } from "./tools/directory-tree.js";
import { registerListDirectory } from "./tools/list-directory.js";
import { registerSearchMarkdown } from "./tools/search-markdown.js";
import { registerReadToc } from "./tools/read-toc.js";
import { registerReadSection } from "./tools/read-section.js";
import { registerReadFull } from "./tools/read-full.js";
import { registerLinkedFiles } from "./tools/linked-files.js";
import { registerBacklinks } from "./tools/backlinks.js";

// 리소스 등록
import { registerVaultContext } from "./resources/vault-context.js";
import { registerServerInfo } from "./resources/server-info.js";

// MCP 서버 인스턴스 생성
const server = new McpServer({
    name: "markdown-explorer-mcp",
    version: "5.0.0",
});

// 도구 등록
registerDirectoryTree(server);
registerListDirectory(server);
registerSearchMarkdown(server);
registerReadToc(server);
registerReadSection(server);
registerReadFull(server);
registerLinkedFiles(server);
registerBacklinks(server);

// 리소스 등록
registerVaultContext(server);
registerServerInfo(server);

// 서버 시작
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`Markdown Explorer MCP 서버 v5.0.0 시작 (BASE_DIRS: ${BASE_DIRS.join(", ")})`);
}

main().catch((error) => {
    console.error("서버 시작 실패:", error);
    process.exit(1);
});
