// Types for messages
export const PlaceAndTakeOrderSuccessCondition = {
    PartialFill: 1,
    FullFill: 2
} as const;

// Add type for type checking
export type PlaceAndTakeOrderSuccessCondition = typeof PlaceAndTakeOrderSuccessCondition[keyof typeof PlaceAndTakeOrderSuccessCondition];

export const PositionDirection = {
    LONG: { long: {} },
    SHORT: { short: {} }
} as const;

// Keep the type declaration for type checking
export type PositionDirection = typeof PositionDirection.LONG | typeof PositionDirection.SHORT;

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
   export interface DepositMessage {
    type: 'DEPOSIT';
    data: DepositParams;
  }
   
   export interface InitUserAccountMessage {
     type: 'INIT_USER_ACCOUNT';
     data: InitUserAccountParams;
   }
   
   export interface GetInitUserInstructionsMessage {
     type: 'GET_INIT_USER_INSTRUCTIONS';
     data: InitUserAccountParams;
   }
   
   export interface getDepositInstructionMessage {
     type: 'GET_DEPOSIT_INSTRUCTION';
     data: DepositParams;
   }
   
//    export interface PlacePerpOrderParams {
//      orderParams: OptionalOrderParams;
//      subAccountId?: number;
//      depositToTradeArgs?: {
//        depositMarketIndex: number;
//        isMakingNewAccount: boolean;
//      };
//    }
   
//    export interface GetPlacePerpOrderMessage {
//      type: 'GET_PLACE_PERP_ORDER_IX';
//      data: PlacePerpOrderParams;
//    }
   
   export interface PlaceAndTakePerpOrderParams {
     orderDirection: PositionDirection;
     orderMarketIndex: number;
     orderSizeBase: string | number; // Change from BN to string/number
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
     referrerInfo?: any; 
     // ReferrerInfo export type ReferrerInfo = {
    //     referrer: PublicKey;
    //     referrerStats: PublicKey;
    // };
     donateAmount?: any; // BN is a big number
     customMaxMarginRatio?: number;
     poolId?: number;
     useNextSubAccount?: boolean;
   }
   
   export interface InitUserAndDepositMessage {
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
   
   export type WorkerMessage = 
     | InitUserAccountMessage 
     | GetInitUserInstructionsMessage 
     | getDepositInstructionMessage
     // | GetPlacePerpOrderMessage
     | GetPlaceAndTakePerpOrderMessage
     | InitUserAndDepositMessage
     | GetPositionDetailsMessage
     | GetUserMessage;
   
   export interface WorkerResponse {
    type: 'SUCCESS' | 'ERROR';
    data?: any;
    error?: string;
   }

   export interface GetActiveSubAccountIdMessage {
    type: 'GET_ACTIVE_SUB_ACCOUNT_ID';
   }