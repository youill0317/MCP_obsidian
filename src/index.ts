#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// MCP 서버 인스턴스 생성
const server = new McpServer({
    name: "my-mcp-server",
    version: "1.0.0",
});

// ============================================
// 도구(Tool) 정의 예시
// ============================================

// 예시 1: 간단한 인사 도구
server.tool(
    "greet",
    "사용자에게 인사를 합니다",
    {
        name: z.string().describe("인사할 대상의 이름"),
    },
    async ({ name }) => {
        return {
            content: [
                {
                    type: "text",
                    text: `안녕하세요, ${name}님! MCP 서버가 정상 작동 중입니다. 🎉`,
                },
            ],
        };
    }
);

// 예시 2: 현재 시간 반환 도구
server.tool(
    "get_current_time",
    "현재 시간을 반환합니다",
    {},
    async () => {
        const now = new Date();
        return {
            content: [
                {
                    type: "text",
                    text: `현재 시간: ${now.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
                },
            ],
        };
    }
);

// 예시 3: 두 숫자 계산 도구
server.tool(
    "calculate",
    "두 숫자의 사칙연산을 수행합니다",
    {
        a: z.number().describe("첫 번째 숫자"),
        b: z.number().describe("두 번째 숫자"),
        operation: z.enum(["add", "subtract", "multiply", "divide"]).describe("연산 종류"),
    },
    async ({ a, b, operation }) => {
        let result: number;
        switch (operation) {
            case "add":
                result = a + b;
                break;
            case "subtract":
                result = a - b;
                break;
            case "multiply":
                result = a * b;
                break;
            case "divide":
                if (b === 0) {
                    return {
                        content: [{ type: "text", text: "오류: 0으로 나눌 수 없습니다." }],
                        isError: true,
                    };
                }
                result = a / b;
                break;
        }
        return {
            content: [
                {
                    type: "text",
                    text: `계산 결과: ${a} ${operation} ${b} = ${result}`,
                },
            ],
        };
    }
);

// ============================================
// 리소스(Resource) 정의 예시
// ============================================

server.resource(
    "server-info",
    "mcp://my-mcp-server/info",
    async (uri) => {
        return {
            contents: [
                {
                    uri: uri.href,
                    mimeType: "application/json",
                    text: JSON.stringify({
                        name: "my-mcp-server",
                        version: "1.0.0",
                        description: "나만의 MCP 서버",
                        author: "user",
                    }, null, 2),
                },
            ],
        };
    }
);

// ============================================
// 서버 시작
// ============================================

async function main() {
    // stdio 전송 방식 사용 (클라이언트와 표준 입출력으로 통신)
    const transport = new StdioServerTransport();

    // 서버 연결
    await server.connect(transport);

    console.error("MCP 서버가 시작되었습니다.");
}

main().catch((error) => {
    console.error("서버 시작 실패:", error);
    process.exit(1);
});
