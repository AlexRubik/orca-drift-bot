import { BN, calculateLiquidationPrice } from '@drift-labs/sdk';
import { initializeDriftClient } from './drift-worker.js';

async function main() {
    const LAMPORTS_PER_SOL = 1000000000;
    const BN_PER_USDC = 1000000; // 1 million
//   const client = await initializeDriftClient();
//   const user = client.getUser();



//   const liqPrice = user.liquidationPrice(
//     0,
//     new BN(LAMPORTS_PER_SOL / 10),
//     new BN(100 * BN_PER_USDC),
//     'Maintenance',
//     false
//   )
//   console.log(liqPrice.toNumber() / BN_PER_USDC);

  // end client
//   await client.unsubscribe();
const price = 100;
const freeCollateral = 20;
const freeCollateralDelta = -1;
const priceAsBn = new BN(Math.floor(price * BN_PER_USDC));
const freeCollateralAsBn = new BN(Math.floor(freeCollateral * BN_PER_USDC));
const freeCollateralDeltaAsBn = new BN(Math.floor(freeCollateralDelta * BN_PER_USDC));
  const liqPrice2 = calculateLiquidationPrice(
    freeCollateralAsBn,
    freeCollateralDeltaAsBn,
    priceAsBn
  )
  console.log(liqPrice2.toNumber() / BN_PER_USDC);
  
}

/**
 * Calculate required collateral for a position with a desired liquidation price
 * @param positionSizeUSD Position size in USD
 * @param entryPriceUSD Entry price in USD
 * @param liqPricePercent Desired liquidation price as a percentage away from entry price (e.g., 20 for 20%)
 * @returns Required collateral in USD
 */
function calculateRequiredCollateral(
  positionSizeUSD: number,
  liqPricePercent: number
): number {
  // For both longs and shorts, collateral = position size * (liqPricePercent/100)
  return positionSizeUSD * (liqPricePercent/100);
}

// Example usage
function testCollateralCalculation() {
  // Example: $100 position at $100 entry price, liquidation at 20% away
  const positionSizeUSD = 1200;
  const liqPricePercent = 5;
  
  const collateral = calculateRequiredCollateral(positionSizeUSD, liqPricePercent);
  console.log(`Required collateral: $${collateral.toFixed(2)}`);
}

async function subAcc() {
  const client = await initializeDriftClient();
  const activeSub = client.activeSubAccountId;

  console.log('activeSub', activeSub);

  const nextSubAcc = await client.getNextSubAccountId();
  
  console.log('nextSubAcc', nextSubAcc);

  const authSubMap = client.authoritySubAccountMap;

  // log all the stuff in the
  console.log('authSubMap', authSubMap);

  const user0 = client.hasUser(0);
  console.log('user0', user0);

  const user1 = client.hasUser(1);
  console.log('user1', user1);

  // Log the users object and the first user's key
  console.log('users keys:', [...client.users.keys()]);
  
  // Get the first user key
  const firstUserKey = [...client.users.keys()][0];
  console.log('First user key:', firstUserKey);

  // grab first character of firstUserKey and convert to number
  const subAccountId = parseInt(firstUserKey[0]);
  console.log('subAccountId:', subAccountId);
  
  // Log the opts object if available
  if (client.opts) {
    console.log('Client opts:', client.opts);
  }


  const user = client.getUser();
  const userAcc = user.getUserAccount();
  const subAc = userAcc.subAccountId;
  console.log('subAc', subAc);

  await client.unsubscribe();

  // /home/alex/Desktop/projects/arbitrage/rude-bot/keypair.json
  // /home/alex/Desktop/projects/lp-bot/lp-bot/keypairtmr.json
}

// subAcc();