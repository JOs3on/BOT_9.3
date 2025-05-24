const { Connection, PublicKey, Keypair, ComputeBudgetProgram, SystemProgram, TransactionMessage, VersionedTransaction } = require("@solana/web3.js");
const { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createCloseAccountInstruction, getOrCreateAssociatedTokenAccount } = require("@solana/spl-token");
const { Liquidity, Token, TokenAmount, jsonInfo2PoolKeys } = require("@raydium-io/raydium-sdk-v2");
const { MongoClient, ObjectId } = require("mongodb");
const bs58 = require('bs58');
require("dotenv").config();

// Initialize connection
const connection = new Connection(process.env.SOLANA_WS_URL || "https://api.mainnet-beta.solana.com", {
    wsEndpoint: process.env.SOLANA_WS_URL || "wss://api.mainnet-beta.solana.com",
    commitment: "confirmed"
});

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// MongoDB setup
let db;
async function connectToDatabase() {
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    db = client.db("bot");
    return db;
}

async function fetchTokenDataFromMongo(tokenId) {
    if (!db) await connectToDatabase();

    const document = await db.collection("raydium_lp_transactionsV3").findOne({
        _id: new ObjectId(tokenId)
    });

    if (!document) throw new Error(`Token data not found for ID: ${tokenId}`);

    // V2 Required Fields Validation
    const requiredV2Fields = [
        'ammId', 'ammAuthority', 'ammOpenOrders', 'targetOrders',
        'baseMint', 'quoteMint', 'baseVault', 'quoteVault',
        'marketProgramId', 'marketId', 'marketBids', 'marketAsks',
        'marketEventQueue', 'marketBaseVault', 'marketQuoteVault',
        'marketAuthority', 'baseDecimals', 'quoteDecimals'
    ];

    const missingFields = requiredV2Fields.filter(field => !document[field]);
    if (missingFields.length > 0) {
        throw new Error(`Missing required V2 fields: ${missingFields.join(', ')}`);
    }

    return document;
}

async function createSwapInstruction(tokenData, userKeys, amountIn) {
    try {
        const poolKeys = jsonInfo2PoolKeys({
            id: tokenData.ammId,
            baseMint: tokenData.baseMint,
            quoteMint: tokenData.quoteMint,
            lpMint: tokenData.lpMint,
            baseDecimals: tokenData.baseDecimals,
            quoteDecimals: tokenData.quoteDecimals,
            programId: tokenData.programId || "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
            authority: tokenData.ammAuthority,
            openOrders: tokenData.ammOpenOrders,
            targetOrders: tokenData.targetOrders, // Critical V2 field
            baseVault: tokenData.baseVault,
            quoteVault: tokenData.quoteVault,
            marketVersion: 4, // Explicit version
            marketProgramId: tokenData.marketProgramId,
            marketId: tokenData.marketId,
            marketBids: tokenData.marketBids,
            marketAsks: tokenData.marketAsks,
            marketEventQueue: tokenData.marketEventQueue,
            marketBaseVault: tokenData.marketBaseVault,
            marketQuoteVault: tokenData.marketQuoteVault,
            marketAuthority: tokenData.marketAuthority
        });

        const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
            connection,
            poolKeys,
            userKeys: {
                tokenAccountIn: new PublicKey(userKeys.tokenAccountIn),
                tokenAccountOut: new PublicKey(userKeys.tokenAccountOut),
                owner: userKeys.owner
            },
            amountIn: new TokenAmount(
                new Token(poolKeys.baseMint, poolKeys.baseDecimals),
                amountIn
            ),
            amountOutMin: TokenAmount.zero, // Set slippage tolerance here (e.g., TokenAmount.zero for max slippage)
            fixedSide: "in",
            makeTxVersion: 0 // Legacy transaction
        });

        return innerTransactions[0].instructions;
    } catch (error) {
        console.error("[Swap] Instruction creation failed:", error);
        throw error;
    }
}

async function swapTokens({ tokenId, amountSpecified, swapBaseIn }) {
    const userOwner = Keypair.fromSecretKey(
        bs58.decode(process.env.WALLET_PRIVATE_KEY)
    );
    const tokenData = await fetchTokenDataFromMongo(tokenId);

    // Priority fee setup
    const computeUnits = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    const computePrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 });

    // Token addresses
    const inputMint = new PublicKey(swapBaseIn ? tokenData.baseMint : tokenData.quoteMint);
    const outputMint = new PublicKey(swapBaseIn ? tokenData.quoteMint : tokenData.baseMint);

    // Token accounts
    const [tokenAccountIn, tokenAccountOut] = await Promise.all([
        getOrCreateAssociatedTokenAccount(
            connection,
            userOwner,
            inputMint,
            userOwner.publicKey
        ).then(acc => acc.address),
        getOrCreateAssociatedTokenAccount(
            connection,
            userOwner,
            outputMint,
            userOwner.publicKey
        ).then(acc => acc.address)
    ]);

    // WSOL handling
    const preInstructions = [];
    const postInstructions = [];

    if (inputMint.equals(WSOL_MINT)) {
        preInstructions.push(
            SystemProgram.transfer({
                fromPubkey: userOwner.publicKey,
                toPubkey: tokenAccountIn,
                lamports: amountSpecified
            }),
            createAssociatedTokenAccountInstruction(
                userOwner.publicKey,
                tokenAccountIn,
                userOwner.publicKey,
                WSOL_MINT
            )
        );
        postInstructions.push(createCloseAccountInstruction(tokenAccountIn, userOwner.publicKey, userOwner.publicKey));
    }

    // Create swap instructions
    const swapIx = await createSwapInstruction(tokenData, {
        tokenAccountIn: tokenAccountIn.toString(),
        tokenAccountOut: tokenAccountOut.toString(),
        owner: userOwner.publicKey
    }, amountSpecified);

    // Build transaction
    const { blockhash } = await connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
        payerKey: userOwner.publicKey,
        recentBlockhash: blockhash,
        instructions: [
            computeUnits,
            computePrice,
            ...preInstructions,
            ...swapIx,
            ...postInstructions
        ]
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([userOwner]);

    try {
        const signature = await connection.sendTransaction(tx);
        const confirmation = await connection.confirmTransaction(signature, "confirmed");

        // Log successful swap
        await db.collection("swapAttempts").insertOne({
            tokenId,
            amount: amountSpecified,
            direction: swapBaseIn ? "buy" : "sell",
            signature,
            timestamp: new Date(),
            status: confirmation.value.err ? "failed" : "success",
            price: await calculatePriceFromPool(tokenData) // Optional price logging
        });

        return signature;
    } catch (error) {
        await db.collection("swapAttempts").insertOne({
            tokenId,
            amount: amountSpecified,
            direction: swapBaseIn ? "buy" : "sell",
            error: error.message,
            timestamp: new Date(),
            status: "failed"
        });
        throw error;
    }
}

// Helper: Calculate current price from pool reserves
async function calculatePriceFromPool(tokenData) {
    const poolKeys = jsonInfo2PoolKeys({
        id: tokenData.ammId,
        baseMint: tokenData.baseMint,
        quoteMint: tokenData.quoteMint,
        lpMint: tokenData.lpMint,
        baseDecimals: tokenData.baseDecimals,
        quoteDecimals: tokenData.quoteDecimals,
        programId: tokenData.programId || "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
        authority: tokenData.ammAuthority,
        openOrders: tokenData.ammOpenOrders,
        targetOrders: tokenData.targetOrders, // Critical V2 field
        baseVault: tokenData.baseVault,
        quoteVault: tokenData.quoteVault,
        marketVersion: 4, // Explicit version
        marketProgramId: tokenData.marketProgramId,
        marketId: tokenData.marketId,
        marketBids: tokenData.marketBids,
        marketAsks: tokenData.marketAsks,
        marketEventQueue: tokenData.marketEventQueue,
        marketBaseVault: tokenData.marketBaseVault,
        marketQuoteVault: tokenData.marketQuoteVault,
        marketAuthority: tokenData.marketAuthority
    });

    const poolState = await Liquidity.fetchState({ connection, poolKeys });
    return poolState.quoteReserve.toNumber() / poolState.baseReserve.toNumber();
}

module.exports = {
    swapTokens,
    connectToDatabase,
    fetchTokenDataFromMongo
};