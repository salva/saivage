---
name: saivage-container
description: "Manage the Saivage LXC container: start, stop, restart, deploy, rebuild, run tests, view logs, open shell, check status, get IP. Use when: operating the container, deploying changes, debugging the running service, running commands inside the container, managing the Saivage daemon. Also use whenever the user says things like 'check on saivage', 'is saivage running', 'rebuild saivage', 'saivage logs', 'SSH into the container', 'update saivage', 'restart the service', 'what is the container IP', or any mention of the LXC container, even if they don't say 'container' explicitly."
compatibility: "Requires bare LXC (not LXD), SSH access configured via 'Host saivage' in ~/.ssh/config, Ubuntu host with NVIDIA GPU optional."
allowed-tools: Bash(ssh:*) Bash(make:*) Bash(sudo:*)
metadata:
  author: salva
  version: "1.0"
---

# Saivage LXC Container Management

## Overview

Saivage runs inside a bare LXC container on the host. The host source directory is bind-mounted into the container at `/opt/saivage`, so edits on the host are immediately visible inside.

All runtime commands go through **SSH** (`ssh saivage`) — no sudo required. Only container lifecycle commands (create, start-container, stop-container, destroy) need `sudo lxc-*`.

## Architecture

- **Container name**: `saivage`
- **Base OS**: Ubuntu 25.10 (questing), matching host for NVIDIA/CUDA compatibility
- **Node.js**: 24 (via NodeSource)
- **Source mount**: host project root → `/opt/saivage` (bind mount, read-write)
- **Service**: systemd unit `saivage.service` running `node dist/index.js serve` on port 7777
- **SSH**: passwordless via `Host saivage` entry in `~/.ssh/config`
- **GPU**: NVIDIA devices bind-mounted (optional), userspace libs installed in container
- **Network**: veth on lxcbr0, static IP `10.0.3.111` (DHCP reservation via MAC `00:16:3e:5a:1e:a9`)

## Quick Reference

All commands run from `deploy/` directory. Prefer the Makefile targets.

| Task | Command |
|------|---------|
| Start daemon | `make -C deploy start` |
| Stop daemon | `make -C deploy stop` |
| Restart daemon | `make -C deploy restart` |
| View status | `make -C deploy status` |
| Tail logs | `make -C deploy logs` |
| Open shell | `make -C deploy shell` |
| Rebuild & restart | `make -C deploy deploy` |
| Run tests | `make -C deploy test` |
| Get container IP | `make -C deploy ip` |
| Container info | `make -C deploy info` |
| Open dashboard | `make -C deploy dashboard` |
| Edit config | `make -C deploy configure` |

## Common Procedures

### Run a command inside the container

```bash
ssh saivage "command here"
```

For interactive commands (like chat), use `-t` for a TTY:

```bash
ssh saivage -t "cd /opt/saivage && node dist/index.js chat"
```

### Deploy after code changes

Source is bind-mounted, so changes are already visible. Just rebuild and restart:

```bash
make -C deploy deploy
```

This runs `npm ci && npm run build` inside the container, then restarts the systemd service.

### Check if the service is healthy

```bash
ssh saivage "sudo systemctl status saivage"
```

Or check the HTTP endpoint:

```bash
CONTAINER_IP=$(make -C deploy ip)
curl -s "http://${CONTAINER_IP}:7777/health" || echo "Service not responding"
```

### View recent logs

```bash
ssh saivage "sudo journalctl -u saivage -n 50 --no-pager"
```

For live tailing:

```bash
ssh saivage "sudo journalctl -u saivage -f --no-pager"
```

### Restart after a crash

```bash
ssh saivage "sudo systemctl restart saivage"
```

Check why it crashed:

```bash
ssh saivage "sudo journalctl -u saivage -n 100 --no-pager"
```

### Full container lifecycle (first-time setup)

```bash
cd deploy
make create      # Create LXC container
make provision   # Install Node, NVIDIA libs, build, create systemd unit
make configure   # Edit saivage.json (API keys, model config)
make start       # Start the daemon
```

### Destroy the container

```bash
make -C deploy destroy
```

This prompts for confirmation before deleting.

## Troubleshooting

### SSH connection refused

The container may not be running:

```bash
sudo lxc-info -n saivage
sudo lxc-start -n saivage
```

Or SSH may not have started inside:

```bash
sudo lxc-attach -n saivage -- systemctl status ssh
```

### Container IP changed

The `Host saivage` entry in `~/.ssh/config` has a fixed IP from provisioning time. If the container gets a new IP after restart:

```bash
NEW_IP=$(sudo lxc-info -n saivage -iH | head -1)
sed -i "s/HostName .*/HostName ${NEW_IP}/" ~/.ssh/config
```

### Build failures

If `npm ci` or `npm run build` fails inside the container:

```bash
ssh saivage "cd /opt/saivage && npm ci 2>&1 | tail -30"
```

Common causes: stale `node_modules` (remove and retry), native module build issues (check `build-essential` and `python3` are installed), or disk space. The bind mount means `node_modules` lives on the host filesystem.

### Port conflict

If the service won't start because port 7777 is already in use:

```bash
ssh saivage "ss -tlnp | grep 7777"
```

Kill the conflicting process or change the port in `~/.saivage/saivage.json` inside the container.

### NVIDIA/CUDA not working

Check that the host devices are visible:

```bash
ssh saivage "ls -la /dev/nvidia*"
ssh saivage "nvidia-smi"
```

If `nvidia-smi` fails, the userspace libs may not match the host driver. Check versions:

```bash
cat /proc/driver/nvidia/version          # host
ssh saivage "dpkg -l | grep nvidia"      # container
```

## Key File Paths

- **Makefile**: `deploy/Makefile`
- **Container creation**: `deploy/scripts/create-container.sh`
- **Provisioning**: `deploy/scripts/provision.sh`
- **Default config**: `deploy/config/saivage.json`
- **LXC config** (host, needs sudo): `/var/lib/lxc/saivage/config`
- **Runtime config** (inside container): `~/.saivage/saivage.json`
- **Systemd unit** (inside container): `/etc/systemd/system/saivage.service`
- **Source** (inside container): `/opt/saivage` (bind mount of host project root)
