import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_PATH = process.env.MCP_PATH || '/gov24/mcp';
const PORT = Number(process.env.PORT || 3000);
const WIDGET_URI = 'ui://gov24/widget.html';
const GOV24_SEARCH_URL =
  process.env.GOV24_SEARCH_URL ||
  'https://plus.gov.kr/api/iwcas/guide/v1.0/search/mergeResult';
const GOV24_LIST_COUNT = Number(process.env.GOV24_LIST_COUNT || 10);

const widgetHtml = fs.readFileSync(
  path.join(__dirname, 'public', 'gov24-widget.html'),
  'utf8'
);

const inputSchema = {
  message: z.string().min(1),
  documents: z.array(z.string()).optional(),
  items: z
    .array(
      z.union([
        z.string(),
        z.object({
          id: z.string().optional(),
          title: z.string(),
          summary: z.string().optional(),
          required_documents: z.array(z.string()).optional(),
          links: z
            .array(
              z.object({
                label: z.string().optional(),
                url: z.string()
              })
            )
            .optional()
        })
      ])
    )
    .optional()
};

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function normalize(text) {
  return (text || '').toLowerCase();
}

function normalizeGov24Url(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return null;
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  if (value.startsWith('//')) {
    return `https:${value}`;
  }
  if (value.startsWith('/')) {
    return `https://www.gov.kr${value}`;
  }
  return `https://www.gov.kr/${value}`;
}

function mapGov24Result(row) {
  const title =
    stripHtml(row.TITLE) ||
    stripHtml(row.PRCS_TYPE_NM) ||
    stripHtml(row.SERVICE_NM) ||
    stripHtml(row.SERVICE_NAME) ||
    '';
  const summary =
    stripHtml(row.CONTENT) ||
    stripHtml(row.DSBLTY_CN) ||
    stripHtml(row.DEPARTMENT) ||
    '';
  const link = normalizeGov24Url(
    row.GOV24_URL ||
      row.DETAIL_URL ||
      row.SITE_MVMN_URL ||
      row.BUTTON_URL ||
      row.MOBILE_URL ||
      ''
  );

  return {
    id: row.DOCID || row.SERVICE_ID || row.SRVC_ID || undefined,
    title: title || '정부24 민원',
    summary: summary || undefined,
    required_documents: undefined,
    links: link
      ? [
          {
            label: '정부24 바로가기',
            url: link
          }
        ]
      : undefined
  };
}

async function searchGov24Services(message, strictMatch = false) {
  if (!GOV24_SEARCH_URL) return [];

  const payload = {
    query: message,
    startCount: '0',
    listCount: String(GOV24_LIST_COUNT),
    collections: 'IW_SERVICE',
    sortField: 'WEIGHT/DESC,RANK/DESC,INQ_CNT/DESC,TYPE_SN/ASC,UID/ASC',
    docId: ''
  };

  try {
    const response = await fetch(GOV24_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      console.warn('[gov24_search] request failed', response.status);
      return [];
    }
    const data = await response.json();
    const list =
      data?.searchMergeResult?.MERGE_COLLECTION ||
      data?.searchMergeResult?.IW_SERVICE ||
      [];
    const normalizedQuery = normalize(message);
    const seen = new Set();
    const results = [];

    for (const row of list) {
      if (!row.GOV24_URL) {
        continue;
      }
      const item = mapGov24Result(row);
      const key = `${item.title}|${item.links?.[0]?.url || ''}`;
      if (!item.title || seen.has(key)) {
        continue;
      }
      if (normalizedQuery && !normalize(item.title).includes(normalizedQuery)) {
        continue;
      }
      seen.add(key);
      results.push(item);
    }

    if (!results.length && !strictMatch) {
      for (const row of list) {
        if (!row.GOV24_URL) {
          continue;
        }
        const item = mapGov24Result(row);
        const key = `${item.title}|${item.links?.[0]?.url || ''}`;
        if (!item.title || seen.has(key)) {
          continue;
        }
        seen.add(key);
        results.push(item);
      }
    }

    return results.slice(0, 1);
  } catch (error) {
    console.error('[gov24_search] fetch error', error);
    return [];
  }
}

function gov24SearchLink(query) {
  const encoded = encodeURIComponent(query);
  return {
    label: '정부24 검색',
    url: `https://www.gov.kr/portal/search?searchQuery=${encoded}`
  };
}

function normalizeItems(items) {
  return items.map((item) => {
    const hasLinks = Array.isArray(item.links) && item.links.length;
    if (hasLinks) {
      return item;
    }
    return {
      ...item,
      links: [gov24SearchLink(item.title)]
    };
  });
}

function extractItemQueries(items) {
  if (!items) return [];
  const queries = [];
  for (const entry of items) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text) queries.push(text);
      continue;
    }
    if (entry && typeof entry.title === 'string') {
      const text = entry.title.trim();
      if (text) queries.push(text);
    }
  }
  return queries;
}

function extractDocumentQueries(documents) {
  if (!Array.isArray(documents)) return [];
  return documents.map((doc) => String(doc || '').trim()).filter(Boolean);
}

function buildReply(message, matches) {
  if (!matches.length) {
    return [
      '요청하신 민원이 명확하지 않아요.',
      '예: "전세계약 할 건데 필요한 서류 알려줘", "가족관계증명서 발급"처럼 구체적으로 말씀해 주세요.'
    ].join('\n');
  }

  const lines = [];
  lines.push('아래 민원과 발급 필요 서류를 정리했어요. 상세 요건은 신청 페이지에서 다시 확인해 주세요.');

  matches.forEach((item, index) => {
    lines.push('');
    lines.push(`${index + 1}) ${item.title}`);
    if (item.summary) {
      lines.push(`- 안내: ${item.summary}`);
    }
    if (item.required_documents && item.required_documents.length) {
      lines.push(`- 필요 서류: ${item.required_documents.join(', ')}`);
    }
    if (item.links && item.links.length) {
      lines.push('- 바로가기:');
      item.links.forEach((link) => {
        lines.push(`  - ${link.label}: ${link.url}`);
      });
    }
  });

  lines.push('');
  lines.push('추가로 상황(전입 예정일, 세대 분리 여부 등)을 알려주면 더 정확히 안내할게요.');
  return lines.join('\n');
}

function createGov24Server() {
  const server = new McpServer({ name: 'gov24-connector', version: '0.2.0' });

  server.registerResource(
    'gov24-widget',
    WIDGET_URI,
    {},
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: 'text/html+skybridge',
          text: widgetHtml,
          _meta: { 'openai/widgetPrefersBorder': true }
        }
      ]
    })
  );

  server.registerTool(
    'gov24_requirements',
    {
      title: '정부24 민원 서류 안내',
      description:
        '필요 서류를 추론할 수 있으면 documents 배열로 전달하세요. (예: ["등기권리증","인감증명서"])\n' +
        'documents/items가 없으면 message를 그대로 검색합니다.\n' +
        '예시1) 질문: "건물 팔려고 하는데 필요한 서류?"\n' +
        '호출: {"documents":["등기권리증","신분증","인감증명서","인감도장","주민등록초본","토지대장","건축물대장","등기부등본"]}\n' +
        '예시2) 질문: "주민등록등본 발급"\n' +
        '호출: {"documents":["주민등록표등본(초본)교부"]}',
      inputSchema,
      _meta: {
        'openai/outputTemplate': WIDGET_URI,
        'openai/toolInvocation/invoking': '정부24 민원 분석 중',
        'openai/toolInvocation/invoked': '정부24 민원 분석 완료'
      }
    },
    async (args) => {
      console.log('[gov24_requirements] args:', JSON.stringify(args));
      const items = Array.isArray(args?.items) ? args.items : null;
      const documents = Array.isArray(args?.documents) ? args.documents : null;
      const message = args?.message?.trim?.() ?? '';
      if (!message && !items && !documents) {
        console.warn('[gov24_requirements] empty input');
      }

      const itemQueries = items ? extractItemQueries(items) : [];
      const documentQueries = documents ? extractDocumentQueries(documents) : [];
      const queries = itemQueries.length
        ? itemQueries
        : documentQueries.length
          ? documentQueries
          : message
            ? [message]
            : [];
      const matchesRaw = [];
      const seen = new Set();

      for (const query of queries) {
        const strictMatch = Boolean(items || documents);
        const results = await searchGov24Services(query, strictMatch);
        if (!results.length) continue;
        for (const item of results) {
          const key = `${item.title}|${item.links?.[0]?.url || ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          matchesRaw.push(item);
        }
      }

      const matches = matchesRaw.length > 0 ? normalizeItems(matchesRaw) : [];
      console.log('[gov24_requirements] message:', message);
      console.log('[gov24_requirements] matches:', matches.length);
      const reply = buildReply(message, matches);

      if (!matches.length) {
        console.warn('[gov24_requirements] no matches for message');
        return {
          content: [],
          structuredContent: {
            message,
            reply: '검색 결과가 없습니다.',
            matches: []
          },
          isError: true
        };
      }

      return {
        content: [],
        structuredContent: {
          message,
          reply,
          matches
        }
      };
    }
  );

  return server;
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end('Missing URL');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS' && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, mcp-session-id',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Gov24 MCP server');
    return;
  }

  const mcpMethods = new Set(['POST', 'GET', 'DELETE']);
  if (url.pathname === MCP_PATH && req.method && mcpMethods.has(req.method)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    const server = createGov24Server();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    res.on('close', () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.writeHead(500).end('Internal server error');
      }
    }
    return;
  }

  res.writeHead(404).end('Not Found');
});

httpServer.listen(PORT, () => {
  console.log(`Gov24 MCP server listening on http://localhost:${PORT}${MCP_PATH}`);
});
