// drift-worker.ts
import { Connection } from "@solana/web3.js";

import { BN, Wallet, loadKeypair, DriftClient, OrderParams, 
  OptionalOrderParams, 
  PlaceAndTakeOrderSuccessCondition, MakerInfo, 
  ReferrerInfo, PositionDirection, MarketType, OrderType, 
  BASE_PRECISION, OrderTriggerCondition } from "@drift-labs/sdk";

import { getMakerInfoForPlaceAndTake, getSignatureStatuses, getActiveSubAccountId } from "./utils";
import { buildAndSendJitoBundle } from "./jito";

// load in config.json
const config = require('../../config.json');

// Types for messages
export interface InitUserAccountParams {
 subAccountId: number;
 name: string;
}

export interface DepositParams {
 marketIndex: number;
 amount: number;  // Will be converted to BN with proper precision
 subAccountId?: number;
 reduceOnly?: boolean;
 userInitialized?: boolean;
}

export interface InitUserAccountMessage {
  type: 'INIT_USER_ACCOUNT';
  data: InitUserAccountParams;
}

export interface GetInitUserInstructionsMessage {
  type: 'GET_INIT_USER_INSTRUCTIONS';
  data: InitUserAccountParams;
}

export interface DepositMessage {
  type: 'DEPOSIT';
  data: DepositParams;
}

export interface PlacePerpOrderParams {
  orderParams: OptionalOrderParams;
  decimals: number;  subAccountId?: number;
  depositToTradeArgs?: {
    depositMarketIndex: number;
    isMakingNewAccount: boolean;
  };
  
}

export interface GetPlacePerpOrderMessage {
  type: 'GET_PLACE_PERP_ORDER_IX';
  data: PlacePerpOrderParams;
}

export interface PlaceAndTakePerpOrderParams {
  orderDirection: PositionDirection;
  orderMarketIndex: number;
  orderSizeBase: number;
  successCondition: PlaceAndTakeOrderSuccessCondition;
  decimals: number;
  subAccountId?: number;
}

export interface GetPlaceAndTakePerpOrderMessage {
  type: 'GET_PLACE_AND_TAKE_PERP_ORDER_IX';
  data: PlaceAndTakePerpOrderParams;
}

export interface InitUserAndDepositParams {
  amount: number; // Will be converted to proper precision
  marketIndex?: number;
  subAccountId?: number;
  name?: string;
  fromSubAccountId?: number;
  referrerInfo?: ReferrerInfo;
  donateAmount?: BN;
  customMaxMarginRatio?: number;
  poolId?: number;
  useNextSubAccount?: boolean;
}

export interface GetInitUserAndDepositMessage {
  type: 'INIT_USER_AND_DEPOSIT';
  data: InitUserAndDepositParams;
}

export interface GetPositionDetailsParams {
  marketIndex: number;
  decimals: number;
  subAccountId?: number;
}

export interface GetPositionDetailsMessage {
  type: 'GET_POSITION_DETAILS';
  data: GetPositionDetailsParams;
}

export interface GetUserParams {
  subAccountId: number;
}

export interface GetUserMessage {
  type: 'GET_USER';
  data: GetUserParams;
}

export interface GetActiveSubAccountIdMessage {
  type: 'GET_ACTIVE_SUB_ACCOUNT_ID';
}

export type WorkerMessage = 
  | InitUserAccountMessage 
  | GetInitUserInstructionsMessage 
  | DepositMessage
  | GetPlacePerpOrderMessage
  | GetPlaceAndTakePerpOrderMessage
  | GetInitUserAndDepositMessage
  | GetPositionDetailsMessage
  | GetUserMessage
  | GetActiveSubAccountIdMessage;

export interface WorkerResponse {
 type: 'SUCCESS' | 'ERROR';
 data?: any;
 error?: string;
}

let driftClient: DriftClient | null = null;

const wssUrl = "wss://summer-thrilling-rain.solana-mainnet.quiknode.pro/b011ab54cb2f4dfe5f7de0b13979d1e616711cdc/"
const universalUrl = "https://api.mainnet-beta.solana.com"

const connection = new Connection(config.rpcUrl, 'confirmed');

let wallet: Wallet;
try {
  const keyPairFile = config.keypairPath;
  wallet = new Wallet(loadKeypair(keyPairFile));
} catch (error) {
  console.error("\n========== KEYPAIR LOADING ERROR ==========");
  console.error("Failed to load Solana keypair file. This is likely due to:");
  console.error("1. The keypair file is corrupted or has invalid characters");
  console.error("2. The keypair file path is incorrect");
  console.error("3. The keypair file permissions are incorrect");
  console.error("\nFile path being used:", config.keypairPath);
  console.error("\nTo fix this:");
  console.error("- Check that your keypair file exists and contains valid base58 characters");
  console.error("- Verify the path in config.json is correct");
  console.error("- Try regenerating your keypair if necessary");
  console.error("\nOriginal error:", error);
  console.error("===========================================\n");
  
  // Either exit the process or throw a more descriptive error
  process.exit(1);
}

export async function initializeDriftClient() {
  if (driftClient) {
    console.log("Using existing Drift client instance");
    return driftClient;
  }

  console.log("Initializing new Drift client...");
  
  driftClient = new DriftClient({
    connection: connection,
    wallet,
    env: 'mainnet-beta'
  });
  
  await driftClient.subscribe();
  console.log("Drift client initialized and subscribed");

  return driftClient;
}

process.on('message', async (message: WorkerMessage) => {
  if (!process.send) return;

  try {
    // Initialize client once at the start of handling a message
    const client = await initializeDriftClient();

    switch (message.type) {
      case 'INIT_USER_ACCOUNT':
        console.log('Starting INIT_USER_ACCOUNT...');
        const initAccountParams = message.data as InitUserAccountParams;

        const [txSig, userPublicKey] = await client.initializeUserAccount(
          initAccountParams.subAccountId || getActiveSubAccountId(client), // TODO: account for subaccounts existing, can't overwrite
          initAccountParams.name
        );

        process.send({ 
          type: 'SUCCESS', 
          data: { 
            txSig, 
            userPublicKey 
          } 
        } as WorkerResponse);
        break;
        case 'GET_INIT_USER_INSTRUCTIONS':
        console.log('Starting GET_INIT_USER_INSTRUCTIONS...');
        const initParams = message.data as InitUserAccountParams;

        const userStatsIx = await client.getInitializeUserStatsIx();

        const instruction = await client.getInitializeUserAccountIxs(
          initParams.subAccountId || getActiveSubAccountId(client), // TODO: account for subaccounts existing, can't overwrite
          initParams.name
        ); // Promise<[PublicKey, TransactionInstruction]>
        process.send({
          type: 'SUCCESS',
          data: {
           statIx: userStatsIx,
           initIx: instruction[1],
           pubkey: instruction[0]
          }
        } as WorkerResponse);
        break;
        case 'DEPOSIT':
          console.log('Starting DEPOSIT... for amount: ', message.data.amount);
          // log sub acc id
          console.log('subAccountId: ', message.data.subAccountId);
          const depositParams = message.data as DepositParams;
          const depositAmount = client.convertToSpotPrecision(
            depositParams.marketIndex,
            depositParams.amount
          );
          
          const associatedTokenAccount = await client.getAssociatedTokenAccount(
            depositParams.marketIndex
          );
          
          
          const depositInstruction = await client.getDepositInstruction(
            depositAmount,
            depositParams.marketIndex,
            associatedTokenAccount,
            depositParams.subAccountId || getActiveSubAccountId(client),
            depositParams.reduceOnly || false,
            depositParams.userInitialized || false
          );

          // Send transaction using Jito
          const jitoBundleDeposit = await buildAndSendJitoBundle(
            [depositInstruction],
            wallet,
            config.rpcUrl,
            0.001,
            undefined,
            true
          );

          // Wait for confirmation
          await new Promise(resolve => setTimeout(resolve, 5000));
          const txnStatusDeposit = await getSignatureStatuses(config.rpcUrl, [jitoBundleDeposit.txnId]);
          
          process.send({
            type: 'SUCCESS',
            data: {
              txId: jitoBundleDeposit.txnId,
              base64Tx: jitoBundleDeposit.base64Tx,
              status: txnStatusDeposit[0].confirmationStatus,
              associatedTokenAccount
            }
          } as WorkerResponse);
          break;
        case 'GET_PLACE_PERP_ORDER_IX':
          console.log('Starting GET_PLACE_PERP_ORDER_IX...');
          const perpOrderParams = message.data as PlacePerpOrderParams;
          const perpOrderIx = await client.getPlacePerpOrderIx(
            perpOrderParams.orderParams,
            perpOrderParams.subAccountId || getActiveSubAccountId(client),
            perpOrderParams.depositToTradeArgs
          );
          
          process.send({
            type: 'SUCCESS',
            data: {
              instruction: perpOrderIx
            }
          } as WorkerResponse);
          break;
        case 'GET_PLACE_AND_TAKE_PERP_ORDER_IX':
          const placeAndTakeParams = message.data as PlaceAndTakePerpOrderParams;
          console.log('Starting GET_PLACE_AND_TAKE_PERP_ORDER_IX... with subAccountId: ', placeAndTakeParams.subAccountId);
          
          // Log all available users
          console.log('Available users in client:', [...client.users.keys()]);
          console.log('Active sub account ID from function:', getActiveSubAccountId(client));
          
          // Check if user exists for the requested subAccountId
          const requestedSubAccountId = placeAndTakeParams.subAccountId || getActiveSubAccountId(client);
          console.log('Requested subAccountId:', requestedSubAccountId);
          console.log('Has user for requested subAccountId:', client.hasUser(requestedSubAccountId));
          
          try {
            const makerInfos = await getMakerInfoForPlaceAndTake(
              placeAndTakeParams.orderDirection,
              placeAndTakeParams.orderMarketIndex,
              MarketType.PERP,
              client
            );

            // log maker infos array size
            console.log('Maker infos array size:', makerInfos.length);
            
            console.log('Got maker infos successfully');
            
            const placeAndTakeIx = await client.getPlaceAndTakePerpOrderIx(
              {
                direction: placeAndTakeParams.orderDirection,
                baseAssetAmount: new BN(Math.floor(Number(placeAndTakeParams.orderSizeBase) * Math.pow(10, placeAndTakeParams.decimals))),
                marketIndex: placeAndTakeParams.orderMarketIndex,
                marketType: MarketType.PERP,
                orderType: OrderType.MARKET
              },
              makerInfos, // makerInfos
              undefined,
              placeAndTakeParams.successCondition,
              undefined,
              requestedSubAccountId
            );

            
            console.log('Got place and take instruction successfully');
            
            // settle ixs
            const user = client.getUser(requestedSubAccountId);
            const userAccount = user.getUserAccount();
            const userAccountPublicKey = user.userAccountPublicKey;
            console.log('User account public key:', userAccountPublicKey.toString());
            
            const settleIxs = await client.getSettlePNLsIxs([{
              settleeUserAccountPublicKey: userAccountPublicKey,
              settleeUserAccount: userAccount
            }], [placeAndTakeParams.orderMarketIndex]);
            
            console.log('Got settle instructions successfully, count:', settleIxs.length);

            const usdcBalanceIndex = 0;

            const usdcBalBefore = user.getTokenAmount(0);

            const jitoBundle = await buildAndSendJitoBundle(
             [placeAndTakeIx, ...settleIxs],
              wallet,
               config.rpcUrl,
                0.001,
                 undefined,
                 true,
                 [
                  'Fpys8GRa5RBWfyeN7AaDUwFGD1zkDCA4z3t4CJLV8dfL',
                  'EiWSskK5HXnBTptiS5DH6gpAJRVNQ3cAhTKBGaiaysAb'
                ] // LUT Account
           );

          // wait 10 seconds and then check if the txn is confirmed or finalized
          await new Promise(resolve => setTimeout(resolve, 10000));
          const txnStatus = await getSignatureStatuses(config.rpcUrl, [jitoBundle.txnId]);
          console.log('txnStatus:', txnStatus[0].confirmationStatus);

          let normalizedUsdcBalChange = 0;
          let usdcBalBeforeNormalized = 0;
          let usdcBalAfterNormalized = 0;
          let newBaseAssetAmount = 0;
          let oraclePriceNormalized = 0;
          let totalValueUsdPlaceAndTake = 0;
          // if status is confirmed or finalized, get position
          if (txnStatus[0].confirmationStatus === 'confirmed' || txnStatus[0].confirmationStatus === 'finalized') { 

            const position = user.getPerpPosition(placeAndTakeParams.orderMarketIndex);

            newBaseAssetAmount = position?.baseAssetAmount.toNumber() || 0;

            const usdcBalAfter = user.getTokenAmount(usdcBalanceIndex);

            const usdcBalChange = usdcBalAfter.sub(usdcBalBefore);

            // normalize before and after and log it
            usdcBalBeforeNormalized = usdcBalBefore.toNumber() / Math.pow(10, 6);
            usdcBalAfterNormalized = usdcBalAfter.toNumber() / Math.pow(10, 6);

            const balChangeAsNumber = usdcBalChange.toNumber();

            // normalize
            normalizedUsdcBalChange = balChangeAsNumber / Math.pow(10, 6);

            const oraclePrice = client.getOracleDataForPerpMarket(placeAndTakeParams.orderMarketIndex);

            oraclePriceNormalized = oraclePrice.price.toNumber() / Math.pow(10, 6);

            console.log("Oracle Price Number:", oraclePriceNormalized);

            totalValueUsdPlaceAndTake = newBaseAssetAmount * oraclePriceNormalized;

            


          }
           
           process.send({
             type: 'SUCCESS',
             data: {

               bundleId: jitoBundle.bundleId,
               txnId: jitoBundle.txnId,
               base64Txn: jitoBundle.base64Tx,
               usdcBalBefore: usdcBalBeforeNormalized,
               usdcBalAfter: usdcBalAfterNormalized,
               normalizedUsdcBalChange: normalizedUsdcBalChange,
               baseAssetAmount: newBaseAssetAmount,
               baseAssetAmountNormalized: newBaseAssetAmount / Math.pow(10, placeAndTakeParams.decimals),
               oraclePriceNormalized,
               totalValueUsdPlaceAndTake
             }
           } as WorkerResponse);
         } catch (error) {
           console.error('Error in GET_PLACE_AND_TAKE_PERP_ORDER_IX:', error);
           process.send({ 
             type: 'ERROR', 
             error: error instanceof Error ? error.message : 'Unknown error in place and take' 
           } as WorkerResponse);
           break;
         }
         break;
       case 'INIT_USER_AND_DEPOSIT':
         console.log('Starting INIT_USER_AND_DEPOSIT...');
         const initAndDepositParams = message.data as InitUserAndDepositParams;

         const subAccountIdForInitAndDeposit = initAndDepositParams.useNextSubAccount ? await client.getNextSubAccountId() : initAndDepositParams.subAccountId || getActiveSubAccountId(client);
         
         // Get associated token account and convert amount
         const ata = await client.getAssociatedTokenAccount(
           initAndDepositParams.marketIndex || 0
         );
         const depositAmt = client.convertToSpotPrecision(
           initAndDepositParams.marketIndex || 0,
           initAndDepositParams.amount
         );

         console.log("subAccountIdForInitAndDeposit:", subAccountIdForInitAndDeposit);
         // market index
         console.log("marketIndex:", initAndDepositParams.marketIndex);
         // amount
         console.log("amount from params:", initAndDepositParams.amount);
         // depositAmt
         console.log("depositAmt:", depositAmt.toNumber());
         
         const initAndDepositIxs = await client.createInitializeUserAccountAndDepositCollateralIxs(
           depositAmt,
           ata,
           initAndDepositParams.marketIndex || 0,
           subAccountIdForInitAndDeposit,
           initAndDepositParams.name,
           initAndDepositParams.fromSubAccountId,
           initAndDepositParams.referrerInfo,
           initAndDepositParams.donateAmount,
           initAndDepositParams.customMaxMarginRatio,
           initAndDepositParams.poolId
         );

         const jitoBundleInitAndDeposit = await buildAndSendJitoBundle(
          [...initAndDepositIxs.ixs],
           wallet,
            config.rpcUrl,
             0.001,
              undefined,
              true
        );

        // wait 10 seconds and then check if the txn is confirmed or finalized
        await new Promise(resolve => setTimeout(resolve, 10000));
        const txnStatusInitAndDeposit = await getSignatureStatuses(config.rpcUrl, [jitoBundleInitAndDeposit.txnId]);
        console.log('txnStatus:', txnStatusInitAndDeposit[0].confirmationStatus);
         
         process.send({
           type: 'SUCCESS',
           data: {
             
             userAccountPublicKey: initAndDepositIxs.userAccountPublicKey.toString(),
             associatedTokenAccount: ata.toString(),
             bundleId: jitoBundleInitAndDeposit.bundleId,
             txnId: jitoBundleInitAndDeposit.txnId,
             base64Txn: jitoBundleInitAndDeposit.base64Tx,
             status: txnStatusInitAndDeposit[0].confirmationStatus,
             subAccountId: subAccountIdForInitAndDeposit
           }
         } as WorkerResponse);
         break;
       case 'GET_POSITION_DETAILS':
         console.log('Starting GET_POSITION_DETAILS...');
         const positionParams = message.data as GetPositionDetailsParams;
         
         const userForPosition = client.getUser(positionParams.subAccountId || getActiveSubAccountId(client));

         const position = userForPosition.getPerpPosition(positionParams.marketIndex);
         const oraclePrice = client.getOracleDataForPerpMarket(positionParams.marketIndex);

         const baseAssetAmount = position?.baseAssetAmount.toNumber() || 0;
         const baseAssetAmountNormalized = baseAssetAmount / Math.pow(10, positionParams.decimals);
         
         const oraclePriceNumber = oraclePrice.price.toNumber() / Math.pow(10, 6); // Oracle price is in 6 decimals
         const totalValueUsd = baseAssetAmountNormalized * oraclePriceNumber;

         const unsettledPnl = userForPosition.getUnrealizedPNL(true, positionParams.marketIndex);
         const unsettledPnlNormalized = unsettledPnl.toNumber() / Math.pow(10, 6);
         

         process.send({
           type: 'SUCCESS',
           data: {
             baseAssetAmount,
             baseAssetAmountNormalized,
             oraclePrice: oraclePriceNumber,
             totalValueUsd: Math.abs(totalValueUsd),
             unsettledPnl: unsettledPnlNormalized
           }
         } as WorkerResponse);
         break;
       case 'GET_USER':
        const { subAccountId } = message.data as GetUserParams;
         console.log('Starting GET_USER...');

         const userOutput = client.getUser(subAccountId);
         const userOutputAccount = userOutput.getUserAccount();
         const userOutputAccountPublicKey = userOutput.userAccountPublicKey;
         const userOutputAccountBalance = userOutput.getTokenAmount(0); // usdc
         const userOutputAccountBalanceNormalized = userOutputAccountBalance.toNumber() / Math.pow(10, 6); // usdc
         // create output object
         const userOutputObject = {
          //  user: userOutput,
          //  userAccount: userOutputAccount,
           userAccountPublicKey: userOutputAccountPublicKey.toString(),
           userAccountBalanceUsdc: userOutputAccountBalanceNormalized
         }

         console.log('userOutputObject:', userOutputObject);
         
         process.send({
           type: 'SUCCESS',
           data: {
             user: userOutputObject
           }
         } as WorkerResponse);
         break;
       case 'GET_ACTIVE_SUB_ACCOUNT_ID':
         console.log('Getting active sub account ID...');
         const activeSubAccountId = getActiveSubAccountId(client);
         
         process.send({
           type: 'SUCCESS',
           data: {
             activeSubAccountId
           }
         } as WorkerResponse);
         break;
     default:
       process.send({ 
         type: 'ERROR', 
         error: `Unknown message type: ${(message as any).type}` 
       } as WorkerResponse);
   }
 } catch (error) {
   process.send({ 
     type: 'ERROR', 
     error: error instanceof Error ? error.message : 'Unknown error' 
   } as WorkerResponse);
 }
});

// Add a proper cleanup handler for when the process exits
process.on('SIGTERM', async () => {
  console.log("Process terminating, cleaning up Drift client...");
  if (driftClient) {
    try {
      await driftClient.unsubscribe();
      console.log("Drift client unsubscribed successfully");
    } catch (error) {
      console.error('Error unsubscribing from Drift client:', error);
    }
    driftClient = null;
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log("Process interrupted, cleaning up Drift client...");
  if (driftClient) {
    try {
      await driftClient.unsubscribe();
      console.log("Drift client unsubscribed successfully");
    } catch (error) {
      console.error('Error unsubscribing from Drift client:', error);
    }
    driftClient = null;
  }
  process.exit(0);
});