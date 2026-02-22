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
                            description: "마크다운 전용 파일 탐색 MCP 서버",
                            baseDirs: BASE_DIRS,
                            features: [
                                "통합 검색 (search_markdown) - 파일명/태그/내용 동시 검색",
                                "검색 후 바로 읽기 (query 파라미터)",
                                "전체 헤더 검색 (read_markdown_section)",
                                "프론트매터 태그 기반 검색",
                                "목차(TOC) 추출",
                                "섹션별 부분 읽기",
                                "링크 추출 및 존재 확인",
                                "역링크(backlinks) 탐색",
                                "복수 파일 일괄 읽기",
                                "vault-context 리소스",
                            ],
                            tools: [
                                "get_directory_tree",
                                "list_directory",
                                "search_markdown (통합 검색: 파일명/태그/내용)",
                                "read_markdown_toc",
                                "read_markdown_section",
                                "read_markdown_full",
                                "get_linked_files",
                                "get_backlinks",
                            ],
                            resources: [
                                "vault-context (vault 구조/최근 파일/태그)",
                                "server-info",
                            ],
                        }, null, 2),
                    },
                ],
            };
        }
    );
}
