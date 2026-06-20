#!/bin/bash

# Development script for WorkX Chrome Extension

echo "Starting WorkX Chrome Extension development build..."

# Build the extension in watch mode
npm run build -- --watch &

echo ""
echo "✅ Build process started in watch mode"
echo ""
echo "To load the extension in Chrome:"
echo "1. Open chrome://extensions/"
echo "2. Enable 'Developer mode' (top right)"
echo "3. Click 'Load unpacked'"
echo "4. Select the 'dist' folder in workx-chrome directory"
echo ""
echo "The extension will auto-reload when you make changes."
echo "Press Ctrl+C to stop the build process."

# Wait for the background process
wait