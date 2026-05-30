import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid(defineConfig({
  title: "Saivage",
  description:
    "Self-extending autonomous AI software-engineering agent — full project documentation",
  lang: "en-US",
  base: process.env.VITEPRESS_BASE || "/docs/",
  cleanUrls: false,
  lastUpdated: true,
  ignoreDeadLinks: true,

  head: [
    ["link", { rel: "icon", href: "/docs/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#3c8772" }],
  ],

  themeConfig: {
    siteTitle: "Saivage",
    outline: [2, 3],

    nav: [
      { text: "Guide", link: "/guide/introduction" },
      { text: "Internals", link: "/internals/architecture" },
      { text: "API Reference", link: "/api/" },
      {
        text: "v0.1.0",
        items: [
          {
            text: "GitHub",
            link: "https://github.com/salva/saivage",
          },
          {
            text: "Specifications",
            link: "/internals/specifications",
          },
        ],
      },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Getting Started",
          collapsed: false,
          items: [
            { text: "Introduction", link: "/guide/introduction" },
            { text: "Concepts", link: "/guide/concepts" },
            { text: "Quickstart", link: "/guide/quickstart" },
          ],
        },
        {
          text: "Installation",
          collapsed: false,
          items: [
            { text: "Standalone (Node.js)", link: "/guide/install-node" },
            { text: "LXC Container Deployment", link: "/guide/install-lxc" },
          ],
        },
        {
          text: "Configuration",
          collapsed: false,
          items: [
            {
              text: "Project Configuration",
              link: "/guide/config-project",
            },
            {
              text: "Runtime Configuration",
              link: "/guide/config-runtime",
            },
            { text: "LLM Providers & Auth", link: "/guide/providers" },
            { text: "Routing & Model Selection", link: "/guide/routing" },
          ],
        },
        {
          text: "Operating Saivage",
          collapsed: false,
          items: [
            { text: "Command-Line Interface", link: "/guide/cli" },
            { text: "Web Dashboard", link: "/guide/web-ui" },
            { text: "Telegram Channel", link: "/guide/telegram" },
            { text: "User Notes & Steering", link: "/guide/notes" },
            { text: "Skills", link: "/guide/skills" },
          ],
        },
        {
          text: "Operations",
          collapsed: false,
          items: [
            { text: "Monitoring & Logs", link: "/guide/monitoring" },
            { text: "Backup & Recovery", link: "/guide/backup" },
            { text: "Troubleshooting", link: "/guide/troubleshooting" },
          ],
        },
      ],

      "/internals/": [
        {
          text: "Overview",
          collapsed: false,
          items: [
            { text: "Architecture", link: "/internals/architecture" },
            { text: "Source Tree", link: "/internals/source-tree" },
            { text: "Specifications", link: "/internals/specifications" },
          ],
        },
        {
          text: "Agent Hierarchy",
          collapsed: false,
          items: [
            { text: "Agent System", link: "/internals/agents/" },
            { text: "Planner", link: "/internals/agents/planner" },
            { text: "Manager", link: "/internals/agents/manager" },
            { text: "Coder, Researcher & Data Agent", link: "/internals/agents/workers" },
            { text: "Reviewer, Designer & Critic", link: "/internals/agents/stage-scoped" },
            { text: "Inspector", link: "/internals/agents/inspector" },
            { text: "Librarian", link: "/internals/agents/librarian" },
            { text: "Chat", link: "/internals/agents/chat" },
          ],
        },
        {
          text: "Runtime Core",
          collapsed: false,
          items: [
            { text: "Runtime Details", link: "/internals/runtime/details" },
            { text: "Dispatcher & Suspend/Resume", link: "/internals/runtime/dispatcher" },
            { text: "Compaction", link: "/internals/runtime/compaction" },
            { text: "Self-Check & Loop Detection", link: "/internals/runtime/self-check" },
            { text: "Abort & Recovery", link: "/internals/runtime/abort-recovery" },
            { text: "Supervisor & Shutdown Handoff", link: "/internals/runtime/supervisor" },
            { text: "Event Bus", link: "/internals/runtime/events" },
          ],
        },
        {
          text: "Tooling & Services",
          collapsed: false,
          items: [
            { text: "MCP Runtime", link: "/internals/mcp/runtime" },
            { text: "MCP Services Catalog", link: "/internals/mcp/services" },
            { text: "Plan MCP Service", link: "/internals/mcp/plan-service" },
            { text: "Provider Router", link: "/internals/providers/router" },
            { text: "Auth & Token Stores", link: "/internals/providers/auth" },
            { text: "Document Store", link: "/internals/knowledge/store" },
            { text: "Skills & Memory", link: "/internals/knowledge/skills-and-memory" },
          ],
        },
        {
          text: "Server & Channels",
          collapsed: false,
          items: [
            { text: "HTTP / WebSocket Server", link: "/internals/server/http-ws" },
            { text: "Channels", link: "/internals/server/channels" },
            { text: "Web Dashboard Internals", link: "/internals/server/web-internals" },
          ],
        },
        {
          text: "Data Model",
          collapsed: false,
          items: [
            { text: "Types & Schemas", link: "/internals/data/types" },
            { text: "On-Disk Layout", link: "/internals/data/on-disk-layout" },
          ],
        },
        {
          text: "RAG Subsystem",
          collapsed: false,
          items: [
            { text: "Overview", link: "/internals/rag/" },
            { text: "Configuration", link: "/internals/rag/configuration" },
            { text: "On-Disk Layout", link: "/internals/rag/on-disk-layout" },
            { text: "Operational Runbook", link: "/internals/rag/operational-runbook" },
          ],
        },
        {
          text: "Contributing",
          collapsed: false,
          items: [
            { text: "Development Setup", link: "/internals/contributing/development" },
            { text: "Testing", link: "/internals/contributing/testing" },
            { text: "Release Process", link: "/internals/contributing/release" },
          ],
        },
      ],

      "/api/": [
        {
          text: "API Reference",
          link: "/api/",
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/salva/saivage" },
    ],

    search: {
      provider: "local",
    },

    footer: {
      message: "Saivage — autonomous software engineering agent.",
      copyright: "Source documentation generated with VitePress + TypeDoc.",
    },

    editLink: {
      pattern:
        "https://github.com/salva/saivage/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
  },
}));
