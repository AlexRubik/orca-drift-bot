import { address, createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, 
  createSolanaRpc, mainnet,

} from '@solana/web3.js';
import fs from 'fs';
import path from 'path';


import { setWhirlpoolsConfig, setDefaultFunder, 
  fetchConcentratedLiquidityPool, openPositionInstructions, 
  closePositionInstructions,
  setNativeMintWrappingStrategy} from '@orca-so/whirlpools';
import { fetchWhirlpool } from '@orca-so/whirlpools-client';


import { getWhirlpoolByAddress, getTokenBalance, getFeeForMessage, sendTransactionWithPriorityFee, convertQuoteToHuman, createPriceBounds, calcUsdValueOfPosition, fetchWhirlpoolUtil, getTokenBalUtil, sendTransactionWithJito, checkTransactionConfirmed } from './utils';
import { isSystemError } from '@solana-program/system';
import { sqrtPriceToPrice, priceToTickIndex, tryGetAmountDeltaA, tickIndexToSqrtPrice, tryGetAmountDeltaB, positionRatio, increaseLiquidityQuoteA } from '@orca-so/whirlpools-core';
import { getJitoTipData } from './jito';
import { closePositionUtil, getPriceOfPool, openPositionUtil } from './positionManagement';
import { startWorkerStrategy1 } from './strats/workerStrategy1';
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync, createAtaForMint } from './tokenHelper';
import { SOL_MINT, SOL_MINT_DECIMALS, USDT_MINT } from './constants';
import { getJupiterQuote, getUsdPriceFromJup, swapToUsdc } from './jup';
import { USDC_MINT } from './constants';
import { db, initDb } from './db';
import { startHedgeWorkerStrategy1 } from './strats/hedgeStrategy1';

// Load config file
let config: any;
try {
    // Try loading from dist directory first (for pkg)
    const configPath = path.join(__dirname, '../config.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
    // Fallback to current working directory (for development)
    try {
        const configPath = path.join(process.cwd(), 'config.json');
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
        console.error('Failed to load config.json:', err);
        process.exit(1);
    }
}

const keypairPath = config.keypairPath;
const rpcUrl = config.rpcUrl;

  



async function main() {

const keyPairBytes = new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
const wallet = await createKeyPairSignerFromBytes(keyPairBytes);

    await setWhirlpoolsConfig('solanaMainnet');


    const mainnetRpc = createSolanaRpc(mainnet(rpcUrl));
    

    // SOL/USDT pool

    const solUsdtPoolAddress = address("FwewVm8u6tFPGewAyHmWAqad9hmF7mvqxK4mJ7iNqqGC");
   

    console.log("--------------------------------");
    console.log("Opening Position in SOL/USDT Pool");
    console.log("--------------------------------");

    const rangeDeviationPercentAsDecimal = 0.05;
    const tokenMintAddressA = address("So11111111111111111111111111111111111111112");
    const tokenMintAddressB = address("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    const targetUsdValueOfPosition = 17.50;


    try {

      const {signature, positionMintAddress, estimatedAmounts} = await openPositionUtil(
        mainnetRpc,
        solUsdtPoolAddress,
        rangeDeviationPercentAsDecimal,
        wallet,
        tokenMintAddressA,
        tokenMintAddressB,
        targetUsdValueOfPosition
      );

      // wait 5 secnods
      await new Promise(resolve => setTimeout(resolve, 5000));
      // const positionMintAddress = address("9Aa1yWqNyrF13PTKneHggccXoTP6LhJwTbNvTcd3hTtw");

      try {

      // const usdValue = await calcUsdValueOfPosition(
      //   mainnetRpc, 
      //   positionMintAddress, 
      //   100,
      //   9, 
      //   solUsdtPoolAddress, 
      //   wallet
      // );
      // console.log("USD Value Object: ", usdValue);

      // const startingPositionSizeUsd = usdValue?.totalUsdValue;

      // console.log("Starting Position Size USD: ", startingPositionSizeUsd);

      

      } catch (error) {
        console.error("Error calculating USD value: ", error);
      }



      } catch (error) {
        console.error("Error opening position: ", error);
      } 





}

async function manualClosePosition() {
  await initDb();
  setNativeMintWrappingStrategy('none');

  const keyPairBytes = new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
  const wallet = await createKeyPairSignerFromBytes(keyPairBytes);
  const mainnetRpc = createSolanaRpc(mainnet(rpcUrl));

  // const positionMintAddress = address("2Sk3JXzHwLnqgQUmGWstewq9jLRhpJeKUdJNP9gh4doU");
  const positionMintAddress = address("2Sk3JXzHwLnqgQUmGWstewq9jLRhpJeKUdJNP9gh4doU");
  const poolAddress = address("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE");

  // Fetch whirlpool info to verify tokens
  // const whirlpool = await fetchWhirlpool(mainnetRpc, poolAddress);
  // console.log("Whirlpool token A:", whirlpool.data.tokenMintA.toString());
  // console.log("Whirlpool token B:", whirlpool.data.tokenMintB.toString());


  const slippageToleranceBps = 100;

  const decimalsTokenA = 9;
  const decimalsTokenB = 6;

  const closePositionResult = await closePositionUtil(
    mainnetRpc, 
    positionMintAddress,
    address(SOL_MINT),
    address(USDC_MINT),
    decimalsTokenA,
    decimalsTokenB,
    slippageToleranceBps, 
    wallet,
    poolAddress
  );

  // console.log("Close Position Confirmed: ", closePositionResult?.isConfirmed);

//   const result = await calcUsdValueOfPosition(
//     mainnetRpc,
//     positionMintAddress,
//     100,
//     decimalsTokenA,
//     decimalsTokenB,
//     poolAddress,
//     wallet
//   );
//   console.log("Result: ", result);

}

async function startWorker() {

const config = require(path.join(process.cwd(), 'config.json'));
  const keyPairBytes = new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
const wallet = await createKeyPairSignerFromBytes(keyPairBytes);
const mainnetRpc = createSolanaRpc(mainnet(rpcUrl));

// use fetchWhirlpool to get the token addresses and then use getTokenBalance to get the decimals



  // await startWorkerStrategy1(
  //   wallet,
  //   rpcUrl,
  //   config.targetPositionSizeUsd,
  //   config.rangeDeviationPercentAsDecimal,
  //   address(config.poolAddress),
  //   config.checkIntervalMinutes,
  //   config.profitTargetAsDecimal
  // );

  // log using strategy
  
  if (config.strategy === 1) {
    await startWorkerStrategy1(
      wallet,
      rpcUrl,
      config.targetPositionSizeUsd,
      config.rangeDeviationPercentAsDecimal,
      address(config.poolAddress),
    config.checkIntervalMinutes,
      config.profitTargetAsDecimal
    );
  } else if (config.strategy === 2) {

    console.log("Using Hedge Strategy 1");

    await startHedgeWorkerStrategy1(
      wallet,
      rpcUrl,
      config.targetPositionSizeUsd,
      config.rangeDeviationPercentAsDecimal,
      address(config.poolAddress),
      config.checkIntervalMinutes,
      config.profitTargetAsDecimal,
      config.usdcPercOfPositionSizeForShort
    );
  }



  // const bal = await rpc.getBalance(address('4oKp3b2QkoYn9WGBfuDXvAqJeTMFeWTRLH5KTjucKcM6')).send();

  // console.log("Balance: ", bal.value);






    


}

async function swapAll() {
    const keyPairBytes = new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
    const wallet = await createKeyPairSignerFromBytes(keyPairBytes);
    const mainnetRpc = createSolanaRpc(mainnet(rpcUrl));

    try {
        // Create ATAs if they don't exist
        await createAtaForMint(mainnetRpc, wallet, address(SOL_MINT));
        await createAtaForMint(mainnetRpc, wallet, address(USDC_MINT));

        // Swap wSOL to USDC
        console.log("Swapping wSOL to USDC...");
        const success = await swapToUsdc(
            mainnetRpc,
            wallet,
            address(SOL_MINT),
            5  // max attempts
        );

        if (success) {
            const usdcBalance = await getTokenBalUtil(wallet, address(USDC_MINT));
            console.log(`Final USDC balance: ${usdcBalance?.tokenBalanceNormalized || 0} USDC`);
        }
    } catch (error) {
        console.error("Error in swapAll:", error);
        throw error;
    }
}

startWorker().catch(console.error);
// manualClosePosition().catch(console.error);
// swapAll().catch(console.error);

