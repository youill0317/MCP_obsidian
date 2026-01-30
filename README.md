# My MCP Server

나만의 MCP (Model Context Protocol) 서버입니다.

## 설치

```bash
npm install
```

## 빌드

```bash
npm run build
```

## 실행

```bash
npm start
```

## 클라이언트 설정

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "my-mcp-server": {
      "command": "node",
      "args": ["c:\\Users\\user\\Documents\\Projects_src\\My_mcp\\dist\\index.js"]
    }
  }
}
```

### VS Code (Gemini Code Assist 등)

설정에서 MCP 서버 경로를 위와 동일하게 지정합니다.

## 제공 도구 (Tools)

| 도구명 | 설명 |
|--------|------|
| `greet` | 사용자에게 인사 |
| `get_current_time` | 현재 시간 반환 |
| `calculate` | 두 숫자 사칙연산 |

## 제공 리소스 (Resources)

| 리소스 | URI |
|--------|-----|
| `server-info` | `mcp://my-mcp-server/info` |

## 개발

```bash
# 개발 모드 (파일 변경 시 자동 빌드)
npm run dev
```
