import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BASE_DIRS } from "../config.js";

export function registerServerInfo(server: McpServer) {
    server.resource(
        "server-info",
        "mcp://markdown-explorer-mcp/info",
        async (uri) => {
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: "application/json",
                        text: JSON.stringify({
                            name: "markdown-explorer-mcp",
                            version: "5.0.0",
                            description: "MCP server for markdown discovery, reading, and link analysis.",
                            baseDirs: BASE_DIRS,
                            features: [
                                "Unified search across filename, frontmatter tags, and content",
                                "Directory navigation with markdown and gitignore filters",
                                "TOC extraction and section-level reading",
                                "Full markdown reading with frontmatter parsing",
                                "Link extraction and backlink discovery",
                                "Vault context resource with structure, recency, and tag stats",
                                "Clear responsibility split: search for discovery, read tools for explicit file reads",
                            ],
                            tools: [
                                "get_directory_tree",
                                "list_directory",
                                "search_markdown",
                                "read_markdown_toc",
                                "read_markdown_section",
                                "read_markdown_full",
                                "get_linked_files",
                                "get_backlinks",
                            ],
                            resources: [
                                "vault-context",
                                "server-info",
                            ],
                        }, null, 2),
                    },
                ],
            };
        }
    );
}
