import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_RESULTS } from "../config.js";
import { searchMarkdownFiles } from "../core/markdown-search.js";
import {
    normalizeAndValidatePath,
    accessDeniedError,
    createErrorResponse,
    pathNotFoundError,
    exists,
} from "../utils.js";

function parseOptionalDate(value: string | undefined, label: string): Date | null {
    if (!value) {
        return null;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid date format (${label}): ${value}`);
    }
    return parsed;
}

export function registerSearchMarkdown(server: McpServer) {
    server.tool(
        "search_markdown",
        "Unified markdown discovery tool. Searches filename, frontmatter tags, and content in one call. For multiple independent searches, call this tool multiple times.",
        {
            query: z.string().describe("Single search query text."),
            tag: z.string().optional().describe("Optional tag filter (substring match, case-insensitive)."),
            filenamePattern: z.string().optional().describe("Optional filename glob pattern filter (* and ? supported)."),
            directory: z.string().optional().default(".").describe("Search root directory. Defaults to base directory."),
            maxResults: z.number().optional().default(10).describe(`Maximum results to return (1-${MAX_RESULTS}).`),
            respectGitignore: z.boolean().optional().default(true).describe("Apply .gitignore rules."),
            useRegex: z.boolean().optional().default(false).describe("Treat query as regex if true."),
            fuzzy: z.boolean().optional().default(false).describe("Enable fuzzy matching if true. Cannot be used with useRegex."),
            frontmatterFilter: z.record(z.string()).optional().describe("Filter by frontmatter key/value substring matches."),
            modifiedAfter: z.string().optional().describe("Only include files modified after this ISO date."),
            modifiedBefore: z.string().optional().describe("Only include files modified before this ISO date."),
        },
        async ({
            query,
            tag,
            filenamePattern,
            directory,
            maxResults,
            respectGitignore,
            useRegex,
            fuzzy,
            frontmatterFilter,
            modifiedAfter,
            modifiedBefore,
        }) => {
            try {
                const validatedPath = normalizeAndValidatePath(directory);
                if (validatedPath === null) {
                    return accessDeniedError(directory);
                }
                const normalizedPath = validatedPath;

                if (!(await exists(normalizedPath))) {
                    return pathNotFoundError(normalizedPath);
                }

                if (!query || query.trim().length === 0) {
                    return createErrorResponse("query must be a non-empty string.");
                }

                const afterDate = parseOptionalDate(modifiedAfter, "modifiedAfter");
                const beforeDate = parseOptionalDate(modifiedBefore, "modifiedBefore");

                const { normalizedQuery, results } = await searchMarkdownFiles({
                    rootDir: normalizedPath,
                    query,
                    maxResults,
                    respectGitignore,
                    useRegex,
                    fuzzy,
                    tag,
                    filenamePattern,
                    frontmatterFilter,
                    modifiedAfter: afterDate,
                    modifiedBefore: beforeDate,
                    contentSampleBytes: 8192,
                    contentMatchLimit: 3,
                });

                if (results.length === 0) {
                    return {
                        content: [{
                            type: "text",
                            text: `No results for "${normalizedQuery}".\n\nSuggestions:\n  - Try a different query\n  - Run get_directory_tree to inspect the folder structure`,
                        }],
                        structuredContent: {
                            query: normalizedQuery,
                            totalResults: 0,
                            results: [],
                        },
                    };
                }

                const filenameMatches = results.filter((item) => item.matchTypes.includes("filename"));
                const tagMatches = results.filter((item) => item.matchTypes.includes("tag"));
                const contentMatches = results.filter((item) => item.matchTypes.includes("content"));

                let output = `"${normalizedQuery}" search results (${results.length}):\n\n`;

                if (filenameMatches.length > 0) {
                    output += `[Filename] (${filenameMatches.length}):\n`;
                    filenameMatches.forEach((item) => {
                        output += `  - ${item.path}\n`;
                    });
                    output += "\n";
                }

                if (tagMatches.length > 0) {
                    output += `[Tags] (${tagMatches.length}):\n`;
                    tagMatches.forEach((item) => {
                        output += `  - ${item.path} (tags: [${item.tags.join(", ")}])\n`;
                    });
                    output += "\n";
                }

                if (contentMatches.length > 0) {
                    output += `[Content] (${contentMatches.length}):\n`;
                    contentMatches.forEach((item) => {
                        const firstMatch = item.contentMatches[0];
                        if (!firstMatch) {
                            return;
                        }
                        const snippet = firstMatch.text.length > 60
                            ? `${firstMatch.text.substring(0, 60)}...`
                            : firstMatch.text;
                        output += `  - ${item.path}:L${firstMatch.line}: "${snippet}"\n`;
                    });
                }

                return {
                    content: [{ type: "text", text: output.trim() }],
                    structuredContent: {
                        query: normalizedQuery,
                        totalResults: results.length,
                        results: results.map((item) => ({
                            path: item.path,
                            relativePath: item.relativePath,
                            fileName: item.fileName,
                            matchTypes: item.matchTypes,
                            score: item.score,
                            tags: item.tags,
                            contentMatches: item.contentMatches,
                        })),
                    },
                };
            } catch (error) {
                return createErrorResponse(error instanceof Error ? error.message : String(error));
            }
        }
    );
}
