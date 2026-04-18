#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as cheerio from "cheerio";

const MAX_CONTENT = 100_000;

const server = new McpServer({ name: "web", version: "0.1.0" });

server.tool(
  "fetch_url",
  "Fetch the raw content of a URL",
  {
    url: z.string().url().describe("URL to fetch"),
    headers: z.record(z.string(), z.string()).default({}).describe("Extra headers"),
    maxBytes: z.number().default(MAX_CONTENT).describe("Max response bytes"),
  },
  async ({ url, headers, maxBytes }) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      const res = await fetch(url, {
        headers: {
          "User-Agent": "Saivage/0.1.0",
          ...headers,
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const text = await res.text();
      const truncated = text.slice(0, maxBytes);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: res.status,
              contentType: res.headers.get("content-type"),
              body: truncated,
              truncated: text.length > maxBytes,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "fetch_page_content",
  "Fetch a web page and extract its main text content (HTML stripped)",
  {
    url: z.string().url().describe("URL to fetch"),
    selector: z.string().default("body").describe("CSS selector for content extraction"),
    maxLength: z.number().default(50_000).describe("Max content length"),
  },
  async ({ url, selector, maxLength }) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      const res = await fetch(url, {
        headers: { "User-Agent": "Saivage/0.1.0" },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const html = await res.text();
      const $ = cheerio.load(html);

      // Remove noise
      $("script, style, nav, header, footer, aside, .ads, .sidebar").remove();

      const text = $(selector)
        .text()
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);

      const title = $("title").text().trim();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              title,
              url,
              content: text,
              truncated: text.length >= maxLength,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
