import { fork } from 'child_process';
import { 
  getDepositInstructionMessage, 
  GetInitUserInstructionsMessage,
  InitUserAccountMessage,
  WorkerResponse,
//   GetPlacePerpOrderMessage,
  GetPlaceAndTakePerpOrderMessage,
  InitUserAndDepositMessage,
  PositionDirection,
  PlaceAndTakeOrderSuccessCondition,
  GetPositionDetailsMessage,
  GetUserMessage,
  DepositMessage,
  GetActiveSubAccountIdMessage
} from './drift-worker-types';

const DEBUG = false;

// import { OptionalOrderParams, OrderParams, MakerInfo, ReferrerInfo, PlaceAndTakeOrderSuccessCondition, PositionDirection, BN, PublicKey } from '@drift-labs/sdk';

function sendMessage(message: any): Promise<WorkerResponse> {
  const worker = fork(__dirname + '/../../drift-worker/dist/drift-worker.js'); // TODO: figure out how to handle this path
  
  return new Promise((resolve, reject) => {
    worker.on('message', (response: WorkerResponse) => {
      DEBUG ? console.log('Worker response:', response) : null;
      worker.kill();
      if (response.type === 'ERROR') {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });

    worker.on('error', (error) => {
      worker.kill();
      reject(error);
    });

    worker.send(message);
  });
}

export async function getUser(subAccountId: number = 0): Promise<{
  type: 'SUCCESS' | 'ERROR';
  data?: {
    user: {
      userAccountPublicKey: string;
      userAccountBalanceUsdc: number;
    }
  };
  error?: string;
}> {
  console.log("Starting getUser");
  const message: GetUserMessage = {
    type: 'GET_USER',
    data: { subAccountId }
  };
  return sendMessage(message);
}

// make a type for the response of initUserAndDeposit
export type InitUserAndDepositResponse = {
  type: 'SUCCESS' | 'ERROR';
  data?: {
    userAccountPublicKey: string;
    associatedTokenAccount: string;
    bundleId: string;
    txnId: string;
    base64Txn: string;
    status: string;
    subAccountId: number;
  };
}

export async function initUserAndDeposit(
  amount: number,
  marketIndex = 0,
  subAccountId = 0,
  name?: string,
  fromSubAccountId?: number,
  donateAmount?: string,
  customMaxMarginRatio?: number,
  poolId?: number,
  useNextSubAccount?: boolean
): Promise<InitUserAndDepositResponse> {


      const message: InitUserAndDepositMessage = {
        type: 'INIT_USER_AND_DEPOSIT',
        data: {
          amount,
          marketIndex,
          subAccountId,
          name,
          fromSubAccountId,
          donateAmount,
          customMaxMarginRatio,
          poolId,
          useNextSubAccount
        }
      };
      
      const response = await sendMessage(message);
      console.log("Init user and deposit completed successfully");
      // log how much was deposited
      console.log(`Deposited ${amount} usdc`);
      return response;
      
}

export async function deposit(marketIndex: number, amount: number, subAccountId = 0, reduceOnly = false, userInitialized = true) {
  const message: DepositMessage = {
    type: 'DEPOSIT',
    data: { marketIndex, amount, subAccountId, reduceOnly, userInitialized }
  };
  return sendMessage(message);
}


// export async function initUserAccount(subAccountId: number, name: string) {
//   const message: InitUserAccountMessage = {
//     type: 'INIT_USER_ACCOUNT',
//     data: { subAccountId, name }
//   };
//   return sendMessage(message);
// }


export async function placeAndTakePerpOrder(
  orderDirection: PositionDirection,
  orderMarketIndex: number,
  orderSizeBase: number, // normalized
  successCondition: PlaceAndTakeOrderSuccessCondition,
  decimals: number,
  subAccountId?: number
): Promise<{
  type: 'SUCCESS' | 'ERROR';
  data?: {
    bundleId: string;
    txnId: string;
    base64Txn: string;
    usdcBalBefore: number;
    usdcBalAfter: number;
    normalizedUsdcBalChange: number;
    baseAssetAmount: number;
    baseAssetAmountNormalized: number;
    oraclePriceNormalized: number;
    totalValueUsdPlaceAndTake: number;
  };
  error?: any;
}> {
  const message: GetPlaceAndTakePerpOrderMessage = {
    type: 'GET_PLACE_AND_TAKE_PERP_ORDER_IX',
    data: { 
      orderDirection,
      orderMarketIndex,
      orderSizeBase,
      successCondition,
      decimals,
      subAccountId
    }
  };
  return sendMessage(message);
}



export async function getPositionDetails(
  marketIndex: number,
  decimals: number,
  subAccountId?: number
): Promise<{
  type: 'SUCCESS' | 'ERROR';
  data?: {
    baseAssetAmount: number;
    baseAssetAmountNormalized: number;
    oraclePrice: number;
    totalValueUsd: number;
    unsettledPnl: number;
  };
  error?: string;
}> {
  const message: GetPositionDetailsMessage = {
    type: 'GET_POSITION_DETAILS',
    data: { marketIndex, decimals, subAccountId }
  };
  return sendMessage(message);
}

export async function getActiveSubAccountId(): Promise<{
  type: 'SUCCESS' | 'ERROR';
  data?: {
    activeSubAccountId: number;
  };
  error?: string;
}> {
  const message: GetActiveSubAccountIdMessage = { type: 'GET_ACTIVE_SUB_ACCOUNT_ID' };
  return sendMessage(message);
}
