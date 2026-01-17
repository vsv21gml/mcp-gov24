# Gov24 ChatGPT App (Apps SDK / MCP)

정부24 민원 정보를 묻는 질문을 이해해 필요한 서류를 안내하고, 정부24 바로가기 링크를 카드 형태로 제공합니다.

이 서버는 ChatGPT Apps SDK에서 사용하는 MCP(Model Context Protocol) 형태로 동작합니다.

## 빠른 시작

```bash
npm install
npm start
```

서버는 기본적으로 `http://localhost:3000/mcp`에서 MCP 세션을 제공합니다.

환경 변수:

- `GOV24_SEARCH_URL`: 정부24 검색 API URL (기본 제공)
- `GOV24_LIST_COUNT`: 검색 결과 수 (기본 10)
- `PORT`: 서버 포트 (기본 3000)

## MCP 도구

### gov24_requirements

기본 입력:

```json
{
  "message": "전세계약을 해야 되는데 필요한 서류 알려줘"
}
```

추가 입력(권장): ChatGPT가 필요한 서류를 추론해 documents로 전달합니다.

```json
{
  "documents": [
    "등기권리증",
    "신분증",
    "인감증명서",
    "인감도장",
    "주민등록초본",
    "토지대장",
    "건축물대장",
    "등기부등본"
  ]
}
```

응답:

- 정부24 바로가기 링크가 포함된 카드 목록
- 대화창 안에 위젯(UI)로 표시

## ChatGPT Apps 등록

1. ChatGPT에서 Developer mode를 켭니다.
2. Settings → Connectors에서 새 커넥터를 만들고, 공개된 MCP URL을 입력합니다.
   - 예: `https://<ngrok-subdomain>.ngrok.app/mcp`
3. 새 채팅에서 커넥터를 추가한 뒤 질문을 던지면 됩니다.

## UI 위젯

결과 UI는 `public/gov24-widget.html`에서 정의합니다. ChatGPT가 `text/html+skybridge`
리소스로 불러와 대화창 안에 렌더링합니다.
