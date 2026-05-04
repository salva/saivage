# LXC Container Deployment

This is the recommended production deployment: Saivage runs inside an
unprivileged-ish LXC container, with the source bind-mounted from the host.
The agents have shell access only inside the container, and the host source
tree updates instantly.

This page mirrors the canonical [`SETUP.md`](https://github.com/salva/saivage/blob/main/SETUP.md)
in the source tree.

## Architecture

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

## Prerequisites

- Ubuntu 24.04+ host (tested on 25.10 *questing*).
- Bare LXC: `sudo apt install lxc lxc-templates dnsmasq-base`.
- Optional: NVIDIA driver + CUDA on the host for GPU-accelerated local
  inference inside the container.
- An SSH keypair at `~/.ssh/id_ed25519` or `~/.ssh/id_rsa`.

## 1. Clone Saivage

```bash
cd ~
git clone https://github.com/salva/saivage.git
cd saivage
```

## 2. Configure host networking

```bash
sudo tee /etc/default/lxc-net > /dev/null <<'EOF'
USE_LXC_BRIDGE="true"
LXC_DHCP_CONFILE=/etc/lxc/dnsmasq-saivage.conf
EOF

sudo tee /etc/lxc/dnsmasq-saivage.conf > /dev/null <<'EOF'
dhcp-host=00:16:3e:5a:1e:a9,10.0.3.111
EOF

sudo systemctl restart lxc-net
```

## 3. Create the container

```bash
make -C deploy create
```

This:

1. Creates an Ubuntu container with `lxc-create -t download`.
2. Appends LXC config: networking, bind mounts (`~/saivage` → `/opt/saivage`),
   optional NVIDIA passthrough.
3. Creates a user inside matching your host UID/GID.
4. Starts the container.

Override defaults via env: `CONTAINER_NAME=myagent RELEASE=noble make -C deploy create`.

## 4. Provision

```bash
make -C deploy provision
```

This installs base packages, NVIDIA userspace libs (optional), Node 24, sets
up SSH, runs `npm ci && npm run build`, and registers `saivage.service`.

You can now `ssh saivage`.

## 5. Configure your target project

```bash
mkdir -p ~/myproject
cd ~/myproject
git init

mkdir -p .saivage
cat > .saivage/config.json <<'EOF'
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
    "filters": { "min_severity": "warning", "categories": [] }
  },
  "skills": { "max_per_agent": 5 }
}
EOF
```

Bind-mount the project into the container:

```ini
# Append to /var/lib/lxc/saivage/config
lxc.mount.entry = /home/youruser/myproject home/youruser/myproject none bind,create=dir 0 0
```

```bash
sudo lxc-stop -n saivage && sudo lxc-start -n saivage
```

## 6. Authenticate inside the container

```bash
ssh saivage
cd /opt/saivage
node dist/cli.js login github-copilot
```

Tokens persist in `~/.saivage/auth-profiles.json` inside the container.

## 7. Point the service at your project

```ini
# /etc/systemd/system/saivage.service (inside the container)
[Service]
ExecStart=/usr/bin/node dist/cli.js serve /home/youruser/myproject
```

```bash
ssh saivage "sudo systemctl daemon-reload && sudo systemctl restart saivage"
```

## 8. Verify

```bash
make -C deploy status
make -C deploy logs
make -C deploy dashboard
```

The Planner should begin reading objectives and producing a plan.

## Day-to-day operations

```bash
# Lifecycle
make -C deploy start
make -C deploy stop
make -C deploy restart
make -C deploy deploy        # rebuild after host edits

# Inspection
make -C deploy shell
make -C deploy ip
make -C deploy logs
```

## Networking

| Purpose      | URL / port                          |
|--------------|--------------------------------------|
| Dashboard    | `http://<container-ip>:8080`        |
| WebSocket    | `ws://<container-ip>:8080/ws`       |
| Health       | `http://<container-ip>:8080/health` |
| API          | `http://<container-ip>:8080/api/*`  |

To expose to the LAN add iptables NAT rules — see [troubleshooting](./troubleshooting).

## Uninstall

```bash
make -C deploy destroy        # destroys the LXC container
sudo rm /etc/lxc/dnsmasq-saivage.conf
sed -i '/^Host saivage$/,/^Host /{ /^Host saivage$/d; /^Host /!d }' ~/.ssh/config
rm -rf ~/saivage
```
