import { address, Address, createSolanaRpc, KeyPairSigner, mainnet } from '@solana/web3.js';
import { openPositionUtil, closePositionUtil, getPriceOfPool } from '../positionManagement';
import { calcUsdValueOfPosition, fetchWhirlpoolUtil, getTokenBalUtil } from '../utils';
import { setNativeMintWrappingStrategy } from '@orca-so/whirlpools';
import { db, initDb } from '../db';
import { fetchWhirlpool } from '@orca-so/whirlpools-client';
import { getUsdPriceFromJup } from '../jup';
import { createAtaForMint } from '../tokenHelper';
import { Strategy } from '../constants';

interface PositionState {
    sessionId: Address;
    positionMintAddress: Address;
    entryPrice: number;
    startingValue: number;
    sessionStartTime: number;
    upperBoundary: number;
    lowerBoundary: number;
    lastCheckTime: number;
    holdAboveEntry: boolean;
    currentPositionUsdValue: number;
}

export async function startWorkerStrategy1(
    wallet: KeyPairSigner,
    rpcUrl: string,
    initialPositionSize: number = 17.50,
    rangeDeviation: number = 0.05,
    poolAddress: Address = address("FwewVm8u6tFPGewAyHmWAqad9hmF7mvqxK4mJ7iNqqGC"),
    checkIntervalMinutes: number = 60,
    profitTargetAsDecimal: number = 0.01
) {

    await initDb();

    setNativeMintWrappingStrategy('none');

    const mainnetRpc = createSolanaRpc(mainnet(rpcUrl));
    const whirlpool = await fetchWhirlpoolUtil(mainnetRpc, address(poolAddress));


    const POOL_ADDRESS = poolAddress;
    const TOKENA_MINT = whirlpool.data.tokenMintA;
    const TOKENB_MINT = whirlpool.data.tokenMintB;
    const RANGE_DEVIATION = rangeDeviation; // 5%
    const POS_CHECK_INTERVAL_MS = Math.ceil(1000 * 60 * checkIntervalMinutes); // 1 hour in milliseconds

    await createAtaForMint(mainnetRpc, wallet, TOKENA_MINT);
    await createAtaForMint(mainnetRpc, wallet, TOKENB_MINT);

    let currentPosition: PositionState | null = null;
    let isRunning = true;

    // Get initial wallet balances at worker startup
    const tokenABalance = await getTokenBalUtil(wallet, TOKENA_MINT);
    const tokenBBalance = await getTokenBalUtil(wallet, TOKENB_MINT);

    const tokenADecimals = tokenABalance.decimals;
    const tokenBDecimals = tokenBBalance.decimals;

    const initialPrice = await getPriceOfPool(mainnetRpc, POOL_ADDRESS, tokenADecimals, tokenBDecimals);

    if (!tokenABalance || !tokenBBalance) {
        throw new Error("Failed to get initial wallet balances");
    }

    console.log("\n=== Initial Wallet Balances ===");
    console.log(`Token A Balance: ${tokenABalance.tokenBalanceNormalized}`);
    console.log(`Token B Balance: ${tokenBBalance.tokenBalanceNormalized}`);
    console.log(`Pool Price: $${initialPrice}`);
    console.log(`Total Value: $${(tokenABalance.tokenBalanceNormalized * initialPrice + tokenBBalance.tokenBalanceNormalized).toFixed(2)}\n`);

    // Store initial balance values for use in all position records
    const sessionStartTokenABalanceUsdValue = tokenABalance.tokenBalanceNormalized * initialPrice;
    const sessionStartTokenBBalanceUsdValue = tokenBBalance.tokenBalanceNormalized;

    async function openNewPosition() {
        console.log("\n=== Opening new position ===");
        try {
            const tokenABalance = await getTokenBalUtil(wallet, TOKENA_MINT);
            const tokenBBalance = await getTokenBalUtil(wallet, TOKENB_MINT);
            let currentPriceOfPool = await getPriceOfPool(mainnetRpc, POOL_ADDRESS, tokenADecimals, tokenBDecimals);
            let currentPriceA = await getUsdPriceFromJup(TOKENA_MINT, BigInt(10 ** tokenADecimals), tokenADecimals);
            let currentPriceB = await getUsdPriceFromJup(TOKENB_MINT, BigInt(10 ** tokenBDecimals), tokenBDecimals);
            if (!tokenABalance || !tokenBBalance) {
                console.error("Failed to get initial wallet balances");
                return;
            }

            const totalBalanceUsdValueOfAssetsOfInterest = tokenABalance.tokenBalanceNormalized * currentPriceA + tokenBBalance.tokenBalanceNormalized * currentPriceB;


            // Only show initial balances for first position
            if (!currentPosition) {
                console.log("\n=== Initial Wallet Balances ===");
                console.log(`Token A Balance: ${tokenABalance.tokenBalanceNormalized}`);
                console.log(`Token B Balance: ${tokenBBalance.tokenBalanceNormalized}`);
                console.log(`Current Price of Pool: $${currentPriceOfPool}`);
                console.log(`Total Balance USD Value of Assets of Interest: $${totalBalanceUsdValueOfAssetsOfInterest.toFixed(2)}\n`);
            }

            // if the wallet has enough value for initialPositionSize then use that, otherwise use the current position value
            const openPositionResult = await openPositionUtil(
                mainnetRpc,
                POOL_ADDRESS,
                RANGE_DEVIATION,
                wallet,
                TOKENA_MINT,
                TOKENB_MINT,
                totalBalanceUsdValueOfAssetsOfInterest >= initialPositionSize ? initialPositionSize : totalBalanceUsdValueOfAssetsOfInterest
            );

            currentPriceOfPool = openPositionResult.currentPrice;
            console.log("Current Price of Pool: ", currentPriceOfPool);
            const positionValue = await calcUsdValueOfPosition(
                mainnetRpc,
                openPositionResult.positionMintAddress,
                100,
                tokenADecimals,
                tokenBDecimals,
                POOL_ADDRESS,
                wallet
            );

            if (!positionValue) {
                console.error("Failed to get position value, retrying in 5 seconds...");
                await new Promise(resolve => setTimeout(resolve, 5000));
                return await openNewPosition();
            }
            // if all of these variables are defined then 
            // (openPositionResult.tokenAChange * currentPrice) + (openPositionResult.tokenBChange * currentPrice)
            // else just use positionValue.totalUsdValue
            const startingValue = (openPositionResult.tokenAChange && openPositionResult.tokenBChange) ? (openPositionResult.tokenAChange * currentPriceA) + (openPositionResult.tokenBChange * currentPriceB) : positionValue.totalUsdValue;
            // log all the values
            console.log("Starting Value: ", startingValue);
            console.log("Token A Change: ", openPositionResult.tokenAChange);
            console.log("Token B Change: ", openPositionResult.tokenBChange);
            console.log("Current Price A: ", currentPriceA);
            console.log("Current Price B: ", currentPriceB);
            console.log("Position Value: ", positionValue.totalUsdValue);

            const now = Date.now();
            currentPosition = {
                sessionId: currentPosition?.sessionId || openPositionResult.positionMintAddress,
                positionMintAddress: openPositionResult.positionMintAddress,
                entryPrice: currentPriceOfPool,
                startingValue: startingValue,
                sessionStartTime: currentPosition?.sessionStartTime || Math.floor(now / 1000),
                upperBoundary: currentPriceOfPool * (1 + RANGE_DEVIATION),
                lowerBoundary: currentPriceOfPool * (1 - RANGE_DEVIATION),
                lastCheckTime: now,
                holdAboveEntry: false,
                currentPositionUsdValue: positionValue.totalUsdValue
            };

            // Record to database after position is confirmed open
            await db.createPosition({
                session_id: currentPosition.sessionId.toString(),
                position_mint_address: openPositionResult.positionMintAddress.toString(),
                pool_address: POOL_ADDRESS.toString(),
                entry_price: currentPriceOfPool,
                range_deviation_perc_as_decimal: RANGE_DEVIATION,
                starting_usd_value: startingValue,
                starting_token_a_amount: positionValue.tokenAEstMinAmountNormalized,
                starting_token_b_amount: positionValue.tokenBEstMinAmountNormalized,
                session_start_time: Math.floor(now / 1000),
                position_start_time: Math.floor(now / 1000),
                lower_boundary: currentPriceOfPool * (1 - RANGE_DEVIATION),
                upper_boundary: currentPriceOfPool * (1 + RANGE_DEVIATION),
                is_active: true,
                session_start_token_a_balance_usd_value: sessionStartTokenABalanceUsdValue,
                session_start_token_b_balance_usd_value: sessionStartTokenBBalanceUsdValue,
                pubkey: wallet.address.toString(),
                token_a_mint: TOKENA_MINT.toString(),
                token_b_mint: TOKENB_MINT.toString(),
                strategy: Strategy.Strat1,
                take_profit_threshold: profitTargetAsDecimal
            }, !currentPosition);

            console.log("New position details:", {
                sessionId: currentPosition.sessionId,
                mint: currentPosition.positionMintAddress,
                entryPrice: currentPosition.entryPrice.toFixed(2),
                startingValue: currentPosition.startingValue.toFixed(2),
                upperBoundary: currentPosition.upperBoundary.toFixed(2),
                lowerBoundary: currentPosition.lowerBoundary.toFixed(2),
                time: new Date(currentPosition.sessionStartTime * 1000).toISOString()
            });
        } catch (error) {
            console.error("Error opening new position:", error);
            console.log("Retrying to open new position in 5 seconds...");
            await new Promise(resolve => setTimeout(resolve, 5000));
            return await openNewPosition();
        }
    }

    async function checkAndManagePosition() {
        if (!currentPosition) return;

        const now = Date.now();
        
        // Only check once per POS_CHECK_INTERVAL_MS
        if (now - currentPosition.lastCheckTime < POS_CHECK_INTERVAL_MS) {
            // log position status

            console.log(`Status Update of Position ${currentPosition.positionMintAddress}`);
            console.log("Time:", new Date().toISOString());

            const currentPriceOfPool = await getPriceOfPool(mainnetRpc, POOL_ADDRESS, tokenADecimals, tokenBDecimals);
            const currentValue = await calcUsdValueOfPosition(
                mainnetRpc,
                currentPosition.positionMintAddress,
                25,
                tokenADecimals,
                tokenBDecimals,
                POOL_ADDRESS,
                wallet
            );
            currentPosition.currentPositionUsdValue = currentValue?.totalUsdValue || 0;
    
            if (!currentValue) throw new Error("Failed to get current position value");
    
            const profitPercent = (currentValue.totalUsdValue - currentPosition.startingValue) / currentPosition.startingValue;
            
            console.log("Position Status:");
            console.log(`- Current Price: $${currentPriceOfPool.toFixed(2)}`);
            console.log(`- Entry Price: $${currentPosition.entryPrice.toFixed(2)}`);
            console.log(`- Current Value: $${currentValue.totalUsdValue.toFixed(2)}`);
            // starting value
            console.log(`- Starting Value: $${currentPosition.startingValue.toFixed(2)}`);
            console.log(`- Profit: ${(profitPercent * 100).toFixed(2)}%`);
            console.log(`- Hours Active: ${((now - currentPosition.sessionStartTime * 1000) / 3600000).toFixed(1)}`);
    
            return;
        }

        console.log(`\n=== Position Check for ${currentPosition.positionMintAddress} ===`);
        console.log("Time:", new Date().toISOString());

        const currentPrice = await getPriceOfPool(mainnetRpc, POOL_ADDRESS, tokenADecimals, tokenBDecimals);
        const currentValue = await calcUsdValueOfPosition(
            mainnetRpc,
            currentPosition.positionMintAddress,
            25,
            tokenADecimals,
            tokenBDecimals,
            POOL_ADDRESS,
            wallet
        );

        if (!currentValue) throw new Error("Failed to get current position value");

        const profitPercent = (currentValue.totalUsdValue - currentPosition.startingValue) / currentPosition.startingValue;
        
        console.log("Position Status:");
        // lower and upper and hold above entry values
        console.log(`- Lower Boundary: $${currentPosition.lowerBoundary.toFixed(2)}`);
        console.log(`- Upper Boundary: $${currentPosition.upperBoundary.toFixed(2)}`);
        console.log(`- Hold Above Entry: ${currentPosition.holdAboveEntry ? "Yes" : "No"}`);
        // current price
        console.log(`- Current Price: $${currentPrice.toFixed(2)}`);
        // entry price
        console.log(`- Entry Price: $${currentPosition.entryPrice.toFixed(2)}`);
        // starting value
        console.log(`- Starting Value: $${currentPosition.startingValue.toFixed(2)}`);
        console.log(`- Current Value: $${currentValue.totalUsdValue.toFixed(2)}`);
        console.log(`- Profit: ${(profitPercent * 100).toFixed(2)}%`);
        console.log(`- Hours Active: ${((now - currentPosition.sessionStartTime * 1000) / 3600000).toFixed(1)}`);
        console.log(`- Mode: ${currentPosition.holdAboveEntry ? "Hold-Above-Entry" : "Normal"}`);

        // Check conditions for closing position
        let shouldClose = false;
        let closeReason = "";

        if (currentPosition.holdAboveEntry) {
            // In hold-above-entry mode, only close if price hits upper boundary or drops to/below entry
            if (currentPrice >= currentPosition.upperBoundary) {
                shouldClose = true;
                closeReason = "Price hit upper boundary while in hold-above-entry mode";
            } else if (currentPrice <= currentPosition.entryPrice) {
                shouldClose = true;
                closeReason = "Price dropped to entry while in hold-above-entry mode";
            } else {
                console.log("Strategy: Maintaining hold-above-entry position");
            }
        } else {
            // Normal mode
            if (currentPrice >= currentPosition.upperBoundary || currentPrice <= currentPosition.lowerBoundary) {
                shouldClose = true;
                closeReason = `Price hit ${currentPrice >= currentPosition.upperBoundary ? "upper" : "lower"} boundary`;
            }
            // Check for profit condition using the parameter
            else if (profitPercent >= profitTargetAsDecimal) {
                if (currentPrice > currentPosition.entryPrice) {
                    console.log(`Strategy: Switching to hold-above-entry mode (${(profitTargetAsDecimal * 100).toFixed(1)}% profit target)`);
                    currentPosition.holdAboveEntry = true;
                } else {
                    shouldClose = true;
                    closeReason = `${(profitTargetAsDecimal * 100).toFixed(2)}% profit achieved below entry price`;
                }
            }
        }

        if (shouldClose) {
            console.log(`\n=== Closing Position: ${closeReason} ===`);
            
            const finalPositionValue = await calcUsdValueOfPosition(
                mainnetRpc,
                currentPosition.positionMintAddress,
                75,
                tokenADecimals,
                tokenBDecimals,
                POOL_ADDRESS,
                wallet
            );

            if (!finalPositionValue) {
                console.error("Failed to get final position value before closing");
                return;
            }

            currentPosition.currentPositionUsdValue = finalPositionValue.totalUsdValue;
            console.log(`Position closing with value: $${finalPositionValue.totalUsdValue.toFixed(2)}`);

            const closeResult = await closePositionUtil(
                mainnetRpc,
                currentPosition.positionMintAddress,
                TOKENA_MINT,
                TOKENB_MINT,
                tokenADecimals,
                tokenBDecimals,
                75,
                wallet,
                POOL_ADDRESS
            );

            const backupTokenAUsdValue = (finalPositionValue.tokenAEstMinAmountNormalized * finalPositionValue.priceOfPool) + finalPositionValue.tokenAFeesNormalized * finalPositionValue.priceOfPool;
            const backupTokenBUsdValue = finalPositionValue.tokenBEstMinAmountNormalized + finalPositionValue.tokenBFeesNormalized;

            if (closeResult && closeResult.isConfirmed) {
                // Calculate final USD values
                const finalTokenAUsdValue = closeResult?.tokenAChange && closeResult.currentPriceA ? closeResult.tokenAChange * closeResult.currentPriceA : backupTokenAUsdValue;
                const finalTokenBUsdValue = closeResult?.tokenBChange && closeResult.currentPriceB ? closeResult.tokenBChange * closeResult.currentPriceB : backupTokenBUsdValue;

                // Record to database only after position is confirmed closed
                await db.closePosition(
                    currentPosition.positionMintAddress.toString(),
                    {
                        position_end_time: Math.floor(Date.now() / 1000),
                        closing_usd_value: finalTokenAUsdValue + finalTokenBUsdValue,
                        ending_token_a_amount: closeResult.tokenAChange ? closeResult.tokenAChange : closeResult.normalizedQuote.tokenAEst,
                        ending_token_b_amount: closeResult.tokenBChange ? closeResult.tokenBChange : closeResult.normalizedQuote.tokenBEst,
                        closing_price: closeResult.currentPriceOfPool || finalPositionValue.priceOfPool
                    },
                    false
                );

                console.log("Position closed successfully and recorded to database");
                await new Promise(resolve => setTimeout(resolve, 1000));
                await openNewPosition();
            }
        }

        // Update last check time
        if (currentPosition) {
            currentPosition.lastCheckTime = now;
        }
    }

    async function closePositionAndExit() {
        console.log("\n=== Graceful Shutdown Initiated ===");
        console.log("Please wait... Closing position...");
        if (!currentPosition) {
            console.log("No position to close");
            process.exit(0);
            return;
        }

        try {
            console.log("Attempting to close position before exit...");
            const finalPositionValue = await calcUsdValueOfPosition(
                mainnetRpc,
                currentPosition.positionMintAddress,
                100,
                tokenADecimals,
                tokenBDecimals,
                POOL_ADDRESS,
                wallet
            );

            if (finalPositionValue) {
                console.log(`Final position value: $${finalPositionValue.totalUsdValue.toFixed(2)}`);
            }

            const closeResult = await closePositionUtil(
                mainnetRpc,
                currentPosition.positionMintAddress,
                TOKENA_MINT,
                TOKENB_MINT,
                tokenADecimals,
                tokenBDecimals,
                75,
                wallet,
                POOL_ADDRESS
            );

            if (closeResult && closeResult.isConfirmed && finalPositionValue) {
                // Get final wallet balances after closing position
                const tokenABalance = await getTokenBalUtil(wallet, TOKENA_MINT);
                const tokenBBalance = await getTokenBalUtil(wallet, TOKENB_MINT);
                const currentPriceOfPool = await getPriceOfPool(mainnetRpc, POOL_ADDRESS, tokenADecimals, tokenBDecimals);

                const currentPriceA = await getUsdPriceFromJup(TOKENA_MINT, BigInt(10 ** tokenADecimals), tokenADecimals);
                const currentPriceB = await getUsdPriceFromJup(TOKENB_MINT, BigInt(10 ** tokenBDecimals), tokenBDecimals);
                if (!tokenABalance || !tokenBBalance) {
                    console.error("Failed to get final wallet balances");
                } else {
                    console.log("\n=== Final Wallet Balances ===");
                    console.log(`Token A Balance: ${tokenABalance.tokenBalanceNormalized}`);
                    console.log(`Token B Balance: ${tokenBBalance.tokenBalanceNormalized}`);
                    console.log(`Current Price: $${currentPriceOfPool}`);
                    console.log(`Total Value: $${(tokenABalance.tokenBalanceNormalized * currentPriceA + tokenBBalance.tokenBalanceNormalized * currentPriceB).toFixed(2)}\n`);
                }

                const backupTokenAUsdValue = (finalPositionValue.tokenAEstMinAmountNormalized * finalPositionValue.currentPriceA) + finalPositionValue.tokenAFeesNormalized * finalPositionValue.currentPriceA;
                const backupTokenBUsdValue = (finalPositionValue.tokenBEstMinAmountNormalized * finalPositionValue.currentPriceB) + finalPositionValue.tokenBFeesNormalized * finalPositionValue.currentPriceB;

                // Calculate final USD values
                const finalTokenAUsdValue = closeResult?.tokenAChange && closeResult.currentPriceA ? closeResult.tokenAChange * closeResult.currentPriceA : backupTokenAUsdValue;
                const finalTokenBUsdValue = closeResult?.tokenBChange && closeResult.currentPriceB ? closeResult.tokenBChange * closeResult.currentPriceB : backupTokenBUsdValue;

                // Record to database only after position is confirmed closed
                await db.closePosition(
                    currentPosition.positionMintAddress.toString(),
                    {
                        position_end_time: Math.floor(Date.now() / 1000),
                        session_end_time: Math.floor(Date.now() / 1000),
                        closing_usd_value: finalTokenAUsdValue + finalTokenBUsdValue,
                        ending_token_a_amount: closeResult.tokenAChange ? closeResult.tokenAChange : closeResult.normalizedQuote.tokenAEst,
                        ending_token_b_amount: closeResult.tokenBChange ? closeResult.tokenBChange : closeResult.normalizedQuote.tokenBEst,
                        closing_price: closeResult.currentPriceOfPool || finalPositionValue.priceOfPool,
                        session_end_token_a_balance_usd_value: tokenABalance.tokenBalanceNormalized * currentPriceA,
                        session_end_token_b_balance_usd_value: tokenBBalance.tokenBalanceNormalized * currentPriceB
                    },
                    true
                );

                console.log("Position closed successfully and recorded to database");
            } else {
                console.error("Failed to close position");
            }
        } catch (error) {
            console.error("Error during graceful shutdown:", error);
        } finally {
            console.log("Exiting... \nPress Enter if logs didn't clear");
            process.exit(0);
        }
    }

    // Handle graceful shutdown signals
    process.on('SIGINT', closePositionAndExit);  // Ctrl+C
    process.on('SIGTERM', closePositionAndExit); // Kill command
    process.on('SIGUSR1', closePositionAndExit); // nodemon restart
    process.on('SIGUSR2', closePositionAndExit); // nodemon restart
    process.on('uncaughtException', async (error) => {
        console.error('Uncaught Exception:', error);
        await closePositionAndExit();
    });
    process.on('unhandledRejection', async (reason, promise) => {
        console.error('Unhandled Rejection at:', promise, 'reason:', reason);
        await closePositionAndExit();
    });

    // Initial position
    await openNewPosition();

    // Main loop
    while (isRunning) {
        try {
            await checkAndManagePosition();
        } catch (error) {
            console.error("Error in position management:", error);
        }
        // Wait the minimum of checkIntervalMinutes or 5 minutes
        const waitTimeMinutes = Math.min(5, checkIntervalMinutes);
        // console log status update every waitTimeMinutes
        console.log(`Status update every ${waitTimeMinutes} minutes...`);
        console.log(`Conditions Check every ${checkIntervalMinutes} minutes...`);
        await new Promise(resolve => setTimeout(resolve, Math.ceil(1000 * 60 * waitTimeMinutes)));
    }
} 