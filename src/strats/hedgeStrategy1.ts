import { address, Address, createSolanaRpc, KeyPairSigner, mainnet } from '@solana/web3.js';
import { openPositionUtil, closePositionUtil, getPriceOfPool } from '../positionManagement';
import { calcUsdValueOfPosition, fetchWhirlpoolUtil, getTokenBalUtil, sendUsdcProtocolFee } from '../utils';
import { setNativeMintWrappingStrategy } from '@orca-so/whirlpools';
import { db, initDb, PerpPosition } from '../db';
import { fetchWhirlpool } from '@orca-so/whirlpools-client';
import { getUsdPriceFromJup } from '../jup';
import { createAtaForMint } from '../tokenHelper';
import { Strategy } from '../constants';
import { calculateRequiredCollateral, closeShort, handleUserAndDeposit, manageShortPositions } from '../drift/drift-utils';
import { getActiveSubAccountId, getPositionDetails } from '../drift/drift-worker-interface';
import { BasicPriceData, checkValidMomentumForPosition } from './momentum';

const DEBUG = false;

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
    startingDriftUsdcBal: number;
    collateralUsdValue: number;
    isActive: boolean;
}

export async function startHedgeWorkerStrategy1(
    wallet: KeyPairSigner,
    rpcUrl: string,
    initialPositionSize: number = 17.50,
    rangeDeviation: number = 0.05,
    poolAddress: Address = address("FwewVm8u6tFPGewAyHmWAqad9hmF7mvqxK4mJ7iNqqGC"),
    checkIntervalMinutes: number = 1,
    profitTargetAsDecimal: number = 0.01,
    usdcPercOfPositionSizeForShort: number = 0.33,
    useHoldAboveEntry: boolean = false
) {

    await initDb();

    setNativeMintWrappingStrategy('none');

    const activeSubAccountIdOutput = await getActiveSubAccountId();

    let subAccountId = activeSubAccountIdOutput?.data?.activeSubAccountId || 0;

    let sessionPnl = 0;

    console.log("Active Sub Account ID: ", activeSubAccountIdOutput);

    if (activeSubAccountIdOutput?.error) {
        throw new Error("Failed to get active sub account id");
    }



    const mainnetRpc = createSolanaRpc(mainnet(rpcUrl));
    const whirlpool = await fetchWhirlpoolUtil(mainnetRpc, address(poolAddress));


    const POOL_ADDRESS = poolAddress;
    const TOKENA_MINT = whirlpool.data.tokenMintA;
    const TOKENB_MINT = whirlpool.data.tokenMintB;
    const RANGE_DEVIATION = rangeDeviation; // 5%
    const POS_CHECK_INTERVAL_MS = Math.ceil(1000 * 60 * checkIntervalMinutes); // 1 hour in milliseconds

    await createAtaForMint(mainnetRpc, wallet, TOKENA_MINT);
    await createAtaForMint(mainnetRpc, wallet, TOKENB_MINT);

    // position size cannot be larger than total assets of interest
    const inittokenABalance = await getTokenBalUtil(wallet, TOKENA_MINT);
    const inittokenBBalance = await getTokenBalUtil(wallet, TOKENB_MINT);

    const initTokenAPrice = await getUsdPriceFromJup(
        TOKENA_MINT, 
        inittokenABalance.tokenBalanceBigInt > 0 ? inittokenABalance.tokenBalanceBigInt : BigInt(10 ** inittokenABalance.decimals), 
        inittokenABalance.decimals
    );

    const initTokenBPrice = await getUsdPriceFromJup(
        TOKENB_MINT, 
        inittokenBBalance.tokenBalanceBigInt > 0 ? inittokenBBalance.tokenBalanceBigInt : BigInt(10 ** inittokenBBalance.decimals), 
        inittokenBBalance.decimals
    );

    const initTotalValue = inittokenABalance.tokenBalanceNormalized * initTokenAPrice + inittokenBBalance.tokenBalanceNormalized * initTokenBPrice;

    const positionSize = Math.min(initialPositionSize, initTotalValue);

    // handle user and deposit
    // get amount of collateral user wants based on usdc perc of position size
    const userCollateralUsdValue = positionSize * usdcPercOfPositionSizeForShort;

    const userAndDepositOutput = await handleUserAndDeposit(
        subAccountId,
        userCollateralUsdValue,
        undefined,
        undefined
    );

    if (userAndDepositOutput && userAndDepositOutput.subAccountId) {
        subAccountId = userAndDepositOutput.subAccountId;

        console.log("Using Sub Account ID: ", subAccountId);
    }

    console.log("Drift USDC Balance: ", userAndDepositOutput);

    // log initial position size
    console.log("Initial Position Size: ", positionSize);

    // log balance / initial position size if userAndDepositOutput is defined
    if (userAndDepositOutput && userAndDepositOutput.newBalance) {
        console.log("Balance / Initial Position Size: ", userAndDepositOutput.newBalance / positionSize);
    }

    let currentPosition: PositionState | null = null;
    let currentPerpPosition: PerpPosition | null = null;
    let isRunning = true;
    let lastCheckTime = Date.now();

    let validTimeForPosition = false;
    let currentMomentum10h = 0;
    let currentMomentum24h = 0;

    let currentBasicPriceDataArray: BasicPriceData[] = [];

    const initialMomentumOutput = await checkValidMomentumForPosition(
        'solana',
        currentBasicPriceDataArray
    );

    validTimeForPosition = initialMomentumOutput.isValid;
    currentMomentum10h = initialMomentumOutput.currentMomentum10h;
    currentMomentum24h = initialMomentumOutput.currentMomentum24h;
    currentBasicPriceDataArray = initialMomentumOutput.basicPriceDataArray;

    // log momentum metrics
    console.log("Current Momentum 10h: ", currentMomentum10h);
    console.log("Current Momentum 24h: ", currentMomentum24h);
    

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
        console.log("\n=== Opening new hedged position ===");
        try {
            const tokenABalance = await getTokenBalUtil(wallet, TOKENA_MINT);
            const tokenBBalance = await getTokenBalUtil(wallet, TOKENB_MINT);
            let currentPriceOfPool = await getPriceOfPool(mainnetRpc, POOL_ADDRESS, tokenADecimals, tokenBDecimals);
            let currentPriceA = await getUsdPriceFromJup(TOKENA_MINT, tokenABalance.tokenBalanceBigInt > 0 ? tokenABalance.tokenBalanceBigInt : BigInt(10 ** tokenADecimals), tokenADecimals);
            let currentPriceB = await getUsdPriceFromJup(TOKENB_MINT, tokenBBalance.tokenBalanceBigInt > 0 ? tokenBBalance.tokenBalanceBigInt : BigInt(10 ** tokenBDecimals), tokenBDecimals);
            if (!tokenABalance || !tokenBBalance) {
                console.error("Failed to get initial wallet balances");
                return;
            }

            const totalBalanceUsdValueOfAssetsOfInterest = tokenABalance.tokenBalanceNormalized * currentPriceA + tokenBBalance.tokenBalanceNormalized * currentPriceB;

            const finalTargetUsdValueForLp = totalBalanceUsdValueOfAssetsOfInterest >= initialPositionSize ? initialPositionSize : totalBalanceUsdValueOfAssetsOfInterest;

            const collateralUsdValue = calculateRequiredCollateral(
                finalTargetUsdValueForLp,
                RANGE_DEVIATION * 100
            );

            // log all the vals above starting with totalBalanceUsdValueOfAssetsOfInterest
            console.log("Total Balance USD Value of Assets of Interest: ", totalBalanceUsdValueOfAssetsOfInterest);
            console.log("Final Target Usd Value for LP: ", finalTargetUsdValueForLp);

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
                finalTargetUsdValueForLp
            );

            if (currentPosition) {
                currentPosition.positionMintAddress = openPositionResult.positionMintAddress;
            }

            currentPriceOfPool = openPositionResult.currentPrice;
            console.log("Current Price of Pool: ", currentPriceOfPool);
            const positionValue = await calcUsdValueOfPosition(
                mainnetRpc,
                openPositionResult.positionMintAddress,
                5,
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

            // manage short positions
            const shortOutput = await manageShortPositions(
                subAccountId,
                TOKENA_MINT, 
                TOKENB_MINT,
                tokenADecimals,
                tokenBDecimals,
                openPositionResult.tokenAChange || positionValue.tokenAEstAmountNormalized, 
                openPositionResult.tokenBChange || positionValue.tokenBEstAmountNormalized
            );

            // if shortOutput is null then close the lp position and wait 30 minutes before retrying
            if (!shortOutput &&  openPositionResult.isConfirmed) {
                console.log("Closing position because short output is null");
                await closePositionUtil(
                    mainnetRpc,
                    openPositionResult.positionMintAddress,
                    TOKENA_MINT,
                    TOKENB_MINT,
                    tokenADecimals,
                    tokenBDecimals,
                    95,
                    wallet,
                    POOL_ADDRESS
                )
                await new Promise(resolve => setTimeout(resolve, 30 * 60 * 1000));
                return await openNewPosition();
            }

            let startingValueLp = 0;
            let startingDriftUsdcBal = shortOutput?.data?.usdcBalBefore;
            if (shortOutput && 
                shortOutput.data && 
                openPositionResult.tokenAChange && 
                openPositionResult.tokenBChange && 
                currentPriceA && 
                currentPriceB &&
                startingDriftUsdcBal
            ) {

                startingValueLp = (openPositionResult.tokenAChange && openPositionResult.tokenBChange) ? (openPositionResult.tokenAChange * currentPriceA) + (openPositionResult.tokenBChange * currentPriceB) : positionValue.totalUsdValue;

            }
            else {
                throw new Error("Failed to get starting value");
            }

            currentPerpPosition = {

                position_mint_address: openPositionResult.positionMintAddress.toString(),
                usdc_collateral_amount: startingDriftUsdcBal,
                position_start_time: Math.floor(Date.now() / 1000),
                entry_price: shortOutput?.data?.oraclePriceNormalized || currentPriceOfPool,
                is_active: true,
                token: 'SOL', // TODO: make this dynamic
                size: shortOutput.data.baseAssetAmountNormalized,
                drift_usdc_balance_at_start: shortOutput.data.usdcBalAfter

            }

            await db.createPerpPosition({
                position_mint_address: openPositionResult.positionMintAddress.toString(),
                usdc_collateral_amount: collateralUsdValue,
                position_start_time: Math.floor(Date.now() / 1000),
                entry_price: shortOutput?.data?.oraclePriceNormalized || currentPriceOfPool,
                is_active: true,
                token: 'SOL', // TODO: make this dynamic
                size: shortOutput.data.baseAssetAmountNormalized,
                drift_usdc_balance_at_start: shortOutput.data.usdcBalAfter
            });

            // if all of these variables are defined then 
            // (openPositionResult.tokenAChange * currentPrice) + (openPositionResult.tokenBChange * currentPrice)
            // else just use positionValue.totalUsdValue
            // log all the values
            console.log("Starting Value LP: ", startingValueLp);
            console.log("Starting Drift Usdc Bal: ", startingDriftUsdcBal);
            console.log("Token A Change: ", openPositionResult.tokenAChange);
            console.log("Token B Change: ", openPositionResult.tokenBChange);
            console.log("Current Price A: ", currentPriceA);
            console.log("Current Price B: ", currentPriceB);
            console.log("Position Value: ", positionValue.totalUsdValue);

            const now = Date.now();
            lastCheckTime = now;
            currentPosition = {
                sessionId: currentPosition?.sessionId || openPositionResult.positionMintAddress,
                positionMintAddress: openPositionResult.positionMintAddress,
                entryPrice: currentPriceOfPool,
                startingValue: startingValueLp,
                sessionStartTime: currentPosition?.sessionStartTime || Math.floor(now / 1000),
                upperBoundary: currentPriceOfPool * (1 + RANGE_DEVIATION),
                lowerBoundary: currentPriceOfPool * (1 - RANGE_DEVIATION),
                lastCheckTime: now,
                holdAboveEntry: false,
                currentPositionUsdValue: positionValue.totalUsdValue,
                startingDriftUsdcBal: startingDriftUsdcBal,
                collateralUsdValue: collateralUsdValue,
                isActive: true
            };

            // Record to database after position is confirmed open
            await db.createPosition({
                session_id: currentPosition.sessionId.toString(),
                position_mint_address: openPositionResult.positionMintAddress.toString(),
                pool_address: POOL_ADDRESS.toString(),
                entry_price: currentPriceOfPool,
                range_deviation_perc_as_decimal: RANGE_DEVIATION,
                starting_usd_value: startingValueLp,
                starting_token_a_amount: openPositionResult.tokenAChange,
                starting_token_b_amount: openPositionResult.tokenBChange,
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
                strategy: Strategy.HedgeStrat1,
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
        // if (!currentPosition) return;

        const currentMomentumOutput = await checkValidMomentumForPosition(
            'solana',
            currentBasicPriceDataArray
        );

        validTimeForPosition = currentMomentumOutput.isValid;
        validTimeForPosition ? console.log("Valid time for position") : console.log("Not a valid time for position");
        currentMomentum10h = currentMomentumOutput.currentMomentum10h;
        currentMomentum24h = currentMomentumOutput.currentMomentum24h;
            // log momentum metrics
        console.log("Current Momentum 10h: ", currentMomentum10h);
        console.log("Current Momentum 24h: ", currentMomentum24h);
        
        currentBasicPriceDataArray = currentMomentumOutput.basicPriceDataArray;
        if ((validTimeForPosition && !currentPosition) || 
        (validTimeForPosition && currentPosition && !currentPosition.isActive)) {
            // it is a valid time for position but we don't have a position open
            // so we need to open a new position
            console.log("Opening new position because it is a valid time for position and we don't have a position open");
            await openNewPosition();
        }

        // if not valid time and we don't have a position open, then return
        // or if not valid time and we have a position open but it is not active, then return
        if ((!validTimeForPosition && !currentPosition) || 
        (!validTimeForPosition && currentPosition && !currentPosition.isActive) ||
        (!currentPosition)) {
            return;
        }

        const now = Date.now();


        
        // Only check once per POS_CHECK_INTERVAL_MS
        if (now - lastCheckTime < POS_CHECK_INTERVAL_MS && currentPosition && currentPosition.isActive) {
            // log position status

            console.log(`Status Update of Position ${currentPosition.positionMintAddress}`);
            console.log("Time:", new Date().toISOString());

            const currentPriceOfPool = await getPriceOfPool(mainnetRpc, POOL_ADDRESS, tokenADecimals, tokenBDecimals);
            const currentValue = await calcUsdValueOfPosition(
                mainnetRpc,
                currentPosition.positionMintAddress,
                0,
                tokenADecimals,
                tokenBDecimals,
                POOL_ADDRESS,
                wallet
            );
            currentPosition.currentPositionUsdValue = currentValue?.totalUsdValue || 0;
    
            if (!currentValue) throw new Error("Failed to get current position value");

            // get position details
            const driftPosDetails = await getPositionDetails(
                0, // TODO: change this to the dynamic market index
                tokenADecimals,
                subAccountId
            );

            const driftUnsettledPnl = driftPosDetails?.data?.unsettledPnl || 0;
            const collateralUsdValue = currentPosition.collateralUsdValue || 0;
            // calc perc pnl
            const driftPnlPerc = collateralUsdValue !== 0 ? driftUnsettledPnl / collateralUsdValue : 0;
            const lpUsdPnl = currentValue.totalUsdValue - currentPosition.startingValue;
    
            const profitPercentLp = lpUsdPnl / currentPosition.startingValue;

            // add both starting values and then calc total perc pnl
            const totalStartingValue = currentPosition.startingValue + collateralUsdValue;
            const totalPnl = lpUsdPnl + driftUnsettledPnl;
            const totalPnlPerc = totalPnl / totalStartingValue;
            
            console.log("Position Status:");
            // lower and upper and hold above entry values
            console.log(`- Lower Boundary: $${currentPosition.lowerBoundary.toFixed(2)}`);
            console.log(`- Upper Boundary: $${currentPosition.upperBoundary.toFixed(2)}`);
            console.log(`- Hold Above Entry: ${currentPosition.holdAboveEntry ? "Yes" : "No"}`);
            // current price
            console.log(`- Current Price: $${currentPriceOfPool.toFixed(2)}`);
            // entry price
            console.log(`- Entry Price: $${currentPosition.entryPrice.toFixed(2)}`);
            // starting value
            console.log(`- Starting Value LP: $${currentPosition.startingValue.toFixed(2)}`);
            console.log(`- Current Value LP: $${currentValue.totalUsdValue.toFixed(2)}`);
            console.log(`- LP Profit: ${(profitPercentLp * 100).toFixed(2)}%`);
            console.log(`- Starting Collateral Usd Value: $${collateralUsdValue.toFixed(2)}`);
            console.log(`- Drift Unsettled Pnl: $${driftUnsettledPnl.toFixed(2)}`);
            console.log(`- Drift Pnl Perc: ${(driftPnlPerc * 100).toFixed(2)}%`);
            console.log(`- Total Starting Value: $${totalStartingValue.toFixed(2)}`);
            console.log(`- Total Current Value: $${(totalStartingValue + totalPnl).toFixed(3)}`);
            console.log(`- Total Pnl: $${totalPnl.toFixed(2)}`);
            console.log(`- Total Pnl Perc: ${(totalPnlPerc * 100).toFixed(2)}%`);
            console.log(`- Hours Active: ${((now - currentPosition.sessionStartTime * 1000) / 3600000).toFixed(1)}`);
            console.log(`- Mode: ${currentPosition.holdAboveEntry ? "Hold-Above-Entry" : "Normal"}`);

            return;
        }


        console.log(`\n=== Position Check for ${currentPosition.positionMintAddress} ===`);
        console.log("Time:", new Date().toISOString());

        const currentPrice = await getPriceOfPool(mainnetRpc, POOL_ADDRESS, tokenADecimals, tokenBDecimals);
        const currentValue = await calcUsdValueOfPosition(
            mainnetRpc,
            currentPosition.positionMintAddress,
            5,
            tokenADecimals,
            tokenBDecimals,
            POOL_ADDRESS,
            wallet
        );

        if (!currentValue) throw new Error("Failed to get current position value");

        // Get drift position details
        const driftPosDetails = await getPositionDetails(
            0, // TODO: change this to the dynamic market index
            tokenADecimals,
            subAccountId
        );

        const currentDriftPrice = driftPosDetails?.data?.oraclePrice || 0;

        const driftUnsettledPnl = driftPosDetails?.data?.unsettledPnl || 0;
        const collateralUsdValue = currentPosition.collateralUsdValue || 0;
        // calc perc pnl
        const driftPnlPerc = collateralUsdValue !== 0 ? driftUnsettledPnl / collateralUsdValue : 0;
        const lpUsdPnl = currentValue.totalUsdValue - currentPosition.startingValue;

        const profitPercentLp = lpUsdPnl / currentPosition.startingValue;

        // add both starting values and then calc total perc pnl
        const totalStartingValue = currentPosition.startingValue + collateralUsdValue;
        const totalPnl = lpUsdPnl + driftUnsettledPnl;
        const totalPnlPerc = totalPnl / totalStartingValue;

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
        console.log(`- Starting Value LP: $${currentPosition.startingValue.toFixed(2)}`);
        console.log(`- Current Value LP: $${currentValue.totalUsdValue.toFixed(2)}`);
        console.log(`- LP Pnl Usd: $${lpUsdPnl.toFixed(3)}`);
        console.log(`- LP Profit: ${(profitPercentLp * 100).toFixed(2)}%`);
        console.log(`- Starting Collateral Usd Value: $${collateralUsdValue.toFixed(2)}`);
        console.log(`- Drift Unsettled Pnl: $${driftUnsettledPnl.toFixed(2)}`);
        console.log(`- Drift Pnl Perc: ${(driftPnlPerc * 100).toFixed(2)}%`);
        // drift entry priece
        console.log(`- Drift Entry Price: $${currentPerpPosition?.entry_price.toFixed(3)}`);
        // drift current price
        console.log(`- Drift Current Price: $${currentDriftPrice.toFixed(3)}`);
        console.log(`- Total Starting Value: $${totalStartingValue.toFixed(2)}`);
        console.log(`- Total Pnl of Current Position: $${totalPnl.toFixed(2)}`);
        console.log(`- Total Pnl Perc of Current Position: ${(totalPnlPerc * 100).toFixed(2)}%`);
        // session pnl
        console.log(`- Settled Session Pnl: $${sessionPnl.toFixed(2)}`);
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
                if (currentPrice > currentPosition.entryPrice && useHoldAboveEntry) {
                    console.log(`Strategy: Switching to hold-above-entry mode (${(profitTargetAsDecimal * 100).toFixed(1)}% profit target)`);
                    currentPosition.holdAboveEntry = true;
                } else {
                    shouldClose = true;
                    closeReason = `${(profitTargetAsDecimal * 100).toFixed(2)}% profit achieved below entry price`;
                }
            }
            else if (!validTimeForPosition) {
                shouldClose = true;
                closeReason = "Not a valid time for position";
            }
        }

        if (shouldClose) {
            console.log(`\n=== Closing Position: ${closeReason} ===`);
            
            const finalPositionValue = await calcUsdValueOfPosition(
                mainnetRpc,
                currentPosition.positionMintAddress,
                10,
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

            // Run both close operations concurrently
            const [closeResult, closeShortResult] = await Promise.all([
                closePositionUtil(
                    mainnetRpc,
                    currentPosition.positionMintAddress,
                    TOKENA_MINT,
                    TOKENB_MINT,
                    tokenADecimals,
                    tokenBDecimals,
                    95,
                    wallet,
                    POOL_ADDRESS
                ),
                closeShort(
                    subAccountId,
                    TOKENA_MINT,
                    tokenADecimals
                )
            ]);

            let shortPnlUsd = 0;
            let shortPnlPerc = 0;
            if (
                closeShortResult && 
                currentPosition.startingDriftUsdcBal && 
                currentPerpPosition?.position_mint_address &&
                closeShortResult.data?.oraclePriceNormalized &&
                closeResult?.currentPriceA
            ) {
                shortPnlUsd = closeShortResult?.data?.normalizedUsdcBalChange || 0; // TODO: use latest unsettled pnl instead in case of unpredictable usdc bal change
                shortPnlPerc = shortPnlUsd / currentPosition.startingDriftUsdcBal;
                console.log(`- Short Pnl Usd: $${shortPnlUsd.toFixed(2)}`);
                console.log(`- Short Pnl Perc: ${(shortPnlPerc * 100).toFixed(2)}%`);
            

            await db.closePerpPosition(
                currentPerpPosition.position_mint_address,
                {
                    position_end_time: Math.floor(Date.now() / 1000),
                    exit_price: closeShortResult.data.oraclePriceNormalized || closeResult?.currentPriceA,
                    pnl: shortPnlUsd,
                    drift_usdc_balance_at_end: closeShortResult?.data?.usdcBalAfter
                }
            )

        }

            DEBUG ? console.log("Close Short Result: ", closeShortResult) : null;

            const backupTokenAUsdValue = (finalPositionValue.tokenAEstMinAmountNormalized * finalPositionValue.priceOfPool) + finalPositionValue.tokenAFeesNormalized * finalPositionValue.priceOfPool;
            const backupTokenBUsdValue = finalPositionValue.tokenBEstMinAmountNormalized + finalPositionValue.tokenBFeesNormalized;

            if (closeResult && closeResult.isConfirmed) {
                currentPosition.isActive = false;
                // Calculate final USD values
                const finalTokenAUsdValue = closeResult?.tokenAChange && closeResult.currentPriceA ? closeResult.tokenAChange * closeResult.currentPriceA : backupTokenAUsdValue;
                const finalTokenBUsdValue = closeResult?.tokenBChange && closeResult.currentPriceB ? closeResult.tokenBChange * closeResult.currentPriceB : backupTokenBUsdValue;

                const trueCurrentPositionPnl = (finalTokenAUsdValue + finalTokenBUsdValue) - currentPosition.startingValue;
                sessionPnl = sessionPnl + trueCurrentPositionPnl + shortPnlUsd;
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

                if (validTimeForPosition) {
                    await openNewPosition();
                }
            }
        }

        // Update last check time
        if (currentPosition) {
            currentPosition.lastCheckTime = now;
        }
        lastCheckTime = now;
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

            // Run both close operations concurrently
            const [closeResult, closeShortResult] = await Promise.all([
                closePositionUtil(
                    mainnetRpc,
                    currentPosition.positionMintAddress,
                    TOKENA_MINT,
                    TOKENB_MINT,
                    tokenADecimals,
                    tokenBDecimals,
                    95,
                    wallet,
                    POOL_ADDRESS
                ),
                closeShort(
                    subAccountId,
                    TOKENA_MINT,
                    tokenADecimals
                )
            ]);

            let shortPnlUsd = 0;
            let shortPnlPerc = 0;
            if (
                closeShortResult && 
                currentPosition.startingDriftUsdcBal && 
                currentPerpPosition?.position_mint_address &&
                closeShortResult.data?.oraclePriceNormalized &&
                closeResult?.currentPriceA
            ) {
                shortPnlUsd = closeShortResult?.data?.normalizedUsdcBalChange || 0;
                shortPnlPerc = shortPnlUsd / currentPosition.startingDriftUsdcBal;
                console.log(`- Short Pnl Usd: $${shortPnlUsd.toFixed(2)}`);
                console.log(`- Short Pnl Perc: ${(shortPnlPerc * 100).toFixed(2)}%`);

                await db.closePerpPosition(
                    currentPerpPosition?.position_mint_address,
                    {
                        position_end_time: Math.floor(Date.now() / 1000),
                        exit_price: closeShortResult.data.oraclePriceNormalized || closeResult?.currentPriceA,
                        pnl: shortPnlUsd,
                        drift_usdc_balance_at_end: closeShortResult?.data?.usdcBalAfter
                    }
                )
            }



            if (closeResult && closeResult.isConfirmed && finalPositionValue) {
                currentPosition.isActive = false;
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
                    console.log(`Current Price of Pool: $${currentPriceOfPool}`);
                    console.log(`Total Value: $${(tokenABalance.tokenBalanceNormalized * currentPriceA + tokenBBalance.tokenBalanceNormalized * currentPriceB).toFixed(2)}\n`);
                }

                const backupTokenAUsdValue = (finalPositionValue.tokenAEstMinAmountNormalized * finalPositionValue.currentPriceA) + finalPositionValue.tokenAFeesNormalized * finalPositionValue.currentPriceA;
                const backupTokenBUsdValue = (finalPositionValue.tokenBEstMinAmountNormalized * finalPositionValue.currentPriceB) + finalPositionValue.tokenBFeesNormalized * finalPositionValue.currentPriceB;

                // Calculate final USD values
                const finalTokenAUsdValue = closeResult?.tokenAChange && closeResult.currentPriceA ? closeResult.tokenAChange * closeResult.currentPriceA : backupTokenAUsdValue;
                const finalTokenBUsdValue = closeResult?.tokenBChange && closeResult.currentPriceB ? closeResult.tokenBChange * closeResult.currentPriceB : backupTokenBUsdValue;

                const trueCurrentPositionPnl = (finalTokenAUsdValue + finalTokenBUsdValue) - currentPosition.startingValue;
                sessionPnl = sessionPnl + trueCurrentPositionPnl + shortPnlUsd;

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

                if (sessionPnl > 0) {

                    console.log("Sending USDC protocol fee (5% of profit)");
                    const feeAmount = sessionPnl * 0.05;
                    console.log("Fee Amount: $", feeAmount.toFixed(3));
                    await sendUsdcProtocolFee(
                        mainnetRpc,
                        wallet,
                        feeAmount
                    )
                }

                console.log("Position closed successfully and recorded to database");
                console.log("Settled Session Pnl: $", sessionPnl.toFixed(3));
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

    // Initial position if valid time for position
    if (validTimeForPosition) {
        await openNewPosition();
    }

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