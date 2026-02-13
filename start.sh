#!/bin/bash
# Start script for Render 24/7 operation

echo "🚀 Starting TRON Quantum Bot on Render..."
echo "=========================================="

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Create necessary directories
echo "📁 Creating directories..."
mkdir -p public
mkdir -p data

# Check if index.html exists in public folder
if [ ! -f "public/index.html" ]; then
    echo "⚠️  Warning: public/index.html not found!"
    echo "   Please make sure your index.html file is in the public folder."
    echo "   Current directory: $(pwd)"
    ls -la public/
else
    echo "✅ Found public/index.html"
fi

# Check if config.json exists
if [ ! -f "config.json" ]; then
    echo "📝 Creating default configuration..."
    if [ -f "config.example.json" ]; then
        cp config.example.json config.json
    else
        echo "{}" > config.json
    fi
fi

# Set environment variables
export NODE_ENV=production
export RENDER=true

# Start the bot
echo "🤖 Starting bot server..."
echo "=========================================="
node server.js