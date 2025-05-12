import { address, Address, getProgramDerivedAddress, IInstruction, AccountRole, RpcMainnet, SolanaRpcApiMainnet, KeyPairSigner } from '@solana/web3.js';
import { sendTransactionWithJito, checkTransactionConfirmed, sendTransactionWithPriorityFee } from './utils';

function base58ToBytes(base58Str: string): Uint8Array {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let value = 0n;
    let multiplier = 1n;
    
    // Convert base58 to decimal
    for (let i = base58Str.length - 1; i >= 0; i--) {
        const digit = BigInt(ALPHABET.indexOf(base58Str[i]));
        value += digit * multiplier;
        multiplier *= 58n;
    }
    
    // Convert to bytes
    const bytes: number[] = [];
    while (value > 0n) {
        bytes.unshift(Number(value & 0xFFn));
        value = value >> 8n;
    }
    
    // Pad with leading zeros based on leading '1's
    const leadingZeros = base58Str.match(/^1*/)?.[0].length ?? 0;
    for (let i = 0; i < leadingZeros; i++) {
        bytes.unshift(0);
    }
    
    return new Uint8Array(bytes);
}

export async function getAssociatedTokenAddressSync(
    mint: Address,
    owner: Address,
): Promise<Address> {
    const TOKEN_PROGRAM_ID = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const ASSOCIATED_TOKEN_PROGRAM_ID = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

    const ownerBytes = base58ToBytes(owner);
    const tokenProgramBytes = base58ToBytes(TOKEN_PROGRAM_ID);
    const mintBytes = base58ToBytes(mint);

    const pda = await getProgramDerivedAddress({
        programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
        seeds: [
            ownerBytes,
            tokenProgramBytes,
            mintBytes
        ],
    });

    return pda[0];
}

export async function createAssociatedTokenAccountInstruction(
    fundingAddress: Address,
    walletAddress: Address,
    tokenMintAddress: Address
): Promise<IInstruction> {
    const ATA_PROGRAM_ID = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const TOKEN_PROGRAM_ID = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const SYSTEM_PROGRAM_ID = address('11111111111111111111111111111111');
    const SYSVAR_RENT_ID = address('SysvarRent111111111111111111111111111111111');
    
    const associatedAccount = await getAssociatedTokenAddressSync(tokenMintAddress, walletAddress);

    return {
        programAddress: ATA_PROGRAM_ID,
        accounts: [
            { address: fundingAddress, role: AccountRole.WRITABLE_SIGNER },
            { address: associatedAccount, role: AccountRole.WRITABLE },
            { address: walletAddress, role: AccountRole.READONLY },
            { address: tokenMintAddress, role: AccountRole.READONLY },
            { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
            { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
            { address: SYSVAR_RENT_ID, role: AccountRole.READONLY }
        ],
        data: new Uint8Array([]) // Empty data vector per the original code
    };
}

export async function createAtaForMint(
    rpc: RpcMainnet<SolanaRpcApiMainnet>,
    wallet: KeyPairSigner,
    mint: Address,
    maxAttempts: number = 8
): Promise<boolean> {
    // First check if ATA exists
    const associatedAccount = await getAssociatedTokenAddressSync(mint, wallet.address);
    console.log("Associated Account: ", associatedAccount);
    const accountInfo = await rpc.getAccountInfo(
        associatedAccount,
        { encoding: 'base64' }
    ).send();

    if (!accountInfo.value) {
        console.log("ATA doesn't exist for mint: ", mint, ", creating it...");
        let attempts = 0;
        
        while (attempts < maxAttempts) {
            try {
                const instruction = await createAssociatedTokenAccountInstruction(
                    wallet.address,
                    wallet.address,
                    mint
                );

                const useJito = attempts <= 2 || (attempts > 2 && attempts % 2 === 0);
                console.log(`Attempt ${attempts + 1}/${maxAttempts}: ${useJito ? 'Using Jito' : 'Using regular transaction'}`);

                const sig = useJito ? 
                    await sendTransactionWithJito([instruction], wallet, rpc) :
                    await sendTransactionWithPriorityFee([instruction], wallet, rpc);

                console.log("Create ATA Signature: ", sig);
                const isConfirmed = await checkTransactionConfirmed(sig, rpc);
                console.log("ATA Creation Confirmed: ", isConfirmed);

                // Check if account exists regardless of transaction confirmation
                const accountCheck = await rpc.getAccountInfo(
                    associatedAccount,
                    { encoding: 'base64' }
                ).send();

                if (accountCheck.value) {
                    console.log("ATA exists after attempt (confirmed via account check)");
                    return true;
                }

                if (isConfirmed) {
                    return true;
                }
                
                console.log("Transaction not confirmed and ATA still doesn't exist, retrying...");
            } catch (error) {
                console.error(`Error creating ATA (attempt ${attempts + 1}):`, error);
            }

            attempts++;
            if (attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.error(`Failed to create ATA after ${maxAttempts} attempts`);
        return false;
    } else {
        console.log("ATA already exists!");
        console.log("Owner:", accountInfo.value?.owner);
        return true;
    }
}