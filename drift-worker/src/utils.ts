import { TransactionInstruction, PublicKey as SolanaPublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import {
  decodeUser,
  PublicKey,
  MarketType,
  BASE_PRECISION,
  PlaceAndTakeOrderSuccessCondition,
  UserAccount,
  isVariant,
  PositionDirection,
  DriftClient,
  getUserStatsAccountPublicKey,
  BN,
  OrderType,
} from '@drift-labs/sdk';

interface RawInstruction {
  programId: string;
  keys: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  data: number[];
}

/**
 * Converts a raw instruction object from worker message into a TransactionInstruction
 * @param rawIx The raw instruction object from worker
 * @returns TransactionInstruction
 */
export function convertToTransactionInstruction(rawIx: RawInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new SolanaPublicKey(rawIx.programId),
    keys: rawIx.keys.map(key => ({
      pubkey: new SolanaPublicKey(key.pubkey),
      isSigner: key.isSigner,
      isWritable: key.isWritable
    })),
    data: Buffer.from(rawIx.data)
  });
}

interface TopMakerParams {
  marketIndex: number;
  marketType: MarketType;
  side: 'bid' | 'ask';
}

interface TopMakerResult {
  userAccountPubKey: PublicKey;
  userAccount: UserAccount;
}

/**
 * Fetches the current top makers from Drift's off-chain infrastructure
 */
export async function getTopMakersForPlaceAndTake({
  marketIndex,
  marketType,
  side,
}: TopMakerParams): Promise<TopMakerResult[]> {
  const dlobServerUrl = `https://dlob.drift.trade/`;
  const marketTypeStr = isVariant(marketType, 'perp') ? 'perp' : 'spot';
  const limit = 4;
  const maxRetries = 5;
  let retries = 0;

  const queryParams = `marketIndex=${marketIndex}&marketType=${marketTypeStr}&side=${side}&limit=${limit}&includeAccounts=true`;

  while (retries < maxRetries) {
    try {

      // log full url
      console.log(`Fetching top makers from: ${dlobServerUrl}/topMakers?${queryParams}`);
      const response = await fetch(`${dlobServerUrl}/topMakers?${queryParams}`);
      if (!response.ok) {
        console.error('Failed to fetch top makers:', response.statusText);
        retries++;
        if (retries >= maxRetries) return [];
        continue;
      }

      let result = await response.json() as {
        userAccountPubKey: string;
        accountBase64: string;
      }[];
      
      // Filter out entries with null or empty accountBase64
      result = result.filter(item => item.accountBase64 && item.accountBase64.trim() !== '');
      
      // If result is empty after filtering, retry
      if (!result || result.length === 0) {
        retries++;
        if (retries >= maxRetries) return [];
        console.log(`Attempt ${retries}/${maxRetries}: Empty result, retrying...`);
        continue;
      }

      return result.map(value => ({
        userAccountPubKey: new PublicKey(value.userAccountPubKey),
        userAccount: decodeUser(Buffer.from(value.accountBase64, 'base64')),
      }));
    } catch (error) {
      console.error(`Attempt ${retries + 1}/${maxRetries}: Error fetching top makers:`, error);
      retries++;
      if (retries >= maxRetries) return [];
    }
  }
  
  return [];
}

/**
 * Processes top makers into params for a place and take order
 */
export async function getMakerInfoForPlaceAndTake(
  orderDirection: PositionDirection,
  orderMarketIndex: number,
  orderMarketType: MarketType,
  driftClient: DriftClient
) {
  const topMakers = await getTopMakersForPlaceAndTake({
    marketIndex: orderMarketIndex,
    marketType: orderMarketType,
    side: isVariant(orderDirection, 'long') ? 'ask' : 'bid',
  });

  const makerAccountKeys = topMakers.map(maker => maker.userAccountPubKey);
  const makerStatsAccountKeys = topMakers.map(makerAccount =>
    getUserStatsAccountPublicKey(
      driftClient.program.programId,
      makerAccount.userAccount.authority
    )
  );
  const makerAccounts = topMakers.map(maker => maker.userAccount);

  return makerAccountKeys.map((makerUserAccountKey, index) => ({
    maker: makerUserAccountKey,
    makerUserAccount: makerAccounts[index],
    makerStats: makerStatsAccountKeys[index],
  }));
}

/**
 * Creates a compute unit instruction
 * @param units Number of compute units to request (default 1_400_000)
 * @returns TransactionInstruction
 */
export function createComputeUnitIx(units: number = 1_400_000): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({
    units
  });
}

/**
 * Creates a priority fee instruction
 * @param microLamports Priority fee in micro-lamports (default 1)
 * @returns TransactionInstruction
 */
export function createPriorityFeeIx(microLamports: number = 1): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitPrice({
    microLamports
  });
}

interface SignatureStatus {
    slot: number;
    confirmations: number | null;
    err: any;
    confirmationStatus?: 'processed' | 'confirmed' | 'finalized';
}

export async function getSignatureStatuses(url: string, signatures: string[]): Promise<SignatureStatus[]> {
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getSignatureStatuses',
                params: [
                    signatures,
                    { searchTransactionHistory: true }
                ]
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data.result.value;
    } catch (error) {
        console.error('Error getting signature statuses:', error);
        throw error;
    }
} 

export function getActiveSubAccountId(driftClient: DriftClient) {

  // if error return 0

  try {
    const firstUserKey = [...driftClient.users.keys()][0];
    console.log('First user key:', firstUserKey);
    // grab first character of firstUserKey and convert to number
    const subAccountId = parseInt(firstUserKey[0]);
    return subAccountId;
  } catch (error) {
    console.error('Error getting sub account id:', error);
    return 0;
  }
}

