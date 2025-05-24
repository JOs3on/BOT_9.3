const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { swapTokens } = require('./swapCreator');
const bs58 = require('bs58');
const { MongoClient } = require('mongodb');
require('dotenv').config();

class Sniper {
    constructor(config, fullLpData = null) {
        // PHASE 1: Store minimal data for monitoring
        this.tokenId = config.tokenId; // MongoDB ObjectId
        this.ammId = config.ammId;
        this.baseMint = config.baseMint;
        this.quoteMint = config.quoteMint;
        this.baseDecimals = config.baseDecimals || 9;
        this.quoteDecimals = config.quoteDecimals || 9;

        // Trading parameters
        this.buyAmount = config.buyAmount;
        this.sellTargetPrice = config.sellTargetPrice || 2;

        // Essential monitoring data (keep in memory)
        this.K = config.K; // Constant product
        this.V = config.V; // Price ratio
        this.initialPrice = config.initialPrice;

        // PHASE 2: Full LP data for immediate buy (will be cleared after buy)
        this.fullLpData = fullLpData;

        // Wallet & Connection
        this.owner = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
        this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

        // Database connection (for sell phase)
        this.db = null;
    }

    async executeBuy() {
        try {
            console.log(`[Buy] Initiating swap for ${this.buyAmount} SOL`);

            if (!this.fullLpData) {
                throw new Error('Full LP data required for buy execution');
            }

            const result = await swapTokens({
                // Pass complete LP data for buy
                lpData: this.fullLpData,
                amountSpecified: this.convertToLamports(this.buyAmount, this.quoteDecimals),
                swapBaseIn: false, // SOL -> Token
                owner: this.owner
            });

            // MEMORY OPTIMIZATION: Clear full data after successful buy
            console.log(`[Memory] Clearing full LP data after buy`);
            this.fullLpData = null;

            return result;
        } catch (error) {
            console.error(`[Buy] Failed:`, error.message);
            throw error;
        }
    }

    async executeSell() {
        try {
            console.log(`[Sell] Fetching full LP data from MongoDB for sell`);

            // Fetch complete LP data from MongoDB for sell
            const fullLpData = await this.fetchLpDataFromMongo();

            if (!fullLpData) {
                throw new Error('Could not fetch LP data for sell');
            }

            const result = await swapTokens({
                lpData: fullLpData,
                amountSpecified: await this.getTokenBalance(), // Sell all tokens
                swapBaseIn: true, // Token -> SOL
                owner: this.owner
            });

            console.log(`[Sell] Completed successfully`);
            return result;
        } catch (error) {
            console.error(`[Sell] Failed:`, error.message);
            throw error;
        }
    }

    async fetchLpDataFromMongo() {
        try {
            if (!this.db) {
                const client = new MongoClient(process.env.MONGO_URI);
                await client.connect();
                this.db = client.db("bot");
            }

            const lpData = await this.db.collection("raydium_lp_transactionsV3")
                .findOne({ _id: this.tokenId });

            if (!lpData) {
                throw new Error(`LP data not found for tokenId: ${this.tokenId}`);
            }

            console.log(`[MongoDB] Successfully fetched LP data for sell`);
            return lpData;
        } catch (error) {
            console.error(`[MongoDB] Fetch error:`, error.message);
            return null;
        }
    }

    async getCurrentPrice() {
        // Use lightweight price calculation without full pool data
        try {
            const poolInfo = await this.connection.getAccountInfo(new PublicKey(this.ammId));
            if (!poolInfo) return null;

            // Parse minimal pool data for price monitoring
            // This is much lighter than fetching full pool state
            const data = poolInfo.data;
            const baseReserve = data.readBigUInt64LE(73);
            const quoteReserve = data.readBigUInt64LE(81);

            return Number(quoteReserve) / Number(baseReserve);
        } catch (error) {
            console.error(`[Price] Error:`, error.message);
            return null;
        }
    }

    async getTokenBalance() {
        try {
            // Get token account balance for selling
            const tokenAccount = await this.connection.getTokenAccountsByOwner(
                this.owner.publicKey,
                { mint: new PublicKey(this.baseMint) }
            );

            if (tokenAccount.value.length === 0) {
                return 0;
            }

            const balance = await this.connection.getTokenAccountBalance(
                tokenAccount.value[0].pubkey
            );

            return balance.value.amount;
        } catch (error) {
            console.error(`[Balance] Error:`, error.message);
            return 0;
        }
    }

    convertToLamports(amount, decimals) {
        return Math.floor(amount * 10 ** decimals);
    }

    // Memory cleanup method
    cleanup() {
        console.log(`[Cleanup] Clearing sniper data for ${this.baseMint}`);
        this.fullLpData = null;
        if (this.db) {
            this.db.client.close();
            this.db = null;
        }
    }
}

module.exports = Sniper;