// https://atiselsts.github.io/pdfs/uniswap-v3-liquidity-math.pdf

// Calculate amount of Token B needed for CL Position given Token A amount, current price, upper bound price, and lower bound price
export function calculateTokenBAmountFromTokenAAmount(
    tokenAAmount: number,
    initialPrice: number,
    currentPrice: number,
    upperBoundPrice: number,
    lowerBoundPrice: number
): number {
    const sqrtInitialPrice = Math.sqrt(initialPrice);
    const sqrtUpperPrice = Math.sqrt(upperBoundPrice);
    const sqrtCurrentPrice = Math.sqrt(currentPrice);
    const sqrtLowerPrice = Math.sqrt(lowerBoundPrice);
    
    // First calculate liquidity value from Token A
    const liquidityValue = tokenAAmount * ((sqrtInitialPrice * sqrtUpperPrice) / (sqrtUpperPrice - sqrtInitialPrice));
    
    // Then calculate Token B amount using that liquidity value
    return liquidityValue * (sqrtCurrentPrice - sqrtLowerPrice);
}

// Example usage:
// const tokenBAmount = calculateTokenBAmount(10, 100, 100, 105, 95.238);

export function calculateLiquidityValue(
    tokenAAmount: number,
    tokenBAmount: number,
    initialPrice: number,
    upperBoundPrice: number,
    lowerBoundPrice: number
): number {
    const sqrtInitialPrice = Math.sqrt(initialPrice);
    const sqrtUpperPrice = Math.sqrt(upperBoundPrice);
    const sqrtLowerPrice = Math.sqrt(lowerBoundPrice);
    
    // Calculate liquidity from token A
    const tokenALiquidity = tokenAAmount * ((sqrtInitialPrice * sqrtUpperPrice) / (sqrtUpperPrice - sqrtInitialPrice));
    
    // Calculate liquidity from token B
    const tokenBLiquidity = tokenBAmount / (sqrtInitialPrice - sqrtLowerPrice);
    
    // Return the minimum of the two liquidity values
    return Math.min(tokenALiquidity, tokenBLiquidity);
}

// Calculate the amount of token A in the liquidity pool
// AKA L of x see https://atiselsts.github.io/pdfs/uniswap-v3-liquidity-math.pdf
export function calculateTokenAAmount(
    liquidityValue: number,
    currentPrice: number,
    upperBoundPrice: number
): number {
    const sqrtCurrentPrice = Math.sqrt(currentPrice);
    const sqrtUpperPrice = Math.sqrt(upperBoundPrice);
    
    return liquidityValue * ((sqrtUpperPrice - sqrtCurrentPrice) / (sqrtCurrentPrice * sqrtUpperPrice));
}

// Calculate the amount of token B in the liquidity pool
// AKA L of y see https://atiselsts.github.io/pdfs/uniswap-v3-liquidity-math.pdf
export function calculateTokenBAmount(
    liquidityValue: number,
    currentPrice: number,
    lowerBoundPrice: number
): number {
    const sqrtCurrentPrice = Math.sqrt(currentPrice);
    const sqrtLowerPrice = Math.sqrt(lowerBoundPrice);
    
    return liquidityValue * (sqrtCurrentPrice - sqrtLowerPrice);
}

interface RangePnL {
    lowerBound: number;
    upperBound: number;
    clmmPnL: {
        lower: number;
        upper: number;
    };
    hedgePnL: {
        lower: number;
        upper: number;
    };
    totalPnL: {
        lower: number;
        upper: number;
    };
}

/**
 * Calculates PnL percentages for a CLMM position with hedging
 * Coefficients derived from ±5% range exact values:
 * Lower bound: -3.5859487% / 5 = -0.717189740%
 * Upper bound: +1.2347538% / 5 = +0.246950760%
 * 
 * +-4% Coefficients:
 * Lower bound: -0.028940431 (-2.8940431% / 4 = -0.723510775%)
 * Upper bound: +0.009901951 (+0.9901951% / 4 = +0.247548775%)
 * 
 * +-3% Coefficients:
 * Lower bound: -0.021898467 (-2.1898467% / 3 = -0.7299489%)
 * Upper bound: +0.007444578 (+0.7444578% / 3 = +0.2481526%)
 * 
 * @param rangePercent Range percentage from initial price (e.g. 5 for ±5% range)
 * @param hedgePercent Hedge ratio percentage (e.g. 50 for 50% hedge)
 * @param initialPrice Initial price of tokenA/tokenB pair where tokenB is USD
 * @returns Object containing bounds and PnL percentages
 */
function calculateRangePnL(
    rangePercent: number,
    hedgePercent: number,
    initialPrice: number = 100
): RangePnL {
    // Constants derived from ±5% range
    const { pnlAtCurrentPriceAsPercent, pnlAtLowerBoundAsPercent, pnlAtUpperBoundAsPercent } = deriveCoeffsAndPnLForUsdcPair(rangePercent);

    // Calculate range bounds
    const upperBound = initialPrice * (1 + rangePercent/100);
    const lowerBound = initialPrice / (1 + rangePercent/100);  // Corrected lower bound calculation

    // Calculate CLMM PnL percentages
    const clmmLowerPnL = pnlAtLowerBoundAsPercent; // percent as decimal
    const clmmUpperPnL = pnlAtUpperBoundAsPercent;

    // Calculate hedge PnL percentages
    const hedgeLowerPnL = (hedgePercent / 100) * ((initialPrice - lowerBound) / initialPrice);
    const hedgeUpperPnL = -(hedgePercent / 100) * ((upperBound - initialPrice) / initialPrice);

    // Calculate total PnL percentages
    const totalLowerPnL = clmmLowerPnL + hedgeLowerPnL;
    const totalUpperPnL = clmmUpperPnL + hedgeUpperPnL;

    return {
        lowerBound,
        upperBound,
        clmmPnL: {
            lower: Number(clmmLowerPnL.toFixed(7)),
            upper: Number(clmmUpperPnL.toFixed(7))
        },
        hedgePnL: {
            lower: Number(hedgeLowerPnL.toFixed(7)),
            upper: Number(hedgeUpperPnL.toFixed(7))
        },
        totalPnL: {
            lower: Number(totalLowerPnL.toFixed(7)),
            upper: Number(totalUpperPnL.toFixed(7))
        }
    };
}

function deriveCoeffsAndPnLForUsdcPair(rangePercent: number): {
    lowerBoundCoefficient: number;
    upperBoundCoefficient: number;
    pnlAtLowerBoundAsPercent: number;
    pnlAtUpperBoundAsPercent: number;
    pnlAtCurrentPriceAsPercent: number;
} {

    const initialUsdcValue = 2000;

    const initialPrice = 100;

    const currentPrice = 100;

    const upperBound = initialPrice * (1 + rangePercent/100);
    const lowerBound = initialPrice / (1 + rangePercent/100);
    // log
    // console.log("Upper Bound: ", upperBound);
    // console.log("Lower Bound: ", lowerBound);

    const liqValue = calculateLiquidityValue(10, 1000, initialPrice, upperBound, lowerBound);

    const tokenAAmountAtLowerBound = calculateTokenAAmount(liqValue, lowerBound, upperBound);
    const tokenBAmountAtUpperBound = calculateTokenBAmount(liqValue, upperBound, lowerBound); // USDC
    const tokenAAmountAtCurrentPrice = calculateTokenAAmount(liqValue, currentPrice, upperBound);
    const tokenBAmountAtCurrentPrice = calculateTokenBAmount(liqValue, currentPrice, lowerBound);

    // console.log("Token A Amount at Lower Bound: ", tokenAAmountAtLowerBound);
    // console.log("Token B Amount at Upper Bound: ", tokenBAmountAtUpperBound);

    const tokenAAmountAsUsdc = tokenAAmountAtLowerBound * lowerBound;
    const tokenBAmountAsUsdc = tokenBAmountAtUpperBound;

    const tokenAAmountAtCurrentPriceAsUsdc = tokenAAmountAtCurrentPrice * currentPrice;
    const tokenBAmountAtCurrentPriceAsUsdc = tokenBAmountAtCurrentPrice;

    const pnlAtLowerBoundAsUsd = tokenAAmountAsUsdc - initialUsdcValue;
    const pnlAtUpperBoundAsUsd = tokenBAmountAsUsdc - initialUsdcValue;

    const pnlAtCurrentPriceAsUsd = tokenAAmountAtCurrentPriceAsUsdc + tokenBAmountAtCurrentPriceAsUsdc - initialUsdcValue;

    const pnlAtLowerBoundAsPercent = pnlAtLowerBoundAsUsd / initialUsdcValue;
    const pnlAtUpperBoundAsPercent = pnlAtUpperBoundAsUsd / initialUsdcValue;
    console.log("PnL at Upper Bound as Percent: ", pnlAtUpperBoundAsPercent.toFixed(7));
    const pnlAtCurrentPriceAsPercent = pnlAtCurrentPriceAsUsd / initialUsdcValue;
    // log initial price and current price
    console.log("Initial Price: ", initialPrice);
    console.log("Current Price: ", currentPrice);
    console.log("clmm PnL at Current Price as Percent: ", pnlAtCurrentPriceAsPercent.toFixed(7));
    const lowerBoundCoefficient = pnlAtLowerBoundAsPercent / rangePercent;
    const upperBoundCoefficient = pnlAtUpperBoundAsPercent / rangePercent;

    // To check if the coefficients are correct, we can use the following:
    // Lower bound coefficient * range percent = pnl at lower bound as percent
    // Upper bound coefficient * range percent = pnl at upper bound as percent

    // const lowerCheck = lowerBoundCoefficient * rangePercent;
    // const upperCheck = upperBoundCoefficient * rangePercent;

    // console.log("Lower Check: ", lowerCheck);
    // console.log("Upper Check: ", upperCheck);



    return {
        lowerBoundCoefficient,
        upperBoundCoefficient,
        pnlAtLowerBoundAsPercent,
        pnlAtUpperBoundAsPercent,
        pnlAtCurrentPriceAsPercent
    };
}






function getTokenAmounts() {

    const rangePercent = 5;
    const initialUsdcValue = 2000;

    const initialPrice = 100;
    const initialTokenAAmount = 10;
    const initialTokenBAmount = 1000;

    const currentPrice = 96;

    const upperBound = initialPrice * (1 + rangePercent/100);
    const lowerBound = initialPrice / (1 + rangePercent/100);

    // log the values above
    console.log("Initial Price: ", initialPrice);
    console.log("Current Price: ", currentPrice);
    console.log("Initial Token A Amount: ", initialTokenAAmount);
    console.log("Initial Token B Amount: ", initialTokenBAmount);
    console.log("Upper Bound: ", upperBound);
    console.log("Lower Bound: ", lowerBound);


    const liqValue = calculateLiquidityValue(
        initialTokenAAmount, 
        initialTokenBAmount, 
        initialPrice, 
        upperBound, 
        lowerBound
    );

    const tokenAAmountAtLowerBound = calculateTokenAAmount(liqValue, lowerBound, upperBound);
    const tokenAAmountAtUpperBound = calculateTokenAAmount(liqValue, upperBound, upperBound);

    const tokenBAmountAtLowerBound = calculateTokenBAmount(liqValue, lowerBound, lowerBound);
    const tokenBAmountAtUpperBound = calculateTokenBAmount(liqValue, upperBound, lowerBound); // USDC

    const tokenAAmountAtCurrentPrice = calculateTokenAAmount(liqValue, currentPrice, upperBound);
    const tokenBAmountAtCurrentPrice = calculateTokenBAmount(liqValue, currentPrice, lowerBound);

    return {
        tokenAAmountAtLowerBound,
        tokenAAmountAtUpperBound,
        tokenBAmountAtLowerBound,
        tokenBAmountAtUpperBound,
        tokenAAmountAtCurrentPrice,
        tokenBAmountAtCurrentPrice
    }
}

const hedgePercent = 50;


// Test scenarios from 1% to 5%
const rangePercent = 5;
const result = calculateRangePnL(rangePercent, hedgePercent);
console.log(`±${rangePercent}% Range with hedge:`, result);

// const tokenAmounts = getTokenAmounts();
// console.log("Token Amounts: ", tokenAmounts);

// TokenA/UDSC Example
// const initialPrice = 100;
// const upperBoundPrice = 105;
// const lowerBoundPrice = 95.238;

// console.log("Initial Price: ", initialPrice);
// console.log("Upper Bound Price: ", upperBoundPrice);
// console.log("Lower Bound Price: ", lowerBoundPrice);

// // Example usage:
// const liqValue = calculateLiquidityValue(10, 1000, initialPrice, upperBoundPrice, lowerBoundPrice);
// console.log("Liquidity Value: ", liqValue);

// const initialTokenAAmount = calculateTokenAAmount(liqValue, initialPrice, upperBoundPrice);
// console.log("Initial Token A Amount: ", initialTokenAAmount);

// const initialTokenBAmount = calculateTokenBAmount(liqValue, initialPrice, lowerBoundPrice);
// console.log("Initial Token B Amount: ", initialTokenBAmount);

// // Total initial USDC Value
// const initialUSDCValue = initialTokenAAmount * initialPrice + initialTokenBAmount;
// console.log("Initial USDC Value: ", initialUSDCValue);



// const finalTokenAAmount = calculateTokenAAmount(liqValue, lowerBoundPrice, upperBoundPrice);
// console.log("Final Token A Amount: ", finalTokenAAmount);

// const finalUsdcAmount = calculateTokenBAmount(liqValue, lowerBoundPrice, lowerBoundPrice);
// console.log("Final USDC Amount: ", finalUsdcAmount);

// // Total final USDC Value
// const finalUSDCValue = finalTokenAAmount * lowerBoundPrice + finalUsdcAmount;
// console.log("Final USDC Value: ", finalUSDCValue);

// // Total profit
// const profit = finalUSDCValue - initialUSDCValue;
// console.log("Profit: ", profit);

// // Total profit percentage
// const profitPercentage = profit / initialUSDCValue;
// console.log("Profit Percentage: ", profitPercentage);

// const currentPrice = 100;

// const tokenBAmountFromTokenAAmount = calculateTokenBAmountFromTokenAAmount(initialTokenAAmount, initialPrice, currentPrice, lowerBoundPrice, upperBoundPrice);
// console.log("Token B Amount From Token A Amount: ", tokenBAmountFromTokenAAmount);
