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
        "Search markdown files by filename, frontmatter tags, and body content.",
        {
            query: z.string().describe("Required. Single discovery query string. Keep one intent per call."),
            tag: z.string().optional().describe("Optional frontmatter tag filter (substring match, case-insensitive)."),
            filenamePattern: z.string().optional().describe("Optional filename glob filter. Supports '*' and '?'."),
            directory: z.string().optional().default(".").describe("Search root directory (must be inside BASE_DIRS)."),
            maxResults: z.number().optional().default(10).describe(`Maximum returned results (integer, clamped to 1-${MAX_RESULTS}).`),
            respectGitignore: z.boolean().optional().default(true).describe("If true, apply .gitignore and default ignore rules."),
            useRegex: z.boolean().optional().default(false).describe("If true, treat query as regex. Cannot be true with fuzzy."),
            fuzzy: z.boolean().optional().default(false).describe("If true, use fuzzy matching. Cannot be true with useRegex."),
            frontmatterFilter: z.record(z.string()).optional().describe("Optional frontmatter key-value filters (substring, case-insensitive)."),
            modifiedAfter: z.string().optional().describe("Optional ISO date filter. Include files modified after this date."),
            modifiedBefore: z.string().optional().describe("Optional ISO date filter. Include files modified before this date."),
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
                            text: `No results for "${normalizedQuery}".`,
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
