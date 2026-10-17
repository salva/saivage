---
name: saivage-container
description: "Operate Saivage v2 services in local classic LXC containers. Use when checking health, inspecting or restarting a Saivage v2 service, viewing logs, verifying bind mounts, running commands in a container, deploying this v2 repo, or handling requests like 'restart the service', 'check saivage', 'saivage logs', 'SSH into the container', or 'what is the container IP'. Prefer this skill for Saivage v2 runtime operations, including named v2 harness instances."
compatibility: "Requires classic LXC (not LXD). Prefer SSH into containers; use sudo lxc-* only for lifecycle or SSH-repair fallback."
allowed-tools: Bash(ssh:*) Bash(make:*) Bash(sudo:*) Bash(curl:*)
metadata:
  author: salva
  version: "2.0"
---

# Saivage v2 LXC Operations

## Ground Rules

- Work from `/home/salva/g/ml` unless the task names another path.
- Read `/home/salva/g/ml/WORKSPACE_HANDOFF.md` before changing deployment/runtime state or long-running autonomous processes.
- Prefer SSH for in-container inspection and service control. Use `root@<ip>` for privileged actions when available; use `salva@<ip>` for non-privileged inspection.
- Use classic LXC commands only for container lifecycle, recovering broken SSH, reading host LXC config, or when the container has no reachable IP: `sudo lxc-ls --fancy`, `sudo lxc-info -n <container>`, `sudo lxc-attach -n <container> -- <command>`.
- Do not use `lxc exec` or `lxc list`; this host uses classic LXC tooling.
- Secret-bearing files such as `.saivage/auth-profiles.json`, `.saivage/saivage.json`, provider configs, env files, shell history, token files, or backups may be inspected or edited when authorized or needed. Avoid unnecessary disclosure of secret values in chat or logs.
- Use `/home/salva/g/ml/tmp/` for temporary artifacts that may need inspection.

## Deployment Inventory

Do not duplicate target-project-specific deployment tables in this project skill. For current container names, IPs, bind mounts, service names, and health snapshots, read `/home/salva/g/ml/WORKSPACE_HANDOFF.md` and verify live state before making changes.

Saivage v2 services usually have this shape:

- Source repo mounted at `/opt/saivage`.
- Target project mounted under `/work/<target>`.
- Systemd service usually named `saivage.service` unless the workspace handoff documents a deployment-specific unit.
- Service command shape usually `node dist/cli.js serve /work/<target>`.
- HTTP health endpoint usually `http://<container-ip>:8080/health`.

## Standard Restart Workflow

1. Probe health from the host:

```bash
curl -fsS --max-time 5 http://<container-ip>:8080/health || true
```

2. Inspect status over SSH:

```bash
ssh root@<container-ip> 'systemctl status <service-name> --no-pager --lines=20'
```

If root SSH is not available but `salva` has sudo rights:

```bash
ssh salva@<container-ip> 'sudo systemctl status <service-name> --no-pager --lines=20'
```

3. Restart only the intended service:

```bash
ssh root@<container-ip> 'systemctl restart <service-name> && systemctl is-active <service-name>'
```

or:

```bash
ssh salva@<container-ip> 'sudo systemctl restart <service-name> && systemctl is-active <service-name>'
```

4. Verify systemd and health:

```bash
ssh root@<container-ip> 'systemctl show <service-name> -p ActiveState -p SubState -p MainPID --no-pager'
curl -fsS --max-time 10 http://<container-ip>:8080/health
```

## Host-Key Handling

If SSH reaches the container but fails host-key verification, do not edit global SSH config or known_hosts casually. Use a workspace-local known-hosts file for the operation:

```bash
ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/home/salva/g/ml/tmp/<container>-known-hosts <user>@<container-ip> '<command>'
```

## Deploy This v2 Repo After Code Changes

For the primary v2 deployment managed by this repo's `deploy/` Makefile, prefer the project targets:

```bash
make -C deploy deploy
make -C deploy status
make -C deploy logs
```

`make -C deploy deploy` rebuilds inside the deployment environment and restarts the service. For named harness instances documented in the workspace handoff, build the mounted `/opt/saivage` repo as required by that deployment before restarting its service.

## Logs And Process Inspection

```bash
ssh root@<container-ip> 'journalctl -u <service-name> -n 120 --no-pager'
ssh root@<container-ip> 'ps -ef | grep -E "node|saivage" | grep -v grep'
ssh root@<container-ip> 'ss -ltnp | grep -E ":8080|node" || true'
```

## LXC Fallback

Use these only when SSH or health probing is unavailable, or for container lifecycle:

```bash
sudo lxc-ls --fancy
sudo lxc-info -n <container>
sudo lxc-attach -n <container> -- systemctl status <service-name> --no-pager --lines=20
```

If SSH is broken, copy the container user's authorized public keys into root's authorized keys via `lxc-attach`. Do not print private keys or token material.

```bash
CT=<container>
sudo lxc-attach -n "$CT" -- sh -lc 'set -eu; mkdir -p /root/.ssh; chmod 700 /root/.ssh; touch /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys; if [ -f /home/salva/.ssh/authorized_keys ]; then while IFS= read -r key; do [ -n "$key" ] || continue; grep -qxF "$key" /root/.ssh/authorized_keys || printf "%s\n" "$key" >> /root/.ssh/authorized_keys; done < /home/salva/.ssh/authorized_keys; fi; chown -R root:root /root/.ssh'
sudo lxc-attach -n "$CT" -- systemctl restart ssh.service
```

## Local v2 Container Makefile Reference

When operating the primary project-local container, these targets may be available:

| Task | Command |
| --- | --- |
| Start daemon | `make -C deploy start` |
| Stop daemon | `make -C deploy stop` |
| Restart daemon | `make -C deploy restart` |
| View status | `make -C deploy status` |
| Tail logs | `make -C deploy logs` |
| Open shell | `make -C deploy shell` |
| Rebuild and restart | `make -C deploy deploy` |
| Run tests | `make -C deploy test` |
| Get container IP | `make -C deploy ip` |
| Container info | `make -C deploy info` |
