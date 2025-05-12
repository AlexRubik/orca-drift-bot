import { address, createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, 
  createSolanaRpc, mainnet, RpcSendOptions, createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  getComputeUnitEstimateForTransactionMessageFactory,
  signTransactionMessageWithSigners,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  sendTransactionWithoutConfirmingFactory,
  createSolanaRpcSubscriptions,
  getBase64EncodedWireTransaction,
  Address,
  RpcMainnet,
  SolanaRpcApiMainnet,
  Rpc,
  GetFeeForMessageApi,
  TransactionMessageBytesBase64,
  IInstruction,
  TransactionSigner,
  KeyPairSigner,
  GetTokenAccountBalanceApi,
  Signature,
  setTransactionMessageFeePayerSigner,
  compressTransactionMessageUsingAddressLookupTables,
  AddressesByLookupTableAddress,
  JsonParsedAddressLookupTableAccount,
  GetMultipleAccountsApi
  

} from '@solana/web3.js';

import { USDC_MINT, USDC_MINT_DECIMALS } from './constants';

import { address as gillAddress } from 'gill';

import { getTransferInstruction, TOKEN_PROGRAM_ADDRESS } from 'gill/programs/token'

import { createAtaForMint, getAssociatedTokenAddressSync } from './tokenHelper';
import fs from 'fs';

import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { getSystemErrorMessage, isSystemError } from '@solana-program/system';
import { IncreaseLiquidityQuote, sqrtPriceToPrice } from '@orca-so/whirlpools-core';
import { closePositionInstructions, setDefaultFunder, swapInstructions } from '@orca-so/whirlpools';
import { fetchWhirlpool } from '@orca-so/whirlpools-client';
import { getJitoTipIxn, sendJitoBundle } from './jito';
import { getUsdPriceFromJup } from './jup';
// import bs58 from 'bs58';
const rpcUrl = 'https://mainnet.helius-rpc.com/?api-key=0c1257a6-bd83-4b93-82eb-93d50ea74652'

const DEBUG = false;


interface Whirlpool {
  address: string;
  [key: string]: any; // allows for other properties in the whirlpool object
}

interface WhirlpoolResponse {
  whirlpools: Whirlpool[];
}

interface FetchedAddressLookup {
    address: string;
    data: {
        addresses: Address[];
    };
}

/**
 * Fetches a whirlpool object by its address
 * @param url The base URL to fetch from
 * @param address The address of the whirlpool to find
 * @returns The matching whirlpool object or null if not found
 */
export async function getWhirlpoolByAddress(url: string, address: string): Promise<Whirlpool | null> {
  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data: WhirlpoolResponse = await response.json();
    
    const whirlpool = data.whirlpools.find(pool => pool.address === address);
    return whirlpool || null;
    
  } catch (error) {
    console.error('Error fetching whirlpool:', error);
    throw error;
  }
}

export async function getTokenBalance(tokenVault: Address): Promise<bigint> {
  const connection = createSolanaRpc(rpcUrl);
  const response = await connection.getTokenAccountBalance(tokenVault).send();
  return BigInt(response.value.amount);
}

export async function getFeeForMessage(rpcUrl: string, encodedMessage: string): Promise<number> {
  try {

    const rpc: Rpc<GetFeeForMessageApi> = createSolanaRpc(rpcUrl);

    // @ts-ignore
  const message: TransactionMessageBytesBase64 = encodedMessage;

  const fee = await rpc.getFeeForMessage(message).send();
  console.log("Fee for message:", fee.value);

    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'helius-example',
        method: 'getPriorityFeeEstimate',
        params: [{
          transaction: encodedMessage,
          options: { 
            transactionEncoding: "base64",
            recommended: true,
          }
        }]
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    // console.log("Fee for message:", data);
    // throw
    throw new Error("throw");
    return data.result.value;

  } catch (error) {
    console.error('Error getting fee:', error);
    throw error;
  }
}

// Usage:
// const fee = await getFeeForMessage('https://api.devnet.solana.com', encodedMessage);

async function fetchJsonParsedAccounts<T>(
    rpc: Rpc<GetMultipleAccountsApi>,
    addresses: Address[],
): Promise<T> {
    const response = await rpc.getMultipleAccounts(addresses, {
        commitment: 'confirmed',
        encoding: 'jsonParsed',
    }).send();

    return response.value.map((account, index) => ({
        address: addresses[index].toString(),
        ...account?.data,
    })) as T;
}

async function fetchLookupTables(
    lookupTableAddresses: Address[],
    rpc: Rpc<GetMultipleAccountsApi>,
): Promise<AddressesByLookupTableAddress> {
    if (lookupTableAddresses.length === 0) {
        return {};
    }

    const fetchedLookupTables = await fetchJsonParsedAccounts<FetchedAddressLookup[]>(
        rpc,
        lookupTableAddresses,
    );

    return fetchedLookupTables.reduce<AddressesByLookupTableAddress>((acc, lookup: any) => {
        console.log("Lookup table address:", lookup);
        return {
            ...acc,
            [lookup.address]: lookup.parsed.info.addresses,
        };
    }, {});
}

export async function sendTransactionWithPriorityFee(
    instructions: IInstruction[],  // Replace 'any' with proper instruction type
    wallet: KeyPairSigner,         // Replace 'any' with proper wallet type
    mainnetRpc: RpcMainnet<SolanaRpcApiMainnet>,      // Replace 'any' with proper RPC type
    lutAddresses?: string[]
) {
    const blockhash = await mainnetRpc.getLatestBlockhash().send();

    console.log("Wallet address:", wallet.address);

    const computeUnitsEstimate = 200000; //await getCUEst(transactionMessage, mainnetRpc);
    console.log("Setting compute units to ", computeUnitsEstimate);

    const medianPrioritizationFee = await mainnetRpc.getRecentPrioritizationFees()
  .send()
  .then(fees => {
    // Filter out zeros and map to numbers
    const nonZeroFees = fees
      .map(fee => Number(fee.prioritizationFee))
      .filter(fee => fee > 0)
      .sort((a, b) => a - b);
    
    console.log("All fees:", fees.map(f => Number(f.prioritizationFee)));
    console.log("Non-zero fees:", nonZeroFees);
    
    const medianIndex = Math.floor(nonZeroFees.length / 2);
    const median = nonZeroFees[medianIndex];
    
    console.log("Number of fees:", fees.length);
    console.log("Number of non-zero fees:", nonZeroFees.length);
    console.log("Median index:", medianIndex);
    console.log("Selected median fee:", median);

    // use calculated median fee if it's greater than 99000, but cap at 400000
    const finalMedianFee = Math.min(
      median > 99000 ? median : 99000,
      400000
    );
    
    console.log("Final fee after capping:", finalMedianFee);
    return finalMedianFee;
  });

  console.log("Final median prioritization fee:", medianPrioritizationFee);

  let finalTransactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayer(wallet.address, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(blockhash.value, tx),
    tx => appendTransactionMessageInstructions([
        getSetComputeUnitPriceInstruction({ microLamports: medianPrioritizationFee }), 
        getSetComputeUnitLimitInstruction({ units: computeUnitsEstimate }),
        ...instructions
    ], tx),
    tx => setTransactionMessageFeePayerSigner(wallet, tx)
);


    if (lutAddresses) {
        const lutAccounts = await fetchLookupTables(lutAddresses.map(address), createSolanaRpc(rpcUrl));
        DEBUG ? console.log("LUT accounts:", lutAccounts) : null;
        finalTransactionMessage = compressTransactionMessageUsingAddressLookupTables(
            finalTransactionMessage,
            lutAccounts
        );
    }

    const signedTxn = await signTransactionMessageWithSigners(finalTransactionMessage);

    // txn msg bytes base64
    const base64Txn = getBase64EncodedWireTransaction(signedTxn);
    

    const sendTransactionWithoutConfirming = sendTransactionWithoutConfirmingFactory({
        rpc: mainnetRpc
    });

    

    const universalRpc = createSolanaRpc(mainnet('https://api.mainnet-beta.solana.com'));

    const sendTransactionUniversal = sendTransactionWithoutConfirmingFactory({
        rpc: universalRpc
    });

    console.log("Base64 transaction:", base64Txn);


    try {

      
        console.log("Sending transaction");
        await sendTransactionWithoutConfirming(signedTxn, { 
            commitment: 'confirmed', 
            maxRetries: BigInt(0), 
            skipPreflight: true
        });

        await sendTransactionUniversal(signedTxn, { 
            commitment: 'confirmed', 
            maxRetries: BigInt(1), 
            skipPreflight: true
        });

        
        return getSignatureFromTransaction(signedTxn);
    } catch (e) {
        if (isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) {
            const preflightErrorContext = e.context;
            const preflightErrorMessage = e.message;
            const errorDetailMessage = isSystemError(e.cause, finalTransactionMessage) ?
                getSystemErrorMessage(e.cause.context.code) : e.cause ? e.cause.message : '';
            console.error(preflightErrorContext, '%s: %s', preflightErrorMessage, errorDetailMessage);
        }
        throw e;
    }
}

export function convertQuoteToHuman(quote: IncreaseLiquidityQuote, decimalA: number, decimalB: number) {
    return {
        liquidityDelta: Number(quote.liquidityDelta),
        tokenEstA: Number(quote.tokenEstA) / Math.pow(10, decimalA),
        tokenEstB: Number(quote.tokenEstB) / Math.pow(10, decimalB),
        tokenMaxA: Number(quote.tokenMaxA) / Math.pow(10, decimalA),
        tokenMaxB: Number(quote.tokenMaxB) / Math.pow(10, decimalB)
    };
}

// create lower and upper bounds for price given a percentage and price
export function createPriceBounds(price: number, percentageAsDecimal: number) {
    const lowerBound = price / (1 + percentageAsDecimal);
    const upperBound = price * (1 + percentageAsDecimal);
    return { lowerBound, upperBound };
}

// calculate usd value of a usd pair position where usd is the tokenb

export async function calcUsdValueOfPosition(
    rpc: RpcMainnet<SolanaRpcApiMainnet>,
    positionMintAddress: Address,
    slippageToleranceBps = 75,
    tokenADecimals: number,
    tokenBDecimals: number,
    poolAddress: Address,
    authority: TransactionSigner
) {
    let attempts = 0;
    const maxAttempts = 7;
    
    while (attempts < maxAttempts) {
        try {
            setDefaultFunder(null);

            const closePositionOutput = await closePositionInstructions(
                rpc,
                positionMintAddress,
                slippageToleranceBps,
                authority
            );

            // Safely convert to numbers using BigInt first
            const tokenAEstMin = BigInt(closePositionOutput.quote.tokenMinA);
            const tokenBEstMin = BigInt(closePositionOutput.quote.tokenMinB);

            const tokenAEst = BigInt(closePositionOutput.quote.tokenEstA);
            const tokenBEst = BigInt(closePositionOutput.quote.tokenEstB);

            // Convert to normalized values more safely
            const tokenAEstMinAmountNormalized = Number(tokenAEstMin) / Math.pow(10, tokenADecimals);
            const tokenBEstMinAmountNormalized = Number(tokenBEstMin) / Math.pow(10, tokenBDecimals);

            const tokenAEstAmountNormalized = Number(tokenAEst) / Math.pow(10, tokenADecimals);
            const tokenBEstAmountNormalized = Number(tokenBEst) / Math.pow(10, tokenBDecimals);

            const whirlpool = await fetchWhirlpoolUtil(rpc, poolAddress);
            const sqrtPrice = whirlpool.data.sqrtPrice;
            const priceOfPool = sqrtPriceToPrice(sqrtPrice, tokenADecimals, tokenBDecimals);

            // Handle potential NaN or Infinity
            if (!isFinite(priceOfPool)) {
                throw new Error('Invalid pool price calculation');
            }

            const currentPriceA = await getUsdPriceFromJup(whirlpool.data.tokenMintA, BigInt(10 ** tokenADecimals), tokenADecimals);
            const currentPriceB = await getUsdPriceFromJup(whirlpool.data.tokenMintB, BigInt(10 ** tokenBDecimals), tokenBDecimals);

            const tokenAUsdValue = tokenAEstMinAmountNormalized * currentPriceA;
            const tokenBUsdValue = tokenBEstMinAmountNormalized * currentPriceB;

            // Safely handle fees
            const tokenAFees = BigInt(closePositionOutput.feesQuote.feeOwedA);
            const tokenBFees = BigInt(closePositionOutput.feesQuote.feeOwedB);

            const tokenAFeesNormalized = Number(tokenAFees) / Math.pow(10, tokenADecimals);
            const tokenBFeesNormalized = Number(tokenBFees) / Math.pow(10, tokenBDecimals);

            const tokenAFeesUsdValue = tokenAFeesNormalized * currentPriceA;
            const tokenBFeesUsdValue = tokenBFeesNormalized * currentPriceB;

            // Check for valid numbers
            const values = [tokenAUsdValue, tokenBUsdValue, tokenAFeesUsdValue, tokenBFeesUsdValue];
            if (values.some(v => !isFinite(v))) {
                throw new Error('Invalid calculation result');
            }

            const totalUsdValue = values.reduce((a, b) => a + b, 0);

            if (!isFinite(totalUsdValue)) {
                throw new Error('Invalid total USD value');
            }

            return {
                tokenAEstMin,
                tokenBEstMin,
                tokenAEstMinAmountNormalized,
                tokenBEstMinAmountNormalized,
                tokenAEstAmountNormalized,
                tokenBEstAmountNormalized,
                tokenAFeesNormalized,
                tokenBFeesNormalized,
                priceOfPool,
                totalUsdValue,
                currentPriceA,
                currentPriceB
            };

        } catch (error) {
            attempts++;
            DEBUG ? console.error(`Attempt ${attempts} failed:`, error) : null;
            
            if (attempts === maxAttempts) {
                console.error('Max attempts reached for calcUsdValueOfPosition. Details:', {
                    positionMint: positionMintAddress,
                    pool: poolAddress,
                    error: error instanceof Error ? error.message : String(error)
                });
                return null;
            }
            
            const timeout = Math.min(1000 * Math.pow(2, attempts), 5000);
            console.log(`Waiting ${timeout/1000} seconds before attempt ${attempts + 1}`);
            await new Promise(resolve => setTimeout(resolve, timeout));
            continue;
        }
    }
    
    return null;
}

export async function getTokenBalUtil(wallet: KeyPairSigner, tokenMintAddress: Address) {
    let attempts = 0;
    const maxAttempts = 3;
    const UNIVERSAL_RPC = 'https://api.mainnet-beta.solana.com';

    let rpc = createSolanaRpc(mainnet(rpcUrl));

    while (attempts < maxAttempts) {
        try {
            rpc = createSolanaRpc(attempts === 1 ? mainnet(UNIVERSAL_RPC) : mainnet(rpcUrl));
            const tokenAccountAddress = await getAssociatedTokenAddressSync(tokenMintAddress, wallet.address);

            console.log("Token account address:", tokenAccountAddress);
            console.log(`Getting token balance... (Attempt ${attempts + 1}${attempts === 1 ? ' using universal RPC' : ''})`);

            const tokenBalance = await rpc.getTokenAccountBalance(tokenAccountAddress).send();
            const tokenBalanceNormalized = Number(tokenBalance.value.amount) / Math.pow(10, tokenBalance.value.decimals);

            return {
                tokenBalanceBigInt: BigInt(tokenBalance.value.amount),
                tokenBalanceNormalized,
                decimals: tokenBalance.value.decimals,
                rawTokenBalObj: tokenBalance
            };

        } catch (error) {
            attempts++;
            console.error(`Token balance fetch attempt ${attempts} failed:`, error);

            if (attempts === maxAttempts) {
                // wait 5 seconds and try to open the account
                await new Promise(resolve => setTimeout(resolve, 5000));
                await createAtaForMint(rpc, wallet, tokenMintAddress);
                throw new Error(`Failed to get token balance after ${maxAttempts} attempts: ${error}`);
            }

            // Wait 3 seconds before retry
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }

    throw new Error('Unexpected error in getTokenBalUtil');
}

/**
 * Waits for a transaction to be confirmed
 * @param signature Transaction signature to check
 * @param rpc RPC connection to use
 * @param maxAttempts Maximum number of attempts (default 14)
 * @param intervalSeconds Time between attempts in seconds (default 5)
 * @returns True if confirmed, false if max attempts reached
 */
export async function checkTransactionConfirmed(
    signature: Signature,
    rpc: RpcMainnet<SolanaRpcApiMainnet>,
    maxAttempts: number = 6,
    intervalSeconds: number = 5
): Promise<boolean> {
    let attempts = 0;
    const UNIVERSAL_RPC = 'https://api.mainnet-beta.solana.com';

    while (attempts < maxAttempts) {
        try {
            // Use universal RPC on 7th attempt
            const currentRpc = attempts === 6 ? 
                createSolanaRpc(UNIVERSAL_RPC) : 
                rpc;

            const statuses = await currentRpc.getSignatureStatuses([signature]).send();
            console.log(`Transaction status (attempt ${attempts + 1}/${maxAttempts}${attempts === 6 ? ' using universal RPC' : ''}):`, statuses.value);
            
            if (statuses.value[0]?.confirmationStatus === 'confirmed' || statuses.value[0]?.confirmationStatus === 'finalized') {
                console.log("Transaction confirmed!");
                return true;
            }
        } catch (error) {
            console.error(`Error checking status (attempt ${attempts + 1}/${maxAttempts}):`, error);
        }

        attempts++;
        if (attempts < maxAttempts) {
            console.log(`Waiting ${intervalSeconds} seconds before next check...`);
            await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
        }
    }

    console.log(`Transaction not confirmed after ${maxAttempts} attempts`);
    return false;
}

export async function swapEntireBalance(
    rpc: RpcMainnet<SolanaRpcApiMainnet>, 
    tokenInputMintAddress: Address,
    poolAddress: Address,
    slippageToleranceBps: number,
    wallet: KeyPairSigner
) {
    const MAX_ATTEMPTS = 5;
    let attempts = 0;
    const isSol = tokenInputMintAddress === address("So11111111111111111111111111111111111111112");

    while (attempts < MAX_ATTEMPTS) {
        try {
            // Get current balance of input token
            const tokenBalUtil = await getTokenBalUtil(wallet, tokenInputMintAddress);
            
            if (!tokenBalUtil || tokenBalUtil.tokenBalanceBigInt === 0n) {
                console.log("No balance to swap");
                return false;
            }

            console.log(`Swapping entire balance of ${tokenBalUtil.tokenBalanceNormalized} tokens`);

            // If it's SOL, leave some for gas
            const inputAmount = isSol
                ? tokenBalUtil.tokenBalanceBigInt - BigInt(100)
                : tokenBalUtil.tokenBalanceBigInt;

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

            const signature = await sendTransactionWithPriorityFee(swapIxnsObj.instructions, wallet, rpc);
            console.log("Signature of swap entire balance txn: ", signature);
            console.log("Checking if txn is confirmed...");
            const isConfirmed = await checkTransactionConfirmed(signature, rpc);

            if (!isConfirmed) {
                console.log("Transaction failed to confirm");
                attempts++;
                continue;
            }

            // Wait a bit for balance to update
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Verify final balance
            if (isSol) {
                // For SOL, check balance is under 1000 lamports
                const finalBalance = await getTokenBalUtil(wallet, tokenInputMintAddress);
                console.log(`Final wSOL balance: ${finalBalance?.tokenBalanceBigInt.toString()} lamports`);

                if (finalBalance && finalBalance.tokenBalanceBigInt > BigInt(1000)) {
                    console.log(`SOL balance still too high (${finalBalance.tokenBalanceBigInt} lamports), retrying...`);
                    attempts++;
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
            } else {
                // For other tokens, check balance is zero or account closed
                try {
                    const finalBalance = await getTokenBalUtil(wallet, tokenInputMintAddress);
                    if (finalBalance && finalBalance.tokenBalanceBigInt > BigInt(0)) {
                        console.log(`Token balance not zero (${finalBalance.tokenBalanceBigInt}), retrying...`);
                        attempts++;
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        continue;
                    }
                } catch (error) {
                    // If we get an error, the token account was probably closed
                    console.log("Token account appears to be closed (expected behavior)");
                }
            }

            return true;

        } catch (error) {
            console.error(`Error swapping entire balance (attempt ${attempts + 1}/${MAX_ATTEMPTS}):`, error);
            attempts++;
            if (attempts === MAX_ATTEMPTS) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    throw new Error(`Failed to swap entire balance after ${MAX_ATTEMPTS} attempts`);
}

export async function sendTransactionWithJito(
    instructions: IInstruction[],
    wallet: TransactionSigner,
    mainnetRpc: RpcMainnet<SolanaRpcApiMainnet>,
    desparate: boolean = false,
    lutAddresses?: string[]
) {
    const blockhash = await mainnetRpc.getLatestBlockhash().send();


    console.log("Wallet address:", wallet.address);

    // Get Jito tip instruction
    const jitoTipIxn = await getJitoTipIxn(wallet, desparate ? 0.005 : undefined);

    const transactionMessage = pipe(
        createTransactionMessage({ version: 0 }),
        tx => setTransactionMessageFeePayer(wallet.address, tx),
        tx => setTransactionMessageLifetimeUsingBlockhash(blockhash.value, tx),
        // Add Jito tip first, then other instructions
        tx => appendTransactionMessageInstructions([jitoTipIxn, ...instructions], tx),
        tx => setTransactionMessageFeePayerSigner(wallet, tx)
    );
    console.log("Transaction message created");

    const computeUnitsEstimate = await getCUEst(transactionMessage, mainnetRpc);
    console.log("Setting compute units to ", computeUnitsEstimate);

    // Only add compute unit limit, no price instruction
    let finalTransactionMessage = appendTransactionMessageInstructions(
        [getSetComputeUnitLimitInstruction({ units: computeUnitsEstimate })],
        transactionMessage,
    );

    // Add lookup tables if provided
    if (lutAddresses) {
        const lutAccounts = await fetchLookupTables(lutAddresses.map(address), createSolanaRpc(rpcUrl));
        DEBUG ? console.log("LUT accounts:", lutAccounts) : null;
        finalTransactionMessage = compressTransactionMessageUsingAddressLookupTables(
            finalTransactionMessage,
            lutAccounts
        );
    }

    const signedTxn = await signTransactionMessageWithSigners(finalTransactionMessage);
    const base64Txn = getBase64EncodedWireTransaction(signedTxn);

    console.log("Base64 transaction:", base64Txn);

    const signature = getSignatureFromTransaction(signedTxn);

    try {
        console.log("Sending transaction as Jito bundle");
        const bundleId = await sendJitoBundle([base64Txn]);
        console.log("Jito Bundle ID:", bundleId);
        console.log("Signature:", signature);
        return signature;
    } catch (e) {
        console.error('Error sending Jito bundle:', e);
        throw e;
    }
}

export async function fetchWhirlpoolUtil(
    rpc: RpcMainnet<SolanaRpcApiMainnet>,
    poolAddress: Address,
    maxAttempts: number = 10
) {
    let attempts = 0;

    while (attempts < maxAttempts) {
        try {
            const whirlpool = await fetchWhirlpool(rpc, poolAddress);
            return whirlpool;
        } catch (error) {
            attempts++;
            DEBUG ? console.error(`Error fetching whirlpool (attempt ${attempts}/${maxAttempts}):`, error) : null;
            
            if (attempts === maxAttempts) {
                throw new Error(`Failed to fetch whirlpool after ${maxAttempts} attempts`);
            }
            
            // Wait 2 seconds before retrying
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    throw new Error('Failed to fetch whirlpool (this should never happen)');
}

export async function getCUEst(
    transactionMessage: any,
    rpc: RpcMainnet<SolanaRpcApiMainnet>,
    defaultUnits: number = 220000
) {
    try {
        const getComputeUnitEstimateForTransactionMessage = getComputeUnitEstimateForTransactionMessageFactory({
            rpc: rpc
        });

        let computeUnitsEstimate = await getComputeUnitEstimateForTransactionMessage(transactionMessage) + 50_000;
        computeUnitsEstimate = (computeUnitsEstimate < 1000) ? 1000 : Math.ceil(computeUnitsEstimate * 1);

        console.log("Compute units estimate:", computeUnitsEstimate);
        
        return computeUnitsEstimate;
    } catch (error: any) {
        console.error('Error getting compute unit estimate:');
        console.error('Error code:', error?.context?.__code);
        console.error('Units consumed:', error?.context?.unitsConsumed);
        
        if (error?.cause?.InstructionError) {
            const [instructionIndex, errorDetails] = error.cause.InstructionError;
            console.error('Failed at instruction:', instructionIndex);
            // Convert BigInts to strings before JSON stringify
            const serializedDetails = JSON.stringify(errorDetails, (_, value) =>
                typeof value === 'bigint' ? value.toString() : value
            , 2);
            console.error('Error details:', serializedDetails);
        }

        // Convert BigInts to strings in full error object
        const serializedError = JSON.stringify(error, (_, value) =>
            typeof value === 'bigint' ? value.toString() : value
        , 2);
        console.error('Full error object:', serializedError);
        
        throw error;
    }
}

const FEE_WALLET = "D96EFRTeN2PSxqUfiHEQyKmwHLAE39Lcq23W2v5FJi8V";

// transfer usdc protocol fee to the fee wallet
export async function sendUsdcProtocolFee(
    rpc: RpcMainnet<SolanaRpcApiMainnet>,
    wallet: KeyPairSigner,
    amount: number,
    feeWalletAddress: Address = address(FEE_WALLET)
) {

    try {

    // get usdc mint address from constants
    const usdcMintAddress = address(USDC_MINT);

    const sourceAta = await getAssociatedTokenAddressSync(usdcMintAddress, wallet.address);
    const destinationAta = await getAssociatedTokenAddressSync(usdcMintAddress, feeWalletAddress);
    const bnAmount = BigInt(Math.floor(amount * 10 ** USDC_MINT_DECIMALS));

    // log the addresses
    console.log("Source Ata: ", sourceAta);
    console.log("Destination Ata: ", destinationAta);
    console.log("Wallet Address: ", wallet.address);
    console.log("Fee Wallet Address: ", feeWalletAddress);

    // create transfer usdc ixn

    const transferIxn = getTransferInstruction(
        {
          source: gillAddress(sourceAta),
          authority: gillAddress(wallet.address),
          destination: gillAddress(destinationAta),
          amount: bnAmount
        },
        { programAddress: TOKEN_PROGRAM_ADDRESS },
      )

      DEBUG ? console.log("Transfer ixn: ", transferIxn) : null;
      const ixn: IInstruction = {
        programAddress: address(TOKEN_PROGRAM_ADDRESS.toString()),
        data: transferIxn.data,
        accounts: transferIxn.accounts
      }

      // send with jito
      const signature = await sendTransactionWithJito([ixn], wallet, rpc);
      return signature;
    } catch (error) {
        console.error('Error sending USDC protocol fee:', error);
        
    }
    

}