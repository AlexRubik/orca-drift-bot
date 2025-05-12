import { fetchWhirlpool } from "@orca-so/whirlpools-client";
import { increaseLiquidityQuoteA, increaseLiquidityQuoteB, priceToTickIndex, sqrtPriceToPrice } from "@orca-so/whirlpools-core";
import { Address, KeyPairSigner, Rpc, RpcMainnet, SolanaRpcApi, SolanaRpcApiMainnet } from "@solana/web3.js";
import { createPriceBounds, getTokenBalUtil, sendTransactionWithPriorityFee, checkTransactionConfirmed, sendTransactionWithJito, fetchWhirlpoolUtil, calcUsdValueOfPosition } from "./utils";
import { closePositionInstructions, openPositionInstructions, setNativeMintWrappingStrategy, swapInstructions } from "@orca-so/whirlpools";
import { getUsdPriceFromJup, swapToUsdc } from "./jup";
import { db, initDb } from "./db";

const DEBUG = true;
export async function openPositionUtil(
    mainnetRpc: RpcMainnet<SolanaRpcApiMainnet>,
    poolAddress: Address,
    rangeDeviationPercentAsDecimal: number,
    wallet: KeyPairSigner,
    tokenMintAddressA: Address,
    tokenMintAddressB: Address,
    targetUsdValueOfPosition: number,
    attempt: number = 0,
    openPositionSlippageBps: number = 85
) {



    // Check if wallet has enough USD value of Token A + Token B close enough to targetUsdValueOfPosition
    // Negative deviation of 5% is allowed
    // Throw error if not

    const tokenBalUtilA = await getTokenBalUtil(wallet, tokenMintAddressA);
    const tokenBalUtilB = await getTokenBalUtil(wallet, tokenMintAddressB);

    const whirlpool = await fetchWhirlpoolUtil(mainnetRpc, poolAddress);
    console.log("Whirlpool: ", whirlpool.address);
    const sqrtPrice = whirlpool.data.sqrtPrice;
    const poolPrice = sqrtPriceToPrice(sqrtPrice, tokenBalUtilA.decimals, tokenBalUtilB.decimals);
    console.log("Current Price of Pool: ", poolPrice);

    const currentPriceA = await getUsdPriceFromJup(tokenMintAddressA, BigInt(10 ** tokenBalUtilA.decimals), tokenBalUtilA.decimals);
    const currentPriceB = await getUsdPriceFromJup(tokenMintAddressB, BigInt(10 ** tokenBalUtilB.decimals), tokenBalUtilB.decimals);

    const tokenAUsdValue = tokenBalUtilA.tokenBalanceNormalized * currentPriceA;
    const tokenBUsdValue = tokenBalUtilB.tokenBalanceNormalized * currentPriceB;  // USDT/USDC already in USD

    // First check if we have any value
    const totalUsdValue = tokenAUsdValue + tokenBUsdValue;
    if (totalUsdValue === 0) {
        throw new Error('No balance available to open position');
    }

    // Use either the target value or total available value, whichever is smaller
    const actualPositionValue = Math.min(totalUsdValue, targetUsdValueOfPosition);
    console.log(`Using position value of $${actualPositionValue.toFixed(2)} (${totalUsdValue < targetUsdValueOfPosition ? 'limited by balance' : 'target value'})`);
    
    const targetValuePerSide = actualPositionValue / 2;

    // Declare variables outside if statement
    let tokenAmountToSwapBigInt: bigint;
    let isSwappingAtoB: boolean;

    console.log("tokenAUsdValue: ", tokenAUsdValue);
    console.log("tokenBUsdValue: ", tokenBUsdValue);
    console.log("targetValuePerSide: ", targetValuePerSide);
    console.log("actualPositionValue: ", actualPositionValue);

    // Calculate how much to swap
    if (tokenAUsdValue > tokenBUsdValue) {
        // Add 0.2% tolerance to targetValuePerSide
        const minAcceptableTokenB = targetValuePerSide * 0.998;  // -0.2%
        
        // Only swap if we need to rebalance AND we have more than target value
        if (tokenBUsdValue < minAcceptableTokenB && tokenAUsdValue > targetValuePerSide) {
            console.log("Need to swap tokenA for tokenB to achieve balance");
            
            // Calculate how much we need to swap to achieve target
            const tokenAUsdValueToSwap = Math.min(
                targetValuePerSide - tokenBUsdValue,  // How much USD value of tokenB we need
                actualPositionValue / 2  // Don't swap more than half of target position
            );
            
            const tokenAAmountToSwap = tokenAUsdValueToSwap / currentPriceA;
            tokenAmountToSwapBigInt = BigInt(Math.floor(tokenAAmountToSwap * Math.pow(10, tokenBalUtilA.decimals)));
            isSwappingAtoB = true;
            console.log(`Need to swap ${tokenAAmountToSwap} of TokenA (${tokenAUsdValueToSwap} USD) for TokenB`);
        } else {
            console.log("No swap needed - already have enough tokenB (within 0.2% tolerance) or not enough tokenA");
            tokenAmountToSwapBigInt = 0n;
            isSwappingAtoB = true;
        }
    } else if (tokenBUsdValue > tokenAUsdValue) {
        // Add 0.2% tolerance to targetValuePerSide
        const minAcceptableTokenA = targetValuePerSide * 0.998;  // -0.2%
        
        // Only swap if we need to rebalance AND we have more than target value
        if (tokenAUsdValue < minAcceptableTokenA && tokenBUsdValue > targetValuePerSide) {
            console.log("Need to swap tokenB for tokenA to achieve balance");
            const amountToSwapUsd = Math.min(
                tokenBUsdValue - targetValuePerSide,  // How much USD value of tokenB we need to swap
                actualPositionValue / 2  // Don't swap more than half of target position
            );
            console.log(`Need to swap ${amountToSwapUsd.toFixed(2)} of TokenB (${amountToSwapUsd.toFixed(2)} USD) for TokenA`);

            // Convert USD amount to token amount
            tokenAmountToSwapBigInt = BigInt(Math.floor(amountToSwapUsd * Math.pow(10, tokenBalUtilB.decimals)));
            isSwappingAtoB = false;
        } else {
            console.log("No swap needed - already have enough tokenA (within 0.2% tolerance) or not enough tokenB");
            tokenAmountToSwapBigInt = 0n;
            isSwappingAtoB = false;
        }
    } else {
        console.log("No swap needed - tokens are balanced");
        tokenAmountToSwapBigInt = 0n;
        isSwappingAtoB = false;
    }

    // Only do the swap if we need to
    if (tokenAmountToSwapBigInt > BigInt(0)) {
        const isConfirmedSwap = await swapToken(
            mainnetRpc, 
            tokenAmountToSwapBigInt,
            isSwappingAtoB ? tokenMintAddressA : tokenMintAddressB, 
            poolAddress, 
            50, 
            wallet,
            attempt
        );

        if (!isConfirmedSwap) {
            throw new Error("Swap txn failed");
        }

        console.log("Swapped tokens txn confirmed");

        // wait 10 seconds before continuing
        console.log("Waiting 5 seconds before continuing...");
        await new Promise(resolve => setTimeout(resolve, 5000));
    }


    // Get token balance after swap of tokenB and record that final amount
    const tokenBalUtilBAfterSwap = await getTokenBalUtil(wallet, tokenMintAddressB);
    console.log("Token B Balance After Swap: ", tokenBalUtilBAfterSwap);

    // Calculate target value of token B in token terms using currentPriceB
    const targetValueOfTokenB = targetValuePerSide / currentPriceB;
    console.log("Target Value of Token B (in token terms): ", targetValueOfTokenB);
    
    // Convert to big int with proper decimals
    let targetValueOfTokenBBigInt = BigInt(Math.floor(targetValueOfTokenB * Math.pow(10, tokenBalUtilB.decimals)));

    // subtract 0.2% of targetValueOfTokenBBigInt for slippage
    targetValueOfTokenBBigInt = targetValueOfTokenBBigInt - BigInt(Math.floor(Number(targetValueOfTokenBBigInt) * 0.002));
    


    // After swaps are complete, proceed with position opening...
    const bounds = createPriceBounds(poolPrice, rangeDeviationPercentAsDecimal);
    console.log("Price Bounds: ", bounds);

    const tickLower = priceToTickIndex(bounds.lowerBound, tokenBalUtilA.decimals, tokenBalUtilB.decimals);
    const tickUpper = priceToTickIndex(bounds.upperBound, tokenBalUtilA.decimals, tokenBalUtilB.decimals);

    console.log("Debug Token Info:");
    console.log("Token A:", {
        mint: tokenMintAddressA,
        decimals: tokenBalUtilA.decimals,
        balance: tokenBalUtilA.tokenBalanceNormalized,
        balanceBigInt: tokenBalUtilA.tokenBalanceBigInt.toString()
    });
    console.log("Token B:", {
        mint: tokenMintAddressB,
        decimals: tokenBalUtilB.decimals,
        balance: tokenBalUtilB.tokenBalanceNormalized,
        balanceBigInt: tokenBalUtilB.tokenBalanceBigInt.toString()
    });

    console.log("Token B amount used in param for functions: ");
    console.log("Token B Amount in BigInt ", tokenBalUtilBAfterSwap.tokenBalanceBigInt);
    console.log("Token B Amount Normalized: ", tokenBalUtilBAfterSwap.tokenBalanceNormalized);

    const increaseLiqOutput = increaseLiquidityQuoteB(
        targetValueOfTokenBBigInt,
        openPositionSlippageBps,
        sqrtPrice,
        tickLower,
        tickUpper,
    );

    const tokenAEst = increaseLiqOutput.tokenEstA;
    const tokenAMax = increaseLiqOutput.tokenMaxA;
    const tokenBEst = increaseLiqOutput.tokenEstB;
    const tokenBMax = increaseLiqOutput.tokenMaxB;
    const tokenANormalized = Number(tokenAEst) / Math.pow(10, tokenBalUtilA.decimals);
    const tokenBNormalized = Number(tokenBEst) / Math.pow(10, tokenBalUtilB.decimals);
    const tokenAMaxNormalized = Number(tokenAMax) / Math.pow(10, tokenBalUtilA.decimals);
    const tokenBMaxNormalized = Number(tokenBMax) / Math.pow(10, tokenBalUtilB.decimals);

    console.log("Increase Liquidity Quote Est Amounts Normalized: ", {
        tokenA: tokenANormalized,
        tokenB: tokenBNormalized
    });

    console.log("Increase Liquidity Quote Max Amounts Normalized: ", {
        tokenA: tokenAMaxNormalized,
        tokenB: tokenBMaxNormalized
    });

    // log the liq delta
    console.log("Liquidity Delta: ", increaseLiqOutput.liquidityDelta);

    let attempts = 0;
    const maxAttempts = 7;
    let liquidityDelta = increaseLiqOutput.liquidityDelta;
    let success = false;
    let result;
    let slippageToleranceBps = openPositionSlippageBps;  // Initial slippage tolerance

    while (attempts < maxAttempts && !success) {
        try {
            const param = { liquidity: liquidityDelta };
            
            // Increase slippage tolerance by 5% each attempt
            const currentSlippage = Math.floor(slippageToleranceBps * (1 + (attempts * 0.01)));
            console.log(`Attempt ${attempts + 1}: Using slippage tolerance of ${currentSlippage} bps`);
            
            const instructions = await openPositionInstructions(
                mainnetRpc,
                poolAddress, 
                param, 
                bounds.lowerBound, 
                bounds.upperBound, 
                currentSlippage,  // Use increased slippage
                wallet
            );

            const positionMintAddress = instructions.positionMint;
            console.log("Position Mint Address: ", positionMintAddress);

            const estAmountsBigInt = {
                tokenA: instructions.quote.tokenEstA,
                tokenB: instructions.quote.tokenEstB
            }

            const maxAmountsBigInt = {
                tokenA: instructions.quote.tokenMaxA,
                tokenB: instructions.quote.tokenMaxB
            }

            const maxAmountsNormalized = {
                tokenA: Number(instructions.quote.tokenMaxA) / Math.pow(10, tokenBalUtilA.decimals),
                tokenB: Number(instructions.quote.tokenMaxB) / Math.pow(10, tokenBalUtilB.decimals)
            }

            

            console.log("Sending txn to open position...");
            let signature;
            
            // Alternate between Jito and regular transaction sending
            if (attempts % 2 === 0) {
                console.log(`Attempt ${attempts + 1}: Using Jito bundle`);
                signature = await sendTransactionWithJito(instructions.instructions, wallet, mainnetRpc);
            } else {
                console.log(`Attempt ${attempts + 1}: Using regular transaction`);
                signature = await sendTransactionWithPriorityFee(instructions.instructions, wallet, mainnetRpc);
            }
            
            console.log("Signature: ", signature);

            const isConfirmed = await checkTransactionConfirmed(signature, mainnetRpc);
            if (!isConfirmed) {
                console.log("Transaction not confirmed");
                throw new Error("Transaction not confirmed");
            }

            const currentPrice = await getPriceOfPool(mainnetRpc, poolAddress, tokenBalUtilA.decimals, tokenBalUtilB.decimals);
            const maxAmountsUsdValues = {
                tokenA: maxAmountsNormalized.tokenA * currentPrice,
                tokenB: maxAmountsNormalized.tokenB
            }
            

            
            console.log("Open Position Quote's Estimated Amounts BigInt:", estAmountsBigInt);

            const estAmountsNormalized = {
                tokenA: Number(instructions.quote.tokenEstA) / Math.pow(10, tokenBalUtilA.decimals),
                tokenB: Number(instructions.quote.tokenEstB) / Math.pow(10, tokenBalUtilB.decimals)
            }
            console.log("Open Position Quote's Estimated Amounts Normalized:", estAmountsNormalized);

            let tokenAChange;
            let tokenBChange;

            try {

                const tx = await mainnetRpc.getTransaction(signature, {
                    commitment: "confirmed",
                    maxSupportedTransactionVersion: 0,
                }).send();
                // log the post token balances and pre token balances
                console.log("Post token balances: ", tx?.meta?.postTokenBalances);
                console.log("Pre token balances: ", tx?.meta?.preTokenBalances);

                if (tx?.meta) {
                    const balanceChanges = calculateBalanceChanges(
                        tx.meta.preTokenBalances || [],
                        tx.meta.postTokenBalances || [],
                        wallet.address.toString(),
                        tokenMintAddressA.toString(),
                        tokenMintAddressB.toString()
                    );

                    tokenAChange = balanceChanges.tokenA.change;
                    tokenBChange = balanceChanges.tokenB.change;

                    console.log("\nWallet Balance Changes:");
                    console.log("Token A:");
                    console.log(`  Pre:    ${balanceChanges.tokenA.pre}`);
                    console.log(`  Post:   ${balanceChanges.tokenA.post}`);
                    console.log(`  Change: ${tokenAChange.toFixed(tokenBalUtilA.decimals)}`);
                    console.log("Token B:");
                    console.log(`  Pre:    ${balanceChanges.tokenB.pre}`);
                    console.log(`  Post:   ${balanceChanges.tokenB.post}`);
                    console.log(`  Change: ${tokenBChange.toFixed(tokenBalUtilB.decimals)}`);
                }

            } catch (error) {
                console.error("Error getting transaction for opening position: ", error);
            }
            
            



            success = true;
            result = {
                isConfirmed,
                signature,
                positionMintAddress,
                estimatedAmounts: estAmountsBigInt,
                maxAmountsBigInt,
                maxAmountsUsdValues,
                maxAmountsNormalized,
                currentPrice,
                tokenAChange,
                tokenBChange
            };

        } catch (error) {
            attempts++;
            // Reduce liquidity by an additional 0.25% each attempt
            const reductionFactor = 1 - (0.0025 * attempts);
            liquidityDelta = BigInt(Math.floor(Number(increaseLiqOutput.liquidityDelta) * reductionFactor));
            
            console.log(`Attempt ${attempts} failed. Reducing liquidity delta by ${attempts * 0.25}%`);
            console.log("New liquidity delta:", liquidityDelta.toString());
            
            if (attempts === maxAttempts) {
                console.error("Failed to open position after all attempts");
                throw error;
            }
            
            // Wait a bit before retrying
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    return result!;
}

export async function swapToken(
    rpc: RpcMainnet<SolanaRpcApiMainnet>, 
    inputAmount: bigint,
    tokenInputMintAddress: Address,
    poolAddress: Address,
    slippageToleranceBps: number = 75,
    wallet: KeyPairSigner,
    attempt: number = 0
) {

    DEBUG ? console.log("Getting swap instructions...") : null;
    const swapIxnsObj = await swapInstructions(
        rpc,
        {
            inputAmount,
            mint: tokenInputMintAddress,
        },
        poolAddress,
        slippageToleranceBps,
        wallet
    );

    let signature;
    // Use Jito for first 3 attempts or even attempts after that
    if (attempt <= 2 || (attempt > 2 && attempt % 2 === 0)) {
        console.log(`Attempt ${attempt}: ------- Using Jito bundle -------`);
        signature = await sendTransactionWithJito(swapIxnsObj.instructions, wallet, rpc);
    } else {
        console.log(`Attempt ${attempt}: Using regular transaction`);
        signature = await sendTransactionWithPriorityFee(swapIxnsObj.instructions, wallet, rpc);
    }

    console.log("Signature of swap txn: ", signature);
    console.log("Checking if txn is confirmed...");
    const isConfirmed = await checkTransactionConfirmed(signature, rpc);
    return isConfirmed;
}

export async function closePositionUtil(
    rpc: RpcMainnet<SolanaRpcApiMainnet>,
    positionMintAddress: Address,
    tokenMintAddressA: Address,
    tokenMintAddressB: Address,
    decimalsTokenA: number,
    decimalsTokenB: number,
    slippageToleranceBps: number,  // Initial slippage tolerance
    wallet: KeyPairSigner,
    poolAddress: Address
) {
    let attempts = 0;

    while (true) {  // Keep trying indefinitely
        try {
            attempts++;  // Track attempts for logging
            // Increase slippage tolerance by 10% each attempt, cap at 300 bps
            const currentSlippage = Math.min(
                Math.floor(slippageToleranceBps * (1 + (attempts * 0.15))),
                270
            );

            const positionBalance = await rpc.getBalance(positionMintAddress).send();
            console.log("Position balance:", positionBalance.value.toString());
            
            if (positionBalance.value === BigInt(0)) {
              console.log("Position doesn't exist or has already been closed");
              return;
            }
            console.log("Position exists and is not closed");
            
            const closePositionIxns = await closePositionInstructions(
                rpc,
                positionMintAddress,
                currentSlippage,
                wallet
            );

            console.log(`\nAttempt ${attempts} to close position...`);
            console.log("Position Mint Address: ", positionMintAddress);
            console.log("Slippage Tolerance Bps: ", currentSlippage);

            const quote = closePositionIxns.quote;
            const feesQuote = closePositionIxns.feesQuote;
            const feesQuoteNormalized = {
                tokenA: Number(feesQuote.feeOwedA) / Math.pow(10, decimalsTokenA),
                tokenB: Number(feesQuote.feeOwedB) / Math.pow(10, decimalsTokenB),
            }
            console.log("Fees Quote Normalized: ", feesQuoteNormalized);

            const normalizedQuote = {
                tokenAEst: Number(quote.tokenEstA) / Math.pow(10, decimalsTokenA),
                tokenBEst: Number(quote.tokenEstB) / Math.pow(10, decimalsTokenB),
                tokenAMin: Number(quote.tokenMinA) / Math.pow(10, decimalsTokenA),
                tokenBMin: Number(quote.tokenMinB) / Math.pow(10, decimalsTokenB),
            };
            console.log("Normalized Quote: ", normalizedQuote);

            let signature;
            
            // Alternate between Jito and regular transaction sending
            if (attempts % 2 === 0) {
                console.log(`Attempt ${attempts + 1}: ------- Using Jito bundle -------`);
                const desperate = attempts > 10;
                console.log("Desperate: ", desperate);

                signature = await sendTransactionWithJito(closePositionIxns.instructions, wallet, rpc, desperate);
            } else {
                console.log(`Attempt ${attempts + 1}: Using regular transaction`);
                signature = await sendTransactionWithPriorityFee(closePositionIxns.instructions, wallet, rpc);
            }
            
            console.log("Signature of close position txn: ", signature);
            console.log("Checking if txn is confirmed...");
            let isConfirmed = await checkTransactionConfirmed(signature, rpc, 2, 4);

            let currentPriceA;
            let currentPriceB;
            let usdValues;
            let totalMinUsdValue;


            
            // Wait a bit for chain state to update
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const positionMintBal = await rpc.getBalance(positionMintAddress).send();
            console.log("Balance after closing position: ", positionMintBal.value);

            let tokenAChange;
            let tokenBChange;

            // Success condition: position is closed (balance is 0)
            if (positionMintBal.value === BigInt(0)) {
                console.log(`Position successfully closed (balance is 0) after ${attempts} attempts`);
                isConfirmed = true;

                currentPriceA = await getUsdPriceFromJup(tokenMintAddressA, BigInt(10 ** decimalsTokenA), decimalsTokenA);
                currentPriceB = await getUsdPriceFromJup(tokenMintAddressB, BigInt(10 ** decimalsTokenB), decimalsTokenB);

                usdValues = {
                    tokenA: normalizedQuote.tokenAMin * currentPriceA,
                    tokenB: normalizedQuote.tokenBMin * currentPriceB,
                    feesTokenA: feesQuoteNormalized.tokenA * currentPriceA,
                    feesTokenB: feesQuoteNormalized.tokenB * currentPriceB
                }
                console.log("USD Values: ", usdValues);
                // total estimated usd value
                totalMinUsdValue = usdValues.tokenA + usdValues.tokenB;
                console.log("Closing Position Total Estimated USD Value: ", totalMinUsdValue);

                    try {

                const tx = await rpc.getTransaction(signature,
                    {
                        commitment: "confirmed",
                        maxSupportedTransactionVersion: 0,
                    }
                ).send();

                
                // log the post token balances and pre token balances
                console.log("Post token balances: ", tx?.meta?.postTokenBalances);
                console.log("Pre token balances: ", tx?.meta?.preTokenBalances);    



                if (tx?.meta) {
                    const balanceChanges = calculateBalanceChanges(
                        tx.meta.preTokenBalances || [],
                        tx.meta.postTokenBalances || [],
                        wallet.address.toString(),
                        tokenMintAddressA.toString(),
                        tokenMintAddressB.toString()
                    );

                    tokenAChange = balanceChanges.tokenA.change;
                    tokenBChange = balanceChanges.tokenB.change;

                    console.log("\nWallet Balance Changes:");
                    console.log("Token A:");
                    console.log(`  Pre:    ${balanceChanges.tokenA.pre}`);
                    console.log(`  Post:   ${balanceChanges.tokenA.post}`);
                    console.log(`  Change: ${tokenAChange.toFixed(decimalsTokenA)}`);
                    console.log("Token B:");
                    console.log(`  Pre:    ${balanceChanges.tokenB.pre}`);
                    console.log(`  Post:   ${balanceChanges.tokenB.post}`);
                    console.log(`  Change: ${tokenBChange.toFixed(decimalsTokenB)}`);
                }
            } catch (error) {
                console.error("Error getting transaction for closing position: ", error);
            }

            const currentPriceOfPool = await getPriceOfPool(rpc, poolAddress, decimalsTokenA, decimalsTokenB);

            // swap tokenA and B to USDC
            const swaptTokenAToUsdcResult = await swapToUsdc(rpc, wallet, tokenMintAddressA, decimalsTokenA);
            const swaptTokenBToUsdcResult = await swapToUsdc(rpc, wallet, tokenMintAddressB, decimalsTokenB);

            console.log("SwaptokenAToUsdcResult: ", swaptTokenAToUsdcResult);
            console.log("SwaptokenBToUsdcResult: ", swaptTokenBToUsdcResult);
                
                return {
                    isConfirmed,
                    signature,
                    positionMintAddress,
                    usdValues,
                    normalizedQuote,
                    feesQuoteNormalized,
                    currentPriceA,
                    currentPriceB,
                    tokenAChange,
                    tokenBChange,
                    currentPriceOfPool,
                    swaptTokenAToUsdcResult,
                    swaptTokenBToUsdcResult
                };
            }

            // If we get here, position wasn't closed successfully
            console.log(`Position not fully closed after attempt ${attempts}, retrying...`);
            await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
            console.error(`Error closing position (attempt ${attempts}):`, error);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

export async function getPriceOfPool(
    rpc: RpcMainnet<SolanaRpcApiMainnet>,
    poolAddress: Address,
    decimalsTokenA: number, 
    decimalsTokenB: number
) {
    const maxAttempts = 10;
    let attempts = 0;

    while (attempts < maxAttempts) {
        try {
            const whirlpool = await fetchWhirlpoolUtil(rpc, poolAddress);
            const sqrtPrice = whirlpool.data.sqrtPrice;
            const priceOfPool = sqrtPriceToPrice(sqrtPrice, decimalsTokenA, decimalsTokenB);
            return priceOfPool;
        } catch (error) {
            attempts++;
            DEBUG ? console.error(`Error getting pool price (attempt ${attempts}/${maxAttempts}):`, error) : null;
            
            if (attempts === maxAttempts) {
                throw new Error(`Failed to get pool price after ${maxAttempts} attempts`);
            }
            
            // Wait 2 seconds before retrying
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    throw new Error('Failed to get pool price (this should never happen)');
}

function calculateBalanceChanges(
    preBalances: readonly any[],
    postBalances: readonly any[],
    walletAddress: string,
    tokenAMint: string,
    tokenBMint: string
) {
    const getBalance = (balances: readonly any[], mint: string) => {
        return balances.find(b => 
            b.owner === walletAddress && 
            b.mint === mint
        )?.uiTokenAmount?.uiAmountString || '0';
    };

    const tokenA = {
        pre: getBalance(preBalances, tokenAMint),
        post: getBalance(postBalances, tokenAMint),
        change: 0
    };
    
    const tokenB = {
        pre: getBalance(preBalances, tokenBMint),
        post: getBalance(postBalances, tokenBMint),
        change: 0
    };

    tokenA.change = Math.abs(Number(tokenA.post) - Number(tokenA.pre));
    tokenB.change = Math.abs(Number(tokenB.post) - Number(tokenB.pre));

    return { tokenA, tokenB };
}

export async function manualClose(
    mainnetRpc: RpcMainnet<SolanaRpcApiMainnet>,
    wallet: KeyPairSigner,
    positionMintAddress: Address,
    tokenADecimals: number,
    tokenBDecimals: number,
    poolAddress: Address,
    tokenAMint: Address,
    tokenBMint: Address
) {
    // Initialize DB and set native mint strategy
    await initDb();
    setNativeMintWrappingStrategy('none');

    try {
        console.log("Attempting to close position before exit...");
        const finalPositionValue = await calcUsdValueOfPosition(
            mainnetRpc,
            positionMintAddress,
            100,
            tokenADecimals,
            tokenBDecimals,
            poolAddress,
            wallet
        );

        if (finalPositionValue) {
            console.log(`Final position value: $${finalPositionValue.totalUsdValue.toFixed(2)}`);
        }

        const closeResult = await closePositionUtil(
            mainnetRpc,
            positionMintAddress,
            tokenAMint,
            tokenBMint,
            tokenADecimals,
            tokenBDecimals,
            75,
            wallet,
            poolAddress
        );

        if (closeResult && closeResult.isConfirmed && finalPositionValue) {
            // Get final wallet balances after closing position
            const tokenABalance = await getTokenBalUtil(wallet, tokenAMint);
            const tokenBBalance = await getTokenBalUtil(wallet, tokenBMint);
            const currentPriceOfPool = await getPriceOfPool(mainnetRpc, poolAddress, tokenADecimals, tokenBDecimals);

            const currentPriceA = await getUsdPriceFromJup(tokenAMint, BigInt(10 ** tokenADecimals), tokenADecimals);
            const currentPriceB = await getUsdPriceFromJup(tokenBMint, BigInt(10 ** tokenBDecimals), tokenBDecimals);
            
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
                positionMintAddress.toString(),
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
            return closeResult;
        } else {
            console.error("Failed to close position");
            return null;
        }
    } catch (error) {
        console.error("Error during graceful shutdown:", error);
        throw error;
    }
}