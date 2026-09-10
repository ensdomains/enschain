FROM oven/bun:1.2.13

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && node --version \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Install Foundry
RUN curl -L https://foundry.paradigm.xyz | bash
ENV PATH="/root/.foundry/bin:${PATH}"
RUN foundryup

# Set working directory
WORKDIR /app

# Copy the root package.json and bun.lock
COPY package.json bun.lock ./

# Copy the package.json for each workspace.
COPY contracts/package.json ./contracts/

# The root manifest applies these dependency patches during `bun install`.
COPY patches ./patches

# Install all dependencies
RUN bun i

# Copy the rest of the application source
COPY . .

# Build Contracts
WORKDIR /app/contracts

# Initialize git in contracts dir and install forge dependencies
RUN git config --global init.defaultBranch main && \
    cd /app && \
    git init && \
    git submodule update --init --recursive && \
    cd contracts && \
    forge i

# Build ens-contracts submodule to generate artifacts
WORKDIR /app/contracts/lib/ens-contracts
# The locked gateway package moved its Solidity sources under `contracts/`, but
# omitted the legacy Solidity entry points still used by this ENS v1 revision.
# Add those exports only inside the image so the submodule remains clean.
RUN bun install && \
    node /app/docker/patchUnruggableGateways.cjs && \
    NODE_OPTIONS="--max-old-space-size=4096" bun run compile

# Build Contracts
WORKDIR /app/contracts
RUN bun run compile:forge && bun run compile:hardhat --quiet

# Remove build-time dependency trees. The v1 submodule pins an older Rocketh;
# retaining that nested tree makes its deploy scripts incompatible with the
# current environment assembled by this repository.
RUN rm -rf /app/node_modules /app/contracts/node_modules /app/contracts/lib/ens-contracts/node_modules /app/bun.lock /app/bun.lockb

# Install only runtime dependencies
WORKDIR /app/contracts
RUN cd /app && bun install --production

# Clean up other unnecessary files
RUN rm -rf /app/.git /app/contracts/.git 2>/dev/null || true

# Expose the JSON-RPC and deployment-discovery endpoints.
EXPOSE 8545 8000

# Run devnet
WORKDIR /app/contracts
ENV FOUNDRY_DISABLE_NIGHTLY_WARNING=true
CMD ["bun", "./script/runDevnet.ts"]
