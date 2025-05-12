import { USDC_MINT, USDT_MINT, SOL_MINT, SOL_MINT_DECIMALS } from './constants';
import { 
    AddressesByLookupTableAddress,
    address,
     Address, 
     createSolanaRpc, 
     KeyPairSigner, 
     RpcMainnet, SolanaRpcApiMainnet, 
     IInstruction, AccountRole,
     signature,
     Signature} from '@solana/web3.js';
import { getTokenBalUtil, sendTransactionWithJito } from './utils';
import { sendTransactionWithPriorityFee, checkTransactionConfirmed } from './utils';

interface JupiterQuoteResponse {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: 'ExactIn' | 'ExactOut';
    slippageBps: number;
    platformFee: {
        amount: string;
        feeBps: number;
    } | null;
    priceImpactPct: string;
    routePlan: Array<{
        swapInfo: any;
        percent: number;
    }>;
    scoreReport: any | null;
    contextSlot: number;
    timeTaken: number;
    swapUsdValue: string;
}

export async function getJupiterQuote(
    inputMint: Address,
    outputMint: Address,
    amount: bigint,
    slippageBps: number = 50,
    maxAttempts: number = 2,
    retryDelaySeconds: number = 0.5
): Promise<JupiterQuoteResponse> {
    const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}\
&outputMint=${outputMint}\
&amount=${amount}\
&slippageBps=${slippageBps}`;

    let attempts = 0;
    while (attempts < maxAttempts) {
        try {
            console.log(`Attempt ${attempts + 1}/${maxAttempts} to get Jupiter quote`);
            
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Jupiter API error: ${response.status} ${response.statusText}`);
            }
            
            const quoteResponse: JupiterQuoteResponse = await response.json();
            console.log('Successfully fetched Jupiter quote');
            return quoteResponse;
        } catch (error) {
            attempts++;
            console.error(`Error fetching Jupiter quote (attempt ${attempts}/${maxAttempts}):`, error);
            
            if (attempts >= maxAttempts) {
                console.error("Max attempts reached for Jupiter quote, giving up");
                throw error;
            }
            
            console.log(`Waiting ${retryDelaySeconds} seconds before retry...`);
            await new Promise(resolve => setTimeout(resolve, Math.floor(retryDelaySeconds * 1000)));
        }
    }
    
    // This should never be reached due to the throw in the catch block
    throw new Error("Failed to get Jupiter quote after maximum attempts");
}

export async function getUsdPriceFromJup(
    inputMint: Address,
    amount: bigint,
    inputDecimals: number,
    outputMint: Address = address(USDC_MINT)
): Promise<number> {
    // Return 1 for stablecoins
    if (inputMint === address(USDC_MINT) || inputMint === address(USDT_MINT)) {
        return 1;
    }
    
    const quote = await getJupiterQuote(inputMint, outputMint, amount);
    
    // Use passed inputDecimals and hardcoded USDC/USDT decimals (6)
    return (Number(quote.outAmount) / Math.pow(10, 6)) / 
           (Number(quote.inAmount) / Math.pow(10, inputDecimals));
}

async function getJupiterSwapInstruction(
    quoteResponse: JupiterQuoteResponse,
    userPublicKey: string
): Promise<{
    instruction: IInstruction,
    lutAddresses: string[]
}> {
    try {
        const response = await fetch('https://lite-api.jup.ag/swap/v1/swap-instructions', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                quoteResponse,
                userPublicKey,
                wrapAndUnwrapSol: false,
                useSharedAccounts: true,
                prioritizationFeeLamports: 0
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get swap instructions: ${response.status} - ${errorText}`);
        }
        
        const data = await response.json();
        return {
            instruction: deserializeSwapInstruction(data.swapInstruction),
            lutAddresses: data.addressLookupTableAddresses
        };
    } catch (error) {
        console.error('Error getting Jupiter swap instructions:', error);
        throw error;
    }
}

async function executeJupiterSwap(
    rpc: RpcMainnet<SolanaRpcApiMainnet>,
    wallet: KeyPairSigner, 
    inputMint: Address,
    amount: bigint,
    slippageBps: number = 50,
    jito: boolean = true,
    desparate: boolean = false
): Promise<boolean> {
    try {
        const quote = await getJupiterQuote(inputMint, address(USDC_MINT), amount, slippageBps);
        const { instruction, lutAddresses } = await getJupiterSwapInstruction(quote, wallet.address);
        console.log('LUT addresses:', lutAddresses);
        let signature: Signature;
        if (jito) {
            signature = await sendTransactionWithJito([instruction], wallet, rpc, desparate, lutAddresses);
        } else {
            signature = await sendTransactionWithPriorityFee([instruction], wallet, rpc, lutAddresses);
        }

        return await checkTransactionConfirmed(signature, rpc);
    } catch (error) {
        console.error('Error executing Jupiter swap:', error);
        throw error;
    }
}

export async function swapToUsdc(
    rpc: RpcMainnet<SolanaRpcApiMainnet>,
    wallet: KeyPairSigner,
    inputMint: Address,
    maxAttempts: number = 5,
    slippageBps: number = 50
): Promise<boolean> {
    if (inputMint === address(USDC_MINT)) {
        console.log('Input is already USDC, no swap needed');
        return true;
    }
    
    let attempts = 0;
    while (attempts < maxAttempts) {
        // Calculate current slippage with 15% increase per attempt
        const currentSlippage = Math.round(slippageBps * (1 + (0.15 * attempts)));
        try {
            console.log(`\nAttempt ${attempts + 1}/${maxAttempts} with ${currentSlippage} bps slippage`);
            
            const balance = await getTokenBalUtil(wallet, inputMint);
            if (!balance || balance.tokenBalanceBigInt === 0n) {
                console.log('No balance to swap');
                return true;
            }
            
            console.log(`Current balance: ${balance.tokenBalanceNormalized}`);
            const success = await executeJupiterSwap(rpc, wallet, inputMint, balance.tokenBalanceBigInt, currentSlippage);

            if (success) {
                const finalBalance = await getTokenBalUtil(wallet, inputMint);
                if (!finalBalance || finalBalance.tokenBalanceBigInt === 0n) {
                    console.log('Swap successful, balance is now 0');
                    return true;
                }
                console.log(`Swap completed but balance remains: ${finalBalance.tokenBalanceNormalized}`);
            }
        } catch (error) {
            console.error(`\nSwap attempt ${attempts + 1} failed:`, error);
            if (attempts === maxAttempts - 1) throw error;
        }
        attempts++;
        if (attempts < maxAttempts) {
            console.log(`Waiting 2 seconds before next attempt...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    throw new Error(`Failed to swap to USDC after ${maxAttempts} attempts`);
}

interface JupiterInstruction {
    programId: string;
    accounts: {
        pubkey: string;
        isSigner: boolean;
        isWritable: boolean;
    }[];
    data: string;
}

function deserializeSwapInstruction(instruction: JupiterInstruction): IInstruction {
    console.log('Signer accounts:', instruction.accounts.filter(a => a.isSigner));
    return {
        programAddress: address(instruction.programId),
        accounts: instruction.accounts.map((key) => ({
            address: address(key.pubkey),
            role: key.isSigner ? 
                (key.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) :
                (key.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY)
        })),
        data: Buffer.from(instruction.data, "base64")
    };
}