const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const { MongoClient } = require("mongodb");
const bs58 = require('bs58');
const { getAssociatedTokenAddressSync } = require("@solana/spl-token");
require("dotenv").config();

const connection = new Connection(process.env.SOLANA_WS_URL, "confirmed");
const RAYDIUM_AMM_PROGRAM_ID = new PublicKey(process.env.RAYDIUM_AMM_PROGRAM_ID);
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID_STR = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID_STR = "ATokenGPv1sfdS5qUnx9GbS6hX1TTjR1L6rT3HaZJFA";
const WSOL_MINT = "So11111111111111111111111111111112";

let db;

async function connectToDatabase() {
    const mongoUri = process.env.MONGO_URI;
    const client = new MongoClient(mongoUri);
    try {
        await client.connect();
        db = client.db("bot");
        console.log("Connected to MongoDB successfully.");
    } catch (error) {
        console.error("MongoDB connection failed:", error.message);
        process.exit(1);
    }
}

async function saveToMongo(tokenData) {
    try {
        if (!db) throw new Error("Database connection not initialized");
        const collection = db.collection("raydium_lp_transactionsV3");
        const result = await collection.insertOne(tokenData);
        console.log("Saved document with ID:", result.insertedId);
        return result.insertedId;
    } catch (error) {
        console.error("DB save error:", error.message);
        throw error;
    }
}

function parseCreateAmmLpParams(data) {
    return {
        discriminator: data.readUInt8(0),
        nonce: data.readUInt8(1),
        openTime: data.readBigUInt64LE(2).toString(),
        initPcAmount: data.readBigUInt64LE(10).toString(),
        initCoinAmount: data.readBigUInt64LE(18).toString(),
    };
}

async function fetchMarketAccountsFromChain(marketId) {
    try {
        const marketPublicKey = new PublicKey(marketId);
        const accountInfo = await connection.getAccountInfo(marketPublicKey);
        if (!accountInfo) {
            console.log("No account info found for market:", marketId);
            return null;
        }
        const data = accountInfo.data;
        if (data.length < 341) {
            console.log("Market account data too short");
            return null;
        }
        const eventQueue = new PublicKey(data.subarray(245, 245 + 32)).toString();
        const marketBids = new PublicKey(data.subarray(277, 277 + 32)).toString();
        const marketAsks = new PublicKey(data.subarray(309, 309 + 32)).toString();
        return {
            marketAsks,
            marketBids,
            marketEventQueue: eventQueue
        };
    } catch (error) {
        console.error("Error fetching market account:", error.message);
        return null;
    }
}

async function processRaydiumLpTransaction(connection, signature) {
    try {
        const transactionDetails = await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });

        if (!transactionDetails) {
            console.error("No transaction details found:", signature);
            return null;
        }

        const message = transactionDetails.transaction.message;
        const accounts = message.staticAccountKeys
            ? message.staticAccountKeys.map((key) => key.toString())
            : message.accountKeys.map((key) => key.toString());

        const instructions = message.compiledInstructions || message.instructions;

        if (!instructions) {
            console.error("No instructions found");
            return null;
        }

        for (const ix of instructions) {
            const programId = accounts[ix.programIdIndex];

            if (programId === RAYDIUM_AMM_PROGRAM_ID.toString() && ix.data.length > 0) {
                const accountIndices = ix.accounts || ix.accountKeyIndexes;

                if (!accountIndices) {
                    console.error("No account indices");
                    continue;
                }

                const data = Buffer.from(ix.data, 'base64');
                const params = parseCreateAmmLpParams(data);

                const indexedAccounts = {
                    programId: accounts[accountIndices[0]],
                    ammId: accounts[accountIndices[4]],
                    ammAuthority: accounts[accountIndices[5]],
                    ammOpenOrders: accounts[accountIndices[6]],
                    lpMint: accounts[accountIndices[7]],
                    baseMint: accounts[accountIndices[8]],
                    quoteMint: accounts[accountIndices[9]],
                    baseVault: accounts[accountIndices[10]],
                    quoteVault: accounts[accountIndices[11]],
                    ammTargetOrders: accounts[accountIndices[13]],
                    deployer: accounts[accountIndices[17]],
                    marketProgramId: accounts[accountIndices[15]],
                    marketId: accounts[accountIndices[16]],
                    marketBaseVault: accounts[accountIndices[18]],
                    marketQuoteVault: accounts[accountIndices[19]],
                    marketAuthority: accounts[accountIndices[20]]
                };

                console.log("Decoded AMM Accounts:", JSON.stringify({
                    ...indexedAccounts,
                    baseMint: indexedAccounts.baseMint,
                    quoteMint: indexedAccounts.quoteMint,
                    lpMint: indexedAccounts.lpMint
                }, null, 2));

                let tokenData = {
                    programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
                    ammId: new PublicKey(indexedAccounts.ammId).toString(),
                    ammAuthority: new PublicKey(indexedAccounts.ammAuthority).toString(),
                    ammOpenOrders: new PublicKey(indexedAccounts.ammOpenOrders).toString(),
                    lpMint: new PublicKey(indexedAccounts.lpMint).toString(),
                    baseMint: new PublicKey(indexedAccounts.baseMint).toString(),
                    quoteMint: new PublicKey(indexedAccounts.quoteMint).toString(),
                    baseVault: new PublicKey(indexedAccounts.baseVault).toString(),
                    quoteVault: new PublicKey(indexedAccounts.quoteVault).toString(),
                    targetOrders: new PublicKey(indexedAccounts.ammTargetOrders).toString(),
                    ammTargetOrders: new PublicKey(indexedAccounts.ammTargetOrders).toString(),
                    deployer: new PublicKey(indexedAccounts.deployer).toString(),
                    marketProgramId: new PublicKey(indexedAccounts.marketProgramId).toString(),
                    marketId: new PublicKey(indexedAccounts.marketId).toString(),
                    marketBaseVault: new PublicKey(indexedAccounts.marketBaseVault).toString(),
                    marketQuoteVault: new PublicKey(indexedAccounts.marketQuoteVault).toString(),
                    marketAuthority: new PublicKey(indexedAccounts.marketAuthority).toString(),
                    systemProgramId: SYSTEM_PROGRAM_ID,
                    tokenProgramId: TOKEN_PROGRAM_ID_STR,
                    associatedTokenProgramId: ASSOCIATED_TOKEN_PROGRAM_ID_STR,
                    initPcAmount: params.initPcAmount,//amount sol (9 decimals to remove)
                    initCoinAmount: params.initCoinAmount,//amount coin (6 decimals to remove)
                    K: (BigInt(params.initPcAmount) * BigInt(params.initCoinAmount)).toString(),
                    V: (Math.min(Number(params.initPcAmount), Number(params.initCoinAmount)) /
                        Math.max(Number(params.initPcAmount), Number(params.initCoinAmount))).toString(),//price in sol
                    isWSOLSwap: indexedAccounts.baseMint === WSOL_MINT,
                    wrappedSOLAmount: indexedAccounts.baseMint === WSOL_MINT
                        ? params.initCoinAmount
                        : null,
                    fee: "0.003",
                    token: new PublicKey(indexedAccounts.baseMint).toString(),
                    baseDecimals: 9,
                    quoteDecimals: 9,
                    version: 'V2',
                    marketVersion: 'V2',
                    serumProgramId: indexedAccounts.marketProgramId,
                    serumMarket: indexedAccounts.marketId,
                    serumBids: null,
                    serumAsks: null,
                    serumEventQueue: null,
                };

                try {
                    const marketAccounts = await fetchMarketAccountsFromChain(tokenData.marketId);
                    if (marketAccounts) {
                        console.log("Market accounts data:", JSON.stringify(marketAccounts, null, 2));

                        // Add explicit Serum market data
                        tokenData.serumBids = marketAccounts.marketBids;
                        tokenData.serumAsks = marketAccounts.marketAsks;
                        tokenData.serumEventQueue = marketAccounts.marketEventQueue;
                        tokenData.marketBids = marketAccounts.marketBids;
                        tokenData.marketAsks = marketAccounts.marketAsks;
                        tokenData.marketEventQueue = marketAccounts.marketEventQueue;
                    } else {
                        console.log("No market accounts found in on-chain data");
                        throw new Error("Missing critical market data for V2 swaps");
                    }
                } catch (error) {
                    console.error("Failed to fetch market accounts from chain:", error.message);
                    throw error;
                }

                console.log("Full token data structure:", JSON.stringify({
                    ...tokenData,
                    _id: "REDACTED",
                }, null, 2));

                const insertedId = await saveToMongo(tokenData);
                return { ...tokenData, _id: insertedId.toString() };
            }
        }
    } catch (error) {
        if (error.message.includes("Cannot read properties of undefined (reading '_bn')")) {
            console.log("Skipping transaction due to undefined error:", signature);
        } else {
            console.error("Processing error:", error.message);
        }
        return null;
    }
}

module.exports = {
    connectToDatabase,
    processRaydiumLpTransaction,
};