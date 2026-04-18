#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-saivage}"
DIST="${DIST:-ubuntu}"
RELEASE="${RELEASE:-questing}"
ARCH="${ARCH:-amd64}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SAIVAGE_SRC="${PROJECT_ROOT:-$(dirname "$PROJECT_DIR")}"
ROOTFS="/var/lib/lxc/${CONTAINER_NAME}/rootfs"
LXC_CONF="/var/lib/lxc/${CONTAINER_NAME}/config"

if sudo lxc-info -n "$CONTAINER_NAME" &>/dev/null; then
    echo "==> Container '${CONTAINER_NAME}' already exists."
    STATE=$(sudo lxc-info -n "$CONTAINER_NAME" -s | awk '{print $2}')
    if [ "$STATE" != "RUNNING" ]; then
        echo "    Starting container..."
        sudo lxc-start -n "$CONTAINER_NAME"
    fi
else
    echo "==> Creating container '${CONTAINER_NAME}' (${DIST}/${RELEASE}/${ARCH})..."
    sudo lxc-create -t download -n "$CONTAINER_NAME" -- \
        -d "$DIST" -r "$RELEASE" -a "$ARCH"

    echo "==> Applying container configuration..."
    sudo tee -a "$LXC_CONF" > /dev/null <<'EOF'

# --- Saivage customizations ---
# Autostart
lxc.start.auto = 1

# Network (veth on lxcbr0, static IP via DHCP reservation)
lxc.net.0.type = veth
lxc.net.0.link = lxcbr0
lxc.net.0.flags = up
lxc.net.0.hwaddr = 00:16:3e:5a:1e:a9
# Static IP 10.0.3.111 configured via /etc/lxc/dnsmasq-openclaw.conf

# Allow nesting (for Docker-based sandboxing)
lxc.include = /usr/share/lxc/config/nesting.conf

# Cap drops for unprivileged operation
lxc.cap.drop =

# --- Bind mount: host source directory into container ---
# Allows live editing on host, no rsync needed
lxc.mount.entry = SAIVAGE_SRC_PLACEHOLDER opt/saivage none bind,create=dir 0 0

# --- GPU passthrough (NVIDIA only, optional) ---
lxc.mount.entry = /dev/nvidia0 dev/nvidia0 none bind,optional,create=file 0 0
lxc.mount.entry = /dev/nvidiactl dev/nvidiactl none bind,optional,create=file 0 0
lxc.mount.entry = /dev/nvidia-modeset dev/nvidia-modeset none bind,optional,create=file 0 0
lxc.mount.entry = /dev/nvidia-uvm dev/nvidia-uvm none bind,optional,create=file 0 0
lxc.mount.entry = /dev/nvidia-uvm-tools dev/nvidia-uvm-tools none bind,optional,create=file 0 0
lxc.mount.entry = /dev/nvidia-caps dev/nvidia-caps none bind,optional,create=dir 0 0
lxc.cgroup2.devices.allow = c 195:* rwm
lxc.cgroup2.devices.allow = c 507:* rwm
lxc.cgroup2.devices.allow = c 511:* rwm
EOF

    # Patch the bind mount path with actual source directory
    sudo sed -i "s|SAIVAGE_SRC_PLACEHOLDER|${SAIVAGE_SRC}|" "$LXC_CONF"

    echo "==> Starting container..."
    sudo lxc-start -n "$CONTAINER_NAME"
    echo "    Waiting for networking..."
    sleep 5
fi

# Create saivage user matching host user (with matching UID/GID)
HOST_USER="$(whoami)"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
echo "==> Ensuring user '${HOST_USER}' (uid=${HOST_UID}) exists in container..."
sudo lxc-attach -n "$CONTAINER_NAME" -- bash -c "
    # If a default user occupies our UID, move it out of the way
    EXISTING=\$(getent passwd $HOST_UID | cut -d: -f1)
    if [ -n \"\$EXISTING\" ] && [ \"\$EXISTING\" != \"$HOST_USER\" ]; then
        usermod -u 65534 \"\$EXISTING\" 2>/dev/null || true
        groupmod -g 65534 \"\$EXISTING\" 2>/dev/null || true
    fi
    if ! id $HOST_USER &>/dev/null; then
        groupadd -g $HOST_GID $HOST_USER 2>/dev/null || true
        useradd -m -s /bin/bash -u $HOST_UID -g $HOST_GID $HOST_USER
        echo '$HOST_USER ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/$HOST_USER
        chmod 440 /etc/sudoers.d/$HOST_USER
    else
        usermod -u $HOST_UID $HOST_USER 2>/dev/null || true
        groupmod -g $HOST_GID $HOST_USER 2>/dev/null || true
    fi
"

# Copy default config if it exists
if [ -f "${PROJECT_DIR}/config/saivage.json" ]; then
    echo "==> Copying default saivage.json into container..."
    sudo mkdir -p "${ROOTFS}/home/${HOST_USER}/.saivage"
    sudo cp "${PROJECT_DIR}/config/saivage.json" "${ROOTFS}/home/${HOST_USER}/.saivage/saivage.json"
    sudo lxc-attach -n "$CONTAINER_NAME" -- chown -R "${HOST_USER}:${HOST_USER}" "/home/${HOST_USER}/.saivage"
fi

echo "==> Source bind-mounted at /opt/saivage from ${SAIVAGE_SRC}"
echo "==> Container '${CONTAINER_NAME}' is running."
sudo lxc-info -n "$CONTAINER_NAME" -i -S -s
