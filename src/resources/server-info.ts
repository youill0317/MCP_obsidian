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
                                "Vault-scale link health scoring with orphan/broken-link suggestions",
                                "Vault context resource with structure, recency, and tag stats",
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
                                "get_link_health",
                            ],
                            resources: [
                                "vault-context",
                                "server-info",
                            ],
                            toolRoles: {
                                search_markdown: "Discovery across filename/tags/content",
                                get_directory_tree: "Recursive structure overview",
                                list_directory: "Single-level directory listing",
                                read_markdown_full: "Read full body from known path(s)",
                                read_markdown_section: "Read section by header from known path",
                                read_markdown_toc: "Read header outline only",
                                get_linked_files: "Outgoing link analysis",
                                get_backlinks: "Incoming link analysis",
                                get_link_health: "Vault link quality score, orphan notes, and cleanup suggestions",
                            },
                            usageNotes: [
                                "Use workflow skills such as mcp-obsidian or workflow-orchestrator for detailed tool-order guidance.",
                                "This resource describes capabilities, not the full decision process.",
                            ],
                        }, null, 2),
                    },
                ],
            };
        }
    );
}
