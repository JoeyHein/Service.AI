FROM node:20-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    jq \
    ripgrep \
    fd-find \
    python3 \
    python3-pip \
    build-essential \
    postgresql-client \
    redis-tools \
    vim \
    tmux \
    htop \
    ca-certificates \
    gnupg \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (so container can build its own images if needed)
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install pnpm and yarn for flexibility
RUN npm install -g pnpm yarn

# Create workspace user
RUN useradd -m -s /bin/bash -u 1000 builder \
    && mkdir -p /workspace \
    && chown builder:builder /workspace

# Set up git defaults
USER builder
RUN git config --global user.email "builder@servicetitan-clone.local" \
    && git config --global user.name "Autonomous Builder" \
    && git config --global init.defaultBranch main \
    && git config --global pull.rebase false

WORKDIR /workspace

# Healthcheck — verifies Claude CLI is responsive
HEALTHCHECK --interval=5m --timeout=30s --start-period=1m --retries=3 \
    CMD claude --version || exit 1

CMD ["/bin/bash"]
