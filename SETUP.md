# Saivage Setup Guide

Complete instructions for setting up Saivage in an LXC container on a fresh Linux host, including configuring a target project for the agent to work on.

If you are working in this workspace and want Saivage to operate on the sibling `target` repo, use [deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md) for the exact container flow.

## Prerequisites

- **Host OS**: Ubuntu 24.04+ (tested on 25.10 questing)
- **Bare LXC** installed (not LXD/Incus): `sudo apt install lxc lxc-templates dnsmasq-base`
- **Node.js 24+** on the host (optional, only needed for local development)
- **SSH key pair** at `~/.ssh/id_ed25519` or `~/.ssh/id_rsa`
- **Git** installed
- An API key or OAuth credentials for at least one LLM provider (GitHub Copilot, Anthropic, OpenAI, etc.)

### Optional

- **NVIDIA GPU** with drivers installed on the host (for local model inference)
- **CUDA toolkit** on the host (the container will install matching userspace libs)

## Architecture Overview

```
┌─────────────── HOST ─────────────────┐
│                                      │
│  ~/saivage/  (source, bind-mounted)  │
│  ~/myproject/ (target project)       │
│                                      │
│  ┌──────── LXC CONTAINER ────────┐   │
│  │  /opt/saivage  ← bind mount   │   │
│  │  systemd: saivage.service     │   │
│  │  node dist/cli.js serve       │   │
│  │  port 8080 (HTTP + WebSocket) │   │
│  │  SSH access via "ssh saivage" │   │
│  └───────────────────────────────┘   │
└──────────────────────────────────────┘
```

The host source directory is bind-mounted into the container at `/opt/saivage`, so code edits on the host are immediately visible inside. The target project (the repo the agent works on) is passed as a CLI argument to the `serve` command.

## Step 1: Clone Saivage

```bash
cd ~
git clone https://github.com/salva/saivage.git
cd saivage
```

## Step 2: Configure Host Networking for LXC

Ensure the LXC bridge is enabled:

```bash
sudo tee /etc/default/lxc-net > /dev/null <<'EOF'
USE_LXC_BRIDGE="true"
LXC_DHCP_CONFILE=/etc/lxc/dnsmasq-saivage.conf
EOF
```

Create a DHCP reservation file for a static container IP:

```bash
# Pick a MAC address and IP. These must match what goes into the container config.
sudo tee /etc/lxc/dnsmasq-saivage.conf > /dev/null <<'EOF'
dhcp-host=00:16:3e:5a:1e:a9,10.0.3.111
EOF
```

Restart the LXC network:

```bash
sudo systemctl restart lxc-net
```

## Step 3: Create the Container

```bash
make -C deploy create
```

This runs `deploy/scripts/create-container.sh`, which:

1. Creates an Ubuntu container via `lxc-create -t download`
2. Appends custom LXC configuration (networking, bind mounts, GPU passthrough)
3. Creates a user inside the container matching your host UID/GID
4. Starts the container

### LXC Container Configuration

The create script appends the following to `/var/lib/lxc/saivage/config`:

```ini
# --- Saivage customizations ---

# Autostart on host boot
lxc.start.auto = 1

# Network: veth on lxcbr0 with a fixed MAC for DHCP reservation
lxc.net.0.type = veth
lxc.net.0.link = lxcbr0
lxc.net.0.flags = up
lxc.net.0.hwaddr = 00:16:3e:5a:1e:a9

# Allow container nesting (for Docker-based sandboxing if needed)
lxc.include = /usr/share/lxc/config/nesting.conf

# Drop no capabilities (needed for systemd inside container)
lxc.cap.drop =

# Bind mount: host source directory → /opt/saivage inside container
lxc.mount.entry = /home/youruser/saivage opt/saivage none bind,create=dir 0 0

# --- GPU passthrough (NVIDIA, optional) ---
# Only needed if you want GPU-accelerated inference inside the container.
# Remove these lines if you don't have an NVIDIA GPU.
lxc.mount.entry = /dev/nvidia0 dev/nvidia0 none bind,optional,create=file 0 0
lxc.mount.entry = /dev/nvidiactl dev/nvidiactl none bind,optional,create=file 0 0
lxc.mount.entry = /dev/nvidia-modeset dev/nvidia-modeset none bind,optional,create=file 0 0
lxc.mount.entry = /dev/nvidia-uvm dev/nvidia-uvm none bind,optional,create=file 0 0
lxc.mount.entry = /dev/nvidia-uvm-tools dev/nvidia-uvm-tools none bind,optional,create=file 0 0
lxc.mount.entry = /dev/nvidia-caps dev/nvidia-caps none bind,optional,create=dir 0 0
lxc.cgroup2.devices.allow = c 195:* rwm
lxc.cgroup2.devices.allow = c 507:* rwm
lxc.cgroup2.devices.allow = c 511:* rwm
```

The bind mount path is automatically set to your Saivage source directory by the create script.

### Customizing

To change container defaults, set environment variables before running make:

```bash
CONTAINER_NAME=myagent RELEASE=noble make -C deploy create
```

| Variable         | Default    | Description                           |
|------------------|------------|---------------------------------------|
| `CONTAINER_NAME` | `saivage`  | LXC container name                    |
| `DIST`           | `ubuntu`   | Distribution for lxc-create           |
| `RELEASE`        | `questing` | Release codename (25.10)              |
| `ARCH`           | `amd64`    | Architecture                          |

## Step 4: Provision the Container

```bash
make -C deploy provision
```

This runs `deploy/scripts/provision.sh`, which:

1. Installs base packages: `curl`, `ca-certificates`, `git`, `build-essential`, `python3`, `openssh-server`
2. Installs NVIDIA userspace libraries (matching host driver version, optional — failures are non-fatal)
3. Installs Node.js 24 via NodeSource
4. Configures SSH for passwordless access (copies your public key)
5. Adds a `Host saivage` entry to `~/.ssh/config` for easy SSH access
6. Runs `npm ci && npm run build` inside the container
7. Creates and enables the `saivage.service` systemd unit

After provisioning, you can SSH into the container with:

```bash
ssh saivage
```

## Step 5: Configure the Target Project

The target project is the repository that Saivage works on. It needs a `.saivage/config.json` file defining what the agent should do.

### 5a. Create or clone your target project

```bash
# Example: create a new project
mkdir -p ~/myproject
cd ~/myproject
git init
```

### 5b. Initialize Saivage configuration

Create `.saivage/config.json` in the target project:

```bash
mkdir -p ~/myproject/.saivage
cat > ~/myproject/.saivage/config.json <<'EOF'
{
  "project_name": "myproject",
  "objectives": [
    "Build a web application with a REST API and a React frontend.",
    "Implement user authentication with JWT tokens.",
    "Write comprehensive tests for all endpoints."
  ],
  "provider": "github-copilot/claude-sonnet-4",
  "model_overrides": {},
  "notifications": {
    "channels": [],
    "filters": {
      "min_severity": "warning",
      "categories": []
    }
  },
  "skills": {
    "max_per_agent": 5
  }
}
EOF
```

**Key fields:**

| Field             | Description                                                        |
|-------------------|--------------------------------------------------------------------|
| `project_name`    | Human-readable project name                                       |
| `objectives`      | Array of objectives the agent will pursue (be specific and detailed) |
| `provider`        | Default LLM model as `provider/model` (e.g. `github-copilot/claude-sonnet-4`) |
| `model_overrides` | Per-role model overrides (e.g. `{"chat": "github-copilot/gpt-4o-mini"}`) |

### 5c. Configure Saivage runtime settings

Create `~/.saivage/saivage.json` (global settings, shared across projects):

```bash
mkdir -p ~/.saivage
cat > ~/.saivage/saivage.json <<'EOF'
{
  "server": {
    "port": 8080,
    "host": "0.0.0.0"
  },
  "failover_chain": ["github-copilot", "openai-codex"],
  "chat": {
    "model": "github-copilot/gpt-4o-mini"
  }
}
EOF
```

### 5d. Authenticate with LLM providers

Run the OAuth login flow from a terminal inside the container:

```bash
ssh saivage
cd /opt/saivage

# GitHub Copilot (device code flow — opens browser on host)
node dist/cli.js login github-copilot

# OpenAI Codex (PKCE flow — opens browser on host)
node dist/cli.js login openai-codex
```

Auth tokens are stored in `~/.saivage/auth-profiles.json` inside the container. These persist across restarts.

## Step 6: Point the Service at Your Project

Edit the systemd service to serve your target project:

```bash
ssh saivage
sudo nano /etc/systemd/system/saivage.service
```

Set the `ExecStart` line to point at your project directory:

```ini
[Unit]
Description=Saivage AI Agent Server
After=network.target

[Service]
Type=simple
User=youruser
Group=youruser
WorkingDirectory=/opt/saivage
ExecStart=/usr/bin/node dist/cli.js serve /home/youruser/myproject
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

> **Note**: The project path must be accessible from inside the container. If your project is on the host, add a bind mount to the LXC config:
>
> ```ini
> # Add to /var/lib/lxc/saivage/config
> lxc.mount.entry = /home/youruser/myproject home/youruser/myproject none bind,create=dir 0 0
> ```
>
> Then restart the container: `sudo lxc-stop -n saivage && sudo lxc-start -n saivage`

Reload and start:

```bash
ssh saivage "sudo systemctl daemon-reload && sudo systemctl restart saivage"
```

## Step 7: Verify

```bash
# Check the daemon is running
make -C deploy status

# Tail logs to watch the planner start
make -C deploy logs

# Open the web dashboard
make -C deploy dashboard
```

The planner should begin reading your `config.json` objectives and creating stages.

## Day-to-Day Operations

```bash
# Start/stop/restart the daemon
make -C deploy start
make -C deploy stop
make -C deploy restart

# Rebuild after code changes (source is bind-mounted)
make -C deploy deploy

# Open a shell inside the container
make -C deploy shell

# Get the container IP
make -C deploy ip

# Start/stop the LXC container itself
make -C deploy start-container
make -C deploy stop-container
```

## Networking

The container uses a veth pair on `lxcbr0`. By default, LXC provides NAT networking — the container can reach the internet, and the host can reach the container, but external machines cannot reach the container directly.

- **Dashboard**: `http://<container-ip>:8080`
- **WebSocket chat**: `ws://<container-ip>:8080/ws`
- **Health check**: `http://<container-ip>:8080/health`
- **API**: `http://<container-ip>:8080/api/state`, `/api/plan`, etc.

To expose the dashboard to the LAN, set up port forwarding:

```bash
sudo iptables -t nat -A PREROUTING -p tcp --dport 8080 -j DNAT --to-destination 10.0.3.111:8080
sudo iptables -A FORWARD -p tcp -d 10.0.3.111 --dport 8080 -j ACCEPT
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `lxc-start` fails | Check `sudo lxc-checkconfig`. Ensure kernel supports cgroups v2. |
| Container has no network | Verify `lxcbr0` exists (`ip link show lxcbr0`). Restart `lxc-net`: `sudo systemctl restart lxc-net`. |
| SSH connection refused | Container may still be booting. Wait a few seconds. Check `sudo lxc-attach -n saivage -- systemctl status ssh`. |
| Node.js not found | Re-run `make -C deploy provision`. |
| Model not supported (400) | The model name may have changed. Check available models with the Copilot API or try a different model in `config.json`. |
| Rate limited (429) | The daemon retries automatically with exponential backoff. Wait for limits to reset. |
| Permission denied on project dir | Ensure the bind mount exists in the LXC config and the container was restarted after adding it. |
| GPU not available | GPU passthrough requires matching NVIDIA driver versions between host and container userspace libs. Check with `nvidia-smi` inside the container. |

## Uninstalling

```bash
# Stop and destroy the container (asks for confirmation)
make -C deploy destroy

# Remove SSH config entry
sed -i '/^Host saivage$/,/^Host /{ /^Host saivage$/d; /^Host /!d }' ~/.ssh/config

# Remove DHCP reservation
sudo rm /etc/lxc/dnsmasq-saivage.conf

# Remove the source directory
rm -rf ~/saivage
```
