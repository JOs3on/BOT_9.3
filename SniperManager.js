const { Connection, PublicKey } = require('@solana/web3.js');
const Sniper = require('./Sniper');
require('dotenv').config();

class SniperManager {
    static activeSnipers = new Map();
    static connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

    static async addSniper(fullLpData) {
        try {
            // Validate complete LP data
            const requiredFields = [
                'ammId', 'baseMint', 'quoteMint', 'baseVault', 'quoteVault',
                'marketId', 'marketBids', 'marketAsks', 'ammAuthority'
            ];

            for (const field of requiredFields) {
                if (!fullLpData[field]) {
                    throw new Error(`Missing required field: ${field}`);
                }
            }

            // Create lightweight config for monitoring
            const lightweightConfig = {
                tokenId: fullLpData._id,
                ammId: fullLpData.ammId,
                baseMint: fullLpData.baseMint,
                quoteMint: fullLpData.quoteMint,
                baseDecimals: fullLpData.baseDecimals || 9,
                quoteDecimals: fullLpData.quoteDecimals || 9,
                buyAmount: parseFloat(process.env.BUY_AMOUNT) || 0.02,
                sellTargetPrice: parseFloat(process.env.SELL_TARGET_MULTIPLIER) || 2,
                // Essential monitoring data (minimal memory)
                K: fullLpData.K,
                V: fullLpData.V,
                initialPrice: this.calculateInitialPrice(fullLpData)
            };

            if (this.activeSnipers.has(lightweightConfig.ammId)) {
                console.log(`[Sniper] Already tracking AMM: ${lightweightConfig.ammId}`);
                return;
            }

            console.log(`[Sniper] Initializing for token: ${lightweightConfig.baseMint}`);

            // Create sniper with full data for immediate buy
            const sniper = new Sniper(lightweightConfig, fullLpData);

            // PHASE 1: Execute immediate buy with full data
            await sniper.executeBuy();
            console.log(`[Buy] Completed for ${lightweightConfig.baseMint}`);

            // PHASE 2: Start lightweight monitoring (full data cleared automatically)
            const monitorInterval = setInterval(async () => {
                try {
                    const currentPrice = await sniper.getCurrentPrice();
                    const initialPrice = lightweightConfig.initialPrice;
                    const priceMultiplier = currentPrice / initialPrice;

                    console.log(`[Monitor] ${lightweightConfig.baseMint} - Price: ${currentPrice.toFixed(8)}, Multiplier: ${priceMultiplier.toFixed(2)}x`);

                    if (priceMultiplier >= lightweightConfig.sellTargetPrice) {
                        console.log(`[Sell] Target reached for ${lightweightConfig.baseMint}`);

                        // PHASE 3: Execute sell (fetches data from MongoDB)
                        await sniper.executeSell();

                        // PHASE 4: Cleanup
                        clearInterval(monitorInterval);
                        sniper.cleanup();
                        this.activeSnipers.delete(lightweightConfig.ammId);

                        console.log(`[Complete] Sniper cycle finished for ${lightweightConfig.baseMint}`);
                    }
                } catch (error) {
                    console.error(`[Monitor] Error for ${lightweightConfig.baseMint}:`, error.message);
                }
            }, 5000); // Check every 5 seconds

            // Store only lightweight reference
            this.activeSnipers.set(lightweightConfig.ammId, {
                config: lightweightConfig,
                interval: monitorInterval,
                sniper: sniper // Reference for manual operations
            });

            console.log(`[Memory] Optimized sniper active for ${lightweightConfig.baseMint}`);

        } catch (error) {
            console.error(`[SniperManager] Error:`, error.message);
        }
    }

    static calculateInitialPrice(lpData) {
        const baseAmount = parseFloat(lpData.initCoinAmount) / (10 ** (lpData.baseDecimals || 9));
        const quoteAmount = parseFloat(lpData.initPcAmount) / (10 ** (lpData.quoteDecimals || 9));
        return quoteAmount / baseAmount;
    }

    static getMemoryUsage() {
        const used = process.memoryUsage();
        return {
            activeSnipers: this.activeSnipers.size,
            memoryUsage: {
                rss: Math.round(used.rss / 1024 / 1024 * 100) / 100 + ' MB',
                heapTotal: Math.round(used.heapTotal / 1024 / 1024 * 100) / 100 + ' MB',
                heapUsed: Math.round(used.heapUsed / 1024 / 1024 * 100) / 100 + ' MB'
            }
        };
    }

    static stopAll() {
        console.log(`[Cleanup] Stopping ${this.activeSnipers.size} active snipers`);
        this.activeSnipers.forEach(sniper => {
            clearInterval(sniper.interval);
            sniper.sniper.cleanup();
        });
        this.activeSnipers.clear();

        // Force garbage collection
        if (global.gc) {
            global.gc();
        }
    }
}

module.exports = SniperManager;