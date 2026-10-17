---
name: saivage-development-validation
description: "Validate Saivage v2 code, docs, web UI, and local LXC-backed services after changes. Use when modifying TypeScript runtime code, Fastify/API code, Vue web components, docs, MCP tools, deployment files, or when verifying a Saivage v2 service after rebuild/restart."
---

# Saivage v2 Development Validation

## Local Validation

Run from `/home/salva/g/ml/saivage` unless the task names another checkout.

Core gates:

```bash
npm run typecheck
npm test
npm run build
npm run build:web
```

Docs gate when docs changed:

```bash
npm run docs:build
```

Use focused tests first when the changed area has targeted tests, then run the relevant broader gate.

## Web UI Checks

For Vue/component changes:

```bash
npm run build:web
```

If a browser behavior needs verification, use the project-local `webapp-testing` skill and test against the running dev server or deployed service as appropriate.

## Live Service Verification

For LXC-backed Saivage v2 services, use the project-local `saivage-container` skill.

Minimum post-restart verification:

```bash
curl -fsS --max-time 10 http://<container-ip>:8080/health
ssh root@<container-ip> 'systemctl show <service-name> -p ActiveState -p SubState -p MainPID --no-pager'
```

If root SSH is unavailable but `salva` has sudo rights:

```bash
ssh salva@<container-ip> 'sudo systemctl show <service-name> -p ActiveState -p SubState -p MainPID --no-pager'
```

## Reporting

Report the commands that passed, any failures that remain, and any validation gaps. Avoid unnecessary disclosure of secrets, token values, provider config contents, or auth profile details.
