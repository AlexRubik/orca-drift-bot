import { fork } from 'child_process';
import { 
  GetInitUserInstructionsMessage,
  InitUserAccountMessage,
  WorkerResponse,
  GetPlacePerpOrderMessage,
  GetPlaceAndTakePerpOrderMessage,
  GetInitUserAndDepositMessage,
  GetUserMessage,
  DepositMessage
} from './drift-worker.js';

import { OptionalOrderParams, OrderParams, MakerInfo, ReferrerInfo, PlaceAndTakeOrderSuccessCondition, PositionDirection, BN, PublicKey } from '@drift-labs/sdk';

function sendMessage(message: any): Promise<WorkerResponse> {
  const worker = fork(__dirname + '/drift-worker.ts');
  
  return new Promise((resolve, reject) => {
    worker.on('message', (response: WorkerResponse) => {
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

export async function getDepositInstruction(marketIndex: number, amount: number, subAccountId = 0, reduceOnly = false, userInitialized = true) {
  const message: DepositMessage = {
    type: 'DEPOSIT',
    data: { marketIndex, amount, subAccountId, reduceOnly, userInitialized }
  };
  return sendMessage(message);
}

export async function getInitUserInstructions(subAccountId: number, name: string) {
  const message: GetInitUserInstructionsMessage = {
    type: 'GET_INIT_USER_INSTRUCTIONS',
    data: { subAccountId, name }
  };
  return sendMessage(message);
}

export async function initUserAccount(subAccountId: number, name: string) {
  const message: InitUserAccountMessage = {
    type: 'INIT_USER_ACCOUNT',
    data: { subAccountId, name }
  };
  return sendMessage(message);
}

export async function getPlacePerpOrderIx(
  orderParams: OptionalOrderParams,
  subAccountId?: number,
  depositToTradeArgs?: {
    depositMarketIndex: number;
    isMakingNewAccount: boolean;
  }
) {
  const message: GetPlacePerpOrderMessage = {
    type: 'GET_PLACE_PERP_ORDER_IX',
    data: { 
      orderParams, 
      subAccountId, 
      depositToTradeArgs,
      decimals: 6
    }
  };
  return sendMessage(message);
}

export async function getPlaceAndTakePerpOrderIx(
  orderDirection: PositionDirection,
  orderMarketIndex: number,
  orderSizeBase: number,
  successCondition: PlaceAndTakeOrderSuccessCondition,
  decimals: number = 9
) {
  const message: GetPlaceAndTakePerpOrderMessage = {
    type: 'GET_PLACE_AND_TAKE_PERP_ORDER_IX',
    data: {
      orderDirection,
      orderMarketIndex,
      orderSizeBase,
      successCondition,
      decimals
    }
  };
  return sendMessage(message);
}

export async function getInitUserAndDepositIx(
  amount: number,
  marketIndex = 0,
  subAccountId = 0,
  name?: string,
  fromSubAccountId?: number,
  referrerInfo?: ReferrerInfo,
  donateAmount?: BN,
  customMaxMarginRatio?: number,
  poolId?: number
) {
  const message: GetInitUserAndDepositMessage = {
    type: 'INIT_USER_AND_DEPOSIT',
    data: {
      amount,
      marketIndex,
      subAccountId,
      name,
      fromSubAccountId,
      referrerInfo,
      donateAmount,
      customMaxMarginRatio,
      poolId
    }
  };
  return sendMessage(message);
}

export async function getUser(subAccountId: number = 0) {
  const message: GetUserMessage = {
    type: 'GET_USER',
    data: { subAccountId }
  };
  return sendMessage(message);
}

export async function deposit(marketIndex: number, amount: number, subAccountId = 0, reduceOnly = false, userInitialized = true) {
  const message: DepositMessage = {
    type: 'DEPOSIT',
    data: { marketIndex, amount, subAccountId, reduceOnly, userInitialized }
  };
  return sendMessage(message);
} 