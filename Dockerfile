# docker/Dockerfile
FROM python:3.10-slim

# Install prerequisites: git, curl, build essentials
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    build-essential \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install solc-select
# ***************************

RUN pip install slither-analyzer

# === Install Foundry using foundryup === (Keep this section)
RUN curl -L https://foundry.paradigm.xyz | bash -s -- --no-modify-path
ENV FOUNDRY_DIR=/root/.foundry
ENV PATH="$FOUNDRY_DIR/bin:$PATH"
RUN foundryup
# === Foundry Installation Complete ===

RUN forge --version && cast --version

WORKDIR /app
