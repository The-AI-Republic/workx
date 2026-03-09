#!/bin/bash
# Install headless Chromium for Apple Pi Server Mode
# Supports Debian/Ubuntu-based systems

set -e

echo "Installing Chromium for Apple Pi Server Mode..."

if command -v apt-get &> /dev/null; then
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates \
        fonts-liberation
    echo "Chromium installed: $(chromium --version)"
elif command -v dnf &> /dev/null; then
    sudo dnf install -y chromium
    echo "Chromium installed: $(chromium-browser --version)"
elif command -v brew &> /dev/null; then
    brew install --cask chromium
    echo "Chromium installed via Homebrew"
else
    echo "Unsupported package manager. Please install Chromium manually."
    exit 1
fi

echo "Done."
