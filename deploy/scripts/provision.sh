#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-saivage}"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
HOST_USER="$(whoami)"
TARGET_PROJECT_MOUNT="${TARGET_PROJECT_MOUNT:-/work/target}"

run() {
    sudo lxc-attach -n "$CONTAINER_NAME" -- "$@"
}

run_as() {
    sudo lxc-attach -n "$CONTAINER_NAME" -- su - "$HOST_USER" -c "$1"
}

echo "==> Updating package lists..."
run apt-get update

echo "==> Installing base dependencies..."
run apt-get install -y \
    curl \
    ca-certificates \
    git \
    build-essential \
    python3 \
    xvfb \
    openssh-server

echo "==> Installing NVIDIA userspace libraries (matching host driver)..."
# The kernel module is shared from the host. We only need matching userspace libs.
# Install the CUDA toolkit to match host CUDA 12.9.
run bash -c '
    apt-get install -y nvidia-utils-580 libnvidia-compute-580 || true
    curl -fsSL https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2504/x86_64/cuda-keyring_1.1-1_all.deb -o /tmp/cuda-keyring.deb
    dpkg -i /tmp/cuda-keyring.deb
    rm /tmp/cuda-keyring.deb
    apt-get update
    apt-get install -y cuda-toolkit-12-9 || true
'

echo "==> Installing Node.js 24 via NodeSource..."
run bash -c '
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs
'

echo "==> Verifying Node.js installation..."
run node --version
run npm --version

echo "==> Configuring SSH for passwordless access..."
run bash -c '
    sed -i "s/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/" /etc/ssh/sshd_config
    sed -i "s/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/" /etc/ssh/sshd_config
    systemctl enable ssh
    systemctl restart ssh
'

# Copy host user's SSH public key into container
echo "==> Setting up SSH key for ${HOST_USER}..."
run bash -c "
    mkdir -p /home/${HOST_USER}/.ssh
    chmod 700 /home/${HOST_USER}/.ssh
    chown ${HOST_USER}:${HOST_USER} /home/${HOST_USER}/.ssh
"
SSH_KEY=""
for keyfile in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub"; do
    if [ -f "$keyfile" ]; then
        SSH_KEY="$keyfile"
        break
    fi
done
if [ -n "$SSH_KEY" ]; then
    cat "$SSH_KEY" | run bash -c "
        tee /home/${HOST_USER}/.ssh/authorized_keys > /dev/null
        chmod 600 /home/${HOST_USER}/.ssh/authorized_keys
        chown ${HOST_USER}:${HOST_USER} /home/${HOST_USER}/.ssh/authorized_keys
    "
    echo "    Installed $(basename "$SSH_KEY")"
else
    echo "    WARNING: No SSH public key found (~/.ssh/id_ed25519.pub or id_rsa.pub)."
    echo "    Copy your key manually into the container."
fi

# Add container to host SSH config for easy access
CONTAINER_IP=$(sudo lxc-info -n "$CONTAINER_NAME" -iH 2>/dev/null | head -1)
if [ -n "$CONTAINER_IP" ]; then
    echo "==> Container IP: ${CONTAINER_IP}"
    # Update or add SSH config entry
    SSH_CONFIG="$HOME/.ssh/config"
    if grep -q "^Host saivage$" "$SSH_CONFIG" 2>/dev/null; then
        echo "    SSH config entry 'saivage' already exists — updating..."
        # Remove existing block (from "Host saivage" to next "Host " or EOF)
        sed -i '/^Host saivage$/,/^Host /{/^Host saivage$/d;/^Host /!d}' "$SSH_CONFIG"
    fi
    cat >> "$SSH_CONFIG" <<SSHEOF

Host saivage
    HostName ${CONTAINER_IP}
    User ${HOST_USER}
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
    LogLevel ERROR
SSHEOF
    chmod 600 "$SSH_CONFIG"
    echo "    Added 'Host saivage' to ~/.ssh/config (ssh saivage)"
fi

echo "==> Source is bind-mounted at /opt/saivage — no sync needed."

echo "==> Installing npm dependencies..."
run_as "cd /opt/saivage && npm ci"
run_as "cd /opt/saivage/web && npm ci"

echo "==> Installing Playwright browser dependencies for headless MCP..."
run_as "cd /opt/saivage && npx -y playwright@latest install --with-deps chromium" || \
    echo "    WARNING: Playwright browser installation failed; Data Agent can still use built-in data MCP tools."

echo "==> Building Saivage..."
run_as "cd /opt/saivage && npm run build"

echo "==> Verifying build..."
run_as "cd /opt/saivage && node dist/cli.js --version" || true

echo "==> Creating systemd service..."
run tee /etc/systemd/system/saivage.service > /dev/null <<EOF
[Unit]
Description=Saivage AI Agent Server
After=network.target

[Service]
Type=simple
User=${HOST_USER}
Group=${HOST_USER}
WorkingDirectory=/opt/saivage
ExecStart=/usr/bin/node dist/cli.js serve ${TARGET_PROJECT_MOUNT}
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

run systemctl daemon-reload
run systemctl enable saivage

echo "==> Provisioning complete."
echo ""
echo "  Configure:  make configure  (edit /opt/saivage/.saivage/saivage.json)"
echo "  Project:    ${TARGET_PROJECT_MOUNT}"
echo "  Start:      make start"
echo "  Logs:       make logs"
echo "  Chat:       make chat"
echo "  Dashboard:  make dashboard"
