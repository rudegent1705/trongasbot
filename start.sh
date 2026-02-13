#!/bin/bash
echo "🚀 Starting TRON Quantum Bot on Render..."
echo "=========================================="

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Create public directory if it doesn't exist
mkdir -p public

# List files in current directory and public directory
echo "📁 Current directory contents:"
ls -la

echo "📁 Public directory contents:"
ls -la public/ || echo "   public/ directory is empty"

# Check if index.html exists
if [ ! -f "public/index.html" ]; then
    echo "⚠️  WARNING: public/index.html not found!"
    echo "   The web interface will not be available."
else
    echo "✅ Found public/index.html"
fi

# Set environment variables
export NODE_ENV=production
export RENDER=true

# Start the server
echo "🤖 Starting server..."
echo "=========================================="
node server.js