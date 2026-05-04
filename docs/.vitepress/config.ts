import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Saivage",
  description:
    "Self-extending autonomous AI software-engineering agent — full project documentation",
  lang: "en-US",
  base: "/",
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,

  head: [
    ["link", { rel: "icon", href: "/favicon.svg" }],
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
            { text: "Agent System", link: "/internals/agents" },
            { text: "Planner", link: "/internals/agent-planner" },
            { text: "Manager", link: "/internals/agent-manager" },
            { text: "Coder & Researcher", link: "/internals/agent-workers" },
            { text: "Inspector", link: "/internals/agent-inspector" },
            { text: "Chat", link: "/internals/agent-chat" },
          ],
        },
        {
          text: "Runtime Core",
          collapsed: false,
          items: [
            { text: "Dispatcher & Suspend/Resume", link: "/internals/dispatcher" },
            { text: "Compaction", link: "/internals/compaction" },
            { text: "Self-Check & Loop Detection", link: "/internals/self-check" },
            { text: "Abort & Recovery", link: "/internals/abort-recovery" },
            { text: "Supervisor & Shutdown Handoff", link: "/internals/supervisor" },
            { text: "Event Bus", link: "/internals/events" },
          ],
        },
        {
          text: "Tooling & Services",
          collapsed: false,
          items: [
            { text: "MCP Runtime", link: "/internals/mcp-runtime" },
            { text: "MCP Services Catalog", link: "/internals/mcp-services" },
            { text: "Plan MCP Service", link: "/internals/plan-mcp" },
            { text: "Provider Router", link: "/internals/provider-router" },
            { text: "Auth & Token Stores", link: "/internals/auth" },
            { text: "Document Store", link: "/internals/store" },
            { text: "Skill Loader", link: "/internals/skill-loader" },
            { text: "Security: Prompt-Injection Cop", link: "/internals/security" },
          ],
        },
        {
          text: "Server & Channels",
          collapsed: false,
          items: [
            { text: "HTTP / WebSocket Server", link: "/internals/server" },
            { text: "Channels", link: "/internals/channels" },
            { text: "Web Dashboard Internals", link: "/internals/web-internals" },
          ],
        },
        {
          text: "Data Model",
          collapsed: false,
          items: [
            { text: "Types & Schemas", link: "/internals/data-model" },
            { text: "On-Disk Layout", link: "/internals/on-disk-layout" },
          ],
        },
        {
          text: "Contributing",
          collapsed: false,
          items: [
            { text: "Development Setup", link: "/internals/development" },
            { text: "Testing", link: "/internals/testing" },
            { text: "Release Process", link: "/internals/release" },
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
});
