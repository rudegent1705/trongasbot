// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const TronWeb = require('tronweb');
const axios = require('axios');

class TronQuantumBotServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });
        
        // Bot state with persistence
        this.state = {
            isRunning: false,
            isConnected: false,
            processedTransactions: 0,
            totalForwarded: 0,
            startTime: null,
            currentBlock: 0,
            uptimeInterval: null,
            monitorInterval: null,
            tronWeb: null,
            activeConnections: new Set(),
            config: null,
            lastSavedState: null,
            autoStartEnabled: true,
            crashCount: 0,
            lastCrashTime: null
        };
        
        // Configuration with defaults
        this.configPath = path.join(__dirname, 'config.json');
        this.statePath = path.join(__dirname, 'bot_state.json');
        this.defaultConfig = {
            adminPassword: this.hashPassword('admin123'),
            network: 'shasta',
            tronApiKey: '',
            rpcEndpoints: [
                'https://api.shasta.trongrid.io',
                'https://shasta.tronscan.org/api'
            ],
            monitorAddresses: [],
            receiverAddress: '',
            minAmount: 1,
            autoWithdraw: true,
            multisigMode: 'multisig',
            signerKeys: [],
            signerAddresses: [],
            requiredSignatures: 2,
            txDelay: true,
            confirmations: 19,
            feeLimit: 5,
            checkInterval: 10000,
            maxBatch: 5,
            randomIntervals: true,
            autoRetry: true,
            stealthMode: false,
            telegramToken: '',
            telegramChatId: '',
            notifyReceive: true,
            notifySend: true,
            notifyError: true,
            dailySummary: true,
            encryptionMethod: 'aes',
            masterPassword: '',
            biometricLock: false,
            sessionTimeout: 60,
            ipWhitelist: [],
            autoLogout: true,
            autoWipe: false,
            scheduleType: 'none',
            scheduleTime: '00:00',
            autoCompound: false,
            smartFees: true,
            autoSwitchRPC: true,
            autoBackup: false,
            customScripts: '',
            uiTheme: 'dark',
            compactMode: false,
            autoStartOnBoot: true,
            autoRestartOnCrash: true,
            maxCrashThreshold: 10,
            crashResetTime: 3600000
        };
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
        this.initializeServer();
    }
    
    async initializeServer() {
        await this.loadConfig();
        await this.loadState();
        
        // Auto-start bot if enabled
        if (this.state.config.autoStartOnBoot !== false) {
            setTimeout(() => {
                this.startBot().catch(err => {
                    this.log(`Auto-start failed: ${err.message}`, 'error');
                });
            }, 5000);
        }
        
        this.setupCrashRecovery();
        this.setupKeepAlive();
    }
    
    setupKeepAlive() {
        // Prevent Render from sleeping
        setInterval(() => {
            if (this.state.isRunning) {
                this.log('🔄 Keep-alive ping', 'info');
                
                if (!this.state.isConnected) {
                    this.initTronWeb().catch(() => {});
                }
            }
        }, 300000);
        
        // Self-ping to keep server active
        if (process.env.RENDER) {
            const pingUrl = process.env.RENDER_EXTERNAL_URL;
            if (pingUrl) {
                setInterval(async () => {
                    try {
                        await axios.get(`${pingUrl}/health`);
                        this.log('🏓 Self-ping successful', 'info');
                    } catch (error) {
                        // Ignore ping errors
                    }
                }, 600000);
            }
        }
    }
    
    setupCrashRecovery() {
        process.on('uncaughtException', async (error) => {
            this.log(`💥 Uncaught Exception: ${error.message}`, 'error');
            this.log(error.stack, 'error');
            await this.handleCrash();
        });
        
        process.on('unhandledRejection', async (error) => {
            this.log(`💥 Unhandled Rejection: ${error.message}`, 'error');
            await this.handleCrash();
        });
        
        process.on('SIGTERM', async () => {
            this.log('📴 Received SIGTERM signal', 'warning');
            await this.gracefulShutdown();
            process.exit(0);
        });
        
        process.on('SIGINT', async () => {
            this.log('📴 Received SIGINT signal', 'warning');
            await this.gracefulShutdown();
            process.exit(0);
        });
    }
    
    async handleCrash() {
        this.state.crashCount++;
        this.state.lastCrashTime = Date.now();
        
        await this.saveState();
        
        this.log(`⚠️ Crash #${this.state.crashCount}`, 'warning');
        
        if (this.state.config.autoRestartOnCrash) {
            const timeSinceLastCrash = Date.now() - (this.state.lastCrashTime || 0);
            
            if (timeSinceLastCrash > this.state.config.crashResetTime) {
                this.state.crashCount = 1;
            }
            
            if (this.state.crashCount > this.state.config.maxCrashThreshold) {
                this.log('❌ Too many crashes, disabling auto-restart', 'error');
                this.state.config.autoRestartOnCrash = false;
                await this.saveConfigToFile();
                return;
            }
            
            this.log('🔄 Attempting to restart bot in 10 seconds...', 'warning');
            
            this.state.isConnected = false;
            this.state.tronWeb = null;
            
            setTimeout(() => {
                if (!this.state.isRunning) {
                    this.startBot().catch(err => {
                        this.log(`Restart failed: ${err.message}`, 'error');
                    });
                }
            }, 10000);
        }
    }
    
    async gracefulShutdown() {
        this.log('🛑 Performing graceful shutdown...', 'warning');
        
        await this.saveState();
        
        if (this.state.isRunning) {
            this.stopBot();
        }
        
        this.state.activeConnections.forEach(ws => {
            try { ws.close(); } catch (e) {}
        });
        
        this.log('✅ Graceful shutdown complete', 'success');
    }
    
    async loadState() {
        try {
            const data = await fs.readFile(this.statePath, 'utf8');
            const savedState = JSON.parse(data);
            
            this.state.processedTransactions = savedState.processedTransactions || 0;
            this.state.totalForwarded = savedState.totalForwarded || 0;
            this.state.crashCount = savedState.crashCount || 0;
            this.state.lastCrashTime = savedState.lastCrashTime || null;
            
            this.log('📁 Bot state loaded from file', 'info');
        } catch (error) {
            this.log('No saved state found, starting fresh', 'info');
        }
    }
    
    async saveState() {
        try {
            const state = {
                processedTransactions: this.state.processedTransactions,
                totalForwarded: this.state.totalForwarded,
                crashCount: this.state.crashCount,
                lastCrashTime: this.state.lastCrashTime,
                lastSaved: Date.now()
            };
            
            await fs.writeFile(this.statePath, JSON.stringify(state, null, 2));
            this.log('📁 Bot state saved', 'info');
        } catch (error) {
            this.log(`Failed to save state: ${error.message}`, 'error');
        }
    }
    
    setupMiddleware() {
        // ✅ CRITICAL FIX: Properly serve static files from public directory
        const publicPath = path.join(__dirname, 'public');
        
        // Log the public path for debugging
        console.log(`📁 Serving static files from: ${publicPath}`);
        
        // Check if public directory exists
        fs.access(publicPath).then(() => {
            console.log('✅ Public directory found');
        }).catch(() => {
            console.log('❌ Public directory not found! Creating it...');
            fs.mkdir(publicPath, { recursive: true }).catch(console.error);
        });
        
        // Serve static files with proper MIME types
        this.app.use(express.static(publicPath, {
            index: 'index.html',
            extensions: ['html', 'htm'],
            setHeaders: (res, filepath) => {
                // Set proper content type for HTML files
                if (filepath.endsWith('.html')) {
                    res.setHeader('Content-Type', 'text/html; charset=utf-8');
                }
                // Cache control for better performance
                res.setHeader('Cache-Control', 'public, max-age=3600');
            }
        }));
        
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));
    }
    
    setupRoutes() {
        // ✅ FIXED: Explicit route for root to serve index.html
        this.app.get('/', (req, res) => {
            const indexPath = path.join(__dirname, 'public', 'index.html');
            
            // Check if file exists and serve it
            fs.access(indexPath).then(() => {
                res.sendFile(indexPath);
            }).catch(() => {
                // If index.html doesn't exist, create a basic one
                this.log('⚠️ index.html not found, serving basic interface', 'warning');
                res.send(`
                    <!DOCTYPE html>
                    <html>
                        <head>
                            <title>TRON Quantum Bot</title>
                            <meta http-equiv="refresh" content="0;url=/" />
                        </head>
                        <body>
                            <h1>TRON Quantum Bot</h1>
                            <p>Loading interface...</p>
                            <script>
                                window.location.href = '/';
                            </script>
                        </body>
                    </html>
                `);
            });
        });
        
        // ✅ FIXED: Serve index.html for all routes (SPA fallback)
        this.app.get('*', (req, res, next) => {
            // Skip API routes
            if (req.path.startsWith('/api/') || req.path.startsWith('/health') || req.path.startsWith('/ws')) {
                return next();
            }
            
            // Skip static file requests that have extensions
            if (req.path.includes('.')) {
                return next();
            }
            
            // Serve index.html for all other routes
            const indexPath = path.join(__dirname, 'public', 'index.html');
            res.sendFile(indexPath, (err) => {
                if (err) {
                    next();
                }
            });
        });
        
        // API endpoints
        this.app.post('/api/login', (req, res) => {
            const { password } = req.body;
            if (this.hashPassword(password) === this.state.config.adminPassword) {
                res.json({ success: true });
            } else {
                res.status(401).json({ success: false, error: 'Invalid password' });
            }
        });
        
        this.app.get('/api/config', (req, res) => {
            const safeConfig = { ...this.state.config };
            delete safeConfig.signerKeys;
            delete safeConfig.adminPassword;
            delete safeConfig.masterPassword;
            res.json(safeConfig);
        });
        
        this.app.post('/api/config', async (req, res) => {
            try {
                await this.updateConfig(req.body);
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });
        
        this.app.post('/api/start', async (req, res) => {
            try {
                await this.startBot();
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });
        
        this.app.post('/api/stop', (req, res) => {
            this.stopBot();
            res.json({ success: true });
        });
        
        this.app.post('/api/test', async (req, res) => {
            try {
                await this.testConnection();
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });
        
        this.app.get('/api/status', (req, res) => {
            res.json({
                isRunning: this.state.isRunning,
                isConnected: this.state.isConnected,
                processedTransactions: this.state.processedTransactions,
                totalForwarded: this.state.totalForwarded,
                currentBlock: this.state.currentBlock,
                uptime: this.state.startTime ? Date.now() - this.state.startTime : 0,
                signersCount: this.state.config.signerKeys.length,
                crashCount: this.state.crashCount
            });
        });
        
        this.app.get('/api/export', (req, res) => {
            const configStr = JSON.stringify(this.state.config, null, 2);
            res.setHeader('Content-Disposition', 'attachment; filename="tron-quantum-bot-config.json"');
            res.setHeader('Content-Type', 'application/json');
            res.send(configStr);
        });
        
        this.app.post('/api/import', async (req, res) => {
            try {
                const imported = req.body;
                await this.updateConfig(imported);
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });
        
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                uptime: process.uptime(),
                botRunning: this.state.isRunning,
                botConnected: this.state.isConnected,
                timestamp: Date.now(),
                publicDir: path.join(__dirname, 'public'),
                nodeEnv: process.env.NODE_ENV,
                render: !!process.env.RENDER
            });
        });
    }
    
    setupWebSocket() {
        this.wss.on('connection', (ws) => {
            this.state.activeConnections.add(ws);
            
            ws.send(JSON.stringify({
                type: 'init',
                data: {
                    status: this.getStatus(),
                    config: this.getSafeConfig()
                }
            }));
            
            ws.on('message', async (message) => {
                try {
                    const data = JSON.parse(message);
                    await this.handleWebSocketMessage(ws, data);
                } catch (error) {
                    this.log(`WebSocket error: ${error.message}`, 'error');
                }
            });
            
            ws.on('close', () => {
                this.state.activeConnections.delete(ws);
            });
        });
    }
    
    async handleWebSocketMessage(ws, data) {
        switch (data.action) {
            case 'start':
                await this.startBot();
                break;
            case 'stop':
                this.stopBot();
                break;
            case 'test':
                await this.testConnection();
                break;
            case 'save':
                await this.updateConfig(data.config);
                break;
            case 'getStatus':
                ws.send(JSON.stringify({
                    type: 'status',
                    data: this.getStatus()
                }));
                break;
        }
    }
    
    broadcast(message) {
        const data = typeof message === 'string' ? message : JSON.stringify(message);
        this.state.activeConnections.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(data);
            }
        });
    }
    
    hashPassword(password) {
        return crypto.createHash('sha256').update(password).digest('hex');
    }
    
    async loadConfig() {
        try {
            const data = await fs.readFile(this.configPath, 'utf8');
            this.state.config = JSON.parse(data);
            this.state.config = { ...this.defaultConfig, ...this.state.config };
            this.log('Configuration loaded from file');
        } catch (error) {
            this.state.config = { ...this.defaultConfig };
            await this.saveConfigToFile();
            this.log('Created default configuration');
        }
    }
    
    async updateConfig(newConfig) {
        this.state.config = { ...this.state.config, ...newConfig };
        
        if (newConfig.adminPassword && newConfig.adminPassword !== this.hashPassword('')) {
            this.state.config.adminPassword = this.hashPassword(newConfig.adminPassword);
        }
        
        await this.saveConfigToFile();
        
        this.broadcast({
            type: 'config',
            data: this.getSafeConfig()
        });
        
        this.log('Configuration updated', 'success');
    }
    
    async saveConfigToFile() {
        await fs.writeFile(this.configPath, JSON.stringify(this.state.config, null, 2));
    }
    
    getSafeConfig() {
        const safeConfig = { ...this.state.config };
        delete safeConfig.signerKeys;
        delete safeConfig.adminPassword;
        delete safeConfig.masterPassword;
        return safeConfig;
    }
    
    getStatus() {
        return {
            isRunning: this.state.isRunning,
            isConnected: this.state.isConnected,
            processedTransactions: this.state.processedTransactions,
            totalForwarded: this.state.totalForwarded,
            currentBlock: this.state.currentBlock,
            uptime: this.state.startTime ? Date.now() - this.state.startTime : 0,
            network: this.state.config.network,
            crashCount: this.state.crashCount
        };
    }
    
    async initTronWeb() {
        try {
            const endpoints = this.state.config.rpcEndpoints.filter(e => e.trim());
            
            if (endpoints.length === 0) {
                throw new Error('No valid RPC endpoints configured');
            }
            
            let connected = false;
            let lastError = null;
            
            for (const endpoint of endpoints) {
                try {
                    this.log(`Trying endpoint: ${endpoint}`, 'info');
                    
                    const headers = {};
                    if (this.state.config.tronApiKey) {
                        headers["TRON-PRO-API-KEY"] = this.state.config.tronApiKey;
                    }
                    
                    this.state.tronWeb = new TronWeb({
                        fullHost: endpoint,
                        headers: headers
                    });
                    
                    if (this.state.config.tronApiKey) {
                        this.state.tronWeb.setHeader({ "TRON-PRO-API-KEY": this.state.config.tronApiKey });
                    }
                    
                    const block = await this.state.tronWeb.trx.getCurrentBlock();
                    this.state.currentBlock = block.block_header.raw_data.number;
                    
                    connected = true;
                    this.state.isConnected = true;
                    this.log(`✅ Connected to: ${endpoint}`, 'success');
                    this.log(`📦 Current block: ${this.state.currentBlock}`, 'info');
                    
                    this.broadcast({
                        type: 'status',
                        data: this.getStatus()
                    });
                    
                    break;
                    
                } catch (error) {
                    lastError = error;
                    this.log(`❌ Failed: ${endpoint} - ${error.message}`, 'error');
                    continue;
                }
            }
            
            if (!connected) {
                throw new Error(`All endpoints failed. Last error: ${lastError?.message}`);
            }
            
        } catch (error) {
            this.state.isConnected = false;
            this.broadcast({
                type: 'status',
                data: this.getStatus()
            });
            throw error;
        }
    }
    
    async startBot() {
        if (this.state.isRunning) {
            this.log('Bot is already running', 'warning');
            return;
        }
        
        try {
            this.log('🚀 Starting Quantum Bot...', 'info');
            
            await this.initTronWeb();
            
            if (!this.validateConfig()) {
                throw new Error('Configuration validation failed');
            }
            
            this.state.isRunning = true;
            this.state.startTime = Date.now();
            
            this.startMonitoring();
            this.startUptimeCounter();
            
            this.log('✅ Quantum Bot Started Successfully', 'success');
            
            this.broadcast({
                type: 'botStarted',
                data: this.getStatus()
            });
            
            if (this.state.config.telegramToken && this.state.config.telegramChatId) {
                await this.sendTelegramNotification(
                    `🤖 *TRON Quantum Bot Started*\n` +
                    `📍 Network: ${this.state.config.network}\n` +
                    `📡 Monitoring ${this.state.config.monitorAddresses.length} addresses\n` +
                    `⏰ Started: ${new Date().toLocaleString()}`
                );
            }
            
            this.state.crashCount = 0;
            await this.saveState();
            
        } catch (error) {
            this.log(`❌ Failed to start bot: ${error.message}`, 'error');
            this.state.isRunning = false;
            
            if (this.state.config.autoRestartOnCrash) {
                this.log('🔄 Scheduling retry in 30 seconds...', 'warning');
                setTimeout(() => {
                    this.startBot().catch(() => {});
                }, 30000);
            }
            
            throw error;
        }
    }
    
    stopBot() {
        if (!this.state.isRunning) return;
        
        if (this.state.monitorInterval) {
            clearInterval(this.state.monitorInterval);
            this.state.monitorInterval = null;
        }
        
        if (this.state.uptimeInterval) {
            clearInterval(this.state.uptimeInterval);
            this.state.uptimeInterval = null;
        }
        
        this.state.isRunning = false;
        
        this.log('🛑 Quantum Bot Stopped', 'warning');
        
        this.broadcast({
            type: 'botStopped',
            data: this.getStatus()
        });
        
        if (this.state.config.telegramToken && this.state.config.telegramChatId) {
            this.sendTelegramNotification(
                `🛑 *TRON Quantum Bot Stopped*\n` +
                `📊 Processed: ${this.state.processedTransactions} transactions\n` +
                `💰 Total Forwarded: ${(this.state.totalForwarded / 1_000_000).toFixed(2)} TRX`
            );
        }
        
        this.saveState();
    }
    
    startMonitoring() {
        if (this.state.monitorInterval) {
            clearInterval(this.state.monitorInterval);
        }
        
        const runCycle = async () => {
            try {
                await this.monitoringCycle();
            } catch (error) {
                this.log(`Monitoring error: ${error.message}`, 'error');
            }
        };
        
        runCycle();
        
        let interval = this.state.config.checkInterval;
        if (this.state.config.randomIntervals) {
            interval = interval + (Math.random() * interval * 0.5);
        }
        
        this.state.monitorInterval = setInterval(runCycle, interval);
        
        this.log(`🔁 Monitoring interval: ${Math.round(interval)}ms`, 'info');
    }
    
    async monitoringCycle() {
        if (!this.state.isConnected || !this.state.tronWeb) {
            await this.initTronWeb();
            if (!this.state.isConnected) return;
        }
        
        try {
            const block = await this.state.tronWeb.trx.getCurrentBlock();
            this.state.currentBlock = block.block_header.raw_data.number;
            
            for (const address of this.state.config.monitorAddresses) {
                await this.checkAddress(address);
            }
            
            this.broadcast({
                type: 'status',
                data: this.getStatus()
            });
            
        } catch (error) {
            this.log(`Monitoring cycle error: ${error.message}`, 'error');
            this.state.isConnected = false;
            
            if (this.state.config.autoSwitchRPC) {
                this.log('Attempting to switch RPC endpoint...', 'warning');
                setTimeout(() => this.initTronWeb(), 5000);
            }
        }
    }
    
    async checkAddress(address) {
        try {
            const account = await this.state.tronWeb.trx.getAccount(address);
            const balance = account.balance || 0;
            const balanceTRX = balance / 1_000_000;
            
            if (balanceTRX >= this.state.config.minAmount) {
                await this.processWithdrawal(address, balance);
            }
            
        } catch (error) {
            this.log(`Error checking ${address}: ${error.message}`, 'error');
        }
    }
    
    async processWithdrawal(fromAddress, balanceSun) {
        const balanceTRX = balanceSun / 1_000_000;
        
        const reserveSun = (this.state.config.feeLimit || 5) * 1_000_000;
        const amountToSend = balanceSun - reserveSun;
        
        if (amountToSend <= 0) {
            this.log(`⚠️ Insufficient balance after reserve (need > ${(reserveSun/1_000_000).toFixed(2)} TRX)`, 'warning');
            return;
        }
        
        this.log(`💰 Processing ${balanceTRX.toFixed(6)} TRX from ${fromAddress.substring(0, 12)}...`, 'info');
        
        try {
            let txId;
            
            if (this.state.config.multisigMode === 'single') {
                txId = await this.createSingleTransaction(fromAddress, amountToSend);
            } else {
                txId = await this.createMultisigTransaction(fromAddress, amountToSend);
            }
            
            this.state.processedTransactions++;
            this.state.totalForwarded += amountToSend;
            
            this.log(`✅ Successfully forwarded ${(amountToSend/1_000_000).toFixed(6)} TRX`, 'success');
            this.log(`📤 TX: ${txId.substring(0, 20)}...`, 'info');
            
            await this.saveState();
            
            if (this.state.config.telegramToken && this.state.config.notifySend) {
                await this.sendTelegramNotification(
                    `🔄 *TRX Forwarded*\n` +
                    `💰 Amount: ${(amountToSend/1_000_000).toFixed(6)} TRX\n` +
                    `📍 From: \`${fromAddress.substring(0, 12)}...\`\n` +
                    `📎 TX: \`${txId}\``
                );
            }
            
        } catch (error) {
            this.log(`❌ Transaction failed: ${error.message}`, 'error');
            
            if (this.state.config.telegramToken && this.state.config.notifyError) {
                await this.sendTelegramNotification(
                    `❌ *Transaction Failed*\n` +
                    `⚠️ Error: ${error.message}\n` +
                    `📍 Address: \`${fromAddress.substring(0, 12)}...\``
                );
            }
        }
    }
    
    async createSingleTransaction(fromAddress, amountSun) {
        const privateKey = this.state.config.signerKeys[0];
        
        if (!privateKey) {
            throw new Error('No private key configured');
        }
        
        const transaction = await this.state.tronWeb.transactionBuilder.sendTrx(
            this.state.config.receiverAddress,
            amountSun,
            fromAddress
        );
        
        const signedTx = await this.state.tronWeb.trx.sign(transaction, privateKey);
        const result = await this.state.tronWeb.trx.sendRawTransaction(signedTx);
        
        if (!result.result) {
            let errorMsg = result.message || 'Unknown error';
            if (typeof errorMsg === 'string' && /^[0-9a-fA-F]+$/.test(errorMsg)) {
                try {
                    errorMsg = Buffer.from(errorMsg, 'hex').toString('utf8');
                } catch (e) {}
            }
            throw new Error(`Broadcast failed: ${errorMsg}`);
        }
        
        return result.txid || result.transaction?.txID;
    }
    
    async createMultisigTransaction(fromAddress, amountSun) {
        const signerKeys = this.state.config.signerKeys;
        const requiredSignatures = Math.min(this.state.config.requiredSignatures, signerKeys.length);
        
        if (signerKeys.length < requiredSignatures) {
            throw new Error(`Insufficient signers: ${signerKeys.length}/${requiredSignatures}`);
        }
        
        const transaction = await this.state.tronWeb.transactionBuilder.sendTrx(
            this.state.config.receiverAddress,
            amountSun,
            fromAddress
        );
        
        transaction.raw_data.contract[0].Permission_id = 0;
        
        let finalTx = await this.state.tronWeb.trx.sign(transaction, signerKeys[0]);
        
        for (let i = 1; i < requiredSignatures; i++) {
            if (signerKeys[i]) {
                finalTx = await this.state.tronWeb.trx.multiSign(finalTx, signerKeys[i], 0);
            }
        }
        
        const result = await this.state.tronWeb.trx.sendRawTransaction(finalTx);
        
        if (!result.result) {
            let errorMsg = result.message || 'Unknown error';
            if (typeof errorMsg === 'string' && /^[0-9a-fA-F]+$/.test(errorMsg)) {
                try {
                    errorMsg = Buffer.from(errorMsg, 'hex').toString('utf8');
                } catch (e) {}
            }
            throw new Error(`Broadcast failed: ${errorMsg}`);
        }
        
        return result.txid || result.transaction?.txID;
    }
    
    async testConnection() {
        try {
            await this.initTronWeb();
            
            if (this.state.config.telegramToken && this.state.config.telegramChatId) {
                await this.sendTelegramNotification('✅ Connection test successful');
            }
            
            this.log('✅ All connections working', 'success');
            
        } catch (error) {
            this.log(`❌ Connection test failed: ${error.message}`, 'error');
            throw error;
        }
    }
    
    validateConfig() {
        const errors = [];
        
        if (!this.state.config.receiverAddress) {
            errors.push('Receiver address not configured');
        }
        
        if (this.state.config.monitorAddresses.length === 0) {
            errors.push('No monitoring addresses configured');
        }
        
        if (this.state.config.signerKeys.length === 0) {
            errors.push('No signer keys configured');
        }
        
        if (errors.length > 0) {
            errors.forEach(error => this.log(`Validation error: ${error}`, 'error'));
            return false;
        }
        
        return true;
    }
    
    async sendTelegramNotification(message) {
        if (!this.state.config.telegramToken || !this.state.config.telegramChatId) return;
        
        try {
            const url = `https://api.telegram.org/bot${this.state.config.telegramToken}/sendMessage`;
            
            await axios.post(url, {
                chat_id: this.state.config.telegramChatId,
                text: message,
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            }, { timeout: 10000 });
            
        } catch (error) {
            this.log(`Telegram notification failed: ${error.message}`, 'error');
        }
    }
    
    startUptimeCounter() {
        if (this.state.uptimeInterval) {
            clearInterval(this.state.uptimeInterval);
        }
        
        this.state.uptimeInterval = setInterval(() => {
            this.broadcast({
                type: 'status',
                data: this.getStatus()
            });
        }, 1000);
    }
    
    log(message, type = 'info') {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;
        
        console.log(logMessage);
        
        this.broadcast({
            type: 'log',
            data: {
                message,
                type,
                timestamp
            }
        });
    }
    
    start(port = process.env.PORT || 3000) {
        this.server.listen(port, '0.0.0.0', () => {
            console.log('\n' + '='.repeat(60));
            console.log(`🚀 TRON Quantum Bot Server Started`);
            console.log('='.repeat(60));
            console.log(`📡 Port: ${port}`);
            console.log(`🌐 Web Interface: http://localhost:${port}`);
            console.log(`📁 Public Directory: ${path.join(__dirname, 'public')}`);
            console.log(`🤖 Bot Status: ${this.state.isRunning ? 'Running' : 'Stopped'}`);
            console.log(`🔄 Auto-start: ${this.state.config.autoStartOnBoot ? 'Enabled' : 'Disabled'}`);
            console.log(`💪 Crash Recovery: ${this.state.config.autoRestartOnCrash ? 'Enabled' : 'Disabled'}`);
            
            if (process.env.RENDER) {
                console.log(`☁️ Render URL: ${process.env.RENDER_EXTERNAL_URL || 'Not available'}`);
                console.log(`💾 Persistent Disk: /opt/render/project/src`);
            }
            
            console.log('='.repeat(60) + '\n');
        });
    }
}

// Create the bot instance
const bot = new TronQuantumBotServer();

// Export for serverless environments
if (process.env.RENDER || process.env.VERCEL) {
    module.exports = bot.app;
} else {
    // Start the server normally
    bot.start();
}